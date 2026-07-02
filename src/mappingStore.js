const fs = require("fs");
const { ALS_SUPPORTED_REGIONS } = require("../config/als-regions");

// Invert a region-first mapping ({region: [country,...]}) into a
// country->region Map. The region set is the mapping's top-level keys, so the
// file is the single source of truth for which regions are in use. A region
// may map to [] (no country binding) when it exists only as the fallback /
// reverse-geocode guide region. Validates ALS support and rejects duplicate
// countries. Returns { map, regions }.
function invertMapping(regionFirst) {
  const map = new Map();
  const regions = new Set();
  for (const [region, countries] of Object.entries(regionFirst)) {
    if (!ALS_SUPPORTED_REGIONS.has(region)) {
      throw new Error(`Mapping region "${region}" is not an ALS-supported region`);
    }
    regions.add(region);
    for (const raw of countries) {
      const cc = String(raw).toUpperCase();
      if (map.has(cc)) {
        throw new Error(
          `Duplicate country "${cc}" mapped to both "${map.get(cc)}" and "${region}"`
        );
      }
      map.set(cc, region);
    }
  }
  return { map, regions };
}

// Read the packaged mapping JSON file and invert+validate it.
// Returns { map, regions }.
function loadMapping(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        `Country-region mapping file not found at ${filePath}. ` +
          `Create it from the example: ` +
          `cp config/country-region-map-example.json config/country-region-map.json`
      );
    }
    throw e;
  }
  const regionFirst = JSON.parse(raw);
  return invertMapping(regionFirst);
}

// Build a store with a getRegion(countryCode) lookup and the region set.
function createMappingStore(filePath) {
  const { map, regions } = loadMapping(filePath);
  return {
    getRegion(countryCode) {
      if (!countryCode) return null;
      return map.get(String(countryCode).toUpperCase()) || null;
    },
    regions,
    size: map.size,
  };
}

module.exports = { invertMapping, loadMapping, createMappingStore };
