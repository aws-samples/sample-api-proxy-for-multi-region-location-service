// CORS for the /api surface. The proxy is the deliverable, and a customer may
// host their own frontend on a DIFFERENT origin — without CORS the browser
// blocks those cross-origin calls. This is DEFAULT-CLOSED: with no allowlist
// configured, no CORS headers are sent (same-origin only), so the API is never
// accidentally opened to the whole web (which would let any site burn the
// account's ALS quota). Set ALLOWED_ORIGINS to opt specific origins in.
//
// The API carries no cookies/credentials (keys live server-side), so this is
// about controlling WHO may call the API, not CSRF.

// Parse the ALLOWED_ORIGINS env (comma-separated) into a trimmed list.
// Empty/undefined → [] (same-origin only).
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
