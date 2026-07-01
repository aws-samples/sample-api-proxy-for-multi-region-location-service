const { test } = require("node:test");
const assert = require("node:assert");
const { parseKeyMap } = require("../src/keyMap");

test("parses region->key JSON into a Map", () => {
  const km = parseKeyMap('{"ap-northeast-1":"v1.public.aaa","eu-west-1":"v1.public.bbb"}');
  assert.strictEqual(km.get("ap-northeast-1"), "v1.public.aaa");
  assert.strictEqual(km.get("eu-west-1"), "v1.public.bbb");
});

test("throws on invalid JSON", () => {
  assert.throws(() => parseKeyMap("not json"), /LOCATION_API_KEYS.*JSON/);
});

test("throws on empty/undefined", () => {
  assert.throws(() => parseKeyMap(undefined), /LOCATION_API_KEYS.*not set/);
});
