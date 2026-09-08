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
  // Region is pinned to home, but the country is still reported so a
  // single-region deployment can keep defaulting the map label language from it.
  assert.deepStrictEqual(r, { targetRegion: HOME, source: "home-disabled", countryCode: "DE" });
});

test("routing disabled with no country reports a null country", async () => {
  const r = await resolveRegion({ routingEnabled: false }, deps());
  assert.deepStrictEqual(r, { targetRegion: HOME, source: "home-disabled", countryCode: null });
});

test("country code maps to its region", async () => {
  const r = await resolveRegion({ countryCode: "JP", routingEnabled: true }, deps());
  assert.deepStrictEqual(r, {
    targetRegion: "ap-northeast-1",
    source: "country-map",
    countryCode: "JP",
  });
});

// An EXPLICIT country that the mapping doesn't serve must never be silently
// answered from the home region: the caller asked about that country, so home
// results would contradict the request. The HTTP layer already rejects it with
// 400 before we get here, so reaching this point means a caller skipped that
// check — a programming error, which throws rather than degrades.
test("unmapped explicit country throws instead of falling back to home", async () => {
  await assert.rejects(
    () => resolveRegion({ countryCode: "ZZ", routingEnabled: true }, deps()),
    /countryCode "ZZ" is not in the region mapping/
  );
});

test("lat/lng reverse-geocodes to country then maps", async () => {
  const r = await resolveRegion({ lat: 52.5, lng: 13.4, routingEnabled: true }, deps());
  // The reverse-geocoded country is surfaced so callers don't repeat the lookup.
  assert.deepStrictEqual(r, {
    targetRegion: "eu-west-1",
    source: "reverse-geo",
    countryCode: "DE",
  });
});

test("reverse geocode returning null falls back to home", async () => {
  const r = await resolveRegion(
    { lat: 0, lng: 0, routingEnabled: true },
    deps({ reverseGeocodeToCountry: async () => null })
  );
  assert.deepStrictEqual(r, {
    targetRegion: HOME,
    source: "reverse-miss-fallback",
    countryCode: null,
  });
});

test("no input falls back to home", async () => {
  const r = await resolveRegion({ routingEnabled: true }, deps());
  assert.deepStrictEqual(r, {
    targetRegion: HOME,
    source: "no-input-fallback",
    countryCode: null,
  });
});

test("reverse-geocoded unmapped country uses distinct fallback source", async () => {
  const r = await resolveRegion(
    { lat: 10, lng: 10, routingEnabled: true },
    deps({ reverseGeocodeToCountry: async () => "ZZ" })
  );
  assert.deepStrictEqual(r, {
    targetRegion: HOME,
    source: "reverse-geo-map-miss-fallback",
    countryCode: "ZZ",
  });
});

test("countryCode takes precedence over lat/lng", async () => {
  const r = await resolveRegion(
    { countryCode: "JP", lat: 52.5, lng: 13.4, routingEnabled: true },
    deps()
  );
  assert.deepStrictEqual(r, {
    targetRegion: "ap-northeast-1",
    source: "country-map",
    countryCode: "JP",
  });
});
