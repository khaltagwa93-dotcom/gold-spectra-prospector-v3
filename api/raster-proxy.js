'use strict';
const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
const SIGN = 'https://planetarycomputer.microsoft.com/api/sas/v1/sign/';
const ALLOWED_BANDS = new Set(['B02','B03','B04','B05','B06','B07','B08','B8A','B11','B12','SCL']);
const CACHE_TTL_MS = 35 * 60 * 1000;
const cache = global.__goldSpectraSignedAssetCache || (global.__goldSpectraSignedAssetCache = new Map());

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}
function validItemId(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value); }
async function getSignedAsset(itemId, band) {
  const key = `${itemId}:${band}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.href;
  const itemUrl = `${STAC}/collections/sentinel-2-l2a/items/${encodeURIComponent(itemId)}`;
  const itemResponse = await fetch(itemUrl, { headers: { Accept: 'application/geo+json, application/json' } });
  if (!itemResponse.ok) throw new Error(`STAC item unavailable (${itemResponse.status})`);
  const item = await itemResponse.json();
  const assetHref = item.assets?.[band]?.href;
  if (!assetHref) throw new Error('The requested band is not available for this scene.');
  const parsedAsset = new URL(assetHref);
  // Prevent SSRF: only sign documented Planetary Computer Azure Blob assets.
  if (parsedAsset.protocol !== 'https:' || !parsedAsset.hostname.endsWith('.blob.core.windows.net')) throw new Error('The asset host is not permitted.');
  const signUrl = `${SIGN}?href=${encodeURIComponent(assetHref)}`;
  const signResponse = await fetch(signUrl, { headers: { Accept: 'application/json' } });
  if (!signResponse.ok) throw new Error(`Asset signing failed (${signResponse.status})`);
  const signed = await signResponse.json();
  if (!signed.href || !String(signed.href).startsWith('https://')) throw new Error('The data provider returned an invalid signed link.');
  let expiry = Date.now() + CACHE_TTL_MS;
  if (signed['msft:expiry']) {
    const parsedExpiry = Date.parse(signed['msft:expiry']);
    if (Number.isFinite(parsedExpiry)) expiry = Math.min(expiry, parsedExpiry - 60000);
  }
  cache.set(key, { href: signed.href, expires: expiry });
  if (cache.size > 160) for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
  return signed.href;
}
module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Only GET and HEAD are supported.' });
  const item = String(req.query?.item || '');
  const band = String(req.query?.band || '').toUpperCase();
  if (!validItemId(item) || !ALLOWED_BANDS.has(band)) return json(res, 400, { error: 'Invalid scene or band identifier.' });
  try {
    const href = await getSignedAsset(item, band);
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];
    if (req.headers['if-modified-since']) headers['If-Modified-Since'] = req.headers['if-modified-since'];
    const upstream = await fetch(href, { method: req.method, headers });
    res.statusCode = upstream.status;
    for (const name of ['accept-ranges','content-length','content-range','content-type','etag','last-modified','expires']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name.replace(/(^|-)([a-z])/g, (_, dash, ch) => dash + ch.toUpperCase()), value);
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (req.method === 'HEAD' || upstream.status === 304 || upstream.status === 416) return res.end();
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.end(bytes);
  } catch (error) {
    console.error('Raster proxy failed:', error?.message || error);
    json(res, 502, { error: 'Could not read this Sentinel-2 asset. Try another scene or use local GeoTIFF bands.' });
  }
};
