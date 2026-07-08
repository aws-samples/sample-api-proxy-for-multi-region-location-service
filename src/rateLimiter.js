// Basic per-source-IP rate limiting for the /api surface. This is a BASELINE
// in-process control, not a replacement for a WAF:
//   - It is per-TASK (in-memory). With N ECS tasks behind the ALB the effective
//     global rate is up to N × ratePerSec — fine as a floor, but true global
//     limiting needs a WAF rate rule or a shared store (e.g. ElastiCache).
//   - A token bucket (not a fixed per-second counter) is used so a normal typing
//     burst (autocomplete debounced at ~3 req/s) isn't falsely blocked: `burst`
//     absorbs spikes while `ratePerSec` caps the sustained rate.
// Mount it on /api only. /health MUST be exempt or the ALB health check gets
// throttled and the task is marked unhealthy.

// Resolve the real client IP. Behind CloudFront→ALB, Express only sees the ALB
// unless `trust proxy` is set — with it set, req.ip is already the real client.
// Fall back to the LEFTMOST X-Forwarded-For entry (the original client), then
// the socket address.
function clientIpFrom(req) {
  if (req.ip) return req.ip;
  const xff = req.headers && req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Token-bucket limiter. Options:
//   ratePerSec  sustained tokens added per second (default 10)
//   burst       bucket capacity / max spike (default 20)
//   idleMs      evict a source's bucket after this much inactivity (default 5min)
//   now         injectable clock (tests); defaults to Date.now
function createTokenBucketLimiter({
  ratePerSec = 10,
  burst = 20,
  idleMs = 5 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map(); // ip -> { tokens, lastRefill, lastSeen }
  let lastSweep = now();

  // Drop buckets idle beyond idleMs so memory can't grow unbounded under a
  // churn of distinct IPs. Gated to run at most once per idleMs (cheap).
  function sweep(t) {
    if (t - lastSweep < idleMs) return;
    lastSweep = t;
    for (const [ip, b] of buckets) {
      if (t - b.lastSeen > idleMs) buckets.delete(ip);
    }
  }

  function middleware(req, res, next) {
    const t = now();
    sweep(t);
    const ip = clientIpFrom(req);

    let b = buckets.get(ip);
    if (!b) {
      b = { tokens: burst, lastRefill: t, lastSeen: t };
      buckets.set(ip, b);
    }
    // Lazy refill: add tokens accrued since the last check, capped at burst.
    const elapsedSec = (t - b.lastRefill) / 1000;
    b.tokens = Math.min(burst, b.tokens + elapsedSec * ratePerSec);
    b.lastRefill = t;
    b.lastSeen = t;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return next();
    }
    // Out of tokens → 429. Retry-After is the whole seconds until one token.
    const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / ratePerSec));
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many requests, please slow down." });
  }

  middleware.size = () => buckets.size; // for tests / observability
  return middleware;
}

module.exports = { createTokenBucketLimiter, clientIpFrom };
