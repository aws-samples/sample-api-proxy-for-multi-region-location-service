const express = require("express");
const path = require("path");
const { loadConfig } = require("./src/config");
const { createMappingStore } = require("./src/mappingStore");
const { createAlsClient } = require("./src/alsClient");
const { createReverseGeocoder } = require("./src/reverseGeocoder");
const { resolveRegion } = require("./src/regionResolver");

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
    const { query, lat, lng, countryCode } = req.query;
    if (!query) return res.json([]);
    try {
      const region = await targetRegionFor({ countryCode, lat, lng });
      const data = await als.suggest({ region, key: keyFor(region), query, lat, lng });
      const suggestions = (data.ResultItems || [])
        .filter((item) => item.SuggestResultItemType === "Place" && item.Place)
        .map((item) => ({
          placeId: item.Place?.PlaceId,
          text: item.Title,
          address: item.Place?.Address,
          position: item.Place?.Position,
        }));
      res.json(suggestions);
    } catch (err) {
      console.error("Suggest error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/place/:placeId", async (req, res) => {
    const { countryCode, lat, lng } = req.query;
    try {
      const region = await targetRegionFor({ countryCode, lat, lng });
      const data = await als.getPlace({ region, key: keyFor(region), placeId: req.params.placeId });
      res.json({ label: data.Title, position: data.Position, address: data.Address });
    } catch (err) {
      console.error("GetPlace error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/map-style", async (req, res) => {
    const styleName = req.query.style || "Standard";
    const { countryCode, lat, lng } = req.query;
    const allowed = availableStyles.map((s) => s.id);
    if (!allowed.includes(styleName)) {
      return res.status(400).json({ error: `Invalid style. Allowed: ${allowed.join(", ")}` });
    }
    try {
      const region = await targetRegionFor({ countryCode, lat, lng });
      const style = await als.getStyleDescriptor({ region, key: keyFor(region), styleName });
      res.json(als.rewriteStyle(style, { region, mapTileDomain: config.mapTileDomain }));
    } catch (err) {
      console.error("Map style error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/map-styles", (req, res) => res.json(availableStyles));

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
  // The mapping file is the single source of truth for the region set, so it is
  // loaded first; its regions feed config validation (throws → process exits).
  const mappingStore = createMappingStore(MAPPING_FILE);
  const config = loadConfig(process.env, mappingStore.regions);
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
