const fs = require("fs");
const { ALS_SUPPORTED_REGIONS } = require("../config/als-regions");

// Invert a region-first mapping ({region: [country,...]}) into a
// country->region Map. Validates regions and rejects duplicate countries.
function invertMapping(regionFirst, enabledRegions) {
  const map = new Map();
  for (const [region, countries] of Object.entries(regionFirst)) {
    if (!ALS_SUPPORTED_REGIONS.has(region)) {
      throw new Error(`Mapping region "${region}" is not an ALS-supported region`);
    }
    if (!enabledRegions.has(region)) {
      throw new Error(`Mapping region "${region}" is not in ENABLED_REGIONS`);
    }
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
  return map;
}

// Read the packaged mapping JSON file and invert+validate it.
function loadMapping(filePath, enabledRegions) {
  const regionFirst = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return invertMapping(regionFirst, enabledRegions);
}

// Build a store object with a getRegion(countryCode) lookup.
function createMappingStore(filePath, enabledRegions) {
  const map = loadMapping(filePath, enabledRegions);
  return {
    getRegion(countryCode) {
      if (!countryCode) return null;
      return map.get(String(countryCode).toUpperCase()) || null;
    },
    size: map.size,
  };
}

module.exports = { invertMapping, loadMapping, createMappingStore };
