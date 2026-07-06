function placesEndpoint(region) {
  return `https://places.geo.${region}.amazonaws.com`;
}
function mapsOrigin(region) {
  return `https://maps.geo.${region}.amazonaws.com`;
}

// Strip null values from a paint/layout object (MapLibre rejects nulls).
function cleanProps(obj) {
  if (!obj) return obj;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null));
}

function createAlsClient({ fetchImpl = fetch } = {}) {
  // lang controls the result display language only (not input); defaults to en
  // (this proxy targets overseas regions). includeCountries (ISO codes) becomes
  // a hard Filter.IncludeCountries — it coexists with BiasPosition and overrides
  // bias ranking, so results are constrained to those countries.
  async function suggest({ region, key, query, lat, lng, includeCountries, lang }) {
    const params = new URLSearchParams({ key });
    const body = { QueryText: query, Language: lang || "en", MaxResults: 5 };
    if (lat != null && lng != null) body.BiasPosition = [parseFloat(lng), parseFloat(lat)];
    if (includeCountries && includeCountries.length) {
      body.Filter = { IncludeCountries: includeCountries };
    }
    const resp = await fetchImpl(`${placesEndpoint(region)}/v2/suggest?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  async function getPlace({ region, key, placeId, lang }) {
    const params = new URLSearchParams({ key, language: lang || "en" });
    const resp = await fetchImpl(`${placesEndpoint(region)}/v2/place/${placeId}?${params}`);
    return resp.json();
  }

  async function getStyleDescriptor({ region, key, styleName }) {
    const resp = await fetchImpl(
      `${mapsOrigin(region)}/v2/styles/${styleName}/descriptor?key=${key}`
    );
    return resp.json();
  }

  async function styleExists({ region, key, styleName }) {
    const resp = await fetchImpl(
      `${mapsOrigin(region)}/v2/styles/${styleName}/descriptor?key=${key}`,
      { method: "HEAD" }
    );
    return resp.ok;
  }

  // reverse-geocode a position to an ISO alpha-2 country code (or null).
  async function reverseGeocodeCountry({ region, key, lat, lng }) {
    const params = new URLSearchParams({ key });
    const resp = await fetchImpl(`${placesEndpoint(region)}/v2/reverse-geocode?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ QueryPosition: [parseFloat(lng), parseFloat(lat)], MaxResults: 1 }),
    });
    const data = await resp.json();
    const item = (data.ResultItems || [])[0];
    return item?.Address?.Country?.Code2 || null;
  }

  // Rewrite an ALS style descriptor so tile/glyph/sprite URLs go through the
  // region-prefixed CloudFront path and carry no key.
  function rewriteStyle(style, { region, mapTileDomain }) {
    const amazonOrigin = mapsOrigin(region);
    const cfOrigin = `https://${mapTileDomain}/${region}`;
    const swap = (url) =>
      url.replace(amazonOrigin, cfOrigin).replace(/[?&]key=[^&]+/g, "");

    if (style.sources) {
      for (const src of Object.values(style.sources)) {
        if (src.tiles) src.tiles = src.tiles.map(swap);
        if (src.url) src.url = swap(src.url);
      }
    }
    if (style.glyphs) style.glyphs = swap(style.glyphs);
    if (style.sprite) style.sprite = swap(style.sprite);
    if (style.layers) {
      style.layers = style.layers.map((layer) => ({
        ...layer,
        paint: cleanProps(layer.paint),
        layout: cleanProps(layer.layout),
      }));
    }
    return style;
  }

  return { suggest, getPlace, getStyleDescriptor, styleExists, reverseGeocodeCountry, rewriteStyle };
}

module.exports = { createAlsClient, placesEndpoint, mapsOrigin };
