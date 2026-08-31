const {
  MAP_LABEL_LANGUAGES,
  GRABMAPS_PLACES_LANGUAGES,
  DEFAULT_MAP_LANGUAGE,
  languageForCountry,
} = require("../config/map-languages");
const { GRABMAPS_REGIONS } = require("../config/als-regions");

// Normalize a caller-supplied language tag to an ALS label-language code.
// Accepts a full BCP 47 tag ("zh-CN", "pt_BR", "en-GB") and keeps only the
// primary subtag, because ALS tile data is keyed by ISO 639-1 code (name:zh,
// name:pt) with no regional variants.
//
// Returns { code } when absent (code: null), { code } when valid, or { error }
// when present but unsupported — mirroring normalizeCountry in server.js, so an
// unsupported value becomes a 400 instead of silently rendering English labels.
function normalizeLanguage(raw) {
  if (!raw) return { code: null };
  const primary = String(raw).trim().toLowerCase().split(/[-_]/)[0];
  if (!MAP_LABEL_LANGUAGES.has(primary)) {
    return { error: `Unsupported map label language "${raw}" (expected an ISO 639-1 code supported by Amazon Location)` };
  }
  return { code: primary };
}

// Language primary subtags this application is willing to forward to GeoPlaces.
//
// AWS publishes no single global language list for GeoPlaces, only the GrabMaps
// regional subset, so exact validation is impossible. What we CAN do is refuse
// values that are documented nowhere: without this, "cn" (a country code, not a
// language — Chinese is "zh"), "xx" or "zzz-Latn-999" are all structurally valid
// BCP 47 and were forwarded upstream, spending an ALS round trip to earn a 4xx
// that reads like an upstream fault in the log. It also removes an asymmetry that
// was visible to API consumers: `lang=cn` failed locally on /api/map-style but
// only remotely on /api/suggest, for the same parameter name.
//
// The union is deliberately broader than either list alone — the two sets do not
// contain each other (GrabMaps has lo/tl; the label list has 60+ codes GrabMaps
// lacks) — and a code in it may still be rejected by GeoPlaces, which stays a
// 4xx→400 as before. This is a cheap local filter, not a support guarantee.
const PLACES_KNOWN_LANGUAGES = new Set([...MAP_LABEL_LANGUAGES, ...GRABMAPS_PLACES_LANGUAGES]);

// Normalize a language for GeoPlaces requests. Unlike vector-tile labels,
// GeoPlaces accepts BCP 47 tags and does not publish one global language enum,
// so validating against MAP_LABEL_LANGUAGES would incorrectly reject valid
// Places-only codes such as "lo" and "tl". Validate the tag's structure and
// preserve its canonical regional/script subtags for non-GrabMaps regions.
function normalizePlacesLanguage(raw) {
  if (!raw) return { code: null };
  const value = String(raw).trim().replace(/_/g, "-");
  let code;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) throw new RangeError("empty language tag");
    // Intl canonicalizes the legacy-but-documented GrabMaps code "tl" to
    // "fil". Preserve an explicitly documented GrabMaps primary code so it is
    // not transformed into a value outside that provider's published subset.
    const requestedPrimary = value.toLowerCase().split("-")[0];
    if (GRABMAPS_PLACES_LANGUAGES.has(requestedPrimary)) {
      const canonicalParts = canonical.split("-");
      code = [requestedPrimary, ...canonicalParts.slice(1)].join("-");
    } else {
      code = canonical;
    }
  } catch {
    return { error: `Invalid Places language "${raw}" (expected a BCP 47 language tag)` };
  }
  // Structurally valid but documented by neither Amazon Location list: reject
  // here instead of paying an upstream round trip to be told the same thing.
  if (!PLACES_KNOWN_LANGUAGES.has(code.toLowerCase().split("-")[0])) {
    return {
      error: `Unsupported Places language "${raw}" (expected a BCP 47 tag whose language is supported by Amazon Location)`,
    };
  }
  return { code };
}

// Decide which language the map labels should use. Precedence mirrors the
// region-routing contract: an explicit request wins, then the country code, then
// the deployment default, then "en".
//
// `lang` must already be normalized (a bare ISO 639-1 code or null) — validation
// belongs at the request edge so a bad value 400s rather than falling back.
// Returns { language, source }; source explains the decision path (for logs and
// so the client can tell "you asked for this" from "we picked this for you").
function resolveMapLanguage({ lang, countryCode, defaultLanguage } = {}) {
  if (lang) return { language: lang, source: "explicit" };

  const fromCountry = languageForCountry(countryCode);
  if (fromCountry) return { language: fromCountry, source: "country-map" };

  if (defaultLanguage) return { language: defaultLanguage, source: "config-default" };

  return { language: DEFAULT_MAP_LANGUAGE, source: "fallback" };
}

// Clamp a language to what the GeoPlaces APIs document as supported in `region`.
//
// The GrabMaps regions publish only a small subset. Requests outside that subset
// are clamped rather than relying on undocumented fallback/error behavior. A full
// BCP 47 tag whose primary language is supported (for example zh-CN) is reduced to
// the documented primary code there. Non-GrabMaps regions pass the canonical tag
// through unchanged.
//
// `fallback` is the deployment's configured default; it is itself clamped. Only
// when that is unavailable do we reach for the built-in "en", which is in the
// documented GrabMaps subset.
function clampPlacesLanguage(language, region, fallback) {
  if (!language) return null;
  if (!GRABMAPS_REGIONS.has(region)) return language;
  const primary = String(language).toLowerCase().split("-")[0];
  if (GRABMAPS_PLACES_LANGUAGES.has(primary)) return primary;
  if (fallback && GRABMAPS_PLACES_LANGUAGES.has(fallback)) return fallback;
  return DEFAULT_MAP_LANGUAGE;
}

// Expression heads whose operands are COMPARED rather than displayed. A
// `name:` lookup inside one of these is a comparison key, so replacing it with a
// coalesce chain would change which branch matches — a broken label, not a
// localized one. None of these shapes has been observed in an ALS descriptor's
// text-field; the guard exists so the assumption is enforced rather than implied.
//
// Boolean combinators (case/all/any/!) are deliberately NOT here: their operands
// are themselves conditions, so any name lookup inside them sits under one of the
// heads below, while their OUTPUT operands are display text worth localizing.
const COMPARISON_HEADS = new Set(["==", "!=", "<", ">", "<=", ">=", "in", "index-of"]);

// Rewrite one `text-field` expression so it prefers `name:<language>`.
//
// ALS descriptors express label text as a coalesce chain over the tile's name
// properties, e.g.
//   ["coalesce", ["get","name:en"], ["get","name"]]
// Replacing the head of that chain switches the label language, with name:en and
// name as fallbacks so a feature missing the translation still gets a label
// (ALS's documented behavior: "fall back to another language").
//
// Implements the algorithm from the Amazon Location developer guide
// ("How to set a preferred language for a map"), with one addition: a bare
// ["get","name:xx"] with no surrounding coalesce is also upgraded, since that
// shape appears in some layers and the documented version leaves it untranslated.
function rewriteTextField(exp, language) {
  if (!Array.isArray(exp)) return exp;

  const localized = ["coalesce", ["get", `name:${language}`], ["get", "name:en"], ["get", "name"]];

  // Bare ["get","name:xx"] → full localized coalesce chain.
  if (exp[0] === "get" && typeof exp[1] === "string" && /^name:[A-Za-z\-_]+$/.test(exp[1])) {
    return localized;
  }

  // Comparison/branching on a value: leave it entirely alone (see above).
  if (typeof exp[0] === "string" && COMPARISON_HEADS.has(exp[0])) return exp;

  // ["match", input, label, output, …, fallback]: `input` is matched against the
  // labels, so only the outputs may be localized.
  if (exp[0] === "match") {
    return exp.map((v, i) => (i === 1 ? v : rewriteTextField(v, language)));
  }

  if (exp[0] !== "coalesce") {
    return exp.map((v) => rewriteTextField(v, language));
  }

  // The shape we can replace wholesale is EXACTLY a two-fallback name chain:
  //   ["coalesce", ["get","name:xx"], ["get", …]]        (length 3)
  // The length check must be exact. An earlier version tested `exp[4] === undefined`,
  // which accepted a THREE-fallback chain and replaced it with the two-fallback
  // localized one — silently discarding the third fallback, so features labelled
  // only by e.g. `ref` (route numbers, unnamed boundaries) lost their label
  // entirely once a language was picked.
  //
  // Longer or unrecognized chains fall through to the recursion below, which
  // rewrites just the head `["get","name:xx"]` into a nested localized coalesce.
  // That is the better outcome anyway: the labels get localized AND every extra
  // fallback is preserved, e.g.
  //   ["coalesce", name:en, name, ref]
  //     -> ["coalesce", ["coalesce", name:de, name:en, name], name, ref]
  // MapLibre evaluates that identically, so nesting costs nothing. A coalesce over
  // non-name properties has no `name:` head and is therefore left untouched.
  const [, first, second] = exp;
  const isNameCoalesce =
    exp.length === 3 &&
    Array.isArray(first) &&
    first[0] === "get" &&
    typeof first[1] === "string" &&
    /^name:[A-Za-z\-_]+$/.test(first[1]) &&
    Array.isArray(second) &&
    second[0] === "get";

  if (!isNameCoalesce) {
    return exp.map((v) => rewriteTextField(v, language));
  }
  return localized;
}

// Return a copy of a MapLibre style whose symbol layers render labels in
// `language`. A no-op for "en" (ALS descriptors already coalesce to name:en) and
// for styles without symbol layers (e.g. Satellite, which ALS documents as not
// supporting language).
//
// Non-mutating: layers and their layout objects are copied, so the caller's
// descriptor (which may be shared/cached) is untouched.
function applyPreferredLanguage(style, language) {
  if (!style || !Array.isArray(style.layers) || !language || language === "en") return style;
  return {
    ...style,
    layers: style.layers.map((layer) => {
      if (layer.type !== "symbol" || !layer.layout || !layer.layout["text-field"]) return layer;
      return {
        ...layer,
        layout: {
          ...layer.layout,
          "text-field": rewriteTextField(layer.layout["text-field"], language),
        },
      };
    }),
  };
}

// Pull just the label expressions out of a (already localized) style, keyed by
// layer id. This is what lets a client change the label language WITHOUT
// refetching the whole descriptor: the payload is ~3 KB instead of ~136 KB and
// the client only assigns the values via setLayoutProperty, so the language
// decision and the expression rewriting both stay server-side.
//
// Only symbol layers whose text-field actually references a `name:` property are
// included — road shields (`shield_text`), house numbers and refs are not label
// text and must never be touched (see rewriteTextField).
function extractLabelExpressions(style) {
  const out = {};
  for (const layer of (style && style.layers) || []) {
    if (layer.type !== "symbol") continue;
    const textField = layer.layout && layer.layout["text-field"];
    if (!textField) continue;
    if (!JSON.stringify(textField).includes('"name:')) continue;
    out[layer.id] = textField;
  }
  return out;
}

module.exports = {
  normalizeLanguage,
  normalizePlacesLanguage,
  resolveMapLanguage,
  clampPlacesLanguage,
  applyPreferredLanguage,
  rewriteTextField,
  extractLabelExpressions,
};
