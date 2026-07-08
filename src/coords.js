// Validate/parse the lat & lng query params. Coordinates are OPTIONAL (routing
// falls back to a region center / home when absent), but if provided they must
// be well-formed — a bare parseFloat("") → NaN would otherwise reach ALS.
//
// Rules:
//   - both absent / empty string  → valid, no coords ({lat:null, lng:null})
//   - both present & finite & in range → valid, parsed numbers
//   - only one present, non-numeric, or out of range → invalid (with .error)
//
// Returns { valid, lat, lng } or { valid: false, error }.
function parseCoords(latRaw, lngRaw) {
  const latEmpty = latRaw == null || latRaw === "";
  const lngEmpty = lngRaw == null || lngRaw === "";

  if (latEmpty && lngEmpty) return { valid: true, lat: null, lng: null };
  if (latEmpty !== lngEmpty) {
    return { valid: false, error: "lat and lng must be provided together" };
  }

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { valid: false, error: "lat and lng must be numbers" };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { valid: false, error: "lat must be in [-90,90] and lng in [-180,180]" };
  }
  return { valid: true, lat, lng };
}

module.exports = { parseCoords };
