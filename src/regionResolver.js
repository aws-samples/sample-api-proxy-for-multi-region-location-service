// Decide the target ALS region for a request. Pure: all I/O is injected via deps
// (getRegion: sync country->region lookup; reverseGeocodeToCountry: async).
// Returns { targetRegion, source, countryCode }. source explains the decision
// path (for logs); countryCode is the country the decision was based on (the
// explicit one, or the reverse-geocoded one) or null when there was none — it
// lets callers derive other country-defaulted settings (e.g. the map label
// language) without paying for a second reverse-geocode.
async function resolveRegion(input, deps) {
  const { homeRegion, getRegion, reverseGeocodeToCountry } = deps;
  const { countryCode, lat, lng, routingEnabled } = input;

  if (!routingEnabled) {
    // Routing off still means "this request is about that country" — the region
    // is pinned to home, but the country is reported so language defaulting and
    // logging keep working in single-region deployments.
    return { targetRegion: homeRegion, source: "home-disabled", countryCode: countryCode || null };
  }

  // countryCode takes precedence over lat/lng: an explicit country is
  // authoritative, so coords are ignored when both are present.
  if (countryCode) {
    const region = getRegion(countryCode);
    return region
      ? { targetRegion: region, source: "country-map", countryCode }
      : { targetRegion: homeRegion, source: "country-map-miss-fallback", countryCode };
  }

  if (lat != null && lng != null) {
    const cc = await reverseGeocodeToCountry(lat, lng);
    if (!cc) {
      return { targetRegion: homeRegion, source: "reverse-miss-fallback", countryCode: null };
    }
    const region = getRegion(cc);
    return region
      ? { targetRegion: region, source: "reverse-geo", countryCode: cc }
      : { targetRegion: homeRegion, source: "reverse-geo-map-miss-fallback", countryCode: cc };
  }

  return { targetRegion: homeRegion, source: "no-input-fallback", countryCode: null };
}

module.exports = { resolveRegion };
