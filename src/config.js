const { ALS_SUPPORTED_REGIONS, GRABMAPS_REGIONS } = require("../config/als-regions");
const { parseKeyMap } = require("./keyMap");
const { parseAllowedOrigins } = require("./cors");

// Pure validation of an already-parsed config object. Throws on any problem.
// Both `homeRegion` and `enabledRegions` come from the mapping file (its "*"
// marker and top-level keys respectively) — the single source of truth. So
// homeRegion is guaranteed to be one of enabledRegions by construction; this
// only validates ALS support, the GrabMaps guard, and key coverage.
function validateConfig(cfg) {
  const { homeRegion, routingEnabled, enabledRegions, keyMap } = cfg;

  // The home region comes from the mapping's "*" marker, not an env var — so
  // error messages point operators at the mapping file, not a phantom knob.
  if (!ALS_SUPPORTED_REGIONS.has(homeRegion)) {
    throw new Error(
      `Home region "${homeRegion}" is not an ALS-supported region ` +
        `(it is the region marked "*" in config/country-region-map.json)`
    );
  }

  // The home region is the reverse-geocode guide region only when routing is on.
  if (routingEnabled && GRABMAPS_REGIONS.has(homeRegion)) {
    throw new Error(
      `Home region "${homeRegion}" (marked "*" in config/country-region-map.json) is a ` +
        `GrabMaps region and cannot be the reverse-geocode guide region while ` +
        `MULTI_REGION_ROUTING is on — mark a global-coverage region "*" instead`
    );
  }

  // Every region declared in the mapping must have a non-empty API key. An
  // empty value passes a `.has()` check but 403s at runtime, so reject it here
  // (fail fast) rather than letting a healthy-looking task serve errors.
  for (const region of enabledRegions) {
    if (!keyMap.has(region)) {
      throw new Error(`LOCATION_API_KEYS is missing API key for region "${region}"`);
    }
    if (!String(keyMap.get(region)).trim()) {
      throw new Error(`LOCATION_API_KEYS has an empty API key for region "${region}"`);
    }
  }
  return cfg;
}

// Parse TRUST_PROXY into what Express `set('trust proxy', …)` accepts: a hop
// count (number), a boolean, or the default (FALSE) when unset. Every unhandled
// case fails SAFE to `false`: unset/empty and an UNRECOGNIZED value (e.g. a typo
// like "tw") both default to `false` + a warning. `true` would trust the whole
// X-Forwarded-For chain and make the rate-limiter's client IP spoofable (a
// viewer forges a leftmost entry to dodge the limiter); `false` only makes
// limiting stricter (keys on the ALB IP). Production MUST set the exact hop
// count (CloudFront→ALB = 2) so req.ip is the real, unspoofable client.
function parseTrustProxy(value) {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  console.warn(
    `[config] TRUST_PROXY "${value}" is not recognized (expected a number, "true", or ` +
      `"false"); defaulting to false so the rate-limiter client IP stays unspoofable`
  );
  return false;
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
  // CORS allowlist (default closed) + baseline per-IP rate limit for /api.
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const rateLimit = {
    ratePerSec: Number(env.API_RATE_PER_SEC) || 10,
    burst: Number(env.API_RATE_BURST) || 20,
  };
  // Express 'trust proxy' setting. Behind CloudFront→ALB the client IP used for
  // rate limiting must be UNSPOOFABLE: a numeric hop count (e.g. 2) makes Express
  // read the IP a fixed number of hops from the right of X-Forwarded-For, so a
  // viewer can't forge a leftmost entry to dodge the limiter. Set TRUST_PROXY=2
  // in the CloudFront+ALB topology. Accepts a number, "true"/"false", or defaults
  // to true (convenient locally; production should pin the hop count).
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  // FIFO bound for the reverse-geocode grid cache (per-task backstop against
  // unbounded growth on a long-running, globally-distributed workload).
  const reverseGeoCacheMax = Number(env.REVERSE_GEO_CACHE_MAX) || 200_000;
  const cfg = {
    homeRegion,
    routingEnabled,
    enabledRegions,
    keyMap,
    mapTileDomain,
    allowedOrigins,
    rateLimit,
    trustProxy,
    reverseGeoCacheMax,
  };
  return validateConfig(cfg);
}

module.exports = { validateConfig, loadConfig };
