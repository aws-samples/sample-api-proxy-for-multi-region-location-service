const { test } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { loadConfig } = require("../src/config");

// Verifies the actual runtime behavior our rate limiter depends on: with
// TRUST_PROXY=2 (the CloudFront→ALB hop count), Express resolves req.ip to the
// REAL client IP — not the ALB (socket peer), not the CloudFront edge, and not
// a client-forged X-Forwarded-For entry.
//
// Chain at the ECS task in production:
//   socket peer      = ALB private IP        (proxy-addr index 0)
//   X-Forwarded-For  = <client>, <cloudfront>  (cloudfront = index 1, client = index 2)
// `trust proxy` = 2 counts 2 hops from the RIGHT (socket side), so it returns
// index 2 = the client. Counting from the right is what makes a forged LEFTMOST
// entry unreachable.
//
// In these tests 127.0.0.1 plays the ALB (the socket peer); the XFF header
// supplies the cloudfront + client (+ any spoofed) entries.

// Build a tiny app configured EXACTLY as server.js does: trust proxy comes from
// loadConfig(TRUST_PROXY=...). A /whoami route echoes the resolved req.ip.
function appWithTrustProxy(trustProxyEnv) {
  const cfg = loadConfig(
    { LOCATION_API_KEYS: '{"us-east-1":"k"}', MAP_TILE_DOMAIN: "d", TRUST_PROXY: trustProxyEnv },
    { regions: new Set(["us-east-1"]), homeRegion: "us-east-1" }
  );
  const app = express();
  app.set("trust proxy", cfg.trustProxy);
  app.get("/whoami", (req, res) => res.json({ ip: req.ip, ips: req.ips }));
  return app;
}

async function whoami(trustProxyEnv, xff) {
  const app = appWithTrustProxy(trustProxyEnv);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
      headers: xff ? { "X-Forwarded-For": xff } : {},
    });
    return res.json();
  } finally {
    server.close();
  }
}

const CLIENT = "203.0.113.7"; // the real viewer
const CLOUDFRONT = "130.176.0.1"; // the CloudFront edge (appended by CloudFront)
const SPOOF = "1.2.3.4"; // a value the viewer forged into X-Forwarded-For

test("TRUST_PROXY=2 resolves req.ip to the real client (CloudFront→ALB chain)", async () => {
  // XFF as the task sees it: "<client>, <cloudfront>"; socket peer (127.0.0.1)
  // stands in for the ALB.
  const { ip } = await whoami("2", `${CLIENT}, ${CLOUDFRONT}`);
  assert.strictEqual(ip, CLIENT, `expected the client IP, got ${ip}`);
});

test("TRUST_PROXY=2 does NOT return the ALB (socket) or CloudFront IP", async () => {
  const { ip } = await whoami("2", `${CLIENT}, ${CLOUDFRONT}`);
  assert.notStrictEqual(ip, CLOUDFRONT, "must not be the CloudFront edge IP");
  assert.notStrictEqual(ip, "127.0.0.1", "must not be the ALB/socket IP");
  assert.notStrictEqual(ip, "::ffff:127.0.0.1", "must not be the ALB/socket IP");
});

test("TRUST_PROXY=2 ignores a client-forged LEFTMOST X-Forwarded-For entry (unspoofable)", async () => {
  // Attacker prepends a fake IP; CloudFront appends the real client, then ALB
  // appends the CloudFront edge → "<spoof>, <client>, <cloudfront>". Counting 2
  // from the right still lands on the real client — the spoof is never used.
  const { ip } = await whoami("2", `${SPOOF}, ${CLIENT}, ${CLOUDFRONT}`);
  assert.strictEqual(ip, CLIENT, `spoofed entry must be ignored, got ${ip}`);
  assert.notStrictEqual(ip, SPOOF, "must never trust the forged leftmost entry");
});

test("default (unset) TRUST_PROXY keys on the socket IP, never a spoofed XFF", async () => {
  // With the fail-safe default (false), req.ip is the socket peer regardless of
  // any X-Forwarded-For — stricter, but never spoofable.
  const { ip } = await whoami(undefined, `${SPOOF}, ${CLIENT}`);
  assert.notStrictEqual(ip, SPOOF, "unset default must not trust XFF");
  assert.notStrictEqual(ip, CLIENT, "unset default reads the socket, not XFF");
  assert.match(ip, /127\.0\.0\.1$/, `expected the socket IP, got ${ip}`);
});
