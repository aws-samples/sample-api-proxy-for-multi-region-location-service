const { ALS_SUPPORTED_REGIONS, GRABMAPS_REGIONS } = require("../config/als-regions");
const { parseKeyMap } = require("./keyMap");

// Pure validation of an already-parsed config object. Throws on any problem.
// Both `homeRegion` and `enabledRegions` come from the mapping file (its "*"
// marker and top-level keys respectively) — the single source of truth. So
// homeRegion is guaranteed to be one of enabledRegions by construction; this
// only validates ALS support, the GrabMaps guard, and key coverage.
function validateConfig(cfg) {
  const { homeRegion, routingEnabled, enabledRegions, keyMap } = cfg;

  if (!ALS_SUPPORTED_REGIONS.has(homeRegion)) {
    throw new Error(`HOME_REGION "${homeRegion}" is not an ALS-supported region`);
  }

  // HOME_REGION is the reverse-geocode guide region only when routing is on.
  if (routingEnabled && GRABMAPS_REGIONS.has(homeRegion)) {
    throw new Error(
      `HOME_REGION "${homeRegion}" is a GrabMaps region and cannot be used as the ` +
        `reverse-geocode guide region while MULTI_REGION_ROUTING is on`
    );
  }

  // Every region declared in the mapping must have an API key.
  for (const region of enabledRegions) {
    if (!keyMap.has(region)) {
      throw new Error(`LOCATION_API_KEYS is missing API key for region "${region}"`);
    }
  }
  return cfg;
}

// Read raw config from process.env plus the mapping-derived region set and home
// region ({ regions, homeRegion }), parse, validate, and return it. HOME_REGION
// and the region set are NOT environment variables — the mapping file is the
// single source of truth.
function loadConfig(env = process.env, mapping = {}) {
  const homeRegion = mapping.homeRegion;
  const routingEnabled = String(env.MULTI_REGION_ROUTING).toLowerCase() === "true";
  const enabledRegions = new Set(mapping.regions || []);
  const keyMap = parseKeyMap(env.LOCATION_API_KEYS);
  const mapTileDomain = env.MAP_TILE_DOMAIN;
  if (!mapTileDomain) {
    throw new Error("MAP_TILE_DOMAIN is not set");
  }
  const cfg = { homeRegion, routingEnabled, enabledRegions, keyMap, mapTileDomain };
  return validateConfig(cfg);
}

module.exports = { validateConfig, loadConfig };
