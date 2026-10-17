/* GOLD SPECTRA PROSPECTOR — background evidence-fusion worker */
'use strict';
const EARTH_KM = 6371.0088;
const FACTORS = {
  alteration: { radius: 5 }, structure: { radius: 10 }, lithology: { radius: 10 },
  geochemistry: { radius: 4 }, geophysics: { radius: 8 }, occurrence: { radius: 20 }
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
function haversineKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const cross = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if (cross) inside = !inside;
  }
  return inside;
}
function scoreLocation(lat, lon, evidence, weights, active, activeWeight, radiusKm) {
  let weighted = 0, supportedFactors = 0;
  const factorScores = {};
  for (const factor of active) {
    const fRadius = Math.max(.15, radiusKm * (FACTORS[factor].radius / 10));
    let best = 0, second = 0, count = 0;
    for (let i = 0; i < evidence.length; i++) {
      const p = evidence[i];
      if (p.factor !== factor) continue;
      const dist = haversineKm(lat, lon, p.lat, p.lon);
      if (dist > fRadius * 5) continue;
      const signal = (p.strength / 5) * (p.confidence / 5) * Math.exp(-dist / fRadius);
      if (signal > best) { second = best; best = signal; }
      else if (signal > second) second = signal;
      if (signal >= .15) count++;
    }
    // A small corroboration component rewards nearby independent observations without allowing point density to dominate.
    const support = clamp(best + Math.min(.18, second * .18) + Math.min(.08, Math.max(0, count - 1) * .02), 0, 1);
    factorScores[factor] = support;
    weighted += weights[factor] * support;
    if (support >= .22) supportedFactors++;
  }
  const base = activeWeight > 0 ? weighted / activeWeight * 100 : 0;
  const convergence = Math.max(0, supportedFactors - 1);
  const bonus = convergence > 0 ? Math.min(12, convergence * 3) * (base / 100) : 0;
  const score = clamp(base + bonus, 0, 100);
  return { score, factorScores, supportingFactors: supportedFactors, convergence: bonus };
}
function makeGrid(payload) {
  const { ring, bounds, requestedStepKm, weights, evidence, radiusKm, coverage } = payload;
  const [south, north, west, east] = bounds;
  const midLat = (south + north) / 2;
  const widthKm = haversineKm(midLat, west, midLat, east);
  const heightKm = haversineKm(south, (west + east) / 2, north, (west + east) / 2);
  const bboxArea = Math.max(.01, widthKm * heightKm);
  // Hard cap prevents a massive AOI from freezing the device. User-selected resolution is a minimum.
  const gridStepKm = Math.max(requestedStepKm, Math.sqrt(bboxArea / 12000));
  const dLat = gridStepKm / 111.32;
  const dLon = gridStepKm / (111.32 * Math.max(.15, Math.cos(midLat * Math.PI / 180)));
  const active = Object.keys(weights).filter(k => weights[k] > 0 && evidence.some(p => p.factor === k));
  const activeWeight = active.reduce((sum, key) => sum + weights[key], 0);
  const cells = [];
  for (let lat = south + dLat / 2; lat <= north && cells.length < 12000; lat += dLat) {
    for (let lon = west + dLon / 2; lon <= east && cells.length < 12000; lon += dLon) {
      if (!pointInRing(lon, lat, ring)) continue;
      cells.push({ lat, lon });
    }
  }
  return { cells, gridStepKm, active, activeWeight };
}
self.onmessage = async (event) => {
  const { type, payload } = event.data || {};
  if (type !== 'analyze') return;
  try {
    const { cells, gridStepKm, active, activeWeight } = makeGrid(payload);
    if (!cells.length) { self.postMessage({ type: 'error', message: 'شبكة التحليل فارغة. قلّل حجم المنطقة أو اختر شبكة أصغر.' }); return; }
    if (!active.length || activeWeight <= 0) { self.postMessage({ type: 'error', message: 'لا توجد طبقات أدلة ذات أوزان فعالة.' }); return; }
    const results = new Array(cells.length);
    const batchSize = 160;
    let cursor = 0;
    function processBatch() {
      const end = Math.min(cells.length, cursor + batchSize);
      for (; cursor < end; cursor++) {
        const c = cells[cursor];
        const scored = scoreLocation(c.lat, c.lon, payload.evidence, payload.weights, active, activeWeight, payload.radiusKm);
        results[cursor] = { ...c, score: scored.score, factorScores: scored.factorScores,
          supportingFactors: scored.supportingFactors, convergence: scored.convergence, coverage: payload.coverage };
      }
      self.postMessage({ type: 'progress', done: cursor, total: cells.length, gridStepKm });
      if (cursor < cells.length) setTimeout(processBatch, 0);
      else self.postMessage({ type: 'complete', results, gridStepKm, active, cells: cells.length });
    }
    self.postMessage({ type: 'started', total: cells.length, gridStepKm });
    processBatch();
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'تعذر إكمال التحليل.' });
  }
};
