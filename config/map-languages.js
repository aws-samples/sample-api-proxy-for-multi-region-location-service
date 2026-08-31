// Map LABEL language configuration.
//
// Amazon Location's dynamic (vector-tile) maps have NO server-side language
// parameter: GetStyleDescriptor accepts ColorScheme / PoliticalView / Terrain /
// ContourDensity / Traffic / TravelMode — but not a language. Only the raster
// GetStaticMap API takes `Language`. For dynamic maps, localization is done by
// rewriting the style descriptor's symbol `text-field` expressions to prefer the
// tile's `name:<lang>` property (see src/mapLanguage.js).
//   https://docs.aws.amazon.com/location/latest/developerguide/maps-localization-internationalization.html
//   https://docs.aws.amazon.com/location/latest/developerguide/how-to-set-preferred-language-map.html
//   https://docs.aws.amazon.com/cli/latest/reference/geo-maps/get-static-map.html
//
// The 68 codes below are transcribed from GetStaticMap's documented `Language`
// values (BCP 47 tags limited there to ISO 639-1 codes). We reuse that list for
// the vector tiles' `name:<lang>` properties, but AWS does not publicly guarantee
// that the static-map enum and the vector-tile property set will always be
// identical. Rejecting values outside this conservative list avoids requesting a
// property this application has not established is present.
const MAP_LABEL_LANGUAGES = new Set([
  "ar", "as", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy",
  "da", "de", "el", "en", "es", "et", "eu", "fi", "fo", "fr",
  "ga", "gl", "gn", "gu", "he", "hi", "hr", "hu", "hy", "id",
  "is", "it", "ja", "ka", "kk", "km", "kn", "ko", "ky", "lt",
  "lv", "mk", "ml", "mr", "ms", "mt", "my", "nl", "no", "or",
  "pa", "pl", "pt", "ro", "ru", "sk", "sl", "sq", "sr", "sv",
  "ta", "te", "th", "tr", "uk", "uz", "vi", "zh",
]);

// Final fallback when a country has no entry below (and when no default is
// configured). "en" is present in every ALS region's tile data.
const DEFAULT_MAP_LANGUAGE = "en";

// Default label language per ISO 3166-1 alpha-2 country — the "缺省按国家码"
// behavior: with no explicit language, a request carrying (or resolving to) a
// country gets that country's primary language.
//
// Rules used to build this table:
//   - the country's dominant/official language, IF it is in MAP_LABEL_LANGUAGES;
//   - otherwise the widely-used administrative language (usually "en"), because
//     an unsupported code would render worse than English. Examples: Sinhala
//     (LK), Nepali (NP), Urdu (PK), Amharic (ET), Swahili (KE/TZ) and Mongolian
//     (MN) are NOT in the ALS set, so those countries map to "en".
//
// Countries absent here fall back to DEFAULT_MAP_LANGUAGE, so this table only
// needs to cover what config/country-region-map.json actually serves.
const COUNTRY_LANGUAGE = {
  // --- Asia Pacific ---
  JP: "ja", KR: "ko",
  CN: "zh", TW: "zh", HK: "zh", MO: "zh",
  TH: "th", VN: "vi", KH: "km", MM: "my",
  MY: "ms", BN: "ms", ID: "id",
  SG: "en", PH: "en", MN: "en",
  AU: "en", NZ: "en", PG: "en", CK: "en", KI: "en", FM: "en", MP: "en",
  NC: "fr",

  // --- South Asia / Central Asia / Middle East ---
  IN: "hi", BD: "bn",
  LK: "en", NP: "en", PK: "en", MV: "en",
  KZ: "kk", UZ: "uz", KG: "ky",
  AE: "ar", SA: "ar", QA: "ar", BH: "ar", KW: "ar", OM: "ar",
  IL: "he", LB: "ar", JO: "ar", IQ: "ar",

  // --- Africa ---
  KE: "en", TZ: "en", UG: "en", RW: "en", ET: "en", SC: "en", MU: "en",
  MW: "en", ZM: "en", ZW: "en", BW: "en", NA: "en", ZA: "en",
  NG: "en", GH: "en", LR: "en",
  MG: "fr", RE: "fr", YT: "fr", SN: "fr", CI: "fr", GN: "fr", BF: "fr", GA: "fr",
  MZ: "pt", GW: "pt", CV: "pt", AO: "pt",
  MA: "ar", DZ: "ar", TN: "ar", EG: "ar",
  GQ: "es",

  // --- Europe ---
  GB: "en", IE: "en",
  FR: "fr", MC: "fr", LU: "fr",
  DE: "de", AT: "de", CH: "de", LI: "de",
  NL: "nl", BE: "nl",
  ES: "es", IT: "it", PT: "pt",
  GR: "el", CY: "el", MT: "mt",
  SE: "sv", NO: "no", DK: "da", GL: "da", FI: "fi", IS: "is",
  EE: "et", LV: "lv", LT: "lt",
  PL: "pl", CZ: "cs", SK: "sk", HU: "hu",
  SI: "sl", HR: "hr", BA: "bs", RS: "sr", ME: "sr", MK: "mk", AL: "sq",
  RO: "ro", MD: "ro", BG: "bg", UA: "uk", RU: "ru", BY: "be",
  TR: "tr", GE: "ka", AM: "hy", AZ: "az",

  // --- Americas ---
  US: "en", CA: "en", VI: "en", UM: "en",
  BS: "en", JM: "en", KN: "en", BB: "en", TT: "en", FK: "en",
  MX: "es", PR: "es", GT: "es", HN: "es", SV: "es", NI: "es", CR: "es", DO: "es",
  AR: "es", CL: "es", PE: "es", UY: "es", PY: "es", BO: "es", EC: "es", CO: "es",
  BR: "pt",
  GP: "fr", MQ: "fr", GF: "fr",
  AW: "nl",
};

// The languages the GeoPlaces APIs accept in the GrabMaps regions
// (ap-southeast-1 / ap-southeast-5). This is a DIFFERENT and much smaller set
// than MAP_LABEL_LANGUAGES above — Places and Maps have independent language
// support — and AWS documents only the following codes there. Requests are
// clamped to this set rather than relying on undocumented fallback/error behavior.
// This keeps a place lookup working when the user has picked, say, Japanese labels.
//
// Note it contains "lo" and "tl", which are NOT valid map label languages: the
// two sets overlap but neither contains the other.
const GRABMAPS_PLACES_LANGUAGES = new Set([
  "en", "id", "km", "lo", "ms", "my", "pt", "th", "tl", "vi", "zh",
]);

// Default label language for a country code (case-insensitive). Returns null
// when the country has no entry, so callers can apply their own fallback chain
// (configured default → DEFAULT_MAP_LANGUAGE).
function languageForCountry(countryCode) {
  if (!countryCode) return null;
  return COUNTRY_LANGUAGE[String(countryCode).toUpperCase()] || null;
}

module.exports = {
  MAP_LABEL_LANGUAGES,
  GRABMAPS_PLACES_LANGUAGES,
  DEFAULT_MAP_LANGUAGE,
  COUNTRY_LANGUAGE,
  languageForCountry,
};
