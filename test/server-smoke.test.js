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
  // Each item carries the region that produced it (DE → eu-west-1), so the
  // frontend can resolve the region-scoped PlaceId via /api/place.
  assert.strictEqual(body[0].region, "eu-west-1");
});

test("suggest with countryCode passes includeCountries (hard filter)", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => {
    seen = args;
    return { ResultItems: [] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/suggest?query=airport&countryCode=DE`);
  server.close();
  assert.strictEqual(seen.region, "eu-west-1"); // DE → eu-west-1
  assert.deepStrictEqual(seen.includeCountries, ["DE"]);
});

test("suggest uses real lat/lng as bias when provided", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => {
    seen = args;
    return { ResultItems: [] };
  };
  // reverse-geo of these coords → JP → home region (ap-northeast-1) in fakeDeps
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&lat=35.6&lng=139.7`);
  server.close();
  // bias must be the real coords, not the region center
  assert.strictEqual(Number(seen.lat), 35.6);
  assert.strictEqual(Number(seen.lng), 139.7);
});

test("suggest forwards lang to als", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => {
    seen = args;
    return { ResultItems: [] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE&lang=de`);
  server.close();
  assert.strictEqual(seen.lang, "de");
});

test("place uses the explicit ?region param (region-scoped PlaceId)", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.getPlace = async (args) => {
    seen = args;
    return { Title: "x", Position: [103.8, 1.35], Address: {} };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  // No countryCode/lat/lng → resolver would fall back to home (ap-northeast-1);
  // the explicit ?region=eu-west-1 must win instead.
  await fetch(`http://127.0.0.1:${port}/api/place/PID?region=eu-west-1`);
  server.close();
  assert.strictEqual(seen.region, "eu-west-1");
  assert.strictEqual(seen.placeId, "PID");
});

test("place ignores an out-of-set ?region and falls back to resolution", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.getPlace = async (args) => {
    seen = args;
    return { Title: "x", Position: [0, 0], Address: {} };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  // bogus region not in enabledRegions → ignored → resolver falls back to home.
  await fetch(`http://127.0.0.1:${port}/api/place/PID?region=mars-1`);
  server.close();
  assert.strictEqual(seen.region, "ap-northeast-1"); // home fallback
});

test("explicit countryCode wins: bias uses region center, not a stray lat/lng", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => {
    seen = args;
    return { ResultItems: [] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  // countryCode=DE is authoritative → region eu-west-1; a stray far-off lat/lng
  // must be ignored for bias (country wins).
  await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE&lat=0&lng=149.8`);
  server.close();
  // eu-west-1 center is Dublin ≈ [-6.26, 53.35]; bias must be that, not [149.8, 0].
  assert.strictEqual(seen.region, "eu-west-1");
  assert.ok(seen.lng < 0 && seen.lat > 50, `bias should be Dublin, got lng=${seen.lng} lat=${seen.lat}`);
});

test("map-config returns the home region's center and zoom", async () => {
  const app = buildApp(fakeDeps()); // home = ap-northeast-1 (Tokyo)
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-config`);
  const body = await res.json();
  server.close();
  assert.ok(Array.isArray(body.center) && body.center.length === 2);
  assert.strictEqual(typeof body.zoom, "number");
  // Tokyo ≈ [139.77, 35.68]
  assert.ok(body.center[0] > 135 && body.center[0] < 145, `lng ${body.center[0]} should be ~140`);
  // includes the home region so the frontend knows the initial tile region
  assert.strictEqual(body.region, "ap-northeast-1");
});

test("map-style accepts an explicit ?region param", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.getStyleDescriptor = async (args) => {
    seen = args;
    return { sources: {} };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/map-style?style=Standard&region=eu-west-1`);
  server.close();
  assert.strictEqual(seen.region, "eu-west-1");
});
