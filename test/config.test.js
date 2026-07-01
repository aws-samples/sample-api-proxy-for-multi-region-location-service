const { test } = require("node:test");
const assert = require("node:assert");
const { validateConfig } = require("../src/config");

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
