const { test } = require("node:test");
const assert = require("node:assert");
const { validateConfig, loadConfig } = require("../src/config");

function base(overrides = {}) {
  return {
    homeRegion: "ap-northeast-1",
    routingEnabled: true,
    // enabledRegions now comes from the mapping file's keys.
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

test("rejects HOME_REGION not present in the mapping regions", () => {
  assert.throws(
    () => validateConfig(base({ homeRegion: "us-east-1" })), // us-east-1 not in {ap-northeast-1, eu-west-1}
    /HOME_REGION.*mapping/i
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

test("loadConfig derives enabledRegions from the passed mapping regions", () => {
  const regions = new Set(["us-east-1"]);
  const cfg = loadConfig({ LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d" }, regions);
  assert.strictEqual(cfg.homeRegion, "us-east-1");
  assert.strictEqual(cfg.routingEnabled, false);
  assert.deepStrictEqual([...cfg.enabledRegions], ["us-east-1"]);
});

test("loadConfig uses mapping regions, ignoring any ENABLED_REGIONS env", () => {
  const regions = new Set(["eu-west-1", "us-east-1"]);
  const cfg = loadConfig(
    {
      HOME_REGION: "eu-west-1",
      ENABLED_REGIONS: "this-should-be-ignored", // env var no longer consulted
      LOCATION_API_KEYS: '{"eu-west-1":"k1","us-east-1":"k2"}',
      MAP_TILE_DOMAIN: "d",
    },
    regions
  );
  assert.strictEqual(cfg.enabledRegions.size, 2);
  assert.ok(cfg.enabledRegions.has("us-east-1"));
  assert.ok(!cfg.enabledRegions.has("this-should-be-ignored"));
});

test("loadConfig throws when MAP_TILE_DOMAIN missing", () => {
  assert.throws(
    () => loadConfig({ LOCATION_API_KEYS: '{"us-east-1":"k"}' }, new Set(["us-east-1"])),
    /MAP_TILE_DOMAIN/
  );
});

test("loadConfig parses MULTI_REGION_ROUTING=true", () => {
  const cfg = loadConfig(
    {
      HOME_REGION: "ap-northeast-1",
      MULTI_REGION_ROUTING: "true",
      LOCATION_API_KEYS: '{"ap-northeast-1":"k"}',
      MAP_TILE_DOMAIN: "d",
    },
    new Set(["ap-northeast-1"])
  );
  assert.strictEqual(cfg.routingEnabled, true);
});
