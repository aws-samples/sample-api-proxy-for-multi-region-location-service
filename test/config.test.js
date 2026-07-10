const { test } = require("node:test");
const assert = require("node:assert");
const { validateConfig, loadConfig } = require("../src/config");

function base(overrides = {}) {
  return {
    homeRegion: "ap-northeast-1",
    routingEnabled: true,
    // enabledRegions and homeRegion both come from the mapping file.
    enabledRegions: new Set(["ap-northeast-1", "eu-west-1"]),
    keyMap: new Map([
      ["ap-northeast-1", "k1"],
      ["eu-west-1", "k2"],
    ]),
    mapTileDomain: "d123.cloudfront.net",
    ...overrides,
  };
}

test("valid config passes", () => {
  assert.doesNotThrow(() => validateConfig(base()));
});

test("rejects home region not ALS-supported (message points at the mapping, not a phantom env var)", () => {
  assert.throws(
    () => validateConfig(base({ homeRegion: "mars-1", enabledRegions: new Set(["mars-1", "eu-west-1"]) })),
    (err) => {
      assert.match(err.message, /home region.*mars-1.*ALS/i);
      assert.match(err.message, /"\*".*country-region-map\.json/); // points at the mapping marker
      assert.doesNotMatch(err.message, /HOME_REGION/); // no such env var exists
      return true;
    }
  );
});

test("routing ON rejects GrabMaps home region (message points at the mapping)", () => {
  assert.throws(
    () =>
      validateConfig(
        base({
          homeRegion: "ap-southeast-1",
          enabledRegions: new Set(["ap-southeast-1", "eu-west-1"]),
          keyMap: new Map([["ap-southeast-1", "k"], ["eu-west-1", "k2"]]),
        })
      ),
    (err) => {
      assert.match(err.message, /home region.*ap-southeast-1.*GrabMaps/i);
      assert.doesNotMatch(err.message, /HOME_REGION/);
      return true;
    }
  );
});

test("routing OFF allows GrabMaps HOME_REGION", () => {
  assert.doesNotThrow(() =>
    validateConfig(
      base({
        routingEnabled: false,
        homeRegion: "ap-southeast-1",
        enabledRegions: new Set(["ap-southeast-1"]),
        keyMap: new Map([["ap-southeast-1", "k"]]),
      })
    )
  );
});

test("rejects a mapping region missing a key", () => {
  assert.throws(
    () => validateConfig(base({ keyMap: new Map([["ap-northeast-1", "k1"]]) })),
    /missing API key.*eu-west-1/
  );
});

test("rejects an empty-string API key (would 403 at runtime, not fail fast)", () => {
  assert.throws(
    () => validateConfig(base({ keyMap: new Map([["ap-northeast-1", "k1"], ["eu-west-1", ""]]) })),
    /empty API key.*eu-west-1/i
  );
});

test("rejects a whitespace-only API key", () => {
  assert.throws(
    () => validateConfig(base({ keyMap: new Map([["ap-northeast-1", "k1"], ["eu-west-1", "   "]]) })),
    /empty API key.*eu-west-1/i
  );
});

test("loadConfig takes homeRegion and regions from the mapping", () => {
  const mapping = { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" };
  const cfg = loadConfig({ LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d" }, mapping);
  assert.strictEqual(cfg.homeRegion, "us-east-1");
  assert.strictEqual(cfg.routingEnabled, false);
  assert.deepStrictEqual([...cfg.enabledRegions], ["us-east-1"]);
});

test("loadConfig ignores any HOME_REGION / ENABLED_REGIONS env (mapping is source of truth)", () => {
  const mapping = { regions: new Set(["eu-west-1", "us-east-1"]), homeRegion: "eu-west-1" };
  const cfg = loadConfig(
    {
      HOME_REGION: "this-is-ignored",
      ENABLED_REGIONS: "this-is-ignored",
      LOCATION_API_KEYS: '{"eu-west-1":"k1","us-east-1":"k2"}',
      MAP_TILE_DOMAIN: "d",
    },
    mapping
  );
  assert.strictEqual(cfg.homeRegion, "eu-west-1");
  assert.strictEqual(cfg.enabledRegions.size, 2);
  assert.ok(!cfg.enabledRegions.has("this-is-ignored"));
});

test("loadConfig throws when MAP_TILE_DOMAIN missing", () => {
  assert.throws(
    () => loadConfig({ LOCATION_API_KEYS: '{"us-east-1":"k"}' }, { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" }),
    /MAP_TILE_DOMAIN/
  );
});

test("loadConfig defaults: no CORS origins (same-origin) and 10/s burst 20", () => {
  const cfg = loadConfig(
    { LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d" },
    { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" }
  );
  assert.deepStrictEqual(cfg.allowedOrigins, []);
  assert.strictEqual(cfg.rateLimit.ratePerSec, 10);
  assert.strictEqual(cfg.rateLimit.burst, 20);
  assert.strictEqual(cfg.reverseGeoCacheMax, 200_000);
});

test("loadConfig reads REVERSE_GEO_CACHE_MAX override", () => {
  const cfg = loadConfig(
    { LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d", REVERSE_GEO_CACHE_MAX: "50000" },
    { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" }
  );
  assert.strictEqual(cfg.reverseGeoCacheMax, 50000);
});

test("loadConfig trustProxy: numeric hop count, boolean, or default true", () => {
  const mk = (env) =>
    loadConfig(
      { LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d", ...env },
      { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" }
    );
  // Numeric string → number (CloudFront+ALB = 2 hops; unspoofable client IP).
  assert.strictEqual(mk({ TRUST_PROXY: "2" }).trustProxy, 2);
  // "false" → boolean false (direct, no proxy).
  assert.strictEqual(mk({ TRUST_PROXY: "false" }).trustProxy, false);
  // "true" → boolean true.
  assert.strictEqual(mk({ TRUST_PROXY: "true" }).trustProxy, true);
  // unset → default true (works out of the box locally).
  assert.strictEqual(mk({}).trustProxy, true);
});

test("loadConfig trustProxy: an UNRECOGNIZED value degrades to false (fail safe), not true", () => {
  // A typo like "tw" must NOT silently become `true` — that would trust every
  // proxy hop and make the rate-limiter's client IP spoofable. Fail safe to
  // `false` (ALB IP → limiter stricter, but IP unspoofable) and warn.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const cfg = loadConfig(
      { LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d", TRUST_PROXY: "tw" },
      { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" }
    );
    assert.strictEqual(cfg.trustProxy, false);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warnings.some((w) => /TRUST_PROXY/.test(w) && /tw/.test(w)),
    `expected a warning naming the bad value; got: ${JSON.stringify(warnings)}`
  );
});

test("loadConfig reads ALLOWED_ORIGINS and API rate env overrides", () => {
  const cfg = loadConfig(
    {
      LOCATION_API_KEYS: '{"us-east-1":"k"}',
      MAP_TILE_DOMAIN: "d",
      ALLOWED_ORIGINS: "https://a.com, https://b.com",
      API_RATE_PER_SEC: "25",
      API_RATE_BURST: "50",
    },
    { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" }
  );
  assert.deepStrictEqual(cfg.allowedOrigins, ["https://a.com", "https://b.com"]);
  assert.strictEqual(cfg.rateLimit.ratePerSec, 25);
  assert.strictEqual(cfg.rateLimit.burst, 50);
});

test("loadConfig parses MULTI_REGION_ROUTING=true", () => {
  const cfg = loadConfig(
    {
      MULTI_REGION_ROUTING: "true",
      LOCATION_API_KEYS: '{"ap-northeast-1":"k"}',
      MAP_TILE_DOMAIN: "d",
    },
    { regions: new Set(["ap-northeast-1"]), homeRegion: "ap-northeast-1" }
  );
  assert.strictEqual(cfg.routingEnabled, true);
});
