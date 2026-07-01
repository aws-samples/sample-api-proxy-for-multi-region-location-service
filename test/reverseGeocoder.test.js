const { test } = require("node:test");
const assert = require("node:assert");
const { gridKey, createReverseGeocoder } = require("../src/reverseGeocoder");

test("gridKey truncates to 1 decimal place", () => {
  assert.strictEqual(gridKey(52.567, 13.412), "52.5,13.4");
  assert.strictEqual(gridKey(-0.04, -0.09), "0.0,0.0"); // -0.0 normalized
});

test("caches by grid: same grid calls underlying once", async () => {
  let calls = 0;
  const rg = createReverseGeocoder({
    homeRegion: "ap-northeast-1",
    getKey: () => "k1",
    reverseGeocodeCountry: async () => {
      calls++;
      return "JP";
    },
  });
  const a = await rg.toCountry(35.68, 139.76);
  const b = await rg.toCountry(35.69, 139.79); // same 35.6,139.7 grid
  assert.strictEqual(a, "JP");
  assert.strictEqual(b, "JP");
  assert.strictEqual(calls, 1);
});

test("passes homeRegion and its key to the underlying call", async () => {
  const seen = {};
  const rg = createReverseGeocoder({
    homeRegion: "ap-northeast-1",
    getKey: (r) => (r === "ap-northeast-1" ? "k1" : "x"),
    reverseGeocodeCountry: async (args) => {
      Object.assign(seen, args);
      return "JP";
    },
  });
  await rg.toCountry(35.6, 139.7);
  assert.strictEqual(seen.region, "ap-northeast-1");
  assert.strictEqual(seen.key, "k1");
});
