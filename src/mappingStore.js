const fs = require("fs");
const { ALS_SUPPORTED_REGIONS } = require("../config/als-regions");

// Invert a region-first mapping ({region: [country,...]}) into a
// country->region Map. The region set is the mapping's top-level keys, so the
// file is the single source of truth for which regions are in use.
//
// Exactly one region must include the "*" wildcard in its country list. That
// marks the HOME region: the fallback for unmatched countries and the reverse-
// geocode guide region. "*" is not a country; the home region may also serve
// specific countries (e.g. ["*", "JP"]).
//
// Validates ALS support, rejects duplicate countries, and requires exactly one
// home region. Returns { map, regions, homeRegion }.
function invertMapping(regionFirst) {
  const map = new Map();
  const regions = new Set();
  let homeRegion = null;
  for (const [region, countries] of Object.entries(regionFirst)) {
    if (!ALS_SUPPORTED_REGIONS.has(region)) {
      throw new Error(`Mapping region "${region}" is not an ALS-supported region`);
    }
    regions.add(region);
    for (const raw of countries) {
      if (raw === "*") {
        if (homeRegion) {
          throw new Error(
            `Mapping has multiple home regions ("*"): "${homeRegion}" and "${region}" ` +
              `(exactly one region may be marked "*")`
          );
        }
        homeRegion = region;
        continue;
      }
      const cc = String(raw).toUpperCase();
      if (map.has(cc)) {
        throw new Error(
          `Duplicate country "${cc}" mapped to both "${map.get(cc)}" and "${region}"`
        );
      }
      map.set(cc, region);
    }
  }
  if (!homeRegion) {
    throw new Error(
      `Mapping has no home region: exactly one region must include "*" in its ` +
        `country list (marks the fallback / reverse-geocode guide region)`
    );
  }
  return { map, regions, homeRegion };
}

// Read the packaged mapping JSON file and invert+validate it.
// Returns { map, regions, homeRegion }.
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

// Build a store with a getRegion(countryCode) lookup, the region set, and the
// home region (all derived from the mapping file — the single source of truth).
function createMappingStore(filePath) {
  const { map, regions, homeRegion } = loadMapping(filePath);
  return {
    getRegion(countryCode) {
      if (!countryCode) return null;
      return map.get(String(countryCode).toUpperCase()) || null;
    },
    regions,
    homeRegion,
    size: map.size,
  };
}

module.exports = { invertMapping, loadMapping, createMappingStore };
