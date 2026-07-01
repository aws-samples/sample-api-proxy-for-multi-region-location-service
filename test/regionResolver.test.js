const { test } = require("node:test");
const assert = require("node:assert");
const { resolveRegion } = require("../src/regionResolver");

const HOME = "ap-northeast-1";
const getRegion = (cc) => ({ JP: "ap-northeast-1", DE: "eu-west-1" }[cc] || null);

function deps(overrides = {}) {
  return {
    homeRegion: HOME,
    getRegion,
    reverseGeocodeToCountry: async () => "DE",
    ...overrides,
  };
}

test("routing disabled always returns home region", async () => {
  const r = await resolveRegion({ countryCode: "DE", routingEnabled: false }, deps());
  assert.deepStrictEqual(r, { targetRegion: HOME, source: "home-disabled" });
});

test("country code maps to its region", async () => {
  const r = await resolveRegion({ countryCode: "JP", routingEnabled: true }, deps());
  assert.deepStrictEqual(r, { targetRegion: "ap-northeast-1", source: "country-map" });
});

test("unmapped country falls back to home", async () => {
  const r = await resolveRegion({ countryCode: "ZZ", routingEnabled: true }, deps());
  assert.deepStrictEqual(r, { targetRegion: HOME, source: "country-map-miss-fallback" });
});

test("lat/lng reverse-geocodes to country then maps", async () => {
  const r = await resolveRegion({ lat: 52.5, lng: 13.4, routingEnabled: true }, deps());
  assert.deepStrictEqual(r, { targetRegion: "eu-west-1", source: "reverse-geo" });
});

test("reverse geocode returning null falls back to home", async () => {
  const r = await resolveRegion(
    { lat: 0, lng: 0, routingEnabled: true },
    deps({ reverseGeocodeToCountry: async () => null })
  );
  assert.deepStrictEqual(r, { targetRegion: HOME, source: "reverse-miss-fallback" });
});

test("no input falls back to home", async () => {
  const r = await resolveRegion({ routingEnabled: true }, deps());
  assert.deepStrictEqual(r, { targetRegion: HOME, source: "no-input-fallback" });
});

test("reverse-geocoded unmapped country uses distinct fallback source", async () => {
  const r = await resolveRegion(
    { lat: 10, lng: 10, routingEnabled: true },
    deps({ reverseGeocodeToCountry: async () => "ZZ" })
  );
  assert.deepStrictEqual(r, { targetRegion: HOME, source: "reverse-geo-map-miss-fallback" });
});

test("countryCode takes precedence over lat/lng", async () => {
  const r = await resolveRegion(
    { countryCode: "JP", lat: 52.5, lng: 13.4, routingEnabled: true },
    deps()
  );
  assert.deepStrictEqual(r, { targetRegion: "ap-northeast-1", source: "country-map" });
});
