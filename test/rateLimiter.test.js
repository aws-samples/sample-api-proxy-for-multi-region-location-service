const { test } = require("node:test");
const assert = require("node:assert");
const { createTokenBucketLimiter, clientIpFrom } = require("../src/rateLimiter");

// A controllable clock so token refill is deterministic (no real time).
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function fakeReqRes(ip, { xff, trustProxy = true } = {}) {
  const headers = {};
  const req = {
    ip,
    headers: xff ? { "x-forwarded-for": xff } : {},
    app: { get: (k) => (k === "trust proxy" ? trustProxy : undefined) },
    socket: { remoteAddress: ip },
  };
  const res = {
    statusCode: 200,
    body: null,
    _headers: headers,
    set(k, v) { headers[k.toLowerCase()] = v; return this; },
    get(k) { return headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return { req, res };
}

test("clientIpFrom reads the leftmost X-Forwarded-For entry when trust proxy is on", () => {
  const { req } = fakeReqRes("10.0.0.5", { xff: "203.0.113.7, 70.1.2.3, 10.0.0.5" });
  // Express with 'trust proxy' sets req.ip to the real client; we prefer req.ip,
  // but fall back to the leftmost XFF entry.
  assert.strictEqual(clientIpFrom(req), "10.0.0.5"); // req.ip wins when present
});

test("clientIpFrom falls back to leftmost XFF when req.ip is absent", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.7, 70.1.2.3" }, socket: {} };
  assert.strictEqual(clientIpFrom(req), "203.0.113.7");
});

test("allows a burst up to capacity, then 429s", () => {
  const clock = fakeClock();
  const mw = createTokenBucketLimiter({ ratePerSec: 5, burst: 5, now: clock.now });
  const results = [];
  for (let i = 0; i < 7; i++) {
    const { req, res } = fakeReqRes("1.2.3.4");
    mw(req, res, () => (res.statusCode = 200));
    results.push(res.statusCode);
  }
  // first 5 pass (burst), next 2 are limited
  assert.deepStrictEqual(results, [200, 200, 200, 200, 200, 429, 429]);
});

test("refills over time: after 1s at 5/s, 5 more requests pass", () => {
  const clock = fakeClock();
  const mw = createTokenBucketLimiter({ ratePerSec: 5, burst: 5, now: clock.now });
  for (let i = 0; i < 5; i++) {
    const { req, res } = fakeReqRes("1.2.3.4");
    mw(req, res, () => {});
  }
  // bucket empty now; next is limited
  let { req, res } = fakeReqRes("1.2.3.4");
  mw(req, res, () => (res.statusCode = 200));
  assert.strictEqual(res.statusCode, 429);

  clock.advance(1000); // refill 5 tokens
  const after = [];
  for (let i = 0; i < 6; i++) {
    const rr = fakeReqRes("1.2.3.4");
    mw(rr.req, rr.res, () => (rr.res.statusCode = 200));
    after.push(rr.res.statusCode);
  }
  assert.deepStrictEqual(after, [200, 200, 200, 200, 200, 429]);
});

test("separate IPs get separate buckets", () => {
  const clock = fakeClock();
  const mw = createTokenBucketLimiter({ ratePerSec: 2, burst: 2, now: clock.now });
  const hit = (ip) => {
    const { req, res } = fakeReqRes(ip);
    mw(req, res, () => (res.statusCode = 200));
    return res.statusCode;
  };
  assert.strictEqual(hit("1.1.1.1"), 200);
  assert.strictEqual(hit("1.1.1.1"), 200);
  assert.strictEqual(hit("1.1.1.1"), 429); // A exhausted
  assert.strictEqual(hit("2.2.2.2"), 200); // B unaffected
});

test("429 response sets Retry-After and a JSON error body", () => {
  const clock = fakeClock();
  const mw = createTokenBucketLimiter({ ratePerSec: 1, burst: 1, now: clock.now });
  let { req, res } = fakeReqRes("9.9.9.9");
  mw(req, res, () => {}); // consume the one token
  ({ req, res } = fakeReqRes("9.9.9.9"));
  mw(req, res, () => {});
  assert.strictEqual(res.statusCode, 429);
  assert.ok(res.get("retry-after"), "Retry-After header should be set");
  assert.ok(res.body && res.body.error, "should return a JSON error body");
});

test("idle buckets are evicted so memory doesn't grow unbounded", () => {
  const clock = fakeClock();
  const mw = createTokenBucketLimiter({ ratePerSec: 5, burst: 5, now: clock.now, idleMs: 10_000 });
  const { req, res } = fakeReqRes("3.3.3.3");
  mw(req, res, () => {});
  assert.strictEqual(mw.size(), 1);
  clock.advance(11_000); // exceed idleMs
  const rr = fakeReqRes("4.4.4.4");
  mw(rr.req, rr.res, () => {}); // this call triggers a sweep
  // 3.3.3.3 was idle > idleMs → evicted; only 4.4.4.4 remains
  assert.strictEqual(mw.size(), 1);
});
