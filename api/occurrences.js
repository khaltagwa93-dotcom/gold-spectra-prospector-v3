'use strict';

// Reference-only query against the public USGS selected major mineral deposits layer.
// These records are not a complete census of mineral occurrences, particularly outside
// the United States; this endpoint must never be treated as evidence of absence.
const USGS_QUERY = 'https://energy.usgs.gov/arcgis/rest/services/Hosted/Major_mineral_deposits/FeatureServer/0/query';
const OUT_FIELDS = 'gid,dep_name,country,latitude,longitude,commodity,dep_type,model_name,citation,url';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=900');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return typeof req.body === 'string' ? JSON.parse(req.body) : {}; } catch { return {}; }
}
function readRing(geometry) {
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates?.[0])) return null;
  const ring = geometry.coordinates[0];
  if (ring.length < 4 || ring.length > 500) return null;
  if (!ring.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]) ) && Math.abs(Number(p[0])) <= 180 && Math.abs(Number(p[1])) <= 90)) return null;
  return ring.map(p => [Number(p[0]), Number(p[1])]);
}
function extentOf(ring) {
  return { xmin: Math.min(...ring.map(p=>p[0])), ymin: Math.min(...ring.map(p=>p[1])), xmax: Math.max(...ring.map(p=>p[0])), ymax: Math.max(...ring.map(p=>p[1])) };
}
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [xi,yi]=ring[i], [xj,yj]=ring[j];
    const cross=((yi>lat)!==(yj>lat)) && (lon < (xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi);
    if (cross) inside=!inside;
  }
  return inside;
}
function cleanFeature(feature, ring) {
  const a = feature?.attributes || {};
  const x = Number(feature?.geometry?.x ?? a.longitude);
  const y = Number(feature?.geometry?.y ?? a.latitude);
  const commodity = String(a.commodity || '');
  if (!Number.isFinite(x) || !Number.isFinite(y) || !/gold|\\bau\\b/i.test(commodity)) return null;
  if (!pointInRing(x, y, ring)) return null;
  return {
    id: String(a.gid ?? a.rec_id ?? `${x.toFixed(5)}_${y.toFixed(5)}`),
    name: String(a.dep_name || 'اسم غير متوفر').slice(0,160),
    country: String(a.country || 'غير محدد').slice(0,80),
    lat: y, lon: x,
    commodity: commodity.slice(0,120),
    depositType: String(a.dep_type || a.model_name || '').slice(0,120),
    citation: String(a.citation || '').slice(0,300),
    url: typeof a.url === 'string' && /^https?:\/\//i.test(a.url) ? a.url.slice(0,1500) : '',
    source: 'USGS selected major mineral deposits'
  };
}
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'استخدم طلب POST لجلب المراجع المعدنية.' });
  const ring = readRing(parseBody(req).geometry);
  if (!ring) return send(res, 400, { error: 'حدود منطقة الدراسة غير صالحة أو معقدة أكثر من اللازم.' });
  const envelope = extentOf(ring);
  const params = new URLSearchParams({
    f: 'json',
    where: "commodity LIKE '%gold%' OR commodity LIKE '%Gold%' OR commodity LIKE '%GOLD%' OR commodity LIKE '%Au%'",
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    outSR: '4326', inSR: '4326',
    geometry: JSON.stringify({ ...envelope, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    resultRecordCount: '2000',
    orderByFields: 'dep_name ASC'
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  try {
    let response = await fetch(`${USGS_QUERY}?${params.toString()}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`USGS request failed (${response.status})`);
    let data = await response.json();
    if (data.error) {
      params.delete('orderByFields');
      response = await fetch(`${USGS_QUERY}?${params.toString()}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(`USGS request failed (${response.status})`);
      data = await response.json();
    }
    if (data.error) throw new Error(data.error.message || 'USGS query error');
    const occurrences = (data.features || []).map(feature => cleanFeature(feature, ring)).filter(Boolean).slice(0, 1000);
    return send(res, 200, {
      source: 'U.S. Geological Survey (USGS), selected major mineral deposits layer',
      sourceUrl: 'https://energy.usgs.gov/arcgis/rest/services/Hosted/Major_mineral_deposits/FeatureServer',
      count: occurrences.length,
      occurrences,
      limitations: 'هذه قاعدة مرجعية منتقاة وليست سجلًا شاملًا؛ قد يكون غياب النقاط ناتجًا عن نقص التغطية أو البيانات، ولا يثبت غياب الذهب.'
    });
  } catch (error) {
    console.error('USGS reference occurrence lookup failed:', error?.message || error);
    return send(res, 502, { error: 'تعذر الوصول إلى قاعدة USGS حاليًا. استخدم الاتصال بالإنترنت وأعد المحاولة؛ لا يعني فشل الاستعلام عدم وجود رواسب.' });
  } finally { clearTimeout(timeout); }
};
