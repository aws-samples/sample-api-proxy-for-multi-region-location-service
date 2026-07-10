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

test("degrades to null when the underlying reverse-geocode throws", async () => {
  // reverse-geocode is a best-effort routing guess; an ALS error must degrade
  // to null (→ caller falls back to home region), not crash the request.
  const rg = createReverseGeocoder({
    homeRegion: "ap-northeast-1",
    getKey: () => "k1",
    reverseGeocodeCountry: async () => {
      throw new Error("ALS 403");
    },
  });
  const cc = await rg.toCountry(35.6, 139.7);
  assert.strictEqual(cc, null);
});

test("does NOT cache a thrown failure (transient errors must be retryable)", async () => {
  let calls = 0;
  const rg = createReverseGeocoder({
    homeRegion: "ap-northeast-1",
    getKey: () => "k1",
    reverseGeocodeCountry: async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return "JP";
    },
  });
  const first = await rg.toCountry(35.6, 139.7); // throws inside → null, not cached
  const second = await rg.toCountry(35.62, 139.72); // same grid, retried → JP
  assert.strictEqual(first, null);
  assert.strictEqual(second, "JP");
  assert.strictEqual(calls, 2);
});

test("cache is bounded (FIFO): stays at maxSize, evicts the oldest entry", async () => {
  let calls = 0;
  const rg = createReverseGeocoder({
    homeRegion: "ap-northeast-1",
    getKey: () => "k1",
    reverseGeocodeCountry: async () => { calls++; return "JP"; },
    maxSize: 3,
  });
  // Fill 3 distinct grid cells (0.1° apart so keys differ).
  await rg.toCountry(0.0, 0.0);
  await rg.toCountry(0.0, 0.2);
  await rg.toCountry(0.0, 0.4);
  assert.strictEqual(rg.cacheSize(), 3);
  assert.strictEqual(calls, 3);

  // A 4th distinct cell evicts the oldest (0,0); still capped at 3.
  await rg.toCountry(0.0, 0.6);
  assert.strictEqual(rg.cacheSize(), 3);
  assert.strictEqual(calls, 4);

  // (0,0) was evicted → a repeat re-fetches (miss); (0,0.6) is still cached (hit).
  await rg.toCountry(0.0, 0.0);
  assert.strictEqual(calls, 5, "evicted oldest cell should miss and re-fetch");
  await rg.toCountry(0.0, 0.6);
  assert.strictEqual(calls, 5, "most-recent cell should still be a cache hit");
});

test("a cache hit does not count toward eviction growth", async () => {
  let calls = 0;
  const rg = createReverseGeocoder({
    homeRegion: "ap-northeast-1",
    getKey: () => "k1",
    reverseGeocodeCountry: async () => { calls++; return "JP"; },
    maxSize: 2,
  });
  await rg.toCountry(0.0, 0.0);
  await rg.toCountry(0.0, 0.0); // hit, no new entry
  await rg.toCountry(0.0, 0.0); // hit
  assert.strictEqual(rg.cacheSize(), 1);
  assert.strictEqual(calls, 1);
});
