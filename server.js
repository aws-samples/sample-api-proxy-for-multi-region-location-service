const express = require("express");
const path = require("path");
const { loadConfig } = require("./src/config");
const { createMappingStore } = require("./src/mappingStore");
const { createAlsClient } = require("./src/alsClient");
const { createReverseGeocoder } = require("./src/reverseGeocoder");
const { resolveRegion } = require("./src/regionResolver");
const { parseCoords } = require("./src/coords");
const { createCorsMiddleware } = require("./src/cors");
const { createTokenBucketLimiter } = require("./src/rateLimiter");
const { regionCenter } = require("./config/region-centers");

const PORT = 3000;
const MAPPING_FILE = path.join(__dirname, "config", "country-region-map.json");
// Candidate ALS style ids probed at startup. Display names are a UI concern
// and belong to the frontend, so the backend deals only in style ids.
const ALL_STYLES = ["Standard", "Monochrome", "Hybrid", "Satellite"];

// Build the express app from injected dependencies (testable).
function buildApp({ config, mappingStore, als, reverseGeocoder, availableStyles }) {
  const app = express();
  // Behind CloudFront→ALB, req.ip must be the real (unspoofable) client for
  // per-IP rate limiting. TRUST_PROXY=2 (the CloudFront+ALB hop count) reads the
  // IP a fixed distance from the right of X-Forwarded-For so a viewer can't forge
  // a leftmost entry to dodge the limiter. Defaults to FALSE (fail safe) when
  // unset — production MUST set the hop count (see infra/ecs-fargate.yaml).
  app.set("trust proxy", config.trustProxy);

  // Baseline security headers on every response (no dependency needed). CSP is
  // intentionally limited to frame-ancestors (clickjacking defense) rather than
  // a script-src/default-src policy: the API returns JSON and the bundled page
  // is a reference demo that uses inline scripts + a CDN, which a strict policy
  // would break. Customers embedding the API in their own frontend apply their
  // own full CSP at their render layer.
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  app.use(express.static(path.join(__dirname, "public")));

  // CORS (default closed) + baseline per-IP rate limit, scoped to /api only.
  // /health is deliberately NOT under /api so the ALB health check is exempt.
  app.use("/api", createCorsMiddleware(config.allowedOrigins || []));
  app.use(
    "/api",
    createTokenBucketLimiter({
      ratePerSec: config.rateLimit?.ratePerSec,
      burst: config.rateLimit?.burst,
    })
  );

  const keyFor = (region) => config.keyMap.get(region);

  // Log the error server-side, return a generic message to the client.
  // Internal/ALS error detail (status, region, key hints) must never leak to
  // callers — they get a 500 with a stable, non-revealing body.
  //
  // The log itself is scrubbed too: a network-level fetch rejection can carry
  // the request URL — which includes ?key=<apiKey> — in err.message/err.stack.
  // Redact any key= querystring before it reaches CloudWatch. We log the
  // sanitized message/stack strings (not the raw Error) so nothing bypasses it.
  function fail500(res, context, err) {
    const scrub = (s) => String(s).replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]");
    const detail = err && (err.stack || err.message || err);
    console.error(`${context}: ${scrub(detail)}`);
    res.status(500).json({ error: "Internal server error" });
  }

  // Resolve target region for a request from countryCode or lat/lng.
  async function targetRegionFor({ countryCode, lat, lng }) {
    const result = await resolveRegion(
      { countryCode, lat, lng, routingEnabled: config.routingEnabled },
      {
        homeRegion: config.homeRegion,
        getRegion: (cc) => mappingStore.getRegion(cc),
        reverseGeocodeToCountry: (la, ln) => reverseGeocoder.toCountry(la, ln),
      }
    );
    if (result.source.endsWith("fallback")) {
      console.warn(`[routing] fallback to ${result.targetRegion} (source=${result.source})`);
    }
    return result.targetRegion;
  }

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // Browsers auto-request /favicon.ico; we don't ship one. Return 204 so it
  // doesn't show up as a 404 in the console.
  app.get("/favicon.ico", (req, res) => res.status(204).end());

  app.get("/api/suggest", async (req, res) => {
    const { query, lat, lng, countryCode, lang } = req.query;
    if (!query) return res.json([]);
    const coords = parseCoords(lat, lng);
    if (!coords.valid) return res.status(400).json({ error: coords.error });
    try {
      const region = await targetRegionFor({ countryCode, lat: coords.lat, lng: coords.lng });
      // Bias selection (BiasPosition is required by ALS suggest). Priority
      // matches the routing contract:
      //   - explicit countryCode -> bias to that region's center (country is
      //     authoritative; also hard-filtered below, so bias only ranks)
      //   - else real user lat/lng -> bias to it ("search near me")
      //   - else -> region (HOME) center (always inside coverage; a bias
      //     outside a region's coverage, esp. GrabMaps, can return nothing).
      const [biasLng, biasLat] =
        !countryCode && coords.lat != null
          ? [coords.lng, coords.lat]
          : regionCenter(region).center;
      // countryCode also becomes a hard IncludeCountries filter, so results are
      // constrained to that country regardless of bias ranking.
      const includeCountries = countryCode ? [String(countryCode).toUpperCase()] : undefined;
      const data = await als.suggest({
        region,
        key: keyFor(region),
        query,
        lat: biasLat,
        lng: biasLng,
        includeCountries,
        lang,
      });
      const suggestions = (data.ResultItems || [])
        .filter((item) => item.SuggestResultItemType === "Place" && item.Place)
        .map((item) => ({
          placeId: item.Place?.PlaceId,
          text: item.Title,
          address: item.Place?.Address,
          position: item.Place?.Position,
          // The region that produced this PlaceId. A PlaceId is region-scoped,
          // so GetPlace must run in the SAME region — the frontend passes this
          // back on /api/place. (GrabMaps suggest omits Position, forcing the
          // GetPlace call, which is where the mismatch used to surface.)
          region,
        }));
      res.json(suggestions);
    } catch (err) {
      fail500(res, "Suggest error", err);
    }
  });

  app.get("/api/place/:placeId", async (req, res) => {
    const { countryCode, lat, lng, region: regionParam, lang } = req.query;
    const coords = parseCoords(lat, lng);
    if (!coords.valid) return res.status(400).json({ error: coords.error });
    try {
      // A PlaceId is region-scoped: GetPlace must run in the region that
      // produced it. The frontend passes ?region=<suggest's region> so we use
      // it directly; fall back to normal resolution only if absent.
      const region =
        regionParam && config.enabledRegions.has(regionParam)
          ? regionParam
          : await targetRegionFor({ countryCode, lat: coords.lat, lng: coords.lng });
      const data = await als.getPlace({ region, key: keyFor(region), placeId: req.params.placeId, lang });
      // tileRegion = the region whose map data covers the RESULT's country
      // (not necessarily the region that produced the PlaceId). The frontend
      // switches map tiles to it so a result shows its local map data.
      const country = data.Address?.Country?.Code2 || null;
      const tileRegion = (country && mappingStore.getRegion(country)) || config.homeRegion;
      res.json({ label: data.Title, position: data.Position, address: data.Address, tileRegion, country });
    } catch (err) {
      fail500(res, "GetPlace error", err);
    }
  });

  // Map a coordinate to the region whose map data covers its country. Used for
  // HERE suggestions that carry a position (no GetPlace call) so the frontend
  // can still switch tiles to the result's local region.
  app.get("/api/tile-region", async (req, res) => {
    const coords = parseCoords(req.query.lat, req.query.lng);
    if (!coords.valid) return res.status(400).json({ error: coords.error });
    try {
      let tileRegion = config.homeRegion;
      let country = null;
      if (coords.lat != null) {
        country = await reverseGeocoder.toCountry(coords.lat, coords.lng);
        if (country) tileRegion = mappingStore.getRegion(country) || config.homeRegion;
      }
      res.json({ tileRegion, country });
    } catch (err) {
      fail500(res, "tile-region error", err);
    }
  });

  app.get("/api/map-style", async (req, res) => {
    const styleName = req.query.style || "Standard";
    const { countryCode, lat, lng, region: regionParam } = req.query;
    if (!availableStyles.includes(styleName)) {
      return res.status(400).json({ error: `Invalid style. Allowed: ${availableStyles.join(", ")}` });
    }
    const coords = parseCoords(lat, lng);
    if (!coords.valid) return res.status(400).json({ error: coords.error });
    try {
      // Explicit ?region lets the frontend switch map tiles to a selected
      // result's region (e.g. a Singapore result -> GrabMaps tiles).
      const region =
        regionParam && config.enabledRegions.has(regionParam)
          ? regionParam
          : await targetRegionFor({ countryCode, lat: coords.lat, lng: coords.lng });
      const style = await als.getStyleDescriptor({ region, key: keyFor(region), styleName });
      res.json(als.rewriteStyle(style, { region, mapTileDomain: config.mapTileDomain }));
    } catch (err) {
      fail500(res, "Map style error", err);
    }
  });

  app.get("/api/map-styles", (req, res) => res.json(availableStyles));

  // Initial map view: the home region's representative center/zoom, so the map
  // opens inside coverage (critical for GrabMaps regions) instead of a
  // hardcoded default that may be outside the region's map data.
  app.get("/api/map-config", (req, res) => {
    const { center, zoom } = regionCenter(config.homeRegion);
    res.json({ center, zoom, region: config.homeRegion });
  });

  return app;
}

// Detect which styles exist in the home region (startup).
async function detectStyles(als, config) {
  const region = config.homeRegion;
  const key = config.keyMap.get(region);
  const results = await Promise.all(
    ALL_STYLES.map(async (styleName) => {
      try {
        return (await als.styleExists({ region, key, styleName })) ? styleName : null;
      } catch {
        return null;
      }
    })
  );
  const available = results.filter(Boolean);
  // A transient ALS blip at boot can make every probe fail, leaving a task that
  // passes /health but serves no styles (empty switcher + 400 on every
  // map-style). Fail fast instead so ECS never routes traffic to it and
  // replaces it — a healthy region always has at least "Standard".
  if (!available.length) {
    throw new Error(
      `No map styles detected in home region ${region} (probed: ${ALL_STYLES.join(", ")}). ` +
        `ALS may be unreachable or the API key is invalid — refusing to start.`
    );
  }
  return available;
}

async function main() {
  // The mapping file is the single source of truth for both the region set and
  // the home region (its "*" marker), so it is loaded first; both feed config
  // validation (throws → process exits).
  const mappingStore = createMappingStore(MAPPING_FILE);
  const config = loadConfig(process.env, {
    regions: mappingStore.regions,
    homeRegion: mappingStore.homeRegion,
  });
  const als = createAlsClient();
  const reverseGeocoder = createReverseGeocoder({
    homeRegion: config.homeRegion,
    getKey: (r) => config.keyMap.get(r),
    reverseGeocodeCountry: als.reverseGeocodeCountry,
    maxSize: config.reverseGeoCacheMax,
  });
  const availableStyles = await detectStyles(als, config);

  const app = buildApp({ config, mappingStore, als, reverseGeocoder, availableStyles });
  const server = app.listen(PORT, () => {
    console.log(`🗺️  Proxy running at http://localhost:${PORT}`);
    console.log(`   Home region (mapping "*"): ${config.homeRegion}`);
    console.log(`   MULTI_REGION_ROUTING: ${config.routingEnabled}`);
    console.log(`   Regions (from mapping): ${[...config.enabledRegions].join(", ")}`);
    console.log(`   Mapping entries: ${mappingStore.size}`);
    console.log(`   Available styles: ${availableStyles.join(", ")}`);
    console.log(
      `   CORS allowlist: ${config.allowedOrigins.length ? config.allowedOrigins.join(", ") : "(none — same-origin only)"}`
    );
    console.log(`   API rate limit: ${config.rateLimit.ratePerSec}/s (burst ${config.rateLimit.burst}) per source IP`);
  });

  // Graceful shutdown: on ECS deploy/scale-in the task gets SIGTERM. Stop
  // accepting new connections and let in-flight requests finish before exit, so
  // a rolling deploy drops zero requests. A timeout guards against hung sockets.
  const shutdown = (signal) => {
    console.log(`${signal} received — shutting down gracefully`);
    server.close(() => {
      console.log("Closed remaining connections, exiting");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Startup failed:", err.message);
    process.exit(1);
  });
}

module.exports = { buildApp, detectStyles };
