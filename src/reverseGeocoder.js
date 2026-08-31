// Grid key: truncate lat/lng to 2 decimal places (~1.1 km at the equator).
// This keeps the cache useful without assigning one country to an ~11 km cell
// that may span a national border. Normalize -0 to 0.
function gridKey(lat, lng) {
  const t = (n) => (Math.trunc(n * 100) / 100 + 0).toFixed(2);
  return `${t(lat)},${t(lng)}`;
}

// Build a reverse geocoder that resolves [lat,lng] -> ISO country code using
// the home region. Successful answers (including a legitimate null/no-result)
// are cached by grid cell for a bounded time. Concurrent misses for the same
// cell share one Promise so a cold burst pays for only one ALS call.
//
// maxSize bounds the cache (FIFO). Per-task/in-process, like the rate limiter.
function createReverseGeocoder({
  homeRegion,
  getKey,
  reverseGeocodeCountry,
  maxSize = 200_000,
  ttlMs = 60 * 60 * 1000,
  now = () => Date.now(),
}) {
  const cache = new Map(); // grid -> { country, expiresAt }
  const inFlight = new Map(); // grid -> Promise<country|null>

  async function toCountry(lat, lng) {
    const k = gridKey(lat, lng);
    const cached = cache.get(k);
    if (cached) {
      if (cached.expiresAt > now()) return cached.country;
      cache.delete(k);
    }
    if (inFlight.has(k)) return inFlight.get(k);

    const pending = (async () => {
      let country;
      try {
        country = await reverseGeocodeCountry({
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

      // FIFO eviction: Map preserves insertion order, so the first key is the
      // oldest. Evict before inserting to keep size at the cap.
      if (cache.size >= maxSize) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(k, { country, expiresAt: now() + ttlMs });
      return country;
    })();

    inFlight.set(k, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(k);
    }
  }

  return { toCountry, cacheSize: () => cache.size };
}

module.exports = { gridKey, createReverseGeocoder };
