const express = require("express");

const app = express();
const PORT = 3000;
const REGION = process.env.AWS_REGION || "us-east-1";
const API_KEY = process.env.LOCATION_API_KEY;
const MAP_TILE_DOMAIN = process.env.MAP_TILE_DOMAIN; // CloudFront domain for map tiles

if (!API_KEY) {
  console.error("❌ 请设置环境变量 LOCATION_API_KEY");
  process.exit(1);
}
if (!MAP_TILE_DOMAIN) {
  console.error("❌ 请设置环境变量 MAP_TILE_DOMAIN（CloudFront 域名）");
  process.exit(1);
}

const GEO_PLACES_BASE = `https://places.geo.${REGION}.amazonaws.com`;

app.use(express.static("public"));

// Health check for ALB
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Address autocomplete suggestions
app.get("/api/suggest", async (req, res) => {
  const { query, lat, lng } = req.query;
  if (!query) return res.json([]);

  const params = new URLSearchParams({
    key: API_KEY,
  });

  const body = {
    QueryText: query,
    Language: "zh",
    MaxResults: 5,
  };
  if (lat && lng) body.BiasPosition = [parseFloat(lng), parseFloat(lat)];

  try {
    const resp = await fetch(`${GEO_PLACES_BASE}/v2/suggest?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    const suggestions = (data.ResultItems || [])
      .filter(item => item.SuggestResultItemType === "Place" && item.Place)
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

// Get place details by PlaceId
app.get("/api/place/:placeId", async (req, res) => {
  const params = new URLSearchParams({ key: API_KEY, language: "zh" });

  try {
    const resp = await fetch(
      `${GEO_PLACES_BASE}/v2/place/${req.params.placeId}?${params}`
    );
    const data = await resp.json();

    res.json({
      label: data.Title,
      position: data.Position,
      address: data.Address,
    });
  } catch (err) {
    console.error("GetPlace error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Map config for frontend - API Key is NOT exposed, tiles go through CloudFront
app.get("/api/map-config", (req, res) => {
  res.json({
    region: REGION,
    // Style descriptor goes through CloudFront (CF Function injects the key)
    styleUrl: `https://${MAP_TILE_DOMAIN}/v2/styles/Standard/descriptor`,
    // Tile base URL also goes through CloudFront
    tileBaseUrl: `https://${MAP_TILE_DOMAIN}`,
  });
});

// Proxy the style descriptor server-side to avoid CORS issues,
// and rewrite tile/glyph/sprite URLs to go through CloudFront
app.get("/api/map-style", async (req, res) => {
  const style_name = req.query.style || "Standard";
  const allowed = availableStyles.map(s => s.id);
  if (!allowed.includes(style_name)) {
    return res.status(400).json({ error: `Invalid style. Allowed: ${allowed.join(", ")}` });
  }

  try {
    const resp = await fetch(
      `https://maps.geo.${REGION}.amazonaws.com/v2/styles/${style_name}/descriptor?key=${API_KEY}`
    );
    const style = await resp.json();

    const amazonOrigin = `https://maps.geo.${REGION}.amazonaws.com`;
    const cfOrigin = `https://${MAP_TILE_DOMAIN}`;

    // Rewrite tile source URLs
    if (style.sources) {
      for (const src of Object.values(style.sources)) {
        if (src.tiles) {
          src.tiles = src.tiles.map(url =>
            url.replace(amazonOrigin, cfOrigin).replace(/[?&]key=[^&]+/g, "")
          );
        }
        if (src.url) {
          src.url = src.url.replace(amazonOrigin, cfOrigin).replace(/[?&]key=[^&]+/g, "");
        }
      }
    }
    if (style.glyphs) {
      style.glyphs = style.glyphs.replace(amazonOrigin, cfOrigin).replace(/[?&]key=[^&]+/g, "");
    }
    if (style.sprite) {
      style.sprite = style.sprite.replace(amazonOrigin, cfOrigin).replace(/[?&]key=[^&]+/g, "");
    }

    // Remove null values from layer paint/layout properties
    // Amazon Location style may contain null values that MapLibre rejects
    if (style.layers) {
      style.layers = style.layers.map(layer => {
        const clean = (obj) => {
          if (!obj) return obj;
          return Object.fromEntries(
            Object.entries(obj).filter(([, v]) => v !== null)
          );
        };
        return {
          ...layer,
          paint: clean(layer.paint),
          layout: clean(layer.layout),
        };
      });
    }

    res.json(style);
  } catch (err) {
    console.error("Map style error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Detect available map styles at startup
const ALL_STYLES = [
  { id: "Standard", label: "标准" },
  { id: "Monochrome", label: "单色" },
  { id: "Hybrid", label: "混合" },
  { id: "Satellite", label: "卫星" },
];
let availableStyles = [];

async function detectStyles() {
  const results = await Promise.all(
    ALL_STYLES.map(async (s) => {
      try {
        const resp = await fetch(
          `https://maps.geo.${REGION}.amazonaws.com/v2/styles/${s.id}/descriptor?key=${API_KEY}`,
          { method: "HEAD" }
        );
        return resp.ok ? s : null;
      } catch {
        return null;
      }
    })
  );
  availableStyles = results.filter(Boolean);
  console.log(`   Available styles: ${availableStyles.map(s => s.id).join(", ")}`);
}

// Available map styles (detected at startup)
app.get("/api/map-styles", (req, res) => {
  res.json(availableStyles);
});

detectStyles().then(() => {
  app.listen(PORT, () => {
    console.log(`🗺️  Demo running at http://localhost:${PORT}`);
    console.log(`   Region: ${REGION}`);
  });
});
