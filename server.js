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
const {
  normalizeLanguage,
  normalizePlacesLanguage,
  resolveMapLanguage,
  clampPlacesLanguage,
  applyPreferredLanguage,
  extractLabelExpressions,
} = require("./src/mapLanguage");
const { MAP_LABEL_LANGUAGES } = require("./config/map-languages");

const PORT = 3000;
const MAPPING_FILE = path.join(__dirname, "config", "country-region-map.json");
// Candidate ALS style ids probed at startup. Display names are a UI concern
// and belong to the frontend, so the backend deals only in style ids.
const ALL_STYLES = ["Standard", "Monochrome", "Hybrid", "Satellite"];
// The label-language list is static, so build the sorted array once instead of
// re-expanding and re-sorting the 68-entry Set on every request.
const SORTED_MAP_LABEL_LANGUAGES = [...MAP_LABEL_LANGUAGES].sort();

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

  // Map an ALS failure to the right client status. A caller-caused ALS 4xx
  // (other than 403/429) becomes 400. A 403 means the deployment key is bad,
  // while a 429 after retries means the deployment is still upstream-throttled;
  // both are server/upstream failures and therefore become a generic 500.
  function failAls(res, context, err) {
    const status = err && err.status;
    if (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      status !== 403 &&
      status !== 429
    ) {
      const scrub = (s) => String(s).replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]");
      console.error(`${context}: ${scrub(err.stack || err.message || err)}`);
      return res.status(400).json({ error: "Invalid request" });
    }
    return fail500(res, context, err);
  }

  // Validate an optional countryCode against the mapping (the single source of
  // truth for served countries). Returns the normalized upper-case code, null
  // when absent, or { error } when the code is present but unsupported — the
  // caller returns 400 so a bad/unknown code (e.g. "UK", whose ISO code is "GB")
  // never reaches ALS as a hard IncludeCountries filter (ALS 400s on it).
  function normalizeCountry(countryCode) {
    if (!countryCode) return { code: null };
    const cc = String(countryCode).toUpperCase();
    if (!mappingStore.getRegion(cc)) {
      return { error: `Unsupported countryCode "${cc}" (not a served country in the mapping)` };
    }
    return { code: cc };
  }

  // Validate an optional suggestion-count limit against the ALS Suggest contract
  // (MaxResults: integer 1-100). Returns the parsed number, undefined when absent
  // (the client applies its own smaller default), or { error } so the caller can
  // 400 — an out-of-range value would otherwise come back as an opaque upstream
  // ValidationException. Repeated ?limit params arrive as an array and are
  // rejected here too, since there is no sane value to pick.
  function normalizeLimit(limit) {
    if (limit === undefined || limit === "") return { value: undefined };
    if (!/^\d+$/.test(String(limit))) {
      return { error: "limit must be an integer between 1 and 100" };
    }
    const value = Number(limit);
    if (value < 1 || value > 100) {
      return { error: "limit must be between 1 and 100" };
    }
    return { value };
  }

  // Resolve the routing decision for a request from countryCode or lat/lng.
  // Returns the full { targetRegion, source, countryCode } so callers can reuse
  // the resolved country for language decisions instead of repeating a lookup.
  async function resolveTargetFor({ countryCode, lat, lng }) {
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
    return result;
  }

  // The country used to DEFAULT the label language, which is a DISPLAY concern and
  // therefore independent of routing. Routing usually resolves a country already;
  // when it did not attempt a lookup (routing disabled or an explicit region),
  // resolve one here. If routing already attempted and failed, do not immediately
  // repeat the same uncached failure and double the upstream load.
  async function countryForLanguage({ resolvedCountry, routingSource, lat, lng }) {
    if (resolvedCountry) return resolvedCountry;
    if (routingSource && routingSource.startsWith("reverse-")) return null;
    if (lat == null || lng == null) return null;
    return reverseGeocoder.toCountry(lat, lng);
  }

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // Browsers auto-request /favicon.ico; we don't ship one. Return 204 so it
  // doesn't show up as a 404 in the console.
  app.get("/favicon.ico", (req, res) => res.status(204).end());

  app.get("/api/suggest", async (req, res) => {
    const { query, lat, lng, countryCode, lang, limit } = req.query;
    if (!query) return res.json([]);
    const coords = parseCoords(lat, lng);
    if (!coords.valid) return res.status(400).json({ error: coords.error });
    const country = normalizeCountry(countryCode);
    if (country.error) return res.status(400).json({ error: country.error });
    const language = normalizePlacesLanguage(lang);
    if (language.error) return res.status(400).json({ error: language.error });
    const maxResults = normalizeLimit(limit);
    if (maxResults.error) return res.status(400).json({ error: maxResults.error });
    try {
      const target = await resolveTargetFor({ countryCode: country.code, lat: coords.lat, lng: coords.lng });
      const region = target.targetRegion;
      // GeoPlaces accepts BCP 47 independently of the map-label enum. An
      // explicit language passes through (subject to the GrabMaps subset); auto
      // mode follows the same country -> deployment-default chain as labels.
      const requestedLanguage =
        language.code ||
        resolveMapLanguage({
          countryCode: await countryForLanguage({
            resolvedCountry: target.countryCode,
            routingSource: target.source,
            lat: coords.lat,
            lng: coords.lng,
          }),
          defaultLanguage: config.defaultMapLanguage,
        }).language;
      const placesLanguage = clampPlacesLanguage(requestedLanguage, region, config.defaultMapLanguage);
      // Bias selection (BiasPosition is required by ALS suggest). Priority
      // matches the routing contract:
      //   - explicit countryCode -> bias to that region's center (country is
      //     authoritative; also hard-filtered below, so bias only ranks)
      //   - else real user lat/lng -> bias to it ("search near me")
      //   - else -> region (HOME) center (always inside coverage; a bias
      //     outside a region's coverage, esp. GrabMaps, can return nothing).
      const [biasLng, biasLat] =
        !country.code && coords.lat != null
          ? [coords.lng, coords.lat]
          : regionCenter(region).center;
      // countryCode also becomes a hard IncludeCountries filter, so results are
      // constrained to that country regardless of bias ranking. Validated above
      // against the mapping, so it is always a served (ISO-valid) code here.
      const includeCountries = country.code ? [country.code] : undefined;
      const data = await als.suggest({
        region,
        key: keyFor(region),
        query,
        lat: biasLat,
        lng: biasLng,
        includeCountries,
        lang: placesLanguage,
        // Upper bound only: ALS may return fewer, and the Place filter below can
        // trim further, so the response length is <= limit.
        maxResults: maxResults.value,
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
      failAls(res, "Suggest error", err);
    }
  });

  app.get("/api/place/:placeId", async (req, res) => {
    const { countryCode, lat, lng, region: regionParam, lang } = req.query;
    const coords = parseCoords(lat, lng);
    if (!coords.valid) return res.status(400).json({ error: coords.error });
    const reqCountry = normalizeCountry(countryCode);
    if (reqCountry.error) return res.status(400).json({ error: reqCountry.error });
    const language = normalizePlacesLanguage(lang);
    if (language.error) return res.status(400).json({ error: language.error });
    if (regionParam && !config.enabledRegions.has(regionParam)) {
      return res.status(400).json({ error: `Unsupported region "${regionParam}"` });
    }
    try {
      // A PlaceId is region-scoped: GetPlace must run in the region that
      // produced it. The frontend passes ?region=<suggest's region> so we use
      // it directly; fall back to normal resolution only if absent.
      const explicitRegion = regionParam || null;
      let region = explicitRegion;
      let resolvedCountry = reqCountry.code;
      let routingSource = null;
      if (!region) {
        const target = await resolveTargetFor({
          countryCode: reqCountry.code,
          lat: coords.lat,
          lng: coords.lng,
        });
        region = target.targetRegion;
        resolvedCountry = target.countryCode;
        routingSource = target.source;
      }
      const requestedLanguage =
        language.code ||
        resolveMapLanguage({
          countryCode: await countryForLanguage({
            resolvedCountry,
            routingSource,
            lat: coords.lat,
            lng: coords.lng,
          }),
          defaultLanguage: config.defaultMapLanguage,
        }).language;
      const placesLanguage = clampPlacesLanguage(requestedLanguage, region, config.defaultMapLanguage);
      const data = await als.getPlace({
        region,
        key: keyFor(region),
        placeId: req.params.placeId,
        lang: placesLanguage,
      });
      // tileRegion = the region whose map data covers the RESULT's country
      // (not necessarily the region that produced the PlaceId). The frontend
      // switches map tiles to it so a result shows its local map data.
      const country = data.Address?.Country?.Code2 || null;
      const tileRegion = (country && mappingStore.getRegion(country)) || config.homeRegion;
      res.json({ label: data.Title, position: data.Position, address: data.Address, tileRegion, country });
    } catch (err) {
      failAls(res, "GetPlace error", err);
    }
  });

  // What is at this coordinate? Backs "click the map to identify a place".
  //
  // Two ALS calls by design: the first (inside resolveTargetFor) reverse-geocodes
  // through the HOME region just to learn the country, so the DETAILED lookup can
  // then run in the region whose provider actually covers that country — which is
  // the whole point of regional routing (a Singapore click should be answered by
  // GrabMaps data, not by the home region's). The country lookup is cached in
  // ~1.1 km cells for one hour, with concurrent cold misses coalesced.
  app.get("/api/reverse-geocode", async (req, res) => {
    const coords = parseCoords(req.query.lat, req.query.lng);
    if (!coords.valid) return res.status(400).json({ error: coords.error });
    // Unlike the other endpoints, coordinates are the whole request here.
    if (coords.lat == null) {
      return res.status(400).json({ error: "lat and lng are required" });
    }
    const language = normalizePlacesLanguage(req.query.lang);
    if (language.error) return res.status(400).json({ error: language.error });
    try {
      const target = await resolveTargetFor({ lat: coords.lat, lng: coords.lng });
      const region = target.targetRegion;
      // Same precedence as the map labels: an explicit pick wins, otherwise the
      // clicked position's own country decides — so clicking in Japan yields a
      // Japanese address, whether or not multi-region routing is on. Then clamp to
      // the language subset documented for this region's provider. With an
      // explicit language the country cannot affect the result, so do not pay for
      // a second country lookup in single-region mode.
      const requestedLanguage =
        language.code ||
        resolveMapLanguage({
          countryCode: await countryForLanguage({
            resolvedCountry: target.countryCode,
            routingSource: target.source,
            lat: coords.lat,
            lng: coords.lng,
          }),
          defaultLanguage: config.defaultMapLanguage,
        }).language;
      const lang = clampPlacesLanguage(requestedLanguage, region, config.defaultMapLanguage);
      const place = await als.reverseGeocodePlace({
        region,
        key: keyFor(region),
        lat: coords.lat,
        lng: coords.lng,
        lang,
      });
      // No result is a legitimate answer (ocean, unmapped area), not an error —
      // 200 with place:null lets the client say "nothing here" instead of
      // showing a failure.
      if (!place) {
        // Same shape as the success branch (country included, just null) so a
        // client never has to branch on which keys exist.
        return res.json({ place: null, country: null, tileRegion: region, language: lang });
      }
      // tileRegion = the region whose map data covers the RESULT's country, which
      // can differ from the region we queried (a click near a border).
      const tileRegion = (place.country && mappingStore.getRegion(place.country)) || config.homeRegion;
      res.json({
        place: {
          label: place.title || place.address?.Label || null,
          address: place.address,
          position: place.position,
          placeType: place.placeType,
          distanceMeters: place.distanceMeters,
        },
        country: place.country,
        tileRegion,
        language: lang,
      });
    } catch (err) {
      failAls(res, "Reverse geocode error", err);
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

  // Shared front half of /api/map-style and /api/map-labels: validate the query,
  // pick the tile region, and decide the label language. Both endpoints MUST
  // agree on these decisions — /api/map-labels exists only to deliver the same
  // localization more cheaply, so any divergence here would be a bug.
  // Returns { error, status } on bad input, else { region, label }.
  async function resolveStyleRequest(req) {
    const styleName = req.query.style || "Standard";
    const { countryCode, lat, lng, region: regionParam, lang } = req.query;
    if (!availableStyles.includes(styleName)) {
      return { status: 400, error: `Invalid style. Allowed: ${availableStyles.join(", ")}` };
    }
    const coords = parseCoords(lat, lng);
    if (!coords.valid) return { status: 400, error: coords.error };
    const country = normalizeCountry(countryCode);
    if (country.error) return { status: 400, error: country.error };
    // Omitting ?lang is the normal case ("use the country's language"); a
    // PRESENT but unsupported code is a client bug and 400s, so a typo like
    // lang=cn (China's ISO 639-1 is "zh") never silently renders English.
    const language = normalizeLanguage(lang);
    if (language.error) return { status: 400, error: language.error };
    if (regionParam && !config.enabledRegions.has(regionParam)) {
      return { status: 400, error: `Unsupported region "${regionParam}"` };
    }

    // Explicit ?region lets the frontend switch map tiles to a selected
    // result's region (e.g. a Singapore result -> GrabMaps tiles). It also makes
    // the ROUTING decision moot, so resolving it would be pure waste.
    const explicitRegion = regionParam || null;
    let region = explicitRegion;
    let resolvedCountry = country.code;
    let routingSource = null;
    if (!region) {
      const target = await resolveTargetFor({
        countryCode: country.code,
        lat: coords.lat,
        lng: coords.lng,
      });
      region = target.targetRegion;
      resolvedCountry = target.countryCode;
      routingSource = target.source;
    }
    // Label language: explicit ?lang wins; otherwise the country decides; otherwise
    // the deployment default. The country is resolved ONLY when it can actually
    // change the outcome — with an explicit ?lang it is irrelevant, so looking it up
    // would be a wasted upstream call.
    //
    // NOTE: an explicit ?region does NOT influence the language — a region spans
    // many countries, so "which tiles" and "which language" stay independent.
    const label = resolveMapLanguage({
      lang: language.code,
      countryCode: language.code
        ? null
        : await countryForLanguage({
            resolvedCountry,
            routingSource,
            lat: coords.lat,
            lng: coords.lng,
          }),
      defaultLanguage: config.defaultMapLanguage,
    });
    return { styleName, region, label };
  }

  // Report the language that was actually applied, so a client in "auto" mode can
  // show the resolved value instead of guessing. Headers rather than body fields,
  // because /api/map-style's body must stay a valid MapLibre style (MapLibre warns
  // about unknown top-level properties). Exposed for cross-origin callers, which
  // otherwise can't read them.
  function setLanguageHeaders(res, label) {
    res.set("X-Map-Label-Language", label.language);
    res.set("X-Map-Label-Language-Source", label.source);
    res.set("Access-Control-Expose-Headers", "X-Map-Label-Language, X-Map-Label-Language-Source");
  }

  app.get("/api/map-style", async (req, res) => {
    try {
      const resolved = await resolveStyleRequest(req);
      if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
      const { styleName, region, label } = resolved;
      const style = await als.getStyleDescriptor({ region, key: keyFor(region), styleName });
      const rewritten = als.rewriteStyle(style, { region, mapTileDomain: config.mapTileDomain });
      setLanguageHeaders(res, label);
      res.json(applyPreferredLanguage(rewritten, label.language));
    } catch (err) {
      failAls(res, "Map style error", err);
    }
  });

  // Just the localized label expressions for a style, keyed by layer id — the
  // cheap path for changing ONLY the language on a map that is already loaded.
  // ~3 KB versus ~136 KB for the full descriptor, and the client applies them
  // with setLayoutProperty, avoiding a setStyle rebuild (which re-requests glyphs
  // and sprites and has to restore the view afterwards).
  //
  // Same query contract as /api/map-style, and the same server-side transform, so
  // the labels are identical to what a full reload would produce. The language
  // decision and the expression rewriting never move to the client — the client
  // only assigns the returned values. Note this still costs one upstream
  // GetStyleDescriptor call; it saves browser bandwidth and the rebuild, not ALS.
  app.get("/api/map-labels", async (req, res) => {
    try {
      const resolved = await resolveStyleRequest(req);
      if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
      const { styleName, region, label } = resolved;
      const style = await als.getStyleDescriptor({ region, key: keyFor(region), styleName });
      // rewriteStyle is deliberately skipped: it only touches tile/glyph/sprite
      // URLs and strips nulls from paint/layout, none of which affects the
      // text-field expressions extracted below. Skipping it keeps this path cheap.
      const localized = applyPreferredLanguage(style, label.language);
      setLanguageHeaders(res, label);
      res.json({
        language: label.language,
        source: label.source,
        layers: extractLabelExpressions(localized),
      });
    } catch (err) {
      failAls(res, "Map labels error", err);
    }
  });

  app.get("/api/map-styles", (req, res) => res.json(availableStyles));

  // Label languages this deployment can render, so a frontend builds its picker
  // from the server's list instead of hardcoding a copy of the ALS enum that
  // silently drifts. `default` is what a request with no ?lang and no country
  // resolves to.
  app.get("/api/map-languages", (req, res) => {
    res.json({ languages: SORTED_MAP_LABEL_LANGUAGES, default: config.defaultMapLanguage });
  });

  // Initial map view: the home region's representative center/zoom, so the map
  // opens inside coverage (critical for GrabMaps regions) instead of a
  // hardcoded default that may be outside the region's map data.
  app.get("/api/map-config", (req, res) => {
    const { center, zoom } = regionCenter(config.homeRegion);
    res.json({ center, zoom, region: config.homeRegion });
  });

  return app;
}

// Detect which styles exist in the home region (startup). A transient probe
// failure rejects startup instead of producing task-specific partial contracts.
async function detectStyles(als, config) {
  const region = config.homeRegion;
  const key = config.keyMap.get(region);
  const results = await Promise.all(
    ALL_STYLES.map(async (styleName) =>
      (await als.styleExists({ region, key, styleName })) ? styleName : null
    )
  );
  const available = results.filter(Boolean);
  // The frontend's initial style is Standard. Starting without it would pass
  // /health but render a blank page; fail fast so ECS replaces the task.
  if (!available.includes("Standard")) {
    throw new Error(
      `Required map style Standard is unavailable in home region ${region} ` +
        `(probed: ${ALL_STYLES.join(", ")}) — refusing to start.`
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
    console.log(`   Default map label language: ${config.defaultMapLanguage} (per-country defaults in config/map-languages.js)`);
    console.log(
      `   CORS allowlist: ${config.allowedOrigins.length ? config.allowedOrigins.join(", ") : "(none — cross-origin reads disabled)"}`
    );
    console.log(`   API rate limit: ${config.rateLimit.ratePerSec}/s (burst ${config.rateLimit.burst}) per source IP`);
  });

  // Graceful shutdown: on ECS deploy/scale-in the task gets SIGTERM. Stop
  // accepting new connections and let in-flight requests finish before exit to
  // reduce dropped requests during rolling deploys. A timeout guards against
  // hung sockets.
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
