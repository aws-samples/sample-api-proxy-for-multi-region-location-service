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

// Throw on a non-ok ALS response so an HTTP error (expired key, throttling,
// bad region) is never mistaken for valid data. Without this, suggest returns
// an empty list (looks like "no matches"), reverse-geocode returns null (silent
// home fallback), and getPlace/getStyleDescriptor return an error body as if it
// were a Place/style. `op` names the call for the log/error; `region` locates it.
async function ensureOk(resp, op, region) {
  if (resp.ok) return resp;
  let detail = "";
  try {
    detail = (await resp.text()).slice(0, 200);
  } catch {
    /* body may be unreadable; the status is enough */
  }
  console.error(`[als] ${op} failed: HTTP ${resp.status} in ${region} ${detail}`);
  const err = new Error(`ALS ${op} failed: HTTP ${resp.status} in ${region}`);
  // Carry the upstream status so the caller can distinguish a client-caused 4xx
  // (bad input → surface as 4xx) from a server-side 5xx / 403 (→ 500). 403 is a
  // bad/expired key, which is the deployment's fault, not the caller's.
  err.status = resp.status;
  throw err;
}

// Transient failures worth retrying: throttling (429) and server errors (5xx).
// A 4xx like 403 (expired/invalid key) or 404 is a hard error — retrying it
// just wastes time and delays the inevitable failure, so we fail fast on those.
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetchImpl: injectable fetch (tests). sleep: injectable backoff (tests use a
// no-op). maxRetries: how many times to retry a TRANSIENT failure after the
// first attempt (default 2 → up to 3 attempts total). backoffMs: base delay,
// doubled each retry.
function createAlsClient({ fetchImpl = fetch, sleep = defaultSleep, maxRetries = 2, backoffMs = 200 } = {}) {
  // Do a fetch and return an ok response, retrying transient failures (429 /
  // 5xx / network errors) with exponential backoff. Non-retryable responses
  // (4xx) throw immediately; a transient failure that never recovers throws
  // once the retry budget is exhausted.
  // opts.probe (bool): in probe mode a non-ok HTTP status is a valid answer
  // (e.g. HEAD 404 = "not present"), so the response is RETURNED rather than
  // thrown — only network errors and retryable 5xx/429 are retried/thrown.
  // Non-probe (default): a non-ok status throws via ensureOk.
  async function fetchOk(url, fetchOpts, op, region, { probe = false } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      let resp;
      try {
        resp = await fetchImpl(url, fetchOpts);
      } catch (err) {
        // Network-level failure (fetch rejected): retry if budget remains.
        // Log op + region only — err.message may carry the key-bearing URL.
        if (attempt < maxRetries) {
          console.warn(`[als] ${op} network error in ${region} (attempt ${attempt + 1}), retrying`);
          continue;
        }
        throw err;
      }
      if (resp.ok) return resp;
      if (isRetryableStatus(resp.status) && attempt < maxRetries) {
        console.warn(`[als] ${op} HTTP ${resp.status} in ${region} (attempt ${attempt + 1}), retrying`);
        continue;
      }
      // Non-retryable status, or out of budget. In probe mode a non-ok status
      // (e.g. 404) is a legitimate answer — return it. Otherwise throw.
      if (probe) return resp;
      return ensureOk(resp, op, region);
    }
    // Unreachable: the loop either returns a response or throws above.
  }

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
    const resp = await fetchOk(
      `${placesEndpoint(region)}/v2/suggest?${params}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "suggest",
      region
    );
    return resp.json();
  }

  async function getPlace({ region, key, placeId, lang }) {
    const params = new URLSearchParams({ key, language: lang || "en" });
    // placeId is an opaque ALS token that may contain reserved URL characters.
    const resp = await fetchOk(
      `${placesEndpoint(region)}/v2/place/${encodeURIComponent(placeId)}?${params}`,
      undefined,
      "getPlace",
      region
    );
    return resp.json();
  }

  async function getStyleDescriptor({ region, key, styleName }) {
    const resp = await fetchOk(
      `${mapsOrigin(region)}/v2/styles/${styleName}/descriptor?key=${key}`,
      undefined,
      "getStyleDescriptor",
      region
    );
    return resp.json();
  }

  // Probe whether a style exists (HEAD). Uses probe mode: a network blip or 5xx
  // is retried (and throws if it never recovers, so the caller can tell "probe
  // failed" from "style absent"); a definitive non-ok like 404 → false.
  async function styleExists({ region, key, styleName }) {
    const resp = await fetchOk(
      `${mapsOrigin(region)}/v2/styles/${styleName}/descriptor?key=${key}`,
      { method: "HEAD" },
      "styleExists",
      region,
      { probe: true }
    );
    return resp.ok;
  }

  // reverse-geocode a position to an ISO alpha-2 country code (or null).
  async function reverseGeocodeCountry({ region, key, lat, lng }) {
    const params = new URLSearchParams({ key });
    const resp = await fetchOk(
      `${placesEndpoint(region)}/v2/reverse-geocode?${params}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ QueryPosition: [parseFloat(lng), parseFloat(lat)], MaxResults: 1 }),
      },
      "reverseGeocode",
      region
    );
    const data = await resp.json();
    const item = (data.ResultItems || [])[0];
    return item?.Address?.Country?.Code2 || null;
  }

  // Rewrite an ALS style descriptor so tile/glyph/sprite URLs go through the
  // region-prefixed CloudFront path and carry no key.
  function rewriteStyle(style, { region, mapTileDomain }) {
    const amazonOrigin = mapsOrigin(region);
    const cfOrigin = `https://${mapTileDomain}/${region}`;
    // Rewrite the origin, then drop the key from the QUERY STRING only. We can't
    // feed the whole URL to `new URL()` because tile templates carry unencoded
    // {z}/{x}/{y} placeholders in the PATH, which URL would percent-encode and
    // break MapLibre. Parsing just the query with URLSearchParams removes `key`
    // wherever it sits (not only when last) without leaving a dangling
    // separator (the old /[?&]key=[^&]+/ regex turned "?key=K&foo=1" into
    // "&foo=1"), and drops the "?" entirely when no other params remain.
    const swap = (url) => {
      const rewritten = url.replace(amazonOrigin, cfOrigin);
      const q = rewritten.indexOf("?");
      if (q === -1) return rewritten;
      const params = new URLSearchParams(rewritten.slice(q + 1));
      params.delete("key");
      const qs = params.toString();
      return qs ? `${rewritten.slice(0, q)}?${qs}` : rewritten.slice(0, q);
    };

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
