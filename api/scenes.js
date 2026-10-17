'use strict';
const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
const ALLOWED_COLLECTION = 'sentinel-2-l2a';

function sendError(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return typeof req.body === 'string' ? JSON.parse(req.body) : {}; } catch { return {}; }
}
function geometryLooksValid(geometry) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) return false;
  try {
    const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
    return Array.isArray(ring) && ring.length >= 4 && ring.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
  try {
    const body = parseBody(req);
    const geometry = body.geometry;
    if (!geometryLooksValid(geometry)) return sendError(res, 400, 'Invalid study area geometry.');
    const start = body.start || body.datetime_from || null;
    const end = body.end || body.datetime_to || null;
    const cloudLimit = Math.min(100, Math.max(0, Number(body.cloudLimit ?? body.maxCloud ?? 30)));
    const limit = Math.min(50, Math.max(1, Number(body.limit || 20)));
    const searchBody = {
      collections: [ALLOWED_COLLECTION],
      intersects: geometry,
      limit: Math.min(100, limit * 3),
      query: { 'eo:cloud_cover': { lte: cloudLimit } }
    };
    if (start || end) {
      searchBody.datetime = `${start || '..'}/${end || '..'}`;
    }
    searchBody.sortby = [{ field: 'properties.datetime', direction: 'desc' }];
    let response = await fetch(`${STAC}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json' },
      body: JSON.stringify(searchBody)
    });
    if (!response.ok) {
      const fallback = { ...searchBody }; delete fallback.sortby;
      response = await fetch(`${STAC}/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json' },
        body: JSON.stringify(fallback)
      });
    }
    if (!response.ok) {
      const fallback = { ...searchBody }; delete fallback.sortby; delete fallback.query;
      response = await fetch(`${STAC}/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json' },
        body: JSON.stringify(fallback)
      });
    }
    if (!response.ok) throw new Error(`STAC service returned ${response.status}`);
    const collection = await response.json();
    const scenes = (collection.features || []).map(item => {
      const assets = item.assets || {};
      const available = key => Boolean(assets[key] && assets[key].href);
      return {
        id: String(item.id || ''),
        date: item.properties?.datetime || item.properties?.['start_datetime'] || null,
        cloud: Number(item.properties?.['eo:cloud_cover'] ?? 100),
        platform: item.properties?.platform || item.properties?.constellation || 'Sentinel-2',
        epsg: item.properties?.['proj:epsg'] || null,
        bbox: item.bbox || null,
        bands: { B02: available('B02'), B04: available('B04'), B05: available('B05'), B06: available('B06'), B07: available('B07'), B08: available('B08'), B11: available('B11'), B12: available('B12'), SCL: available('SCL') },
        collection: ALLOWED_COLLECTION
      };
    }).filter(scene => scene.id && scene.cloud <= cloudLimit && ((scene.bands.B11 && scene.bands.B12) || (scene.bands.B04 && scene.bands.B02)))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, limit);
    res.statusCode = 200;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify({ collection: ALLOWED_COLLECTION, count: scenes.length, scenes, searched: { start, end, cloudLimit } }));
  } catch (error) {
    console.error('Sentinel-2 scene search failed:', error?.message || error);
    sendError(res, 502, 'تعذر الاتصال بكتالوج المشاهد الفضائية حاليًا. تحقق من الاتصال وحاول مجددًا، أو استخدم ملفات GeoTIFF محلية إن كانت متاحة.');
  }
};
