const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeLanguage,
  normalizePlacesLanguage,
  resolveMapLanguage,
  applyPreferredLanguage,
  extractLabelExpressions,
  clampPlacesLanguage,
  rewriteTextField,
} = require("../src/mapLanguage");
const {
  MAP_LABEL_LANGUAGES,
  GRABMAPS_PLACES_LANGUAGES,
  COUNTRY_LANGUAGE,
  languageForCountry,
} = require("../config/map-languages");

// --- normalizeLanguage ---

test("absent language is not an error (auto mode)", () => {
  assert.deepStrictEqual(normalizeLanguage(undefined), { code: null });
  assert.deepStrictEqual(normalizeLanguage(""), { code: null });
});

test("a full BCP 47 tag is reduced to its primary subtag", () => {
  // ALS tiles are keyed by ISO 639-1 (name:zh), never by regional variant.
  assert.strictEqual(normalizeLanguage("zh-CN").code, "zh");
  assert.strictEqual(normalizeLanguage("pt_BR").code, "pt");
  assert.strictEqual(normalizeLanguage("EN-gb").code, "en");
});

test("an unsupported language is rejected, not silently downgraded", () => {
  // "cn" is a common mistake for Chinese (the ISO 639-1 code is "zh"). Falling
  // back to English here would look like the feature simply doesn't work.
  assert.ok(normalizeLanguage("cn").error);
  assert.ok(normalizeLanguage("klingon").error);
  // Not in the ALS label set even though they are real languages.
  assert.ok(normalizeLanguage("sw").error);
  assert.ok(normalizeLanguage("ur").error);
});

// GeoPlaces uses a separate BCP 47 contract rather than the vector-label list.
test("Places language accepts canonical BCP 47 tags and Places-only codes", () => {
  assert.deepStrictEqual(normalizePlacesLanguage(undefined), { code: null });
  assert.strictEqual(normalizePlacesLanguage("zh_cn").code, "zh-CN");
  assert.strictEqual(normalizePlacesLanguage("PT-br").code, "pt-BR");
  assert.strictEqual(normalizePlacesLanguage("lo").code, "lo");
  assert.strictEqual(normalizePlacesLanguage("tl").code, "tl");
});

test("Places language rejects malformed BCP 47 tags", () => {
  for (const bad of ["not a tag", "en--US", "123", "_"]) {
    assert.ok(normalizePlacesLanguage(bad).error, `${bad} should be rejected`);
  }
});

// A structurally valid tag whose language Amazon Location documents nowhere must
// fail HERE, not upstream: forwarding it spends an ALS round trip to earn a 4xx,
// and it made `lang=cn` behave differently on /api/suggest than on /api/map-style.
test("Places language rejects tags no Amazon Location list documents", () => {
  for (const bad of ["cn", "xx", "zzz-Latn-999", "sw-KE"]) {
    assert.ok(normalizePlacesLanguage(bad).error, `${bad} should be rejected`);
  }
  // Still accepted: label-list codes, Places-only codes, and regional variants.
  assert.strictEqual(normalizePlacesLanguage("zh-CN").code, "zh-CN");
  assert.strictEqual(normalizePlacesLanguage("lo-LA").code, "lo-LA");
  assert.strictEqual(normalizePlacesLanguage("en-GB").code, "en-GB");
});

// --- resolveMapLanguage ---

test("explicit language wins over the country default", () => {
  const r = resolveMapLanguage({ lang: "en", countryCode: "JP", defaultLanguage: "de" });
  assert.deepStrictEqual(r, { language: "en", source: "explicit" });
});

test("country code drives the default when no language is given", () => {
  assert.deepStrictEqual(resolveMapLanguage({ countryCode: "JP" }), {
    language: "ja",
    source: "country-map",
  });
  assert.strictEqual(resolveMapLanguage({ countryCode: "br" }).language, "pt");
});

test("configured default is used when the country has no mapping", () => {
  const r = resolveMapLanguage({ countryCode: "ZZ", defaultLanguage: "de" });
  assert.deepStrictEqual(r, { language: "de", source: "config-default" });
});

test("falls back to en with no signal at all", () => {
  assert.deepStrictEqual(resolveMapLanguage({}), { language: "en", source: "fallback" });
});

// --- the country table ---

test("every country served by the mapping resolves to a supported language", () => {
  // The country->language table must not drift from the countries we actually
  // serve: an entry with an unsupported code would render untranslated labels.
  const mapping = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "config", "country-region-map.json"), "utf8")
  );
  const served = Object.values(mapping).flat().filter((cc) => cc !== "*");
  for (const cc of served) {
    const lang = resolveMapLanguage({ countryCode: cc }).language;
    assert.ok(
      MAP_LABEL_LANGUAGES.has(lang),
      `country ${cc} resolves to "${lang}", which is not an ALS label language`
    );
  }
});

test("every entry in COUNTRY_LANGUAGE is a supported language and a 2-letter country", () => {
  for (const [cc, lang] of Object.entries(COUNTRY_LANGUAGE)) {
    assert.match(cc, /^[A-Z]{2}$/, `"${cc}" is not an ISO 3166-1 alpha-2 code`);
    assert.ok(MAP_LABEL_LANGUAGES.has(lang), `${cc} -> "${lang}" is not an ALS label language`);
  }
});

test("languageForCountry is case-insensitive and null for unknown countries", () => {
  assert.strictEqual(languageForCountry("de"), "de");
  assert.strictEqual(languageForCountry("DE"), "de");
  assert.strictEqual(languageForCountry("ZZ"), null);
  assert.strictEqual(languageForCountry(null), null);
});

// --- applyPreferredLanguage ---

// The shape ALS descriptors actually use for label text.
function styleFixture() {
  return {
    layers: [
      {
        id: "place-labels",
        type: "symbol",
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-size": 12 },
      },
      { id: "roads", type: "line", paint: { "line-color": "#fff" } },
      { id: "no-text", type: "symbol", layout: { "icon-image": "pin" } },
    ],
  };
}

test("rewrites symbol text-field to prefer the requested language", () => {
  const out = applyPreferredLanguage(styleFixture(), "zh");
  assert.deepStrictEqual(out.layers[0].layout["text-field"], [
    "coalesce",
    ["get", "name:zh"],
    ["get", "name:en"],
    ["get", "name"],
  ]);
  // Fallbacks are kept so an untranslated feature still gets a label.
  assert.strictEqual(out.layers[0].layout["text-size"], 12, "other layout props are preserved");
});

test("leaves non-symbol layers and symbol layers without text alone", () => {
  const out = applyPreferredLanguage(styleFixture(), "ja");
  assert.deepStrictEqual(out.layers[1], styleFixture().layers[1]);
  assert.deepStrictEqual(out.layers[2], styleFixture().layers[2]);
});

test("does not mutate the input style", () => {
  // The descriptor may be shared/cached upstream, so the transform must copy.
  const input = styleFixture();
  applyPreferredLanguage(input, "ko");
  assert.deepStrictEqual(input.layers[0].layout["text-field"], [
    "coalesce",
    ["get", "name:en"],
    ["get", "name"],
  ]);
});

test("en is a no-op (descriptors already coalesce to name:en)", () => {
  const input = styleFixture();
  assert.strictEqual(applyPreferredLanguage(input, "en"), input);
});

test("a style with no layers is returned unchanged (e.g. Satellite)", () => {
  const raster = { sources: { s: {} } };
  assert.strictEqual(applyPreferredLanguage(raster, "zh"), raster);
});

test("a bare ['get','name:xx'] text-field is upgraded to a localized chain", () => {
  const style = {
    layers: [{ id: "l", type: "symbol", layout: { "text-field": ["get", "name:en"] } }],
  };
  assert.deepStrictEqual(applyPreferredLanguage(style, "fr").layers[0].layout["text-field"], [
    "coalesce",
    ["get", "name:fr"],
    ["get", "name:en"],
    ["get", "name"],
  ]);
});

test("a nested text-field expression is rewritten in place", () => {
  const style = {
    layers: [
      {
        id: "l",
        type: "symbol",
        layout: {
          "text-field": [
            "case",
            ["has", "name"],
            ["coalesce", ["get", "name:en"], ["get", "name"]],
            "",
          ],
        },
      },
    ],
  };
  const out = applyPreferredLanguage(style, "de").layers[0].layout["text-field"];
  assert.deepStrictEqual(out[2], ["coalesce", ["get", "name:de"], ["get", "name:en"], ["get", "name"]]);
  assert.strictEqual(out[0], "case", "the surrounding expression is preserved");
});

// A name lookup used as a COMPARISON key must not be localized: swapping it for a
// coalesce chain would change which branch matches, breaking the label instead of
// translating it.
test("a name lookup inside a comparison is not rewritten", () => {
  const style = {
    layers: [
      {
        id: "l",
        type: "symbol",
        layout: {
          "text-field": [
            "case",
            ["==", ["get", "name:en"], "Berlin"],
            ["get", "name:en"],
            ["coalesce", ["get", "name:en"], ["get", "name"]],
          ],
        },
      },
    ],
  };
  const out = applyPreferredLanguage(style, "de").layers[0].layout["text-field"];
  // The condition keeps its original comparison key…
  assert.deepStrictEqual(out[1], ["==", ["get", "name:en"], "Berlin"]);
  // …while both DISPLAY branches are localized.
  assert.deepStrictEqual(out[2], ["coalesce", ["get", "name:de"], ["get", "name:en"], ["get", "name"]]);
  assert.deepStrictEqual(out[3], ["coalesce", ["get", "name:de"], ["get", "name:en"], ["get", "name"]]);
});

test("a match input is not rewritten, but its outputs are", () => {
  const exp = ["match", ["get", "name:en"], "Berlin", ["get", "name:en"], ["get", "name"]];
  const out = rewriteTextField(exp, "de");
  assert.deepStrictEqual(out[1], ["get", "name:en"], "the matched-on value is untouched");
  assert.deepStrictEqual(out[3], ["coalesce", ["get", "name:de"], ["get", "name:en"], ["get", "name"]]);
});

test("a coalesce that is not a name chain is left alone", () => {
  // Guard against clobbering expressions we don't understand.
  const style = {
    layers: [
      {
        id: "l",
        type: "symbol",
        layout: { "text-field": ["coalesce", ["get", "ref"], ["get", "shield"]] },
      },
    ],
  };
  assert.deepStrictEqual(applyPreferredLanguage(style, "de").layers[0].layout["text-field"], [
    "coalesce",
    ["get", "ref"],
    ["get", "shield"],
  ]);
});

// --- extractLabelExpressions (the cheap /api/map-labels payload) ---

test("extracts only symbol layers whose text-field references a name property", () => {
  const style = {
    layers: [
      { id: "bg", type: "background", paint: {} },
      {
        id: "place",
        type: "symbol",
        layout: { "text-field": ["coalesce", ["get", "name:ja"], ["get", "name:en"], ["get", "name"]] },
      },
      // Road shields / house numbers are not label text and must be excluded, or
      // the client would overwrite them with place names.
      { id: "shield", type: "symbol", layout: { "text-field": ["to-string", ["get", "shield_text"]] } },
      { id: "housenumber", type: "symbol", layout: { "text-field": ["get", "addr_housenumber"] } },
      { id: "icon-only", type: "symbol", layout: { "icon-image": "pin" } },
    ],
  };
  const out = extractLabelExpressions(style);
  assert.deepStrictEqual(Object.keys(out), ["place"]);
  assert.deepStrictEqual(out.place, ["coalesce", ["get", "name:ja"], ["get", "name:en"], ["get", "name"]]);
});

test("extracts nested name expressions (step/case wrappers)", () => {
  // Real ALS descriptors wrap some label expressions in step/concat.
  const style = {
    layers: [
      {
        id: "admin",
        type: "symbol",
        layout: {
          "text-field": ["step", ["zoom"], ["coalesce", ["get", "name:th"], ["get", "name"]], 4, ["get", "name:th"]],
        },
      },
    ],
  };
  assert.deepStrictEqual(Object.keys(extractLabelExpressions(style)), ["admin"]);
});

test("returns an empty object for a style with no label layers (Satellite)", () => {
  assert.deepStrictEqual(extractLabelExpressions({ layers: [{ id: "raster", type: "raster" }] }), {});
  assert.deepStrictEqual(extractLabelExpressions({}), {});
  assert.deepStrictEqual(extractLabelExpressions(null), {});
});

test("the cheap payload matches what a full localized style would render", () => {
  // /api/map-labels must be indistinguishable from a full /api/map-style reload.
  // The ONE structural difference between the two server paths is that map-style
  // runs als.rewriteStyle first and map-labels deliberately skips it, so this runs
  // BOTH REAL PIPELINES and compares. (An earlier version of this test built both
  // sides from the same applyPreferredLanguage call, which cannot fail and left the
  // actual difference unexercised.)
  const { createAlsClient } = require("../src/alsClient");
  const als = createAlsClient();
  // Raw ALS shape: origins still maps.geo.*, key present, and a null layout value
  // for rewriteStyle's cleanProps to strip — the only thing it does to `layout`.
  const descriptor = () => ({
    glyphs: "https://maps.geo.eu-central-1.amazonaws.com/v2/glyphs/{fontstack}/{range}.pbf?key=SECRET",
    sources: {
      base: {
        type: "vector",
        tiles: ["https://maps.geo.eu-central-1.amazonaws.com/v2/tiles/base/{z}/{x}/{y}?key=SECRET"],
      },
    },
    layers: [
      { id: "bg", type: "background" },
      {
        id: "a",
        type: "symbol",
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-transform": null },
      },
      {
        id: "b",
        type: "symbol",
        layout: {
          "text-field": ["step", ["zoom"], ["coalesce", ["get", "name:en"], ["get", "name"]], 6, ["get", "name:en"]],
        },
      },
      { id: "shield", type: "symbol", layout: { "text-field": ["to-string", ["get", "shield_text"]] } },
    ],
  });

  const viaMapStyle = applyPreferredLanguage(
    als.rewriteStyle(descriptor(), { region: "eu-central-1", mapTileDomain: "d123.cloudfront.net" }),
    "de"
  );
  const viaMapLabels = extractLabelExpressions(applyPreferredLanguage(descriptor(), "de"));

  // Sanity: the pipelines really did differ upstream of the labels.
  assert.match(viaMapStyle.glyphs, /d123\.cloudfront\.net/, "map-style path must have rewritten URLs");
  assert.strictEqual(
    "text-transform" in viaMapStyle.layers[1].layout,
    false,
    "rewriteStyle must have stripped the null layout value"
  );

  for (const layer of viaMapStyle.layers) {
    const textField = layer.layout && layer.layout["text-field"];
    if (!textField || !JSON.stringify(textField).includes('"name:')) continue;
    assert.deepStrictEqual(viaMapLabels[layer.id], textField, `layer ${layer.id} diverged`);
  }
  assert.deepStrictEqual(Object.keys(viaMapLabels).sort(), ["a", "b"]);
});

// --- clampPlacesLanguage (GrabMaps regions accept a narrower language set) ---

test("non-GrabMaps regions pass the language through unchanged", () => {
  assert.strictEqual(clampPlacesLanguage("ja", "ap-northeast-1"), "ja");
  assert.strictEqual(clampPlacesLanguage("de", "eu-central-1"), "de");
});

test("GrabMaps regions keep a language they support", () => {
  for (const lang of ["en", "th", "vi", "ms", "id", "km", "zh", "lo", "tl"]) {
    assert.strictEqual(clampPlacesLanguage(lang, "ap-southeast-1"), lang);
    assert.strictEqual(clampPlacesLanguage(lang, "ap-southeast-5"), lang);
  }
  // GrabMaps documents primary codes, so a supported BCP 47 variant is reduced
  // to that primary code rather than being treated as outside the subset.
  assert.strictEqual(clampPlacesLanguage("zh-CN", "ap-southeast-1"), "zh");
});

test("GrabMaps regions clamp a language outside their documented subset", () => {
  // Do not rely on undocumented provider fallback/error behavior.
  for (const lang of ["ja", "ko", "de", "fr", "ar", "hi"]) {
    assert.strictEqual(clampPlacesLanguage(lang, "ap-southeast-1"), "en", `${lang} should clamp`);
  }
});

test("clamping prefers the deployment's default over the built-in en", () => {
  // A deployment serving Southeast Asia may well set DEFAULT_MAP_LANGUAGE=th; that
  // is a better degraded answer there than the hardcoded en.
  assert.strictEqual(clampPlacesLanguage("ja", "ap-southeast-1", "th"), "th");
  // …but only if GrabMaps accepts the default too. A deployment defaulting to de
  // must not push de into a region that rejects it.
  assert.strictEqual(clampPlacesLanguage("ja", "ap-southeast-1", "de"), "en");
  // The fallback is irrelevant outside GrabMaps regions.
  assert.strictEqual(clampPlacesLanguage("ja", "eu-central-1", "th"), "ja");
});

test("clamping a null language stays null (no language sent)", () => {
  assert.strictEqual(clampPlacesLanguage(null, "ap-southeast-1"), null);
  assert.strictEqual(clampPlacesLanguage(undefined, "eu-central-1"), null);
});

test("the GrabMaps Places set is not a subset of the map label set", () => {
  // Documents a real asymmetry: Places and Maps have independent language
  // support, so neither list can be derived from the other.
  const onlyInPlaces = [...GRABMAPS_PLACES_LANGUAGES].filter((l) => !MAP_LABEL_LANGUAGES.has(l));
  assert.deepStrictEqual(onlyInPlaces.sort(), ["lo", "tl"]);
});

// --- rewriteTextField, directly ---
// Tested at this level because the fallback-chain length logic lives here and is
// invisible through applyPreferredLanguage: a wrong length check silently drops
// fallbacks rather than throwing.

const LOCALIZED_DE = ["coalesce", ["get", "name:de"], ["get", "name:en"], ["get", "name"]];

test("a two-fallback name chain is replaced wholesale", () => {
  assert.deepStrictEqual(
    rewriteTextField(["coalesce", ["get", "name:en"], ["get", "name"]], "de"),
    LOCALIZED_DE
  );
});

test("a THREE-fallback chain keeps its extra fallback", () => {
  // Regression: the length check used to accept this and replace it with the
  // two-fallback localized chain, discarding ["get","ref"]. Features labelled only
  // by `ref` (route numbers, unnamed boundaries) then lost their label entirely.
  const out = rewriteTextField(
    ["coalesce", ["get", "name:en"], ["get", "name"], ["get", "ref"]],
    "de"
  );
  assert.deepStrictEqual(out, ["coalesce", LOCALIZED_DE, ["get", "name"], ["get", "ref"]]);
  assert.ok(JSON.stringify(out).includes('"ref"'), "the ref fallback must survive");
});

test("a four-fallback chain also keeps everything", () => {
  const out = rewriteTextField(
    ["coalesce", ["get", "name:en"], ["get", "name"], ["get", "ref"], ["get", "x"]],
    "de"
  );
  assert.deepStrictEqual(out, [
    "coalesce",
    LOCALIZED_DE,
    ["get", "name"],
    ["get", "ref"],
    ["get", "x"],
  ]);
});

test("a bare name get becomes a localized chain", () => {
  assert.deepStrictEqual(rewriteTextField(["get", "name:en"], "de"), LOCALIZED_DE);
});

test("a coalesce with no name head is untouched", () => {
  const exp = ["coalesce", ["get", "ref"], ["get", "shield_text"]];
  assert.deepStrictEqual(rewriteTextField(exp, "de"), exp);
});

test("a coalesce whose second element is not a get is not replaced wholesale", () => {
  // Falls through to the recursion, which localizes only the head.
  const out = rewriteTextField(["coalesce", ["get", "name:en"], "literal"], "de");
  assert.deepStrictEqual(out, ["coalesce", LOCALIZED_DE, "literal"]);
});

test("non-array expressions pass through", () => {
  assert.strictEqual(rewriteTextField("plain", "de"), "plain");
  assert.strictEqual(rewriteTextField(42, "de"), 42);
  assert.strictEqual(rewriteTextField(null, "de"), null);
});

test("nested wrappers are preserved around the rewritten chain", () => {
  const out = rewriteTextField(
    ["step", ["zoom"], ["coalesce", ["get", "name:en"], ["get", "name"]], 6, ["get", "name:en"]],
    "de"
  );
  assert.deepStrictEqual(out, ["step", ["zoom"], LOCALIZED_DE, 6, LOCALIZED_DE]);
});

test("no two rewritten expressions share an array instance", () => {
  // The same style object is handed to MapLibre; sharing one array across layers
  // would make any in-place mutation leak between them.
  const out = rewriteTextField(
    ["step", ["zoom"], ["coalesce", ["get", "name:en"], ["get", "name"]], 6, ["get", "name:en"]],
    "de"
  );
  assert.notStrictEqual(out[2], out[4], "each match must get its own array");
});
