const { test } = require("node:test");
const assert = require("node:assert");
const { buildApp } = require("../server");

function fakeDeps() {
  return {
    config: {
      homeRegion: "ap-northeast-1",
      routingEnabled: true,
      enabledRegions: new Set(["ap-northeast-1", "eu-west-1"]),
      keyMap: new Map([["ap-northeast-1", "k1"], ["eu-west-1", "k2"]]),
      mapTileDomain: "d1.cloudfront.net",
    },
    mappingStore: { getRegion: (cc) => (cc === "DE" ? "eu-west-1" : null) },
    als: {
      suggest: async () => ({ ResultItems: [] }),
      getPlace: async () => ({}),
      getStyleDescriptor: async () => ({ sources: {} }),
      reverseGeocodeCountry: async () => "JP",
      rewriteStyle: (s) => s,
    },
    reverseGeocoder: { toCountry: async () => "JP" },
    availableStyles: [{ id: "Standard", label: "标准" }],
  };
}

test("buildApp returns an express app without throwing", () => {
  const app = buildApp(fakeDeps());
  assert.strictEqual(typeof app.listen, "function");
});

test("map-config returns region-prefixed tile base for home region", async () => {
  const app = buildApp(fakeDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-config`);
  const body = await res.json();
  server.close();
  assert.strictEqual(body.tileBaseUrl, "https://d1.cloudfront.net/ap-northeast-1");
});

test("map-style returns 400 for a disallowed style", async () => {
  const app = buildApp(fakeDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-style?style=Bogus`);
  server.close();
  assert.strictEqual(res.status, 400);
});

test("suggest resolves region and maps Place results", async () => {
  const deps = fakeDeps();
  deps.als.suggest = async ({ region, key }) => ({
    ResultItems: [
      { SuggestResultItemType: "Place", Title: "Tokyo Tower", Place: { PlaceId: "p1", Position: [139.7, 35.6], Address: {} } },
      { SuggestResultItemType: "Query" }, // should be filtered out
    ],
    _region: region, _key: key,
  });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=tokyo&countryCode=DE`);
  const body = await res.json();
  server.close();
  assert.strictEqual(body.length, 1);
  assert.strictEqual(body[0].placeId, "p1");
  assert.strictEqual(body[0].text, "Tokyo Tower");
});
