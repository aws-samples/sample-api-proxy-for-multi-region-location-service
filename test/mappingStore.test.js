const { test } = require("node:test");
const assert = require("node:assert");
const { invertMapping, createMappingStore } = require("../src/mappingStore");

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

test("createMappingStore reads the real config and looks up regions", () => {
  const store = createMappingStore(
    require("path").join(__dirname, "..", "config", "country-region-map.json"),
    new Set(["ap-southeast-1", "ap-northeast-1", "ap-south-1", "eu-west-1", "us-east-1"])
  );
  assert.strictEqual(store.getRegion("jp"), "ap-northeast-1");
  assert.strictEqual(store.getRegion("US"), "us-east-1");
  assert.strictEqual(store.getRegion(undefined), null);
  assert.strictEqual(store.getRegion("ZZ"), null);
  assert.strictEqual(store.size, 33);
});

test("rejects region not in ALS-supported set", () => {
  assert.throws(
    () => invertMapping({ "mars-1": ["US"] }, new Set(["mars-1"])),
    /not an ALS-supported region/
  );
});
