const { test } = require("node:test");
const assert = require("node:assert");
const { invertMapping } = require("../src/mappingStore");

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
