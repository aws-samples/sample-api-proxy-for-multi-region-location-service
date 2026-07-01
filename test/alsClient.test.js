const { test } = require("node:test");
const assert = require("node:assert");
const { createAlsClient } = require("../src/alsClient");

// fake fetch that records the URL and returns a canned JSON body
function fakeFetch(captured, body) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return { json: async () => body };
  };
}

test("reverseGeocodeCountry hits the region's places endpoint and reads Code2", async () => {
  const captured = {};
  const body = { ResultItems: [{ Address: { Country: { Code2: "DE" } } }] };
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, body) });
  const cc = await als.reverseGeocodeCountry({ region: "eu-west-1", key: "k2", lat: 52.5, lng: 13.4 });
  assert.strictEqual(cc, "DE");
  assert.match(captured.url, /places\.geo\.eu-west-1\.amazonaws\.com\/v2\/reverse-geocode/);
  assert.match(captured.url, /key=k2/);
  assert.deepStrictEqual(JSON.parse(captured.opts.body).QueryPosition, [13.4, 52.5]);
});

test("reverseGeocodeCountry returns null when no result", async () => {
  const als = createAlsClient({ fetchImpl: fakeFetch({}, { ResultItems: [] }) });
  const cc = await als.reverseGeocodeCountry({ region: "us-east-1", key: "k", lat: 0, lng: 0 });
  assert.strictEqual(cc, null);
});

test("suggest hits the region's places endpoint", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { ResultItems: [] }) });
  await als.suggest({ region: "ap-northeast-1", key: "k1", query: "tokyo" });
  assert.match(captured.url, /places\.geo\.ap-northeast-1\.amazonaws\.com\/v2\/suggest/);
});

test("rewriteStyle replaces region origin with CloudFront region-prefixed path and strips key", () => {
  const als = createAlsClient({ fetchImpl: async () => ({}) });
  const style = {
    sources: { m: { tiles: ["https://maps.geo.eu-west-1.amazonaws.com/v2/tiles/{z}/{x}/{y}?key=SECRET"] } },
    glyphs: "https://maps.geo.eu-west-1.amazonaws.com/v2/glyphs/{f}/{r}?key=SECRET",
    sprite: "https://maps.geo.eu-west-1.amazonaws.com/v2/sprites/x?key=SECRET",
    layers: [{ id: "a", paint: { "x": null, "y": 1 } }],
  };
  const out = als.rewriteStyle(style, { region: "eu-west-1", mapTileDomain: "d1.cloudfront.net" });
  assert.strictEqual(out.sources.m.tiles[0], "https://d1.cloudfront.net/eu-west-1/v2/tiles/{z}/{x}/{y}");
  assert.strictEqual(out.glyphs, "https://d1.cloudfront.net/eu-west-1/v2/glyphs/{f}/{r}");
  assert.strictEqual(out.sprite, "https://d1.cloudfront.net/eu-west-1/v2/sprites/x");
  assert.deepStrictEqual(out.layers[0].paint, { y: 1 });
});
