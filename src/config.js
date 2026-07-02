const { ALS_SUPPORTED_REGIONS, GRABMAPS_REGIONS } = require("../config/als-regions");
const { parseKeyMap } = require("./keyMap");

// Pure validation of an already-parsed config object. Throws on any problem.
// `enabledRegions` is the set of regions declared in the mapping file (its
// top-level keys) — the single source of truth for which regions are in use.
function validateConfig(cfg) {
  const { homeRegion, routingEnabled, enabledRegions, keyMap } = cfg;

  if (!ALS_SUPPORTED_REGIONS.has(homeRegion)) {
    throw new Error(`HOME_REGION "${homeRegion}" is not an ALS-supported region`);
  }

  // HOME_REGION must appear in the mapping file: it is the fallback / reverse-
  // geocode guide region, so it must be a region we build a key for and route to.
  if (!enabledRegions.has(homeRegion)) {
    throw new Error(
      `HOME_REGION "${homeRegion}" must be present in the mapping file ` +
        `(add it as a key, e.g. "${homeRegion}": [] for a fallback-only region)`
    );
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

// Read raw config from process.env plus the region set derived from the
// mapping file, parse, validate, and return it.
function loadConfig(env = process.env, mappingRegions) {
  const homeRegion = env.HOME_REGION || "us-east-1";
  const routingEnabled = String(env.MULTI_REGION_ROUTING).toLowerCase() === "true";
  // The mapping file's keys are the single source of truth for regions in use.
  const enabledRegions = new Set(mappingRegions || []);
  const keyMap = parseKeyMap(env.LOCATION_API_KEYS);
  const mapTileDomain = env.MAP_TILE_DOMAIN;
  if (!mapTileDomain) {
    throw new Error("MAP_TILE_DOMAIN is not set");
  }
  const cfg = { homeRegion, routingEnabled, enabledRegions, keyMap, mapTileDomain };
  return validateConfig(cfg);
}

module.exports = { validateConfig, loadConfig };
