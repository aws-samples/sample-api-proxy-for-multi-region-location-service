# Amazon Location Service Proxy

Server-side proxy for address autocomplete + map positioning, built with Amazon Location Service and MapLibre GL JS. Routes search and map-tile requests to the Amazon Location Service (ALS) region that best matches the request's country — while keeping every API key off the client.

[中文文档](README.zh-CN.md)

## Highlights

**API Keys Stay Off the Client**: Official Amazon Location Service examples typically embed the API key in frontend code, where it is visible in browser DevTools. This project uses a server-side proxy plus CloudFront edge injection so keys do not appear in browser requests or responses, reducing client-side leakage risk.

- Address search requests are proxied through the Express backend; the API Key is used only on the server side
- Map tile requests go through CloudFront, where a CloudFront Function injects the API Key at the edge; browser requests carry no credentials
- The style descriptor is fetched server-side, tile URLs are rewritten, and all key parameters are stripped before returning to the frontend
- API keys are stored in AWS Secrets Manager; after rotation, redeploy the CloudFront map proxy and ECS tasks so they load the new values

**Multi-Region Routing**: Different ALS regions carry different map data providers and region-specific optimizations (e.g. GrabMaps in Southeast Asia). This proxy routes each request to the region matching its country, so users get the best local map/search quality. Routing is driven by a country→region mapping and can be toggled on/off with a single switch.

**Auto Scaling to Reduce Cost**: The production environment uses ECS Fargate with Auto Scaling to adjust capacity between its minimum task count and configured maximum based on CPU utilization. Low traffic still retains the minimum tasks required for availability, while peaks scale out automatically; CloudFront caching further reduces origin traffic.

## Features

- 🔍 Address search autocomplete (Amazon Location Service Geo Places API)
- 📍 Browser geolocation (Geolocation API)
- 🗺️ Interactive map display (MapLibre GL + Amazon Location Map Tiles)
- 🎨 Map style switching (Standard / Monochrome / Hybrid / Satellite)
- 🌏 Country-based routing to the matching ALS region (search + map tiles)
- 🔤 Selectable map label language, defaulted from the country code (see "Map label language")
- 👆 Click anywhere on the map to identify the place there (reverse geocoding, see "Identify a place by clicking the map")

## How Multi-Region Routing Works

Each request resolves to a **target region**, then the proxy calls that region's ALS endpoint with that region's key:

```
Request
  ├── has countryCode            → look up region in the mapping → target region
  ├── has lat/lng, no country    → reverse-geocode via home region → country → mapping → target region
  └── nothing / no match / error → home region (fallback)
```

- The **country→region mapping** (`config/country-region-map.json`) is the **single source of truth**: its top-level keys are the region set (every key becomes a CloudFront behavior, needs an API key, and is validated at startup), and one region is marked **home** with a `"*"` in its country list.
- The **home region** is the default/guide region: it reverse-geocodes coordinates into a country and is the fallback whenever a country has no mapping. It is chosen by putting `"*"` in that region's country list (e.g. `"ap-northeast-1": ["*"]`, or `["*", "JP"]` if it also serves specific countries). Exactly one region must be marked. There is no `HOME_REGION` environment variable — the mapping defines it.
- The home region must be a global-coverage region when routing is on (not a GrabMaps region — `ap-southeast-1` / `ap-southeast-5`), because reverse-geocoding a worldwide coordinate needs global coverage.
- With routing **off**, every request goes to the home region — identical to a plain single-region proxy.

## Architecture

```
Browser
  ├── Address search → Express backend → ALS Geo Places (target region, server-side key)
  ├── Map style      → Express backend (fetch descriptor + rewrite tile URLs to CloudFront)
  └── Map tiles      → CloudFront /<region>/* (edge cache + inject that region's key) → ALS Geo Maps
```

## API protection & security notes

**CORS (`/api`)** — With `ALLOWED_ORIGINS` unset, no CORS allow headers are sent, so cross-origin browser JavaScript cannot read responses. Configure explicit frontend origins when cross-origin access is needed. CORS is not authentication or a quota boundary: non-browser clients can omit or spoof `Origin`, and a browser may still send a disallowed simple request while hiding its response from script. Avoid `*` in production, and use rate limiting, WAF, and origin protection to control abuse. The API carries no cookies or client credentials, so CSRF is not the concern here.

> Behind CloudFront, forward `Origin`, `Access-Control-Request-Method`, and `Access-Control-Request-Headers`; `infra/ecs-fargate.yaml` already does so.

**Rate limiting (`/api`)** — A baseline per-source-IP token bucket (`API_RATE_PER_SEC` sustained + `API_RATE_BURST` spike) throttles abuse; `/health` is exempt so the ALB health check is never throttled. It is a **floor, not a WAF replacement**: per-task (in-memory), so with N ECS tasks the global rate is up to N × `API_RATE_PER_SEC`. For a global cap at the CloudFront edge, attach the optional WAF rule ([step 4](#4-optional-edge-rate-limiting-with-aws-waf)). `TRUST_PROXY=2` (the CloudFront→ALB hop count) keys the limiter on the real, unspoofable client IP, not the ALB's.

**CloudFront → ALB origin protection** — The ALB is internet-facing, but two controls keep it reachable only through *this* distribution: its **security group** admits only the [CloudFront managed prefix list](https://docs.aws.amazon.com/vpc/latest/userguide/working-with-aws-managed-prefix-lists.html), and its listener **returns 403 unless the request carries the `X-Origin-Verify` shared-secret header** this distribution injects (`OriginVerifySecret`). Because the prefix list spans *all* CloudFront distributions, the header is what stops someone pointing their own distribution at your ALB's DNS. (Health checks hit the target directly, so they're unaffected.)

**CloudFront → ALB origin traffic (plaintext)** — Viewer HTTPS terminates at CloudFront; the CloudFront→ALB hop is HTTP but travels the **AWS backbone**, not the public internet. So the residual exposure is plaintext query terms/coordinates on AWS infrastructure — never credentials (neither the ALS key nor the `X-Origin-Verify` secret leaves the backbone). We leave it plaintext by default; to encrypt it, put an ACM cert on a custom ALB domain and point CloudFront's origin at it (the default `*.elb.amazonaws.com` name can't hold an ACM cert).

**Security response headers** — Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, and `Referrer-Policy: no-referrer`. The CSP is limited to `frame-ancestors` because the API returns JSON; a frontend embedding it applies its own full CSP.

## API endpoints

Every endpoint is a `GET` returning JSON. `/api/*` applies the CORS response policy and per-source-IP token bucket; `/health` deliberately sits outside `/api` so the ALB health check is never rate limited.

**Shared routing parameters** (they decide which ALS region serves the request — see "How Multi-Region Routing Works" for the precedence):

| Parameter | Notes |
|---|---|
| `countryCode` | ISO 3166-1 alpha-2. Highest precedence, and also applied as a hard filter. Must be a country served by the mapping file, otherwise 400 |
| `lat` / `lng` | Decimal degrees, **both or neither**. Range `lat∈[-90,90]`, `lng∈[-180,180]`, otherwise 400 |

**Language parameter:** `lang` is optional and accepts BCP 47 tags such as `zh-CN`. `/api/map-style` and `/api/map-labels` reduce it to a primary ISO 639-1 code and require that code to be in the configured 68-language label list. `/api/suggest`, `/api/place`, and `/api/reverse-geocode` use the independent GeoPlaces language contract: the canonical tag is preserved (`zh-CN` stays `zh-CN`), a malformed tag returns 400, a tag whose primary language appears in neither Amazon Location list (`lang=cn`, `lang=xx`) also returns 400 rather than spending an upstream call to be told the same, and requests routed to GrabMaps are clamped to that provider's documented subset.

**When `lang` is omitted, these three endpoints do not fall back to English** — they follow the same chain as the map labels: the request's `countryCode` (or the country reverse-geocoded from `lat`/`lng`) decides, then `DEFAULT_MAP_LANGUAGE`. So a Tokyo search reads Japanese without the client asking. Two consequences worth knowing:

- This differs from a plain GeoPlaces call, which defaults to English. A client that wants English regardless of location must pass `lang=en` explicitly.
- Deriving the country from `lat`/`lng` requires reverse geocoding. Each task caches a roughly 1.1 km grid cell for one hour, and concurrent misses for the same cold cell share one upstream call. Passing `countryCode` — or an explicit `lang` — avoids this lookup.

| Endpoint | Parameters | Returns |
|---|---|---|
| `/health` | — | `{"status":"ok"}` |
| `/api/suggest` | `query` (required) + routing params + `lang` + `limit` | `[{placeId, text, address, position, region}]`. An empty `query` returns `[]` (200) |
| `/api/place/:placeId` | `region` + routing params + `lang` | `{label, position, address, tileRegion, country}` |
| `/api/reverse-geocode` | `lat`+`lng` (**required**), `lang` | `{place, country, tileRegion, language}`; `place` may be `null` |
| `/api/tile-region` | `lat`+`lng` | `{tileRegion, country}` |
| `/api/map-style` | `style`, `region` + routing params | MapLibre style JSON (tile URLs rewritten, key stripped) |
| `/api/map-labels` | same as `/api/map-style` | `{language, source, layers}` |
| `/api/map-styles` | — | `["Standard","Monochrome",…]` (whatever was detected at startup) |
| `/api/map-languages` | — | `{languages:[…], default:"en"}` |
| `/api/map-config` | — | `{center:[lng,lat], zoom, region}` |

Easy things to get wrong:

- **`/api/suggest`'s `limit` is an upper bound, not a count.** It maps to the Suggest API's `MaxResults` (integer 1–100; anything else returns 400 here rather than upstream). Omitted, the proxy asks for 5 — Amazon Location's own default is 20. The response can still be shorter: the service may return fewer, and non-`Place` suggestions are filtered out. Billing is per request, not per result, so a larger `limit` costs nothing extra beyond response size.
- **A large `limit` is for over-fetching, not for display.** The API accepts up to 100 so a caller that needs to post-process — filter by category or distance, dedupe, re-rank, join against its own data — can ask for a wider candidate set and then show only the few rows it wants. That is a deliberate server- or client-side pipeline, not a bigger dropdown. The demo UI therefore offers only 5/10/20: an autocomplete list nobody scrolls gains nothing from 50 raw suggestions.
- **`/api/place` needs its `region` echoed back.** A PlaceId is **region-scoped**, so GetPlace must run in the region that produced it — which is why every `/api/suggest` result carries `region` for the client to pass through. Omitting it falls back to normal region resolution and can miss the place entirely.
- **`tileRegion` is not the region that was queried.** It is the region whose map data covers the **result's country**, for the client to switch tiles to; for a cross-border result the two differ.
- **`/api/map-style` and `/api/map-labels` also return two headers**: `X-Map-Label-Language` and `X-Map-Label-Language-Source` (`explicit` / `country-map` / `config-default` / `fallback`), exposed to cross-origin callers via `Access-Control-Expose-Headers`.
- **`place: null` from `/api/reverse-geocode` is a valid answer** (open ocean or unmapped area), not an error. Both branches return the same keys — `country` is simply `null` — so a client never has to check which fields exist.

**Errors** are always `{"error":"…"}`:

| Status | Meaning |
|---|---|
| 400 | Invalid request input (coordinate format/range, unsupported `countryCode` / `region` / map-label `lang` / `style`, or malformed/unsupported Places BCP 47 `lang`), or a caller-caused upstream ALS 4xx. The body is generic; details stay in the server log |
| 429 | Per-source-IP rate limit exceeded, with a `Retry-After` header in seconds |
| 500 | Server or upstream failure, including an invalid-key ALS 403, exhausted ALS 429 retries, timeout, or 5xx. The body is always `{"error":"Internal server error"}` and never leaks region, key, or upstream details |

## Prerequisites

1. An AWS account with Amazon Location Service enabled
2. One Location Service **API Key per region in the mapping** (each key needs both `geo-places` and `geo-maps` permissions). Keys are created per region because an ALS API key is region-scoped.
3. `node` (v20+) and the `aws` CLI (configured with credentials).

Two region concepts are used throughout and are intentionally kept distinct:

| Term | Meaning |
|---|---|
| **deploy region** (`<deploy-region>`) | The single region that hosts your infrastructure: the Secrets Manager secret, the CloudFront stack, the ECS stack, and the ECR repository. |
| **ALS region** (`<als-region>`) | A region the proxy routes to — one of the keys in the mapping file. There can be several. |

The home region and the deploy region are independent: they can be the same or different (e.g. deploy in Singapore for latency, but mark `ap-northeast-1` as home with `"*"` because Singapore is a GrabMaps region and can't be the reverse-geocode guide).

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `MULTI_REGION_ROUTING` | Routing switch; defaults to `false` (single-region: everything uses the home region). | `true` |
| `LOCATION_API_KEYS` | JSON of region→API Key (each key has geo-places + geo-maps). Provided as one Secrets Manager secret. | `{"ap-northeast-1":"v1.public.xxx"}` |
| `MAP_TILE_DOMAIN` | CloudFront map-tile domain (output of the CloudFront stack). | `d123.cloudfront.net` |
| `ALLOWED_ORIGINS` | CORS allowlist for `/api` (comma-separated). Unset means no CORS allow headers; this controls whether browser scripts can read cross-origin responses, not authentication. | `https://app.example.com` |
| `API_RATE_PER_SEC` | Sustained per-source-IP request rate for `/api` (token-bucket refill). Default `10`. | `20` |
| `API_RATE_BURST` | Per-source-IP burst capacity for `/api` (bucket size). Default `20`. | `40` |
| `TRUST_PROXY` | Express `trust proxy` value — the proxy hop count so the rate limiter sees the real, unspoofable client IP. **Defaults to `false`** (fail-safe: an unset/empty or unrecognized value won't trust a client-supplied `X-Forwarded-For`, so the limiter can't be dodged; a bad value also warns). Behind CloudFront→ALB set it to `2` (the hop count) — the ECS stack passes `TrustProxy=2` by default. | `2` |
| `REVERSE_GEO_CACHE_MAX` | FIFO cap for the per-task reverse-geocode grid cache (backstop against unbounded growth). Default `200000`. | `200000` |
| `DEFAULT_MAP_LANGUAGE` | Fallback map label language (ISO 639-1), used only when a request has no explicit `lang` and no country to derive one from. Default `en`. An invalid value **fails at startup** rather than silently rendering every map in English. | `zh` |

> The regions in use **and the home region** are **not** environment variables — they come from `config/country-region-map.json` (its keys, and the `"*"`-marked region). Locally the variables above are set via `export`; in production they are passed as CloudFormation parameters (see below). The two mechanisms are independent.

## The Country→Region Mapping File

`config/country-region-map.json` is region-first (`{ region: [ISO country codes] }`) and is the single source of truth for both the region set and the home region:

```json
{
  "ap-northeast-1": ["*", "JP", "KR"],
  "ap-southeast-1": ["SG", "MY", "TH", "ID", "VN", "PH"],
  "eu-central-1": ["GB", "DE", "FR", "NL", "IE", "ES", "IT"],
  "us-east-1": ["US", "CA", "MX"]
}
```

- Each top-level key is an in-use region (gets a CloudFront behavior, needs a key, is validated at startup).
- Exactly one region must include `"*"` in its country list — that marks the **home region** (fallback + reverse-geocode guide). It may also serve specific countries (as above) or be fallback-only (`"ap-northeast-1": ["*"]`).
- A country not listed anywhere behaves differently depending on how the request supplied it. An **explicit `countryCode`** is rejected with **400** (`Unsupported countryCode "XX" (not a served country in the mapping)`) — the mapping is the allowlist of served countries, so a valid ISO code alone is not enough. A country **reverse-geocoded from `lat`/`lng`** falls back to the home region (logged, never an error). Adding a market therefore means adding it to this file.
- Before adding a country, check that the target region's map data provider actually covers it well. Routing a country to a region whose provider has weak local data is worse than leaving it unlisted on the home region, so the example file deliberately lists fewer countries than exist — treat it as a starting point to verify, not a table to extend blindly.

The **real** `config/country-region-map.json` is gitignored (the country list is deployment-specific). The repo tracks `config/country-region-map-example.json`. Create your real file from it:

```bash
cp config/country-region-map-example.json config/country-region-map.json
```

- **Multi-region**: edit the copy to match your business (regions + countries), keeping exactly one region marked `"*"` as home.
- **Single-region**: keep just one region, marked home, e.g. `{ "us-east-1": ["*"] }` (all countries fall back to it).

The file is required at runtime: the app reads it on startup and fails fast if missing (the error tells you to run the `cp` above). `docker build` bakes it into the image, so it must exist before building too.

## Identify a place by clicking the map

Pan and zoom anywhere, then click to get the place at that point (reverse geocoding). The frontend sends the clicked coordinate to `GET /api/reverse-geocode?lat=&lng=&lang=`, which returns:

```json
{ "place": { "label": "東京駅", "address": { "Label": "…", "Locality": "千代田区" },
             "position": [139.7671, 35.6812], "placeType": "PointAddress", "distanceMeters": 12.5 },
  "country": "JP", "tileRegion": "ap-northeast-1", "language": "ja" }
```

Clicking also follows the country context: with "follow the selected result's country" checked it backfills the country box, and switches the tile region (keeping the current view) and label language as needed.

> **The GrabMaps language subset.** AWS documents only `en, id, km, lo, ms, my, pt, th, tl, vi, zh` for GeoPlaces in `ap-southeast-1` / `ap-southeast-5`; it does not document fallback behavior outside that subset. Therefore a Singapore request made while labels are Japanese is clamped before it reaches GeoPlaces (`clampPlacesLanguage`) instead of relying on an undocumented downgrade or error response. The clamp prefers `DEFAULT_MAP_LANGUAGE` when that is itself documented there (a deployment serving Southeast Asia may well default to `th`), and only then falls back to `en`. Note this set and the 68 map label languages do not contain each other: it has `lo` and `tl`, which are not valid label languages. See the [GeoPlaces `Language` reference](https://docs.aws.amazon.com/cli/latest/reference/geo-places/reverse-geocode.html).
>
> The response's `language` field reports what was actually used, and the demo page shows it in the info panel when it differs from the picked language — so an English address under Japanese map labels reads as a deliberate degradation rather than a bug.

> **`IntendedUse` is left at the default `SingleUse` (not persisted).** Storing reverse-geocode results requires setting it to `Storage` per the terms of service and is billed at a higher rate — that has to be an explicit decision, never a silent default.

## Map label language

Amazon Location's **dynamic (vector-tile) maps have no server-side language parameter** — `GetStyleDescriptor` accepts `ColorScheme` / `PoliticalView` / `Terrain` and friends, but not a language; only the raster `GetStaticMap` API takes `Language`. So this proxy follows the AWS-documented approach and rewrites each symbol layer's `text-field` in the style descriptor to prefer the tile's `name:<lang>` property ([preferred-language guide](https://docs.aws.amazon.com/location/latest/developerguide/how-to-set-preferred-language-map.html)):

```
["coalesce", ["get","name:zh"], ["get","name:en"], ["get","name"]]
```

The 68-code list in `config/map-languages.js` is transcribed from the documented [`GetStaticMap Language` values](https://docs.aws.amazon.com/cli/latest/reference/geo-maps/get-static-map.html) and conservatively reused for vector-tile `name:<lang>` properties. AWS does not publicly guarantee that the raster enum and vector-tile property set will always remain identical.

`name:en` and `name` stay as fallbacks, so a feature with no translation still gets a label. The rewrite touches only the `/api/map-style` response — **tile URLs are unchanged**, so CloudFront caching and the tile proxy are unaffected (the tiles already carry every language's name field).

How the language is decided:

1. `GET /api/map-style?lang=<ISO 639-1>` — explicit, highest priority. Full BCP 47 tags are accepted (`zh-CN` → `zh`). An **unsupported value returns 400** (e.g. `lang=cn`; Chinese is `zh`) rather than silently falling back to English.
2. **From the country code** (the default): the request's `countryCode`, or the country reverse-geocoded from `lat`/`lng`, is looked up in the `COUNTRY_LANGUAGE` table in `config/map-languages.js`. The reverse-geocoded country is reused from the routing decision, so this costs no extra ALS call.
3. `DEFAULT_MAP_LANGUAGE` (default `en`).

Note that `?region` only selects **which region serves the tiles** — it does not affect the language. A region spans many countries, so the two are deliberately independent decisions.

The `X-Map-Label-Language` and `X-Map-Label-Language-Source` response headers report what was actually applied and why (`explicit` / `country-map` / `config-default` / `fallback`), which is how the frontend displays the current language while the picker is on "auto". `GET /api/map-languages` returns the selectable languages and the default, so a frontend builds its picker from the server instead of holding a copy of the list that goes stale.

Per-country defaults live in `config/map-languages.js`. Where a country's main language is not among the 68 ALS supports (Sinhala for LK, Nepali for NP, Urdu for PK, Swahili for KE/TZ, Mongolian for MN), the table falls back to that country's common administrative language (usually `en`) — an unsupported code would just produce untranslated labels.

The Satellite style has no label layers, and ALS documents it as not supporting language, so the rewrite is a no-op there.

> **CJK labels depend on local font rasterization.** Measured against the live service, ALS's glyph endpoint returns **zero glyphs** for the CJK ideograph, kana and Hangul ranges, while every other script is served normally (Latin, Cyrillic, Arabic, Devanagari, Thai, Greek, Hebrew, Georgian, Khmer, Myanmar and the Indic scripts all come back populated). MapLibre already rasterizes those ranges from a local font **by default** — `localIdeographFontFamily` defaults to `'sans-serif'` — so the frontend only names better per-platform CJK faces. Setting that option to `false` disables local rasterization and makes every CJK label vanish, leaving only numeric road shields.

### The cheap path for a language-only change

Moving between countries inside one region (`eu-central-1` covers 67 countries and 38 languages) changes the language but not the tiles. Refetching the whole descriptor for that is expensive: ~136 KB, plus `map.setStyle()` rebuilds the entire style — re-requesting glyphs and sprites, dropping any client-added layers, and needing a callback to restore the view.

`GET /api/map-labels` returns only the rewritten label expressions, keyed by layer id:

```json
{ "language": "fr", "source": "country-map",
  "layers": { "place_label": ["coalesce",["get","name:fr"],["get","name:en"],["get","name"]], "...": [] } }
```

That's ~3 KB (45x smaller than the full descriptor), and the frontend assigns it in place with `map.setLayoutProperty(id, "text-field", expr)`. The query contract is identical to `/api/map-style` and the server reuses the same `applyPreferredLanguage`, so the result matches a full reload — the language decision and expression rewriting stay on the server while the client only assigns returned values.

Region and map-style switches still go through `/api/map-style`: they need a fresh descriptor anyway, and that request already carries the right language.

Note this saves browser bandwidth and the style rebuild, **not** the upstream ALS `GetStyleDescriptor` call. To cut ALS calls, add a server-side descriptor cache keyed by `(region, style)` instead — the next section records the upstream behavior measured for exactly that decision.

### Upstream cache behavior (measured)

`getStyleDescriptor` logs the upstream cache headers once per `(region, style)` (deduplicated, and never logging the URL — it carries `?key=`). Measured across 7 regions and 3 styles, 11 combinations, all identical:

```
cache-control=max-age=86400,must-revalidate   etag=(none)
```

Three consequences:

- **`max-age` is 24 hours, which is long.** With hit rate `λT/(1+λT)`, a 24h TTL breaks even at one request per key per task per *day* — any real traffic clears that, so the TTL is never the binding constraint.
- **There is no `ETag`.** Although the AWS docs list `ETag` among this API's response headers, real responses omit it (ruled out a logging miss and header stripping: ECS talks to `maps.geo.<region>.amazonaws.com` directly; only tiles go through CloudFront). So **cheap revalidation via `If-None-Match` is not possible** — expiry means a full refetch, never a 304.
- **`must-revalidate`** means a stale response must not be reused without validating against the origin. Combined with the missing ETag, "validating" *is* a full refetch, so keep TTL ≤ 86400 and don't do stale-while-revalidate.

With no validator available, **shortening the TTL is the only way to bound staleness**. The 26 descriptors total ~2.1 MB and refreshing is cheap (TTL=1h with all 26 keys active is ~50 MB/day/task; realistically only a few keys are hot, ~3 MB/day/task), so default to 1 hour and make it configurable up to 86400 — a few MB buys "an AWS style update appears within an hour" instead of a 24-hour blind spot.

Two traps if you implement it:

- **Cache the raw JSON string, not the parsed object.** `als.rewriteStyle()` mutates its input's `sources[*].tiles`, `glyphs` and `sprite` in place. Handing it a cached object rewrites the cached copy to its "already proxied" form on the first request; subsequent requests then find no original origin to `replace` and silently return an already-rewritten style. Caching strings and calling `JSON.parse` per request (~1 ms for 135 KB) is inherently safe and far smaller (2.1 MB measured, versus 15.1 MB as parsed objects).
- **No Redis/ElastiCache needed.** 26 entries and 2.1 MB against a 512 MB task; and since any given `(region, style)` is equivalent within its TTL, there is no cross-task invalidation to coordinate. An in-process `Map` with a FIFO bound, mirroring `src/reverseGeocoder.js`, is enough.

## Deployment

The steps below are the **same for single-region and multi-region**. Where they differ, a **Single-region** / **Multi-region** note calls it out. Throughout, `<deploy-region>` is your one infrastructure region and `<als-region>` is a region from the mapping.

### 0. Create the mapping file

```bash
cp config/country-region-map-example.json config/country-region-map.json
# then edit config/country-region-map.json for your regions/countries
```

- **Single-region**: reduce it to one region, marked home, e.g. `{ "us-east-1": ["*"] }`.
- **Multi-region**: list each region and its countries; mark exactly one region home with `"*"`.

### 1. Create the per-region API Keys and store them in Secrets Manager

An ALS API key is region-scoped, so you need one key per region in the mapping. The helper script derives the region set from the mapping file, creates a key in each, assembles the `LOCATION_API_KEYS` JSON, and (with `--write-secret`) stores it in Secrets Manager:

```bash
scripts/create-api-keys.sh \
  --mapping-file config/country-region-map.json \
  --secret-name location-proxy/api-keys \
  --deploy-region <deploy-region> \
  --write-secret
```

Without `--write-secret` the script only prints the JSON to stdout so you can review it first. It creates one key named `ProxyApiKey-<als-region>` per region. This works for both single- and multi-region (single-region just has one region → one key).

<details>
<summary>Prefer to do it manually?</summary>

Run once per `<als-region>` in your mapping, then combine the keys into one JSON secret yourself:

```bash
aws location create-key \
  --key-name ProxyApiKey-<als-region> \
  --restrictions '{
    "AllowActions":["geo-places:*","geo-maps:*"],
    "AllowResources":[
      "arn:aws:geo-maps:<als-region>::provider/*",
      "arn:aws:geo-places:<als-region>::provider/*"
    ]}' \
  --expire-time "2028-08-08T08:08:08Z" \
  --region <als-region>

aws secretsmanager create-secret \
  --name location-proxy/api-keys \
  --secret-string '{"<als-region-1>":"v1.public.xxx","<als-region-2>":"v1.public.yyy"}' \
  --region <deploy-region>
```
</details>

### 2. Generate and deploy the CloudFront map-tile proxy

The CloudFront template `infra/cloudfront-map-proxy.yaml` is generated from the mapping file (per region: an origin, a `/<region>/*` behavior, and a CloudFront Function that injects that region's key at the edge and strips the region path prefix):

```bash
node scripts/generate-cloudfront-template.js
```

The template's CachePolicy / OriginRequestPolicy names are account-global (CloudFront is a global service), so the generator appends a short random suffix to avoid `AlreadyExists` collisions across stacks, regions, or redeploys. Set `POLICY_NAME_SUFFIX` to pin it (e.g. for reproducible output): `POLICY_NAME_SUFFIX=v1 node scripts/generate-cloudfront-template.js`.

The generated template reads the JSON secret directly via `{{resolve:secretsmanager:location-proxy/api-keys:SecretString:<region>}}`, so no parameters are needed. Deploy it in your deploy region:

```bash
aws cloudformation deploy \
  --template-file infra/cloudfront-map-proxy.yaml \
  --stack-name location-map-proxy \
  --region <deploy-region>
```

Get the CloudFront domain (this is your `MAP_TILE_DOMAIN`):

```bash
aws cloudformation describe-stacks \
  --stack-name location-map-proxy \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomain`].OutputValue' \
  --output text \
  --region <deploy-region>
```

### 3. Run the application

#### Locally

```bash
npm install
# (mapping file already created in step 0; the "*"-marked region is the home region)

export MULTI_REGION_ROUTING=true   # single-region: false
export LOCATION_API_KEYS='{"ap-northeast-1":"v1.public.xxx","eu-central-1":"v1.public.yyy"}'
export MAP_TILE_DOMAIN=d1234567890.cloudfront.net   # from step 2

npm start
```

> `LOCATION_API_KEYS` must contain an entry for **every region in your mapping file** (the example above shows two regions — match yours). A missing key fails startup validation. The `create-api-keys.sh` script in step 1 assembles this JSON for you.

Open http://localhost:3000

- **Single-region**: set `MULTI_REGION_ROUTING=false` and put a single region in the mapping and in `LOCATION_API_KEYS`.

#### Production (CloudFront + ALB + ECS Fargate)

High-availability architecture: CloudFront edge acceleration + ALB + multi-AZ ECS Fargate + Auto Scaling. Configuration is passed as CloudFormation parameters (not `export`).

```
Browser
  ├── Static assets → CloudFront (edge cache) → ALB → ECS Fargate
  ├── API requests  → CloudFront (AWS backbone) → ALB → ECS Fargate → Amazon Location Service
  └── Map tiles     → CloudFront (edge cache + inject API Key) → Amazon Location Service
```

**a. Create an ECR repository and push the image** (in your deploy region):

```bash
aws ecr create-repository --repository-name location-proxy --region <deploy-region>

# Log in to ECR
aws ecr get-login-password --region <deploy-region> | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com

# Build and push (config/country-region-map.json must exist — it is baked into the image)
docker build --platform linux/arm64 -t location-proxy .
docker tag location-proxy:latest <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
docker push <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
```

**b. Deploy the ECS Fargate stack** (in your deploy region). The regions and home region come from the mapping file baked into the image. A first deployment needs the routing switch, API-key secret, map-tile domain, image, and origin-verification secret; `DefaultMapLanguage` is optional and defaults to `en`. Generate a strong `OriginVerifySecret` for the first deployment (it lets the ALB reject requests that did not come through this CloudFront distribution):

```bash
ORIGIN_VERIFY_SECRET=$(openssl rand -hex 32)

aws cloudformation deploy \
  --template-file infra/ecs-fargate.yaml \
  --stack-name location-proxy-ecs \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    LocationApiKeysSecretArn=arn:aws:secretsmanager:<deploy-region>:<ACCOUNT_ID>:secret:location-proxy/api-keys-XXXXXX \
    MultiRegionRouting=true \
    MapTileDomain=d1234567890.cloudfront.net \
    ImageUri=<ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest \
    DefaultMapLanguage=en \
    OriginVerifySecret=$ORIGIN_VERIFY_SECRET \
  --region <deploy-region>
```

- **Single-region**: set `MultiRegionRouting=false` (the home region is whatever you marked `"*"` in the mapping).
- **`DefaultMapLanguage`**: sets `DEFAULT_MAP_LANGUAGE` and defaults to `en`, so it may be omitted; the command above shows `en` explicitly to make the English default clear. It is used only when a request has neither an explicit language nor a country to derive one from. Change it to `zh` or another supported two-letter language code if needed; an unsupported value fails task startup.
- **`OriginVerifySecret`** (required on the first deployment, minimum 16 characters): CloudFront injects this shared secret as `X-Origin-Verify`, and the ALB returns 403 when it is absent. **When updating an existing stack, you do not need to recover this `NoEcho` parameter's plaintext or generate another value: omit `OriginVerifySecret` from `--parameter-overrides` to retain the stack's current value.** Pass a new value only for an intentional rotation.
- **Optional protection params** (sensible defaults, override as needed): `AllowedOrigins=https://app.example.com` (let that frontend read cross-origin `/api` responses), `ApiRatePerSec=10` / `ApiRateBurst=20` (per-source-IP `/api` rate limit), `TrustProxy=2` (CloudFront→ALB hop count for the real client IP; default already `2`), `WebACLArn=...` (attach an edge WAF — see the optional step below). See [API protection & security notes](#api-protection--security-notes).

> **For later code/mapping-only updates**: if you rebuild and push to the same image tag (`:latest`) while the template and parameters remain unchanged, `cloudformation deploy` reports *"No changes to deploy"*. In that case:
> - Run `aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment --region <deploy-region>`.

**c. Get the access URL**:

```bash
aws cloudformation describe-stacks \
  --stack-name location-proxy-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <deploy-region>
```

> **Page cache (only if an old page is still served after the update deployment)**: a CloudFront configuration deployment does not guarantee eviction of every previously cached object. If an edge location still returns the old `public/index.html`, or immediate page freshness must be guaranteed, invalidate the **application CloudFront** created by the ECS stack as needed (not the map-tile proxy from step 2):
>
> ```bash
> DIST_ID=$(aws cloudformation describe-stacks \
>   --stack-name location-proxy-ecs \
>   --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' \
>   --output text \
>   --region <deploy-region>)
>
> aws cloudfront create-invalidation \
>   --distribution-id "$DIST_ID" \
>   --paths "/" "/index.html"
> ```
>
> `/api/*` uses a caching-disabled policy, so API responses do not need invalidation.

### 4. Optional: edge rate limiting with AWS WAF

A WAF rate-based rule caps requests per client IP at the CloudFront edge — a global backstop above the per-task in-app limiter. Skip this step to run with the in-app limiter only.

A `CLOUDFRONT`-scoped WebACL can **only** be created in **us-east-1**, so it lives in its own small stack (`infra/waf-webacl.yaml`) regardless of your deploy region. Deploy it there:

```bash
aws cloudformation deploy \
  --template-file infra/waf-webacl.yaml \
  --stack-name location-proxy-waf \
  --parameter-overrides WafRateLimit=2000 \
  --region us-east-1
```

Get the WebACL ARN and re-run the ECS deploy (step b) with `WebACLArn=<arn>` added — CloudFront is global, so a us-east-1 WebACL attaches to the distribution even though the ECS stack is in your business region:

```bash
aws cloudformation describe-stacks \
  --stack-name location-proxy-waf \
  --query 'Stacks[0].Outputs[?OutputKey==`WebACLArn`].OutputValue' \
  --output text --region us-east-1
```

> `WafRateLimit` is requests per rolling 5-minute window per IP (default `2000`, min `100`).

## Updating the country→region mapping

Edit `config/country-region-map.json`, then rebuild and push the image. Roll it out with `aws ecs update-service --force-new-deployment` (or an immutable image tag — see the note under step b; `cloudformation deploy` alone does nothing when the tag is unchanged). The template maintains at least two healthy tasks during a rolling update, but downstream timeouts, insufficient capacity, or platform failures can still affect availability. If you added a **new region**, first create its key and update the secret (rerun step 1), then regenerate and redeploy the CloudFront stack (step 2). A misconfigured mapping fails startup validation, so the new task never becomes healthy and the old version keeps serving.

## Tests

```bash
npm test
```

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

---

⭐ If this project is useful to you, please consider [starring the repo](https://github.com/aws-samples/sample-api-proxy-for-multi-region-location-service) — it helps others discover it.
