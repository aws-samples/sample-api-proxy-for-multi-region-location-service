const { test } = require("node:test");
const assert = require("node:assert");
const { ALS_SUPPORTED_REGIONS, GRABMAPS_REGIONS } = require("../config/als-regions");

test("ALS supported regions include common ones", () => {
  assert.ok(ALS_SUPPORTED_REGIONS.has("us-east-1"));
  assert.ok(ALS_SUPPORTED_REGIONS.has("ap-northeast-1"));
  assert.ok(ALS_SUPPORTED_REGIONS.has("eu-west-1"));
});

test("GrabMaps regions are flagged and are a subset of supported", () => {
  assert.ok(GRABMAPS_REGIONS.has("ap-southeast-1"));
  for (const r of GRABMAPS_REGIONS) {
    assert.ok(ALS_SUPPORTED_REGIONS.has(r), `${r} must be in supported set`);
  }
});
