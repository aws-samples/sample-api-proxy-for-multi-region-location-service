// CORS response policy for the /api surface. With no allowlist configured,
// cross-origin browser JavaScript cannot read responses; set ALLOWED_ORIGINS to
// expose them to specific frontend origins. This is not authentication or a
// quota boundary: non-browser clients can omit/spoof Origin, and a disallowed
// simple request may still reach the server even though the browser hides its
// response. Use rate limiting, WAF, and origin protection for abuse controls.
//
// The API carries no cookies/credentials (keys live server-side), so CSRF is not
// the concern here.

// Parse the ALLOWED_ORIGINS env (comma-separated) into a trimmed list.
// Empty/undefined → [] (no cross-origin response headers).
function parseAllowedOrigins(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Build an Express middleware enforcing the allowlist. `allowed` is the parsed
// list; "*" in it means "allow any origin" (still echoes the specific origin so
// it composes with credentials-less requests and with Vary caching).
function createCorsMiddleware(allowed) {
  const allowAny = allowed.includes("*");
  const set = new Set(allowed);

  return function cors(req, res, next) {
    const origin = req.headers && req.headers.origin;
    // No Origin header → same-origin or a server-to-server call; nothing to do.
    if (!origin) return next();

    const isAllowed = allowAny || set.has(origin);
    if (isAllowed) {
      res.set("Access-Control-Allow-Origin", origin);
      // Response varies by Origin, so shared caches must key on it.
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Max-Age", "600");
    }

    // Preflight: answer here so it never falls through to a route. A disallowed
    // preflight simply lacks the allow headers, and the browser blocks it.
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = { parseAllowedOrigins, createCorsMiddleware };
