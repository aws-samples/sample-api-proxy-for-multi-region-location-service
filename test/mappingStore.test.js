const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { invertMapping, createMappingStore, loadMapping } = require("../src/mappingStore");

// The example mapping is the tracked, stable fixture (the real
// country-region-map.json is gitignored and environment-specific).
const EXAMPLE_MAP = path.join(__dirname, "..", "config", "country-region-map-example.json");

test("inverts region-first map to country->region (upper-cased keys)", () => {
  const { map } = invertMapping({ "ap-northeast-1": ["jp", "KR"], "eu-west-1": ["DE"] });
  assert.strictEqual(map.get("JP"), "ap-northeast-1");
  assert.strictEqual(map.get("KR"), "ap-northeast-1");
  assert.strictEqual(map.get("DE"), "eu-west-1");
});

test("region set is derived from the mapping keys", () => {
  const { regions } = invertMapping({ "ap-northeast-1": [], "eu-west-1": ["DE"] });
  assert.deepStrictEqual([...regions].sort(), ["ap-northeast-1", "eu-west-1"]);
});

test("empty [] entry is allowed (region is a fallback/guide only, no country binding)", () => {
  const { map, regions } = invertMapping({ "ap-northeast-1": [], "eu-central-1": ["DE"] });
  assert.strictEqual(map.get("DE"), "eu-central-1");
  assert.strictEqual(map.get("XX"), undefined); // ap-northeast-1 binds no country
  assert.ok(regions.has("ap-northeast-1")); // but it is still in the region set
});

test("rejects duplicate country across regions", () => {
  assert.throws(
    () => invertMapping({ "ap-northeast-1": ["JP"], "eu-west-1": ["JP"] }),
    /duplicate country.*JP/i
  );
});

test("rejects region not in ALS-supported set", () => {
  assert.throws(
    () => invertMapping({ "mars-1": ["US"] }),
    /not an ALS-supported region/
  );
});

test("createMappingStore reads the example config and looks up regions", () => {
  const store = createMappingStore(EXAMPLE_MAP);
  assert.strictEqual(store.getRegion("jp"), "ap-northeast-1");
  assert.strictEqual(store.getRegion("US"), "us-east-1");
  assert.strictEqual(store.getRegion("DE"), "eu-central-1");
  assert.strictEqual(store.getRegion(undefined), null);
  assert.strictEqual(store.getRegion("ZZ"), null);
  assert.ok(store.size > 0);
});

test("createMappingStore exposes the region set from the file keys", () => {
  const store = createMappingStore(EXAMPLE_MAP);
  assert.ok(store.regions.has("ap-northeast-1"));
  assert.ok(store.regions.has("eu-central-1"));
  assert.ok(store.regions.has("sa-east-1"));
});

test("example mapping is internally valid (no duplicate countries, ALS regions)", () => {
  assert.doesNotThrow(() => loadMapping(EXAMPLE_MAP));
});

test("missing mapping file yields a friendly error pointing to the example", () => {
  assert.throws(
    () => loadMapping(path.join(__dirname, "..", "config", "does-not-exist.json")),
    /not found.*cp config\/country-region-map-example\.json/s
  );
});
