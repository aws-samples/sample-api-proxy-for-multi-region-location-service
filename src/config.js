const { ALS_SUPPORTED_REGIONS, GRABMAPS_REGIONS } = require("../config/als-regions");
const { parseKeyMap } = require("./keyMap");

// Pure validation of an already-parsed config object. Throws on any problem.
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

  for (const region of enabledRegions) {
    if (!ALS_SUPPORTED_REGIONS.has(region)) {
      throw new Error(`ENABLED_REGIONS contains non-ALS region "${region}"`);
    }
  }

  // Every region we might route to (enabled ∪ home) must have a key.
  const needKeys = new Set([...enabledRegions, homeRegion]);
  for (const region of needKeys) {
    if (!keyMap.has(region)) {
      throw new Error(`LOCATION_API_KEYS is missing API key for region "${region}"`);
    }
  }
  return cfg;
}

// Read raw config from process.env, parse, validate, and return it.
function loadConfig(env = process.env) {
  const homeRegion = env.HOME_REGION || "us-east-1";
  const routingEnabled = String(env.MULTI_REGION_ROUTING).toLowerCase() === "true";
  const enabledRegions = new Set(
    (env.ENABLED_REGIONS || homeRegion)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const keyMap = parseKeyMap(env.LOCATION_API_KEYS);
  const mapTileDomain = env.MAP_TILE_DOMAIN;
  if (!mapTileDomain) {
    throw new Error("MAP_TILE_DOMAIN is not set");
  }
  const cfg = { homeRegion, routingEnabled, enabledRegions, keyMap, mapTileDomain };
  return validateConfig(cfg);
}

module.exports = { validateConfig, loadConfig };
