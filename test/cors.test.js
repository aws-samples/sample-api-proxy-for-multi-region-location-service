const { test } = require("node:test");
const assert = require("node:assert");
const { parseAllowedOrigins, createCorsMiddleware } = require("../src/cors");

// Minimal fake req/res to exercise the middleware without a live server.
function fakeReqRes(origin, method = "GET") {
  const headers = {};
  const req = { method, headers: origin ? { origin } : {}, get: (h) => req.headers[h.toLowerCase()] };
  const res = {
    statusCode: 200,
    ended: false,
    _headers: headers,
    set(k, v) { headers[k.toLowerCase()] = v; return this; },
    get(k) { return headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    end() { this.ended = true; return this; },
  };
  return { req, res };
}

test("parseAllowedOrigins splits a comma list and trims", () => {
  assert.deepStrictEqual(
    parseAllowedOrigins("https://a.com, https://b.com ,https://c.com"),
    ["https://a.com", "https://b.com", "https://c.com"]
  );
});

test("parseAllowedOrigins returns [] for empty/undefined (same-origin only)", () => {
  assert.deepStrictEqual(parseAllowedOrigins(undefined), []);
  assert.deepStrictEqual(parseAllowedOrigins(""), []);
  assert.deepStrictEqual(parseAllowedOrigins("   "), []);
});

test("no allowed origins → middleware adds NO CORS header (default closed)", () => {
  const mw = createCorsMiddleware([]);
  const { req, res } = fakeReqRes("https://evil.com");
  let nexted = false;
  mw(req, res, () => (nexted = true));
  assert.strictEqual(res.get("access-control-allow-origin"), undefined);
  assert.ok(nexted);
});

test("allowed origin is echoed back with Vary: Origin", () => {
  const mw = createCorsMiddleware(["https://app.customer.com"]);
  const { req, res } = fakeReqRes("https://app.customer.com");
  let nexted = false;
  mw(req, res, () => (nexted = true));
  assert.strictEqual(res.get("access-control-allow-origin"), "https://app.customer.com");
  assert.match(res.get("vary") || "", /Origin/);
  assert.ok(nexted);
});

test("disallowed origin gets NO allow header (request still proceeds; browser blocks)", () => {
  const mw = createCorsMiddleware(["https://app.customer.com"]);
  const { req, res } = fakeReqRes("https://evil.com");
  mw(req, res, () => {});
  assert.strictEqual(res.get("access-control-allow-origin"), undefined);
});

test("wildcard '*' allows any origin (echoes the specific origin)", () => {
  const mw = createCorsMiddleware(["*"]);
  const { req, res } = fakeReqRes("https://anything.example");
  mw(req, res, () => {});
  assert.strictEqual(res.get("access-control-allow-origin"), "https://anything.example");
});

test("OPTIONS preflight from an allowed origin short-circuits with 204", () => {
  const mw = createCorsMiddleware(["https://app.customer.com"]);
  const { req, res } = fakeReqRes("https://app.customer.com", "OPTIONS");
  let nexted = false;
  mw(req, res, () => (nexted = true));
  assert.strictEqual(res.statusCode, 204);
  assert.ok(res.ended);
  assert.ok(!nexted, "preflight must not fall through to the route");
  assert.match(res.get("access-control-allow-methods") || "", /GET/);
});

test("request with no Origin header is untouched (same-origin / server-to-server)", () => {
  const mw = createCorsMiddleware(["https://app.customer.com"]);
  const { req, res } = fakeReqRes(undefined);
  let nexted = false;
  mw(req, res, () => (nexted = true));
  assert.strictEqual(res.get("access-control-allow-origin"), undefined);
  assert.ok(nexted);
});
