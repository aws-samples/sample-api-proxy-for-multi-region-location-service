const { test } = require("node:test");
const assert = require("node:assert");
const { validateConfig, loadConfig } = require("../src/config");

function base(overrides = {}) {
  return {
    homeRegion: "ap-northeast-1",
    routingEnabled: true,
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
  assert.throws(() => validateConfig(base({ homeRegion: "mars-1" })), /HOME_REGION.*ALS/);
});

test("routing ON rejects GrabMaps HOME_REGION", () => {
  assert.throws(
    () => validateConfig(base({ homeRegion: "ap-southeast-1", enabledRegions: new Set(["ap-southeast-1", "eu-west-1"]), keyMap: new Map([["ap-southeast-1","k"],["eu-west-1","k2"]]) })),
    /HOME_REGION.*GrabMaps/
  );
});

test("routing OFF allows GrabMaps HOME_REGION", () => {
  assert.doesNotThrow(() =>
    validateConfig(base({
      routingEnabled: false,
      homeRegion: "ap-southeast-1",
      enabledRegions: new Set(["ap-southeast-1"]),
      keyMap: new Map([["ap-southeast-1", "k"]]),
    }))
  );
});

test("rejects enabled region missing a key", () => {
  assert.throws(
    () => validateConfig(base({ keyMap: new Map([["ap-northeast-1", "k1"]]) })),
    /missing API key.*eu-west-1/
  );
});

test("rejects HOME_REGION missing a key", () => {
  assert.throws(
    () => validateConfig(base({
      homeRegion: "ap-northeast-1",
      keyMap: new Map([["eu-west-1", "k2"]]),
      enabledRegions: new Set(["eu-west-1"]),
    })),
    /missing API key.*ap-northeast-1/
  );
});

test("loadConfig parses env with defaults", () => {
  const cfg = loadConfig({ LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d" });
  assert.strictEqual(cfg.homeRegion, "us-east-1");
  assert.strictEqual(cfg.routingEnabled, false);
  assert.ok(cfg.enabledRegions.has("us-east-1"));
});

test("loadConfig trims and filters ENABLED_REGIONS", () => {
  const cfg = loadConfig({
    HOME_REGION: "eu-west-1",
    ENABLED_REGIONS: "eu-west-1, us-east-1, ",
    LOCATION_API_KEYS: '{"eu-west-1":"k1","us-east-1":"k2"}',
    MAP_TILE_DOMAIN: "d",
  });
  assert.strictEqual(cfg.enabledRegions.size, 2);
  assert.ok(cfg.enabledRegions.has("us-east-1"));
});

test("loadConfig throws when MAP_TILE_DOMAIN missing", () => {
  assert.throws(() => loadConfig({ LOCATION_API_KEYS: '{"us-east-1":"k"}' }), /MAP_TILE_DOMAIN/);
});

test("loadConfig parses MULTI_REGION_ROUTING=true", () => {
  const cfg = loadConfig({
    HOME_REGION: "ap-northeast-1",
    MULTI_REGION_ROUTING: "true",
    ENABLED_REGIONS: "ap-northeast-1",
    LOCATION_API_KEYS: '{"ap-northeast-1":"k"}',
    MAP_TILE_DOMAIN: "d",
  });
  assert.strictEqual(cfg.routingEnabled, true);
});
