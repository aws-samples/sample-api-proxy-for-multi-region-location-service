const { test } = require("node:test");
const assert = require("node:assert");
const { regionCenter, REGION_CENTERS } = require("../config/region-centers");

test("returns center [lng, lat] and zoom for a known region", () => {
  const c = regionCenter("ap-southeast-1");
  assert.ok(Array.isArray(c.center) && c.center.length === 2);
  assert.strictEqual(typeof c.zoom, "number");
  // ap-southeast-1 (GrabMaps) should be over Singapore, not [0,0]
  const [lng, lat] = c.center;
  assert.ok(lng > 100 && lng < 105, `lng ${lng} should be near Singapore`);
  assert.ok(lat > -1 && lat < 3, `lat ${lat} should be near Singapore`);
});

test("known ALS regions all have an entry", () => {
  for (const r of ["us-east-1", "ap-northeast-1", "ap-southeast-1", "eu-central-1", "sa-east-1"]) {
    assert.ok(REGION_CENTERS[r], `${r} should have a center`);
  }
});

test("centers are [lng, lat] order (lng first)", () => {
  // ap-northeast-1 = Tokyo ≈ [139.7, 35.7]: lng ~140 (not lat ~35 first)
  const [lng, lat] = regionCenter("ap-northeast-1").center;
  assert.ok(lng > 135 && lng < 145, `lng ${lng} should be ~140 (Tokyo)`);
  assert.ok(lat > 30 && lat < 40, `lat ${lat} should be ~35 (Tokyo)`);
});

test("unknown region falls back to a neutral world view", () => {
  const c = regionCenter("mars-1");
  assert.deepStrictEqual(c.center, [0, 0]);
  assert.strictEqual(c.zoom, 1);
});
