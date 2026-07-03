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

test("rejects HOME_REGION not ALS-supported", () => {
  assert.throws(
    () => validateConfig(base({ homeRegion: "mars-1", enabledRegions: new Set(["mars-1", "eu-west-1"]) })),
    /HOME_REGION.*ALS/
  );
});

test("routing ON rejects GrabMaps HOME_REGION", () => {
  assert.throws(
    () =>
      validateConfig(
        base({
          homeRegion: "ap-southeast-1",
          enabledRegions: new Set(["ap-southeast-1", "eu-west-1"]),
          keyMap: new Map([["ap-southeast-1", "k"], ["eu-west-1", "k2"]]),
        })
      ),
    /HOME_REGION.*GrabMaps/
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
