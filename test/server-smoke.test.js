const { test } = require("node:test");
const assert = require("node:assert");
const { buildApp, detectStyles } = require("../server");

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
    availableStyles: ["Standard"],
  };
}

test("buildApp returns an express app without throwing", () => {
  const app = buildApp(fakeDeps());
  assert.strictEqual(typeof app.listen, "function");
});

test("favicon.ico returns 204 (no console 404 noise)", async () => {
  const app = buildApp(fakeDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
  server.close();
  assert.strictEqual(res.status, 204);
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

test("place returns tileRegion = the result country's mapped region", async () => {
  const deps = fakeDeps(); // mapping: DE → eu-west-1, else null; home ap-northeast-1
  deps.als.getPlace = async () => ({
    Title: "Berlin", Position: [13.4, 52.5], Address: { Country: { Code2: "DE" } },
  });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/place/PID?region=eu-west-1`);
  const body = await res.json();
  server.close();
  assert.strictEqual(body.tileRegion, "eu-west-1"); // DE → eu-west-1
});

test("place tileRegion falls back to home when country is unmapped", async () => {
  const deps = fakeDeps();
  deps.als.getPlace = async () => ({
    Title: "x", Position: [0, 0], Address: { Country: { Code2: "ZZ" } }, // unmapped
  });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/place/PID?region=eu-west-1`);
  const body = await res.json();
  server.close();
  assert.strictEqual(body.tileRegion, "ap-northeast-1"); // home fallback
});

test("tile-region resolves a coordinate to its country's region", async () => {
  const deps = fakeDeps();
  // reverseGeocoder.toCountry returns JP in fakeDeps; map JP → home here
  deps.mappingStore.getRegion = (cc) => (cc === "JP" ? "ap-northeast-1" : cc === "SG" ? "ap-southeast-1" : null);
  deps.reverseGeocoder.toCountry = async () => "SG";
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/tile-region?lat=1.35&lng=103.8`);
  const body = await res.json();
  server.close();
  assert.strictEqual(body.tileRegion, "ap-southeast-1");
  assert.strictEqual(body.country, "SG"); // for context backfill
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

// --- detectStyles: a transient ALS blip at boot must not leave a "healthy"
// task that serves zero styles (empty switcher + 400 on every map-style). ---

const detectConfig = { homeRegion: "ap-northeast-1", keyMap: new Map([["ap-northeast-1", "k1"]]) };

test("detectStyles returns the styles that exist", async () => {
  const als = { styleExists: async ({ styleName }) => styleName === "Standard" || styleName === "Hybrid" };
  const styles = await detectStyles(als, detectConfig);
  assert.deepStrictEqual(styles.sort(), ["Hybrid", "Standard"]);
});

test("detectStyles tolerates a single style's probe throwing", async () => {
  const als = {
    styleExists: async ({ styleName }) => {
      if (styleName === "Monochrome") throw new Error("flaky");
      return true; // the other three exist
    },
  };
  const styles = await detectStyles(als, detectConfig);
  assert.ok(styles.includes("Standard"));
  assert.ok(!styles.includes("Monochrome"));
  assert.strictEqual(styles.length, 3);
});

test("detectStyles throws when NO style resolves (fail fast so ECS replaces the task)", async () => {
  // e.g. ALS briefly unreachable at boot → every probe fails. Returning [] would
  // leave a task that passes /health but can never render a map.
  const als = { styleExists: async () => { throw new Error("ALS unreachable"); } };
  await assert.rejects(() => detectStyles(als, detectConfig), /no map styles/i);
});

// --- CORS + rate limiting are wired onto /api only (not /health). ---

test("/health is exempt from rate limiting (ALB health check must never be throttled)", async () => {
  const deps = fakeDeps();
  deps.config.rateLimit = { ratePerSec: 1, burst: 1 };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    codes.push(res.status);
  }
  server.close();
  assert.deepStrictEqual(codes, [200, 200, 200, 200, 200]); // never 429
});

test("/api is rate limited per source IP (429 after the burst)", async () => {
  const deps = fakeDeps();
  deps.config.rateLimit = { ratePerSec: 1, burst: 2 };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/map-styles`);
    codes.push(res.status);
  }
  server.close();
  assert.ok(codes.slice(0, 2).every((c) => c === 200), `first 2 should pass: ${codes}`);
  assert.ok(codes.includes(429), `should hit 429 after burst: ${codes}`);
});

test("allowed CORS origin is echoed on /api responses", async () => {
  const deps = fakeDeps();
  deps.config.allowedOrigins = ["https://app.customer.com"];
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-styles`, {
    headers: { Origin: "https://app.customer.com" },
  });
  server.close();
  assert.strictEqual(res.headers.get("access-control-allow-origin"), "https://app.customer.com");
});

test("disallowed CORS origin gets no allow header", async () => {
  const deps = fakeDeps();
  deps.config.allowedOrigins = ["https://app.customer.com"];
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-styles`, {
    headers: { Origin: "https://evil.com" },
  });
  server.close();
  assert.strictEqual(res.headers.get("access-control-allow-origin"), null);
});

// --- 5xx responses are sanitized: internal/ALS error detail is logged
// server-side, never leaked to the client. ---

test("a 500 returns a generic message, not the internal error detail", async () => {
  const deps = fakeDeps();
  deps.als.suggest = async () => {
    throw new Error("ALS suggest failed: HTTP 403 in eu-west-1 <secret-ish detail>");
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE`);
  const body = await res.json();
  server.close();
  assert.strictEqual(res.status, 500);
  assert.strictEqual(body.error, "Internal server error");
  assert.ok(!/403|secret-ish|eu-west-1/.test(JSON.stringify(body)), "must not leak internal detail");
});

// --- lat/lng validation: malformed coords are rejected with 400 before they
// can reach ALS as NaN. ---

test("suggest rejects a malformed lat with 400 (no NaN to ALS)", async () => {
  const deps = fakeDeps();
  let called = false;
  deps.als.suggest = async () => { called = true; return { ResultItems: [] }; };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&lat=abc&lng=103.8`);
  server.close();
  assert.strictEqual(res.status, 400);
  assert.strictEqual(called, false, "als.suggest must not be called with bad coords");
});

test("tile-region rejects an out-of-range coord with 400", async () => {
  const deps = fakeDeps();
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/tile-region?lat=999&lng=0`);
  server.close();
  assert.strictEqual(res.status, 400);
});

test("suggest with no coords still works (coords optional)", async () => {
  const deps = fakeDeps();
  deps.als.suggest = async () => ({ ResultItems: [] });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE`);
  server.close();
  assert.strictEqual(res.status, 200);
});
