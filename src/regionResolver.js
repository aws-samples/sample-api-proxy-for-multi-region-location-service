// Decide the target ALS region for a request. Pure: all I/O is injected via deps
// (getRegion: sync country->region lookup; reverseGeocodeToCountry: async).
// Returns { targetRegion, source }. source explains the decision path (for logs).
async function resolveRegion(input, deps) {
  const { homeRegion, getRegion, reverseGeocodeToCountry } = deps;
  const { countryCode, lat, lng, routingEnabled } = input;

  if (!routingEnabled) {
    return { targetRegion: homeRegion, source: "home-disabled" };
  }

  // countryCode takes precedence over lat/lng: an explicit country is
  // authoritative, so coords are ignored when both are present.
  if (countryCode) {
    const region = getRegion(countryCode);
    return region
      ? { targetRegion: region, source: "country-map" }
      : { targetRegion: homeRegion, source: "country-map-miss-fallback" };
  }

  if (lat != null && lng != null) {
    const cc = await reverseGeocodeToCountry(lat, lng);
    if (!cc) {
      return { targetRegion: homeRegion, source: "reverse-miss-fallback" };
    }
    const region = getRegion(cc);
    return region
      ? { targetRegion: region, source: "reverse-geo" }
      : { targetRegion: homeRegion, source: "reverse-geo-map-miss-fallback" };
  }

  return { targetRegion: homeRegion, source: "no-input-fallback" };
}

module.exports = { resolveRegion };
