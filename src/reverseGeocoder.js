// Grid key: truncate lat/lng to 1 decimal (~11km cells). Normalize -0 to 0.
function gridKey(lat, lng) {
  const t = (n) => (Math.trunc(n * 10) / 10 + 0).toFixed(1);
  return `${t(lat)},${t(lng)}`;
}

// Build a reverse geocoder that resolves [lat,lng] -> ISO country code using
// HOME_REGION, cached by grid cell. reverseGeocodeCountry is injected (alsClient).
function createReverseGeocoder({ homeRegion, getKey, reverseGeocodeCountry }) {
  const cache = new Map();
  async function toCountry(lat, lng) {
    const k = gridKey(lat, lng);
    if (cache.has(k)) return cache.get(k);
    const cc = await reverseGeocodeCountry({
      region: homeRegion,
      key: getKey(homeRegion),
      lat,
      lng,
    });
    cache.set(k, cc);
    return cc;
  }
  return { toCountry };
}

module.exports = { gridKey, createReverseGeocoder };
