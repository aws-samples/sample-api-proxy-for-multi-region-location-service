const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { buildApp, detectStyles, applyKeepAliveTimeouts, ALB_IDLE_TIMEOUT_MS } = require("../server");
// Fully tear down a test server. `close()` stops the listener but leaves already
// established keep-alive sockets open. Node's fetch pools those sockets per
// origin (127.0.0.1:PORT), so once the OS hands the same port to a later test's
// server, a stale pooled socket delivers bytes to the WRONG server — Node then
// answers at the protocol level (400 Bad Request / 426 Upgrade Required) without
// ever entering Express, which is exactly how this suite used to flake. Destroying
// the connections keeps every server strictly inside the test that created it.
function shutdown(srv) {
  if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
  srv.close();
}


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

// A guard, not a feature: Express 5 parses query strings with Node's own
// querystring ("simple") instead of qs, which keeps qs out of the request path
// entirely. Every parameter this API takes is a flat scalar, so nothing here
// needs qs's nested/bracket syntax — setting this to "extended" to support it
// would put attacker-controlled strings back into qs for no benefit.
test('query parser stays "simple" (keeps qs out of the request path)', () => {
  assert.strictEqual(buildApp(fakeDeps()).get("query parser"), "simple");
});

// Node's default keepAliveTimeout (5s) is far SHORTER than the ALB's idle
// timeout (60s), which is the wrong way round: the ALB keeps a pooled
// connection the target closes underneath it, and a request sent as the FIN
// arrives fails as a sporadic 502. The target must outlive the balancer so the
// close is always ALB-initiated. headersTimeout must in turn exceed
// keepAliveTimeout, or a kept-alive connection can be reaped mid-request.
test("keep-alive timeouts outlive the ALB idle timeout", () => {
  const srv = http.createServer();
  assert.strictEqual(srv.keepAliveTimeout, 5000, "Node's unsafe default");
  applyKeepAliveTimeouts(srv);
  assert.ok(
    srv.keepAliveTimeout > ALB_IDLE_TIMEOUT_MS,
    `keepAliveTimeout ${srv.keepAliveTimeout} must exceed ALB idle ${ALB_IDLE_TIMEOUT_MS}`
  );
  assert.ok(
    srv.headersTimeout > srv.keepAliveTimeout,
    `headersTimeout ${srv.headersTimeout} must exceed keepAliveTimeout ${srv.keepAliveTimeout}`
  );
  srv.close();
});

test("baseline security headers are set on responses", async () => {
  const app = buildApp(fakeDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-styles`);
  await res.text();
  shutdown(server);
  assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
  // Clickjacking defense for the served demo page (no legit framing use case).
  assert.strictEqual(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.strictEqual(res.headers.get("referrer-policy"), "no-referrer");
});

test("favicon.ico returns 204 (no console 404 noise)", async () => {
  const app = buildApp(fakeDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
  shutdown(server);
  assert.strictEqual(res.status, 204);
});

test("map-style returns 400 for a disallowed style", async () => {
  const app = buildApp(fakeDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-style?style=Bogus`);
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
  // bias must be the real coords, not the region center
  assert.strictEqual(Number(seen.lat), 35.6);
  assert.strictEqual(Number(seen.lng), 139.7);
});

test("suggest forwards a valid ?limit as maxResults", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => {
    seen = args;
    return { ResultItems: [] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE&limit=10`);
  shutdown(server);
  assert.strictEqual(seen.maxResults, 10);
});

test("suggest without ?limit leaves maxResults unset (client default applies)", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => {
    seen = args;
    return { ResultItems: [] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE`);
  shutdown(server);
  assert.strictEqual(seen.maxResults, undefined);
});

// Reject out-of-contract limits here so the caller gets our 400 rather than an
// upstream ALS ValidationException surfacing as a generic proxy error.
test("suggest returns 400 for a non-integer or out-of-range ?limit", async () => {
  const deps = fakeDeps();
  let called = false;
  deps.als.suggest = async () => {
    called = true;
    return { ResultItems: [] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const statuses = [];
  // The last case is a REPEATED param: the query parser hands those over as an
  // array (["5","9"]), which has no sane single value, so it must be rejected
  // rather than coerced to whichever end the parser happens to keep.
  for (const qs of ["limit=abc", "limit=0", "limit=101", "limit=5.5", "limit=-1", "limit=5&limit=9"]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&${qs}`);
    statuses.push(res.status);
    await res.text();
  }
  shutdown(server);
  assert.deepStrictEqual(statuses, [400, 400, 400, 400, 400, 400]);
  assert.strictEqual(called, false, "must not reach ALS with an invalid limit");
});

test("suggest forwards a normalized Places language to als", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => {
    seen = args;
    return { ResultItems: [] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE&lang=de-DE`);
  shutdown(server);
  assert.strictEqual(seen.lang, "de-DE");
});

test("Places endpoints accept Places-only languages and clamp for GrabMaps", async () => {
  const deps = fakeDeps();
  deps.config.enabledRegions.add("ap-southeast-1");
  deps.config.keyMap.set("ap-southeast-1", "k3");
  deps.mappingStore.getRegion = (cc) => ({ DE: "eu-west-1", SG: "ap-southeast-1" }[cc] || null);
  const seen = {};
  deps.als.suggest = async (args) => { seen.suggest = args; return { ResultItems: [] }; };
  deps.als.getPlace = async (args) => { seen.place = args; return { Address: {} }; };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;

  let res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=SG&lang=lo`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(seen.suggest.lang, "lo", "lo is valid for Places even though it is not a map-label code");

  res = await fetch(`http://127.0.0.1:${port}/api/place/PID?region=ap-southeast-1&lang=tl`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(seen.place.lang, "tl");

  await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=SG&lang=ja`);
  shutdown(server);
  assert.strictEqual(seen.suggest.lang, "en", "ja is outside the documented GrabMaps subset");
});

test("Places endpoints reject malformed BCP 47 language tags before calling ALS", async () => {
  const deps = fakeDeps();
  let calls = 0;
  deps.als.suggest = async () => { calls++; return { ResultItems: [] }; };
  deps.als.getPlace = async () => { calls++; return {}; };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const responses = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/suggest?query=x&lang=en--US`),
    fetch(`http://127.0.0.1:${port}/api/place/PID?lang=not%20a%20tag`),
    fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=1&lng=2&lang=en--US`),
  ]);
  for (const res of responses) {
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /BCP 47/);
  }
  shutdown(server);
  assert.strictEqual(calls, 0);
});

// A tag that is well-formed but names a language Amazon Location documents
// NOWHERE (lang=cn — China's code, not Chinese; Chinese is zh) must fail here,
// not upstream: forwarding it spends an ALS round trip to earn the same 400, and
// it made the SAME parameter behave differently on /api/suggest than it does on
// /api/map-style (which has always rejected it locally).
test("Places endpoints reject undocumented languages before calling ALS", async () => {
  const deps = fakeDeps();
  let calls = 0;
  deps.als.suggest = async () => { calls++; return { ResultItems: [] }; };
  deps.als.getPlace = async () => { calls++; return {}; };
  deps.als.reverseGeocodePlace = async () => { calls++; return null; };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const responses = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/suggest?query=x&lang=cn`),
    fetch(`http://127.0.0.1:${port}/api/place/PID?lang=xx`),
    fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=1&lng=2&lang=zzz-Latn-999`),
  ]);
  for (const res of responses) {
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /Unsupported Places language/);
  }
  shutdown(server);
  assert.strictEqual(calls, 0, "no upstream call may be spent on a language we can reject locally");
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
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
  assert.strictEqual(body.tileRegion, "ap-southeast-1");
  assert.strictEqual(body.country, "SG"); // for context backfill
});

test("place rejects an out-of-set explicit ?region", async () => {
  const deps = fakeDeps();
  let called = false;
  deps.als.getPlace = async () => {
    called = true;
    return { Title: "x", Position: [0, 0], Address: {} };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/place/PID?region=mars-1`);
  shutdown(server);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(called, false, "a region-scoped PlaceId must never silently fall back");
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
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
  assert.strictEqual(seen.region, "eu-west-1");
});
// --- map label language ---
// ALS has no server-side language parameter for dynamic maps, so the proxy
// localizes labels by rewriting the descriptor's symbol text-field expressions.
function labelledStyleDeps() {
  const deps = fakeDeps();
  deps.config.defaultMapLanguage = "en";
  deps.als.getStyleDescriptor = async () => ({
    sources: {},
    layers: [
      {
        id: "labels",
        type: "symbol",
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]] },
      },
    ],
  });
  return deps;
}

// Same, but with the REAL rewriteStyle and a raw ALS-shaped descriptor. Needed for
// the map-style/map-labels agreement test: fakeDeps stubs rewriteStyle to identity,
// which hides the only structural difference between the two endpoints.
function realRewriteDeps() {
  const { createAlsClient } = require("../src/alsClient");
  const deps = labelledStyleDeps();
  deps.als.rewriteStyle = createAlsClient().rewriteStyle;
  deps.als.getStyleDescriptor = async () => ({
    glyphs: "https://maps.geo.eu-west-1.amazonaws.com/v2/glyphs/{fontstack}/{range}.pbf?key=SECRET",
    sources: {
      base: {
        type: "vector",
        tiles: ["https://maps.geo.eu-west-1.amazonaws.com/v2/tiles/base/{z}/{x}/{y}?key=SECRET"],
      },
    },
    layers: [
      {
        id: "labels",
        type: "symbol",
        // A null layout value for cleanProps to strip, so the two paths really do
        // diverge somewhere and the comparison is not vacuous.
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-transform": null },
      },
      {
        id: "shield",
        type: "symbol",
        layout: { "text-field": ["to-string", ["get", "shield_text"]] },
      },
    ],
  });
  return deps;
}
async function getStyle(port, qs) {
  const res = await fetch(`http://127.0.0.1:${port}/api/map-style?${qs}`);
  return { res, body: await res.json() };
}
test("map-style defaults the label language from the countryCode", async () => {
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  // DE is mapped to eu-west-1 by the fake mappingStore, and to "de" by
  // config/map-languages.js — no ?lang needed.
  const { res, body } = await getStyle(port, "style=Standard&countryCode=DE");
  shutdown(server);
  assert.strictEqual(res.headers.get("x-map-label-language"), "de");
  assert.strictEqual(res.headers.get("x-map-label-language-source"), "country-map");
  assert.deepStrictEqual(body.layers[0].layout["text-field"], [
    "coalesce",
    ["get", "name:de"],
    ["get", "name:en"],
    ["get", "name"],
  ]);
});
test("map-style defaults the language from the REVERSE-GEOCODED country", async () => {
  // The fake reverseGeocoder returns JP, so lat/lng alone must yield Japanese —
  // this is what makes the country default work without an explicit countryCode.
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const { res } = await getStyle(port, "style=Standard&lat=35.68&lng=139.77");
  shutdown(server);
  assert.strictEqual(res.headers.get("x-map-label-language"), "ja");
  // The source describes how the LANGUAGE was chosen (the country->language
  // table), not how the country itself was obtained.
  assert.strictEqual(res.headers.get("x-map-label-language-source"), "country-map");
});
test("map-style honors an explicit ?lang over the country default", async () => {
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const { res, body } = await getStyle(port, "style=Standard&countryCode=DE&lang=zh-CN");
  shutdown(server);
  // A full BCP 47 tag is reduced to the ISO 639-1 code ALS tiles are keyed by.
  assert.strictEqual(res.headers.get("x-map-label-language"), "zh");
  assert.strictEqual(res.headers.get("x-map-label-language-source"), "explicit");
  assert.deepStrictEqual(body.layers[0].layout["text-field"][1], ["get", "name:zh"]);
});
test("map-style rejects an unsupported ?lang with 400", async () => {
  // "cn" is a common mistake for Chinese; rendering English instead would look
  // like the feature is broken, so it must be a hard error.
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-style?lang=cn`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(res.status, 400);
  assert.match(body.error, /Unsupported map label language/);
});
test("an explicit ?region does not override the country's language", async () => {
  // Tiles and labels are independent: a region spans many countries.
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const { res } = await getStyle(port, "style=Standard&countryCode=DE&region=ap-northeast-1");
  shutdown(server);
  assert.strictEqual(res.headers.get("x-map-label-language"), "de");
});
test("map-style exposes the language headers to cross-origin callers", async () => {
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-style`);
  await res.json();
  shutdown(server);
  assert.match(res.headers.get("access-control-expose-headers") || "", /X-Map-Label-Language/);
});
test("map-languages lists the supported languages and the configured default", async () => {
  const deps = labelledStyleDeps();
  deps.config.defaultMapLanguage = "ja";
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-languages`);
  const body = await res.json();
  shutdown(server);
  assert.ok(Array.isArray(body.languages));
  for (const code of ["en", "zh", "ja", "de", "ar"]) {
    assert.ok(body.languages.includes(code), `${code} should be offered`);
  }
  assert.ok(!body.languages.includes("cn"), "cn is not an ISO 639-1 code");
  assert.strictEqual(body.default, "ja");
});
test("map-labels returns only the label expressions, localized", async () => {
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-labels?style=Standard&countryCode=DE`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(res.headers.get("x-map-label-language"), "de");
  assert.strictEqual(body.language, "de");
  assert.strictEqual(body.source, "country-map");
  assert.deepStrictEqual(Object.keys(body.layers), ["labels"]);
  assert.deepStrictEqual(body.layers.labels, [
    "coalesce",
    ["get", "name:de"],
    ["get", "name:en"],
    ["get", "name"],
  ]);
  // The point of this endpoint is to be small: no sources/glyphs/sprite/paint.
  assert.strictEqual(body.sources, undefined);
  assert.strictEqual(body.glyphs, undefined);
});
test("map-labels agrees with map-style on the same request", async () => {
  // These two must never diverge — /api/map-labels is only a cheaper delivery of
  // the same localization, so a client using it must render identically. Uses the
  // REAL rewriteStyle so the one structural difference (map-style rewrites,
  // map-labels skips) is actually exercised.
  const app = buildApp(realRewriteDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const qs = "style=Standard&countryCode=DE&lang=ja";
  const [style, labels] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/map-style?${qs}`).then((r) => r.json()),
    fetch(`http://127.0.0.1:${port}/api/map-labels?${qs}`).then((r) => r.json()),
  ]);
  shutdown(server);
  // Prove the paths diverged upstream, otherwise the comparison below is vacuous.
  assert.match(style.glyphs, /d1\.cloudfront\.net/, "map-style must have rewritten the URLs");
  assert.ok(!JSON.stringify(style).includes("SECRET"), "map-style must have stripped the key");
  assert.strictEqual("text-transform" in style.layers[0].layout, false, "nulls must be stripped");

  for (const [id, expr] of Object.entries(labels.layers)) {
    const layer = style.layers.find((l) => l.id === id);
    assert.deepStrictEqual(expr, layer.layout["text-field"], `layer ${id} diverged`);
  }
  assert.deepStrictEqual(Object.keys(labels.layers), ["labels"], "the shield layer must be excluded");
});
test("map-labels validates its query the same way map-style does", async () => {
  const app = buildApp(labelledStyleDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const codes = {};
  for (const [name, qs] of [
    ["badLang", "lang=cn"],
    ["badCountry", "countryCode=UK"],
    ["badStyle", "style=Bogus"],
    ["badCoords", "lat=999&lng=0"],
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/map-labels?${qs}`);
    codes[name] = res.status;
    await res.text();
  }
  shutdown(server);
  assert.deepStrictEqual(codes, { badLang: 400, badCountry: 400, badStyle: 400, badCoords: 400 });
});
test("map-style falls back to the configured default with no country signal", async () => {
  const deps = labelledStyleDeps();
  deps.config.defaultMapLanguage = "fr";
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const { res } = await getStyle(port, "style=Standard");
  shutdown(server);
  assert.strictEqual(res.headers.get("x-map-label-language"), "fr");
  assert.strictEqual(res.headers.get("x-map-label-language-source"), "config-default");
});

// --- detectStyles: a transient ALS blip at boot must not leave a "healthy"
// task that serves zero styles (empty switcher + 400 on every map-style). ---

const detectConfig = { homeRegion: "ap-northeast-1", keyMap: new Map([["ap-northeast-1", "k1"]]) };

test("detectStyles returns the styles that exist", async () => {
  const als = { styleExists: async ({ styleName }) => styleName === "Standard" || styleName === "Hybrid" };
  const styles = await detectStyles(als, detectConfig);
  assert.deepStrictEqual(styles.sort(), ["Hybrid", "Standard"]);
});

test("detectStyles rejects startup when any style probe is indeterminate", async () => {
  const als = {
    styleExists: async ({ styleName }) => {
      if (styleName === "Monochrome") throw new Error("flaky");
      return true;
    },
  };
  await assert.rejects(() => detectStyles(als, detectConfig), /flaky/);
});

test("detectStyles throws when NO style resolves (fail fast so ECS replaces the task)", async () => {
  // e.g. ALS briefly unreachable at boot → every probe fails. Returning [] would
  // leave a task that passes /health but can never render a map.
  const als = { styleExists: async () => { throw new Error("ALS unreachable"); } };
  await assert.rejects(() => detectStyles(als, detectConfig), /ALS unreachable/i);
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
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
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
  shutdown(server);
  assert.strictEqual(res.status, 500);
  assert.strictEqual(body.error, "Internal server error");
  assert.ok(!/403|secret-ish|eu-west-1/.test(JSON.stringify(body)), "must not leak internal detail");
});

test("fail500 log does NOT leak a key-bearing URL (some fetch errors carry ?key=... in the message)", async () => {
  // A network-level fetch rejection can surface the request URL — which carries
  // ?key=<apiKey> — in err.message/err.stack. fail500 logs server-side, but it
  // must scrub any key= querystring so the secret never lands in CloudWatch.
  const deps = fakeDeps();
  deps.als.suggest = async () => {
    throw new Error(
      "request to https://places.geo.eu-west-1.amazonaws.com/v2/suggest?key=SUPERSECRETKEY failed, reason: ECONNRESET"
    );
  };
  const logs = [];
  const origErr = console.error;
  console.error = (...args) => logs.push(args.map(String).join(" "));
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE`);
  } finally {
    shutdown(server);
    console.error = origErr;
  }
  const joined = logs.join("\n");
  assert.ok(joined.length, "fail500 should still log something server-side");
  assert.ok(/Suggest error/.test(joined), "should still name the failing context");
  assert.ok(!/SUPERSECRETKEY/.test(joined), `log must not leak the key: ${joined}`);
  // A key= param may only appear redacted (key=[REDACTED]), never with a value.
  assert.ok(!/key=(?!\[REDACTED\])[^&\s]+/i.test(joined), `key value must be redacted: ${joined}`);
});

// --- countryCode validation: an unsupported/invalid code must be rejected at
// the boundary with 400, never forwarded to ALS as a hard IncludeCountries
// filter (ALS 400s on a non-ISO code like "UK"). The mapping is the single
// source of truth for which countries are served. ---

test("suggest rejects an unsupported countryCode with 400 (never reaches ALS)", async () => {
  const deps = fakeDeps(); // mapping serves only DE (→ eu-west-1)
  let called = false;
  deps.als.suggest = async () => { called = true; return { ResultItems: [] }; };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  // "UK" is not a valid ISO code (the UK is "GB") and is not in the mapping.
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=london&countryCode=UK`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(res.status, 400, "unsupported country must be a client error, not 500");
  assert.match(body.error || "", /countryCode|country/i);
  assert.ok(/UK/.test(body.error || ""), "error should name the offending code");
  assert.strictEqual(called, false, "als.suggest must NOT be called with an unsupported country");
});

test("suggest accepts a supported countryCode (case-insensitive) and calls ALS", async () => {
  const deps = fakeDeps();
  let seen;
  deps.als.suggest = async (args) => { seen = args; return { ResultItems: [] }; };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=de`);
  shutdown(server);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(seen.region, "eu-west-1"); // DE → eu-west-1
  assert.deepStrictEqual(seen.includeCountries, ["DE"]); // normalized upper-case
});

test("place rejects an unsupported countryCode with 400", async () => {
  const deps = fakeDeps();
  let called = false;
  deps.als.getPlace = async () => { called = true; return {}; };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  // No ?region (which would bypass resolution) → countryCode is used → must validate.
  const res = await fetch(`http://127.0.0.1:${port}/api/place/PID?countryCode=UK`);
  shutdown(server);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(called, false);
});

// --- ALS client errors (4xx) are the caller's fault (bad input) → surface as
// 4xx, not 500. 403/5xx/network remain 500 (server-side / bad key / transient). ---

test("an ALS 4xx surfaces as a client 400, not a 500", async () => {
  const deps = fakeDeps();
  deps.als.suggest = async () => {
    const e = new Error("ALS suggest failed: HTTP 400 in eu-west-1");
    e.status = 400;
    throw e;
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(res.status, 400, "an ALS 400 must not be reported as a 500");
  assert.ok(!/eu-west-1|HTTP 400/.test(JSON.stringify(body)), "must not leak internal detail");
});

test("a non-4xx ALS failure (e.g. 403 bad key) still surfaces as 500", async () => {
  const deps = fakeDeps();
  deps.als.suggest = async () => {
    const e = new Error("ALS suggest failed: HTTP 403 in eu-west-1");
    e.status = 403;
    throw e;
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE`);
  shutdown(server);
  assert.strictEqual(res.status, 500, "a 403 (server-side bad key) stays a 500");
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
  shutdown(server);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(called, false, "als.suggest must not be called with bad coords");
});

test("tile-region rejects an out-of-range coord with 400", async () => {
  const deps = fakeDeps();
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/tile-region?lat=999&lng=0`);
  shutdown(server);
  assert.strictEqual(res.status, 400);
});

test("suggest with no coords still works (coords optional)", async () => {
  const deps = fakeDeps();
  deps.als.suggest = async () => ({ ResultItems: [] });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/suggest?query=x&countryCode=DE`);
  shutdown(server);
  assert.strictEqual(res.status, 200);
});

// --- /api/reverse-geocode (click the map to identify a place) ---
function reverseGeoDeps(overrides = {}) {
  const deps = fakeDeps();
  deps.config.defaultMapLanguage = "en";
  deps.config.enabledRegions = new Set(["ap-northeast-1", "eu-west-1", "ap-southeast-1"]);
  deps.config.keyMap = new Map([
    ["ap-northeast-1", "k1"],
    ["eu-west-1", "k2"],
    ["ap-southeast-1", "k3"],
  ]);
  deps.mappingStore = {
    getRegion: (cc) => ({ DE: "eu-west-1", JP: "ap-northeast-1", SG: "ap-southeast-1" }[cc] || null),
  };
  deps.als.reverseGeocodePlace = async () => ({
    placeId: "p1",
    placeType: "PointAddress",
    title: "東京駅",
    address: { Label: "東京都千代田区丸の内1丁目", Country: { Code2: "JP" } },
    position: [139.7671, 35.6812],
    distanceMeters: 12.5,
    country: "JP",
  });
  return { ...deps, ...overrides };
}

test("reverse-geocode returns the identified place, country and tile region", async () => {
  const app = buildApp(reverseGeoDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=35.68&lng=139.77`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.place.label, "東京駅");
  assert.strictEqual(body.place.placeType, "PointAddress");
  assert.strictEqual(body.place.distanceMeters, 12.5);
  assert.deepStrictEqual(body.place.position, [139.7671, 35.6812]);
  assert.strictEqual(body.country, "JP");
  assert.strictEqual(body.tileRegion, "ap-northeast-1");
});

test("reverse-geocode requires coordinates", async () => {
  // Unlike the other endpoints, coords are the entire request here.
  const app = buildApp(reverseGeoDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(res.status, 400);
  assert.match(body.error, /required/);
});

test("reverse-geocode rejects malformed and out-of-range coordinates", async () => {
  const app = buildApp(reverseGeoDeps());
  const server = app.listen(0);
  const port = server.address().port;
  const codes = [];
  for (const qs of ["lat=abc&lng=1", "lat=999&lng=0", "lat=35.68", "lat=0&lng=181"]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?${qs}`);
    codes.push(res.status);
    await res.text();
  }
  shutdown(server);
  assert.deepStrictEqual(codes, [400, 400, 400, 400]);
});

test("reverse-geocode defaults the language from the CLICKED position's country", async () => {
  // The fake reverseGeocoder resolves the position to JP, so the address should
  // come back in Japanese without the client asking for it.
  let seen;
  const deps = reverseGeoDeps();
  deps.als.reverseGeocodePlace = async (args) => {
    seen = args;
    return { title: "x", address: { Country: { Code2: "JP" } }, country: "JP", position: [0, 0] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=35.68&lng=139.77`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(seen.lang, "ja");
  assert.strictEqual(body.language, "ja");
});

test("reverse-geocode honors an explicit ?lang over the position's country", async () => {
  let seen;
  const deps = reverseGeoDeps();
  deps.als.reverseGeocodePlace = async (args) => {
    seen = args;
    return { title: "x", address: { Country: { Code2: "JP" } }, country: "JP", position: [0, 0] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=35.68&lng=139.77&lang=de`);
  shutdown(server);
  assert.strictEqual(seen.lang, "de");
});

test("reverse-geocode with explicit lang skips the display-country lookup when routing is off", async () => {
  const deps = reverseGeoDeps();
  deps.config.routingEnabled = false;
  let countryLookups = 0;
  deps.reverseGeocoder = { toCountry: async () => { countryLookups++; return "JP"; } };
  deps.als.reverseGeocodePlace = async (args) => ({
    title: "x", address: { Country: { Code2: "JP" } }, country: "JP", position: [0, 0], lang: args.lang,
  });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(
    `http://127.0.0.1:${port}/api/reverse-geocode?lat=35.68&lng=139.77&lang=de`
  );
  await res.json();
  shutdown(server);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(countryLookups, 0, "explicit lang makes a display-country lookup unnecessary");
});

test("reverse-geocode clamps the language for GrabMaps regions", async () => {
  // A Japanese label language + a click in Singapore must NOT send Language=ja
  // to GrabMaps, which rejects it. It should degrade to en instead of failing.
  let seen;
  const deps = reverseGeoDeps();
  deps.reverseGeocoder = { toCountry: async () => "SG" }; // routes to ap-southeast-1
  deps.als.reverseGeocodePlace = async (args) => {
    seen = args;
    return { title: "x", address: { Country: { Code2: "SG" } }, country: "SG", position: [0, 0] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=1.35&lng=103.82&lang=ja`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(seen.region, "ap-southeast-1");
  assert.strictEqual(seen.lang, "en", "ja must be clamped for GrabMaps");
  assert.strictEqual(body.language, "en");
});

test("reverse-geocode returns place:null (200) when nothing is there", async () => {
  // Ocean / unmapped area is a legitimate answer, not a failure.
  const deps = reverseGeoDeps();
  deps.als.reverseGeocodePlace = async () => null;
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=0&lng=-140`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.place, null);
  assert.ok(body.tileRegion);
});

test("reverse-geocode queries the region that covers the clicked country", async () => {
  // The point of the two-step lookup: a Singapore click must be answered by the
  // GrabMaps region, not by the home region.
  let seen;
  const deps = reverseGeoDeps();
  deps.reverseGeocoder = { toCountry: async () => "SG" };
  deps.als.reverseGeocodePlace = async (args) => {
    seen = args;
    return { title: "x", address: { Country: { Code2: "SG" } }, country: "SG", position: [0, 0] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=1.35&lng=103.82`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(seen.region, "ap-southeast-1");
  assert.strictEqual(seen.key, "k3", "must use that region's own API key");
  assert.strictEqual(body.tileRegion, "ap-southeast-1");
});

test("reverse-geocode surfaces an ALS 4xx as a client 400, not a 500", async () => {
  const deps = reverseGeoDeps();
  deps.als.reverseGeocodePlace = async () => {
    const err = new Error("bad request");
    err.status = 400;
    throw err;
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=1&lng=1`);
  await res.text();
  shutdown(server);
  assert.strictEqual(res.status, 400);
});

// --- language defaulting must survive MULTI_REGION_ROUTING=false ---
// resolveRegion returns before it ever reverse-geocodes when routing is off, so
// the country it reports is null for a lat/lng-only request. The label language is
// a DISPLAY concern and must not disappear with routing disabled.

test("reverse-geocode defaults the language from the position with routing OFF", async () => {
  const deps = reverseGeoDeps();
  deps.config.routingEnabled = false;
  deps.reverseGeocoder = { toCountry: async () => "DE" };
  let seen;
  deps.als.reverseGeocodePlace = async (args) => {
    seen = args;
    return { title: "x", address: { Country: { Code2: "DE" } }, country: "DE", position: [0, 0] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=52.52&lng=13.40`);
  const body = await res.json();
  shutdown(server);
  // Region is pinned to home (routing off), but the language still follows the
  // clicked position — de, not the config default of en.
  assert.strictEqual(seen.region, "ap-northeast-1");
  assert.strictEqual(seen.lang, "de");
  assert.strictEqual(body.language, "de");
});

test("map-style defaults the language from lat/lng with routing OFF", async () => {
  // This is the locate-button path: auto mode sends coordinates, not a country.
  const deps = reverseGeoDeps();
  deps.config.routingEnabled = false;
  deps.reverseGeocoder = { toCountry: async () => "DE" };
  deps.als.getStyleDescriptor = async () => ({ sources: {}, layers: [] });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/map-style?style=Standard&lat=52.52&lng=13.40`);
  await res.json();
  shutdown(server);
  assert.strictEqual(res.headers.get("x-map-label-language"), "de");
});

// --- an explicit ?region must not cost a routing lookup ---

test("an explicit ?region skips the routing reverse-geocode", async () => {
  // ?region makes the routing decision moot. Resolving it anyway was an upstream
  // call for an answer that gets discarded.
  const deps = reverseGeoDeps();
  let countryLookups = 0;
  deps.reverseGeocoder = { toCountry: async () => { countryLookups++; return "DE"; } };
  deps.als.getStyleDescriptor = async () => ({ sources: {}, layers: [] });
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  // With an explicit language the country cannot change the outcome either, so
  // nothing needs resolving at all.
  let res = await fetch(
    `http://127.0.0.1:${port}/api/map-style?style=Standard&region=eu-west-1&lat=52.5&lng=13.4&lang=ja`
  );
  await res.json();
  assert.strictEqual(res.headers.get("x-map-label-language"), "ja");
  assert.strictEqual(countryLookups, 0, "explicit region + explicit lang needs no lookup");

  // Without an explicit language the country IS needed, so exactly one lookup.
  res = await fetch(
    `http://127.0.0.1:${port}/api/map-style?style=Standard&region=eu-west-1&lat=52.5&lng=13.4`
  );
  await res.json();
  shutdown(server);
  assert.strictEqual(countryLookups, 1, "the language default needs the country, once");
  assert.strictEqual(res.headers.get("x-map-label-language"), "de");
});

test("reverse-geocode returns the same keys whether or not a place was found", async () => {
  // A client must not have to branch on which keys exist.
  const found = reverseGeoDeps();
  const empty = reverseGeoDeps();
  empty.als.reverseGeocodePlace = async () => null;

  const shapes = [];
  for (const deps of [found, empty]) {
    const app = buildApp(deps);
    const server = app.listen(0);
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=1&lng=2`);
    shapes.push(Object.keys(await res.json()).sort());
    shutdown(server);
  }
  assert.deepStrictEqual(shapes[0], shapes[1], "the two branches must agree on keys");
  assert.deepStrictEqual(shapes[0], ["country", "language", "place", "tileRegion"]);
});

test("the GrabMaps clamp prefers the deployment default over the built-in en", async () => {
  // A deployment serving Southeast Asia may set DEFAULT_MAP_LANGUAGE=th, which is a
  // better degraded answer there than the hardcoded en.
  const deps = reverseGeoDeps();
  deps.config.defaultMapLanguage = "th";
  deps.reverseGeocoder = { toCountry: async () => "SG" };
  let seen;
  deps.als.reverseGeocodePlace = async (args) => {
    seen = args;
    return { title: "x", address: { Country: { Code2: "SG" } }, country: "SG", position: [0, 0] };
  };
  const app = buildApp(deps);
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/reverse-geocode?lat=1.35&lng=103.82&lang=ja`);
  const body = await res.json();
  shutdown(server);
  assert.strictEqual(seen.region, "ap-southeast-1");
  assert.strictEqual(seen.lang, "th");
  assert.strictEqual(body.language, "th");
});
