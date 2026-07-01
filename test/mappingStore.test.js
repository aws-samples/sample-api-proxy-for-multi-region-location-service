const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { invertMapping, createMappingStore, loadMapping } = require("../src/mappingStore");

// The example mapping is the tracked, stable fixture (the real
// country-region-map.json is gitignored and environment-specific).
const EXAMPLE_MAP = path.join(__dirname, "..", "config", "country-region-map-example.json");
const EXAMPLE_REGIONS = new Set([
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "eu-central-1",
  "us-east-1",
  "sa-east-1",
]);

const enabled = new Set(["ap-northeast-1", "eu-west-1"]);

test("inverts region-first map to country->region (upper-cased keys)", () => {
  const m = invertMapping({ "ap-northeast-1": ["jp", "KR"], "eu-west-1": ["DE"] }, enabled);
  assert.strictEqual(m.get("JP"), "ap-northeast-1");
  assert.strictEqual(m.get("KR"), "ap-northeast-1");
  assert.strictEqual(m.get("DE"), "eu-west-1");
});

test("rejects region not in ENABLED_REGIONS", () => {
  assert.throws(
    () => invertMapping({ "us-east-1": ["US"] }, enabled),
    /us-east-1.*ENABLED_REGIONS/
  );
});

test("rejects duplicate country across regions", () => {
  assert.throws(
    () => invertMapping({ "ap-northeast-1": ["JP"], "eu-west-1": ["JP"] }, enabled),
    /duplicate country.*JP/i
  );
});

test("createMappingStore reads the example config and looks up regions", () => {
  const store = createMappingStore(EXAMPLE_MAP, EXAMPLE_REGIONS);
  assert.strictEqual(store.getRegion("jp"), "ap-northeast-1");
  assert.strictEqual(store.getRegion("US"), "us-east-1");
  assert.strictEqual(store.getRegion("DE"), "eu-central-1");
  assert.strictEqual(store.getRegion(undefined), null);
  assert.strictEqual(store.getRegion("ZZ"), null);
  assert.ok(store.size > 0);
});

test("example mapping is internally valid (no duplicate countries, regions enabled)", () => {
  // loadMapping throws on any duplicate country or non-enabled/non-ALS region.
  assert.doesNotThrow(() => loadMapping(EXAMPLE_MAP, EXAMPLE_REGIONS));
});

test("rejects region not in ALS-supported set", () => {
  assert.throws(
    () => invertMapping({ "mars-1": ["US"] }, new Set(["mars-1"])),
    /not an ALS-supported region/
  );
});

test("missing mapping file yields a friendly error pointing to the example", () => {
  assert.throws(
    () => loadMapping(path.join(__dirname, "..", "config", "does-not-exist.json"), EXAMPLE_REGIONS),
    /not found.*cp config\/country-region-map-example\.json/s
  );
});
