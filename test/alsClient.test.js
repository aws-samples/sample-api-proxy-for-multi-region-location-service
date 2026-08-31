const { test } = require("node:test");
const assert = require("node:assert");
const { createAlsClient } = require("../src/alsClient");

// fake fetch that records the URL and returns a canned JSON body.
// Mirrors a real fetch Response (ok/status), which the client relies on.
function fakeFetch(captured, body) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return { ok: true, status: 200, json: async () => body };
  };
}

// fake fetch that returns a non-ok HTTP response (e.g. 403 bad key, 500).
function fakeFetchError(status, text = "err") {
  return async () => ({
    ok: false,
    status,
    text: async () => text,
    json: async () => ({}),
  });
}

// No-op sleep so retry tests don't incur real backoff delays.
const noSleep = async () => {};

// fetch that replays a scripted sequence of HTTP statuses (the last repeats),
// counting how many times it was called. 200 returns okBody; anything else is
// a non-ok response.
function scriptedFetch(statuses, okBody = { ResultItems: [] }) {
  const state = { calls: 0 };
  const impl = async () => {
    const status = statuses[Math.min(state.calls, statuses.length - 1)];
    state.calls++;
    if (status === 200) return { ok: true, status: 200, json: async () => okBody };
    return { ok: false, status, text: async () => `err ${status}`, json: async () => ({}) };
  };
  return { impl, state };
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

test("suggest sends bias, and defaults Language to en", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { ResultItems: [] }) });
  await als.suggest({ region: "eu-west-1", key: "k", query: "paris", lat: 48.85, lng: 2.35 });
  const body = JSON.parse(captured.opts.body);
  assert.deepStrictEqual(body.BiasPosition, [2.35, 48.85]);
  assert.strictEqual(body.Language, "en");
  assert.strictEqual(body.Filter, undefined); // no IncludeCountries when none given
});

test("suggest with includeCountries sets Filter.IncludeCountries (hard filter)", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { ResultItems: [] }) });
  await als.suggest({ region: "ap-southeast-1", key: "k", query: "airport", lat: 1.35, lng: 103.82, includeCountries: ["TH"] });
  const body = JSON.parse(captured.opts.body);
  assert.deepStrictEqual(body.Filter.IncludeCountries, ["TH"]);
  // IncludeCountries and BiasPosition coexist (verified against ALS v2)
  assert.deepStrictEqual(body.BiasPosition, [103.82, 1.35]);
});

test("suggest passes an explicit lang through as Language", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { ResultItems: [] }) });
  await als.suggest({ region: "ap-southeast-1", key: "k", query: "x", lat: 1.35, lng: 103.82, lang: "th" });
  assert.strictEqual(JSON.parse(captured.opts.body).Language, "th");
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

test("rewriteStyle strips key even when it is NOT the last query param (no leftover key, well-formed URL)", () => {
  const als = createAlsClient({ fetchImpl: async () => ({}) });
  const style = {
    // key in the middle: naive /[?&]key=[^&]+/ removal can leave a dangling
    // "?&" or drop the wrong separator — worse, a malformed strip could leak
    // the key. Rebuild via URL so the key is gone and the URL stays valid.
    sources: {
      m: { tiles: ["https://maps.geo.eu-west-1.amazonaws.com/v2/tiles/{z}/{x}/{y}?key=SECRET&foo=bar"] },
      v: { url: "https://maps.geo.eu-west-1.amazonaws.com/v2/vector?a=1&key=SECRET&b=2" },
    },
  };
  const out = als.rewriteStyle(style, { region: "eu-west-1", mapTileDomain: "d1.cloudfront.net" });
  const tile = out.sources.m.tiles[0];
  const url = out.sources.v.url;
  assert.ok(!/SECRET/.test(tile), `key must be gone from tiles: ${tile}`);
  assert.ok(!/key=/.test(tile), `no key= param may remain in tiles: ${tile}`);
  assert.ok(!/SECRET/.test(url), `key must be gone from url: ${url}`);
  assert.ok(!/key=/.test(url), `no key= param may remain in url: ${url}`);
  // The non-key params must survive and the origin must be rewritten to CF.
  assert.match(tile, /^https:\/\/d1\.cloudfront\.net\/eu-west-1\/v2\/tiles\/\{z\}\/\{x\}\/\{y\}\?foo=bar$/);
  assert.match(url, /^https:\/\/d1\.cloudfront\.net\/eu-west-1\/v2\/vector\?a=1&b=2$/);
});

test("getPlace hits the region's place endpoint with placeId and default language en", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { Title: "x" }) });
  await als.getPlace({ region: "eu-west-1", key: "k2", placeId: "abc123" });
  assert.match(captured.url, /places\.geo\.eu-west-1\.amazonaws\.com\/v2\/place\/abc123/);
  assert.match(captured.url, /language=en/);
  assert.match(captured.url, /key=k2/);
});

test("getPlace passes an explicit lang", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { Title: "x" }) });
  await als.getPlace({ region: "eu-west-1", key: "k2", placeId: "abc", lang: "zh" });
  assert.match(captured.url, /language=zh/);
});

test("getPlace URL-encodes the placeId (opaque token, may contain reserved chars)", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { Title: "x" }) });
  await als.getPlace({ region: "eu-west-1", key: "k2", placeId: "ab/c d+e" });
  assert.match(captured.url, /\/v2\/place\/ab%2Fc%20d%2Be/);
});

// --- HTTP error handling: a non-ok response must NOT be mistaken for data. ---
// Before this, suggest returned {} → [] (looks like "no matches"),
// reverseGeocodeCountry returned null (silent home fallback), etc.

test("suggest throws on a non-ok HTTP response (not silently empty)", async () => {
  const als = createAlsClient({ fetchImpl: fakeFetchError(403, "AccessDenied") });
  await assert.rejects(
    () => als.suggest({ region: "eu-west-1", key: "bad", query: "x" }),
    /suggest.*403.*eu-west-1/
  );
});

test("getPlace throws on a non-ok HTTP response", async () => {
  const als = createAlsClient({ fetchImpl: fakeFetchError(500) });
  await assert.rejects(
    () => als.getPlace({ region: "eu-west-1", key: "k", placeId: "p" }),
    /getPlace.*500.*eu-west-1/
  );
});

test("getStyleDescriptor throws on a non-ok HTTP response", async () => {
  const als = createAlsClient({ fetchImpl: fakeFetchError(404) });
  await assert.rejects(
    () => als.getStyleDescriptor({ region: "eu-west-1", key: "k", styleName: "Standard" }),
    /getStyleDescriptor.*404.*eu-west-1/
  );
});

test("reverseGeocodeCountry throws on a non-ok HTTP response (caller decides to degrade)", async () => {
  const als = createAlsClient({ fetchImpl: fakeFetchError(403) });
  await assert.rejects(
    () => als.reverseGeocodeCountry({ region: "eu-west-1", key: "bad", lat: 0, lng: 0 }),
    /reverseGeocode.*403.*eu-west-1/
  );
});

// styleExists is a HEAD probe: a non-ok HTTP response (e.g. 404) is a
// legitimate "style not present" and returns false — it must NOT throw.
test("styleExists returns false on a non-ok response (probe, never throws)", async () => {
  const als = createAlsClient({ fetchImpl: fakeFetchError(404) });
  const exists = await als.styleExists({ region: "eu-west-1", key: "k", styleName: "Nope" });
  assert.strictEqual(exists, false);
});

test("styleExists returns true on ok", async () => {
  const als = createAlsClient({ fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.strictEqual(await als.styleExists({ region: "eu-west-1", key: "k", styleName: "Standard" }), true);
});

// A network BLIP (fetch rejects) is "probe failed", NOT "style absent". It must
// be retried (so a transient blip at startup doesn't permanently hide a style),
// and only throw if it never recovers — detectStyles' catch then treats the
// throw as "unknown", distinct from a definitive false.
test("styleExists retries a network error then succeeds", async () => {
  let calls = 0;
  const impl = async () => {
    calls++;
    if (calls === 1) throw new TypeError("network down");
    return { ok: true, status: 200 };
  };
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
  assert.strictEqual(await als.styleExists({ region: "eu-west-1", key: "k", styleName: "Standard" }), true);
  assert.strictEqual(calls, 2);
});

test("styleExists retries a 5xx then returns the recovered result", async () => {
  const { impl, state } = scriptedFetch([503, 200]);
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep });
  const exists = await als.styleExists({ region: "eu-west-1", key: "k", styleName: "Standard" });
  assert.strictEqual(exists, true);
  assert.strictEqual(state.calls, 2);
});

test("styleExists throws (does NOT return false) when a network error never recovers", async () => {
  const impl = async () => { throw new TypeError("network down"); };
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 1 });
  await assert.rejects(
    () => als.styleExists({ region: "eu-west-1", key: "k", styleName: "Standard" }),
    /network down/
  );
});

test("styleExists does NOT retry a 404 (definitive 'absent', returns false immediately)", async () => {
  const { impl, state } = scriptedFetch([404]);
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
  const exists = await als.styleExists({ region: "eu-west-1", key: "k", styleName: "Nope" });
  assert.strictEqual(exists, false);
  assert.strictEqual(state.calls, 1); // no retry — 404 is a real answer
});

// --- Bounded retry with backoff: transient failures (429 / 5xx / network)
// are retried up to `maxRetries` times; non-retryable 4xx throw immediately. ---

test("suggest retries a 429 then succeeds (transient throttling)", async () => {
  const { impl, state } = scriptedFetch([429, 200]);
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep });
  const data = await als.suggest({ region: "eu-west-1", key: "k", query: "x" });
  assert.deepStrictEqual(data, { ResultItems: [] });
  assert.strictEqual(state.calls, 2); // one retry
});

test("suggest retries a 503 then succeeds", async () => {
  const { impl, state } = scriptedFetch([503, 200]);
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep });
  await als.suggest({ region: "eu-west-1", key: "k", query: "x" });
  assert.strictEqual(state.calls, 2);
});

test("retries are bounded: 429 on every attempt throws after maxRetries+1 tries", async () => {
  const { impl, state } = scriptedFetch([429]); // always throttled
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(
    () => als.suggest({ region: "eu-west-1", key: "k", query: "x" }),
    /suggest.*429.*eu-west-1/
  );
  assert.strictEqual(state.calls, 3); // 1 initial + 2 retries
});

test("does NOT retry a non-retryable 4xx (expired/invalid key = 403)", async () => {
  const { impl, state } = scriptedFetch([403]);
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(
    () => als.suggest({ region: "eu-west-1", key: "bad", query: "x" }),
    /suggest.*403.*eu-west-1/
  );
  assert.strictEqual(state.calls, 1); // no retry — fail fast
});

test("does NOT retry a 404", async () => {
  const { impl, state } = scriptedFetch([404]);
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(() => als.getPlace({ region: "eu-west-1", key: "k", placeId: "p" }));
  assert.strictEqual(state.calls, 1);
});

test("retries a network error (fetch rejects) then succeeds", async () => {
  let calls = 0;
  const impl = async () => {
    calls++;
    if (calls === 1) throw new TypeError("network down");
    return { ok: true, status: 200, json: async () => ({ ResultItems: [] }) };
  };
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
  await als.suggest({ region: "eu-west-1", key: "k", query: "x" });
  assert.strictEqual(calls, 2);
});

test("a network error that never recovers throws after the retry budget", async () => {
  let calls = 0;
  const impl = async () => { calls++; throw new TypeError("network down"); };
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 1 });
  await assert.rejects(() => als.suggest({ region: "eu-west-1", key: "k", query: "x" }), /network down/);
  assert.strictEqual(calls, 2); // 1 initial + 1 retry
});

test("network-error retry log does NOT include the error message (may carry the key-bearing URL)", async () => {
  // Some fetch impls put the request URL (which carries ?key=...) in the error
  // message. The retry log must never echo it — log op + region only.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let calls = 0;
  const impl = async () => {
    calls++;
    if (calls === 1) throw new Error("request to https://places.geo.eu-west-1.amazonaws.com/v2/suggest?key=SECRETKEY failed");
    return { ok: true, status: 200, json: async () => ({ ResultItems: [] }) };
  };
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep, maxRetries: 2 });
  try {
    await als.suggest({ region: "eu-west-1", key: "SECRETKEY", query: "x" });
  } finally {
    console.warn = origWarn;
  }
  const joined = warnings.join("\n");
  assert.ok(/eu-west-1/.test(joined), "should still name the region");
  assert.ok(!/SECRETKEY/.test(joined), `log must not leak the key: ${joined}`);
  assert.ok(!/key=/.test(joined), `log must not leak a key= query string: ${joined}`);
});

test("reverseGeocodeCountry also retries transient 5xx", async () => {
  const { impl, state } = scriptedFetch([500, 200], { ResultItems: [{ Address: { Country: { Code2: "SG" } } }] });
  const als = createAlsClient({ fetchImpl: impl, sleep: noSleep });
  const cc = await als.reverseGeocodeCountry({ region: "ap-southeast-1", key: "k", lat: 1.3, lng: 103.8 });
  assert.strictEqual(cc, "SG");
  assert.strictEqual(state.calls, 2);
});

test("request timeout interrupts retry backoff and preserves the total budget", async () => {
  let calls = 0;
  const impl = async () => {
    calls++;
    return { ok: false, status: 500, text: async () => "temporary" };
  };
  // Deliberately ignore the AbortSignal: fetchOk's race must still enforce the
  // budget even when an injected sleep implementation is not signal-aware.
  const neverFinishes = () => new Promise(() => {});
  const als = createAlsClient({
    fetchImpl: impl,
    sleep: neverFinishes,
    maxRetries: 2,
    backoffMs: 10_000,
    requestTimeoutMs: 20,
  });
  const started = Date.now();
  await assert.rejects(
    () => als.suggest({ region: "eu-west-1", key: "k", query: "x" }),
    (err) => err.code === "ALS_TIMEOUT"
  );
  assert.ok(Date.now() - started < 500, "timeout should not wait for the backoff");
  assert.strictEqual(calls, 1, "no retry should start after the deadline");
});

// --- upstream cache-header logging (groundwork for a descriptor cache) ---
// Captures console.log while running fn.
async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}
// fake fetch whose response carries headers (the real fetch Response shape).
function fakeFetchWithHeaders(headers, body = {}) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  });
}

test("getStyleDescriptor logs the upstream cache headers", async () => {
  const als = createAlsClient({
    fetchImpl: fakeFetchWithHeaders({
      "cache-control": "max-age=86400",
      etag: '"abc123"',
      age: "42",
    }),
  });
  const lines = await captureLog(() =>
    als.getStyleDescriptor({ region: "eu-west-1", key: "k", styleName: "Standard" })
  );
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /eu-west-1\/Standard/);
  assert.match(lines[0], /cache-control=max-age=86400/);
  assert.match(lines[0], /etag="abc123"/);
  assert.match(lines[0], /age=42/);
});

test("cache headers are logged ONCE per (region, style), not per request", async () => {
  // The point is to learn the real values, not to emit a line per request.
  const als = createAlsClient({ fetchImpl: fakeFetchWithHeaders({ "cache-control": "max-age=1" }) });
  const lines = await captureLog(async () => {
    for (let i = 0; i < 5; i++) {
      await als.getStyleDescriptor({ region: "eu-west-1", key: "k", styleName: "Standard" });
    }
    await als.getStyleDescriptor({ region: "eu-west-1", key: "k", styleName: "Monochrome" });
    await als.getStyleDescriptor({ region: "us-east-1", key: "k", styleName: "Standard" });
  });
  assert.strictEqual(lines.length, 3, "one line per distinct (region, style)");
  assert.ok(lines.some((l) => l.includes("eu-west-1/Standard")));
  assert.ok(lines.some((l) => l.includes("eu-west-1/Monochrome")));
  assert.ok(lines.some((l) => l.includes("us-east-1/Standard")));
});

test("the cache-header log never contains the API key", async () => {
  // The request URL carries ?key=<apiKey>; logging it would leak the key to
  // CloudWatch, so only region/style/headers may be logged.
  const als = createAlsClient({ fetchImpl: fakeFetchWithHeaders({ etag: '"e"' }) });
  const lines = await captureLog(() =>
    als.getStyleDescriptor({ region: "eu-west-1", key: "v1.public.SUPERSECRET", styleName: "Standard" })
  );
  assert.strictEqual(lines.length, 1);
  assert.ok(!lines[0].includes("SUPERSECRET"), "API key leaked into the log");
  assert.ok(!lines[0].includes("key="), "request URL leaked into the log");
});

test("missing upstream cache headers log as (none) instead of throwing", async () => {
  // Some responses (and the test fakes elsewhere in this file) carry no headers.
  const als = createAlsClient({ fetchImpl: fakeFetch({}, {}) });
  const lines = await captureLog(() =>
    als.getStyleDescriptor({ region: "eu-west-1", key: "k", styleName: "Standard" })
  );
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /cache-control=\(none\).*etag=\(none\)/);
});

// --- reverseGeocodePlace (full place for a map click) ---

test("reverseGeocodePlace posts [lng,lat] and the requested language", async () => {
  const captured = {};
  const als = createAlsClient({
    fetchImpl: fakeFetch(captured, {
      ResultItems: [
        {
          PlaceId: "p1",
          PlaceType: "Street",
          Title: "Unter den Linden",
          Address: { Label: "Unter den Linden, Berlin", Country: { Code2: "DE" } },
          Position: [13.39, 52.52],
          Distance: 8,
        },
      ],
    }),
  });
  const place = await als.reverseGeocodePlace({
    region: "eu-central-1",
    key: "k",
    lat: 52.5,
    lng: 13.4,
    lang: "de",
  });
  const body = JSON.parse(captured.opts.body);
  // ALS takes GeoJSON order: longitude first.
  assert.deepStrictEqual(body.QueryPosition, [13.4, 52.5]);
  assert.strictEqual(body.Language, "de");
  assert.strictEqual(body.MaxResults, 1);
  // IntendedUse is left unset (ALS defaults to SingleUse); sending Storage would
  // change the billing rate and the terms that apply, so it must never be implicit.
  assert.strictEqual(body.IntendedUse, undefined);
  assert.strictEqual(captured.opts.method, "POST");
  assert.match(captured.url, /places\.geo\.eu-central-1\.amazonaws\.com\/v2\/reverse-geocode/);

  assert.strictEqual(place.title, "Unter den Linden");
  assert.strictEqual(place.placeType, "Street");
  assert.strictEqual(place.country, "DE");
  assert.deepStrictEqual(place.position, [13.39, 52.52]);
  assert.strictEqual(place.distanceMeters, 8);
});

test("reverseGeocodePlace omits Language when none is given", async () => {
  const captured = {};
  const als = createAlsClient({ fetchImpl: fakeFetch(captured, { ResultItems: [] }) });
  await als.reverseGeocodePlace({ region: "eu-central-1", key: "k", lat: 1, lng: 2 });
  assert.strictEqual(JSON.parse(captured.opts.body).Language, undefined);
});

test("reverseGeocodePlace returns null when there is no result", async () => {
  // Ocean / unmapped area: a legitimate empty answer, not an error.
  const als = createAlsClient({ fetchImpl: fakeFetch({}, { ResultItems: [] }) });
  const place = await als.reverseGeocodePlace({ region: "eu-central-1", key: "k", lat: 0, lng: -140 });
  assert.strictEqual(place, null);
});

test("reverseGeocodePlace throws on a non-ok HTTP response", async () => {
  const als = createAlsClient({ fetchImpl: fakeFetchError(400) });
  await assert.rejects(
    () => als.reverseGeocodePlace({ region: "ap-southeast-1", key: "k", lat: 1, lng: 1 }),
    /reverseGeocodePlace.*400.*ap-southeast-1/
  );
});

test("reverseGeocodeCountry still works after sharing the POST helper", async () => {
  // Guards the refactor: the country-only path feeds the routing grid cache and
  // must keep its exact behavior.
  const captured = {};
  const als = createAlsClient({
    fetchImpl: fakeFetch(captured, { ResultItems: [{ Address: { Country: { Code2: "SG" } } }] }),
  });
  const cc = await als.reverseGeocodeCountry({ region: "ap-southeast-1", key: "k", lat: 1.35, lng: 103.82 });
  assert.strictEqual(cc, "SG");
  const body = JSON.parse(captured.opts.body);
  assert.deepStrictEqual(body.QueryPosition, [103.82, 1.35]);
  assert.strictEqual(body.Language, undefined, "the country lookup needs no language");
});
