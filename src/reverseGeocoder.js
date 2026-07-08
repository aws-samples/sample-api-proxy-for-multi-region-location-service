// Grid key: truncate lat/lng to 1 decimal (~11km cells). Normalize -0 to 0.
function gridKey(lat, lng) {
  const t = (n) => (Math.trunc(n * 10) / 10 + 0).toFixed(1);
  return `${t(lat)},${t(lng)}`;
}

// Build a reverse geocoder that resolves [lat,lng] -> ISO country code using
// the home region, cached by grid cell. reverseGeocodeCountry is injected (alsClient).
function createReverseGeocoder({ homeRegion, getKey, reverseGeocodeCountry }) {
  const cache = new Map();
  async function toCountry(lat, lng) {
    const k = gridKey(lat, lng);
    if (cache.has(k)) return cache.get(k);
    let cc;
    try {
      cc = await reverseGeocodeCountry({
        region: homeRegion,
        key: getKey(homeRegion),
        lat,
        lng,
      });
    } catch (err) {
      // Reverse-geocode is a best-effort routing guess; an ALS error must
      // degrade to null (caller falls back to home region) rather than crash
      // the request. Do NOT cache the failure — a transient blip should be
      // retryable on the next request for the same grid cell.
      console.warn(`[reverse-geo] ${homeRegion} lookup failed, degrading to home: ${err.message}`);
      return null;
    }
    cache.set(k, cc);
    return cc;
  }
  return { toCountry };
}

module.exports = { gridKey, createReverseGeocoder };
