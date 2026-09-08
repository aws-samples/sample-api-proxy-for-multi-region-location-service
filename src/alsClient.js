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

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("Backoff aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) return onAbort();
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// fetchImpl: injectable fetch (tests). sleep: injectable backoff (tests use a
// no-op). A custom sleep receives (milliseconds, AbortSignal). maxRetries: how
// many times to retry a TRANSIENT failure after the first attempt (default 2 →
// up to 3 attempts total). backoffMs: base delay, doubled each retry.
function createAlsClient({
  fetchImpl = fetch,
  sleep = defaultSleep,
  maxRetries = 2,
  backoffMs = 200,
  requestTimeoutMs = 8_000,
} = {}) {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("requestTimeoutMs must be a positive finite number");
  }

  // Do a fetch and return an ok response, retrying transient failures (429 /
  // 5xx / network errors) with exponential backoff. The timeout covers the
  // whole operation (all attempts + backoff), so one hung ALS call cannot keep
  // an HTTP request alive past the task's graceful-shutdown window.
  // opts.probe (bool): in probe mode a non-ok HTTP status is a valid answer
  // (e.g. HEAD 404 = "not present"), so the response is RETURNED rather than
  // thrown — only network errors and retryable 5xx/429 are retried/thrown.
  // Non-probe (default): a non-ok status throws via ensureOk.
  async function fetchOk(url, fetchOpts, op, region, { probe = false } = {}) {
    const controller = new AbortController();
    const timeoutError = () => {
      const err = new Error(`ALS ${op} timed out after ${requestTimeoutMs}ms in ${region}`);
      err.code = "ALS_TIMEOUT";
      return err;
    };
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const waitForBackoff = async (ms) => {
      if (controller.signal.aborted) throw timeoutError();
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(timeoutError());
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([sleep(ms, controller.signal), aborted]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    };

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await waitForBackoff(backoffMs * 2 ** (attempt - 1));
        let resp;
        try {
          resp = await fetchImpl(url, { ...(fetchOpts || {}), signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) throw timeoutError();
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
    } finally {
      clearTimeout(timeout);
    }
  }

  // lang controls the result display language only (not input); defaults to en
  // (this proxy targets overseas regions). includeCountries (ISO codes) becomes
  // a hard Filter.IncludeCountries — it coexists with BiasPosition and overrides
  // bias ranking, so results are constrained to those countries. maxResults maps
  // to MaxResults (ALS accepts 1-100, defaults to 20); we default to 5 to keep the
  // demo's suggestion dropdown short. It is an upper bound, not a guarantee.
  async function suggest({ region, key, query, lat, lng, includeCountries, lang, maxResults }) {
    const params = new URLSearchParams({ key });
    const body = { QueryText: query, Language: lang || "en", MaxResults: maxResults || 5 };
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

  // Which (region, style) pairs we've already reported cache headers for. Bounded
  // by the deployment: styleName is validated against the detected styles and
  // region against the configured set before reaching here, so this can hold at
  // most regions x styles entries (~26 for the reference mapping).
  const cacheHeadersLogged = new Set();

  // Log the UPSTREAM cache headers once per (region, style). ALS documents
  // GetStyleDescriptor as returning Cache-Control and ETag; we want the real
  // values to decide whether a descriptor cache is worth adding and what TTL to
  // use, but not a line per request — hence once per combination.
  //
  // Deliberately logs only region/style/headers, never the request URL: the URL
  // carries ?key=<apiKey> and would leak it into CloudWatch.
  function logStyleCacheHeaders(resp, region, styleName) {
    const pair = `${region}/${styleName}`;
    if (cacheHeadersLogged.has(pair)) return;
    cacheHeadersLogged.add(pair);
    const h = (name) => resp.headers?.get(name) || "(none)";
    console.log(
      `[als] getStyleDescriptor ${pair} upstream cache headers: ` +
        `cache-control=${h("cache-control")} etag=${h("etag")} age=${h("age")}`
    );
  }

  // Descriptor URL for a style. The key goes through URLSearchParams like every
  // other call rather than being interpolated raw: an API key is an opaque token
  // and a future format with a reserved character (& # +) would otherwise
  // silently truncate the query. styleName is validated against the detected
  // styles before it reaches here, but encode it too so the path can't be
  // steered by input.
  function descriptorUrl(region, key, styleName) {
    const params = new URLSearchParams({ key });
    return `${mapsOrigin(region)}/v2/styles/${encodeURIComponent(styleName)}/descriptor?${params}`;
  }

  async function getStyleDescriptor({ region, key, styleName }) {
    const resp = await fetchOk(
      descriptorUrl(region, key, styleName),
      undefined,
      "getStyleDescriptor",
      region
    );
    logStyleCacheHeaders(resp, region, styleName);
    return resp.json();
  }

  // Probe whether a style exists (HEAD). Uses probe mode: a network blip or 5xx
  // is retried (and throws if it never recovers, so the caller can tell "probe
  // failed" from "style absent"); a definitive non-ok like 404 → false.
  async function styleExists({ region, key, styleName }) {
    const resp = await fetchOk(
      descriptorUrl(region, key, styleName),
      { method: "HEAD" },
      "styleExists",
      region,
      { probe: true }
    );
    return resp.ok;
  }

  // POST /v2/reverse-geocode. `body` carries the operation-specific fields.
  //
  // IntendedUse is left at the ALS default of SingleUse (results are NOT
  // persisted). Storing reverse-geocode results requires IntendedUse=Storage
  // per the terms of service AND is billed at a higher rate, so it must be an
  // explicit decision — never a silent default.
  async function postReverseGeocode({ region, key, lat, lng, extra = {} }, op) {
    const params = new URLSearchParams({ key });
    const resp = await fetchOk(
      `${placesEndpoint(region)}/v2/reverse-geocode?${params}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          QueryPosition: [parseFloat(lng), parseFloat(lat)],
          MaxResults: 1,
          ...extra,
        }),
      },
      op,
      region
    );
    return resp.json();
  }

  // reverse-geocode a position to an ISO alpha-2 country code (or null).
  async function reverseGeocodeCountry({ region, key, lat, lng }) {
    const data = await postReverseGeocode({ region, key, lat, lng }, "reverseGeocode");
    const item = (data.ResultItems || [])[0];
    return item?.Address?.Country?.Code2 || null;
  }

  // reverse-geocode a position to the FULL nearest place (for a map click), or
  // null when the position has no result (ocean, unmapped area — a legitimate
  // answer, not an error).
  //
  // `lang` renders Title/Address in that language. The caller must have already
  // clamped it to what the target region supports: GrabMaps regions accept only
  // a subset (en, id, km, lo, ms, my, pt, th, tl, vi, zh) and reject the rest.
  async function reverseGeocodePlace({ region, key, lat, lng, lang }) {
    const data = await postReverseGeocode(
      { region, key, lat, lng, extra: lang ? { Language: lang } : {} },
      "reverseGeocodePlace"
    );
    const item = (data.ResultItems || [])[0];
    if (!item) return null;
    return {
      placeType: item.PlaceType || null,
      title: item.Title || null,
      address: item.Address || null,
      // ALS echoes the matched place's own position, which is the snapped
      // street/building point rather than the raw click — worth surfacing.
      position: item.Position || null,
      distanceMeters: typeof item.Distance === "number" ? item.Distance : null,
      country: item.Address?.Country?.Code2 || null,
    };
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

  return {
    suggest,
    getPlace,
    getStyleDescriptor,
    styleExists,
    reverseGeocodeCountry,
    reverseGeocodePlace,
    rewriteStyle,
  };
}

module.exports = { createAlsClient, placesEndpoint, mapsOrigin };
