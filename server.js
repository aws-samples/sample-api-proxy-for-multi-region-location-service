const express = require("express");
const path = require("path");
const { loadConfig } = require("./src/config");
const { createMappingStore } = require("./src/mappingStore");
const { createAlsClient } = require("./src/alsClient");
const { createReverseGeocoder } = require("./src/reverseGeocoder");
const { resolveRegion } = require("./src/regionResolver");
const { regionCenter } = require("./config/region-centers");

const PORT = 3000;
const MAPPING_FILE = path.join(__dirname, "config", "country-region-map.json");
const ALL_STYLES = [
  { id: "Standard", label: "标准" },
  { id: "Monochrome", label: "单色" },
  { id: "Hybrid", label: "混合" },
  { id: "Satellite", label: "卫星" },
];

// Build the express app from injected dependencies (testable).
function buildApp({ config, mappingStore, als, reverseGeocoder, availableStyles }) {
  const app = express();
  app.use(express.static("public"));

  const keyFor = (region) => config.keyMap.get(region);

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

  app.get("/api/suggest", async (req, res) => {
    const { query, lat, lng, countryCode, lang } = req.query;
    if (!query) return res.json([]);
    try {
      const region = await targetRegionFor({ countryCode, lat, lng });
      // Bias selection (BiasPosition is required by ALS suggest). Priority
      // matches the routing contract:
      //   - explicit countryCode -> bias to that region's center (country is
      //     authoritative; also hard-filtered below, so bias only ranks)
      //   - else real user lat/lng -> bias to it ("search near me")
      //   - else -> region (HOME) center (always inside coverage; a bias
      //     outside a region's coverage, esp. GrabMaps, can return nothing).
      const [biasLng, biasLat] =
        !countryCode && lat != null && lng != null
          ? [parseFloat(lng), parseFloat(lat)]
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
      console.error("Suggest error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/place/:placeId", async (req, res) => {
    const { countryCode, lat, lng, region: regionParam, lang } = req.query;
    try {
      // A PlaceId is region-scoped: GetPlace must run in the region that
      // produced it. The frontend passes ?region=<suggest's region> so we use
      // it directly; fall back to normal resolution only if absent.
      const region =
        regionParam && config.enabledRegions.has(regionParam)
          ? regionParam
          : await targetRegionFor({ countryCode, lat, lng });
      const data = await als.getPlace({ region, key: keyFor(region), placeId: req.params.placeId, lang });
      res.json({ label: data.Title, position: data.Position, address: data.Address });
    } catch (err) {
      console.error("GetPlace error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/map-style", async (req, res) => {
    const styleName = req.query.style || "Standard";
    const { countryCode, lat, lng, region: regionParam } = req.query;
    const allowed = availableStyles.map((s) => s.id);
    if (!allowed.includes(styleName)) {
      return res.status(400).json({ error: `Invalid style. Allowed: ${allowed.join(", ")}` });
    }
    try {
      // Explicit ?region lets the frontend switch map tiles to a selected
      // result's region (e.g. a Singapore result -> GrabMaps tiles).
      const region =
        regionParam && config.enabledRegions.has(regionParam)
          ? regionParam
          : await targetRegionFor({ countryCode, lat, lng });
      const style = await als.getStyleDescriptor({ region, key: keyFor(region), styleName });
      res.json(als.rewriteStyle(style, { region, mapTileDomain: config.mapTileDomain }));
    } catch (err) {
      console.error("Map style error:", err);
      res.status(500).json({ error: err.message });
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

// Detect which styles exist in HOME_REGION (startup).
async function detectStyles(als, config) {
  const region = config.homeRegion;
  const key = config.keyMap.get(region);
  const results = await Promise.all(
    ALL_STYLES.map(async (s) => {
      try {
        return (await als.styleExists({ region, key, styleName: s.id })) ? s : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
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
  });
  const availableStyles = await detectStyles(als, config);

  const app = buildApp({ config, mappingStore, als, reverseGeocoder, availableStyles });
  app.listen(PORT, () => {
    console.log(`🗺️  Proxy running at http://localhost:${PORT}`);
    console.log(`   HOME_REGION: ${config.homeRegion}`);
    console.log(`   MULTI_REGION_ROUTING: ${config.routingEnabled}`);
    console.log(`   Regions (from mapping): ${[...config.enabledRegions].join(", ")}`);
    console.log(`   Mapping entries: ${mappingStore.size}`);
    console.log(`   Available styles: ${availableStyles.map((s) => s.id).join(", ")}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Startup failed:", err.message);
    process.exit(1);
  });
}

module.exports = { buildApp, detectStyles };
