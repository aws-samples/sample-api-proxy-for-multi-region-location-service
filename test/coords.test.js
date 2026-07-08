const { test } = require("node:test");
const assert = require("node:assert");
const { parseCoords } = require("../src/coords");

test("both absent → valid, no coords (not an error)", () => {
  assert.deepStrictEqual(parseCoords(undefined, undefined), { valid: true, lat: null, lng: null });
});

test("empty strings are treated as absent (common empty-param case)", () => {
  assert.deepStrictEqual(parseCoords("", ""), { valid: true, lat: null, lng: null });
});

test("both present and valid → parsed numbers", () => {
  assert.deepStrictEqual(parseCoords("1.35", "103.82"), { valid: true, lat: 1.35, lng: 103.82 });
});

test("negative and zero coords are valid", () => {
  assert.deepStrictEqual(parseCoords("0", "-0"), { valid: true, lat: 0, lng: -0 });
  assert.deepStrictEqual(parseCoords("-33.87", "151.21"), { valid: true, lat: -33.87, lng: 151.21 });
});

test("non-numeric coord → invalid (NaN must never reach ALS)", () => {
  assert.strictEqual(parseCoords("abc", "103.82").valid, false);
  assert.strictEqual(parseCoords("1.35", "xyz").valid, false);
});

test("empty string paired with a value → invalid (both or neither)", () => {
  assert.strictEqual(parseCoords("1.35", "").valid, false);
  assert.strictEqual(parseCoords("", "103.82").valid, false);
});

test("out-of-range coords → invalid", () => {
  assert.strictEqual(parseCoords("91", "0").valid, false); // lat > 90
  assert.strictEqual(parseCoords("-91", "0").valid, false); // lat < -90
  assert.strictEqual(parseCoords("0", "181").valid, false); // lng > 180
  assert.strictEqual(parseCoords("0", "-181").valid, false); // lng < -180
});

test("boundary coords are valid", () => {
  assert.strictEqual(parseCoords("90", "180").valid, true);
  assert.strictEqual(parseCoords("-90", "-180").valid, true);
});

test("invalid result carries an error message", () => {
  const r = parseCoords("abc", "1");
  assert.strictEqual(r.valid, false);
  assert.ok(typeof r.error === "string" && r.error.length > 0);
});
