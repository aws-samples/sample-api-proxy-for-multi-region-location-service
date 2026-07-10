# Amazon Location Service Proxy

Server-side proxy for address autocomplete + map positioning, built with Amazon Location Service and MapLibre GL JS. Routes search and map-tile requests to the Amazon Location Service (ALS) region that best matches the request's country — while keeping every API key off the client.

[中文文档](README.zh-CN.md)

## Highlights

**Zero API Key Exposure**: Official Amazon Location Service examples typically embed the API Key directly in frontend code, making it visible to anyone via browser DevTools. This project uses a dual-layer architecture — server-side proxy + CloudFront edge injection — to ensure the API Key never reaches the client, eliminating the risk of key leakage.

- Address search requests are proxied through the Express backend; the API Key is used only on the server side
- Map tile requests go through CloudFront, where a CloudFront Function injects the API Key at the edge; browser requests carry no credentials
- The style descriptor is fetched server-side, tile URLs are rewritten, and all key parameters are stripped before returning to the frontend
- The API Key is stored in AWS Secrets Manager for secure rotation

**Multi-Region Routing**: Different ALS regions carry different map data providers and region-specific optimizations (e.g. GrabMaps in Southeast Asia). This proxy routes each request to the region matching its country, so users get the best local map/search quality. Routing is driven by a country→region mapping and can be toggled on/off with a single switch.

**Auto Scaling to Reduce Cost**: The production environment uses ECS Fargate with Auto Scaling, automatically adjusting the number of service instances based on CPU utilization. Scales down to minimum instances during low traffic and scales out during peak hours, avoiding the cost of fixed capacity. CloudFront edge caching further reduces origin requests and API call costs.

## Features

- 🔍 Address search autocomplete (Amazon Location Service Geo Places API)
- 📍 Browser geolocation (Geolocation API)
- 🗺️ Interactive map display (MapLibre GL + Amazon Location Map Tiles)
- 🎨 Map style switching (Standard / Monochrome / Hybrid / Satellite)
- 🌏 Country-based routing to the matching ALS region (search + map tiles)

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

**CORS (`/api`)** — Default closed: with `ALLOWED_ORIGINS` unset, no CORS headers are sent, so only same-origin callers work. Because the proxy is the deliverable and a customer may host their own frontend on a different origin, set `ALLOWED_ORIGINS` to opt those origins in. Avoid `*` in production — it lets any website call your API and burn the account's ALS quota. The API carries no cookies/credentials (keys stay server-side), so this is about *who may call*, not CSRF.

**Rate limiting (`/api`)** — A baseline per-source-IP token bucket (`API_RATE_PER_SEC` sustained + `API_RATE_BURST` spike) throttles abuse; `/health` is exempt so the ALB health check is never throttled. This is a **floor, not a WAF replacement**: it is per-task (in-memory), so with N ECS tasks the effective global rate is up to N × `API_RATE_PER_SEC`. For true global limiting, layer a WAF rate-based rule (or a shared store like ElastiCache) on top. `TRUST_PROXY=2` (the CloudFront→ALB hop count) ensures the limiter keys on the real, unspoofable client IP rather than the ALB's.

**CloudFront → ALB origin traffic (plaintext)** — In the ECS stack, viewer-facing HTTPS is terminated at CloudFront; the CloudFront→ALB hop is HTTP. The ALB is internet-facing but its **security group** only admits the [CloudFront managed prefix list](https://docs.aws.amazon.com/vpc/latest/userguide/working-with-aws-managed-prefix-lists.html), so it isn't directly reachable from the public internet. Origin-fetch traffic from CloudFront to an AWS origin travels over the **AWS network backbone**, not the public internet (AWS even waives data-transfer charges for it) — so the residual exposure is plaintext *query terms/coordinates* on AWS-operated infrastructure, never credentials (the ALS key never traverses this hop). We judge this acceptable and leave it plaintext by default. To eliminate even that, add HTTPS-to-origin: put an ACM certificate on a custom ALB domain and point CloudFront's origin at it (an ALB's default `*.elb.amazonaws.com` name can't hold an ACM cert, so a domain you own is required).

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
| `MULTI_REGION_ROUTING` | Master switch; defaults to `false` (single-region: everything uses the home region). | `true` |
| `LOCATION_API_KEYS` | JSON of region→API Key (each key has geo-places + geo-maps). Provided as one Secrets Manager secret. | `{"ap-northeast-1":"v1.public.xxx"}` |
| `MAP_TILE_DOMAIN` | CloudFront map-tile domain (output of the CloudFront stack). | `d123.cloudfront.net` |
| `ALLOWED_ORIGINS` | CORS allowlist for `/api` (comma-separated). **Default closed**: unset ⇒ no CORS headers ⇒ same-origin only. Use `*` to allow any origin. | `https://app.example.com` |
| `API_RATE_PER_SEC` | Sustained per-source-IP request rate for `/api` (token-bucket refill). Default `10`. | `20` |
| `API_RATE_BURST` | Per-source-IP burst capacity for `/api` (bucket size). Default `20`. | `40` |
| `TRUST_PROXY` | Express `trust proxy` value — the proxy hop count so the rate limiter sees the real, unspoofable client IP. Default `true` locally; set to `2` behind CloudFront→ALB. An unrecognized value fails safe to `false` (with a warning). | `2` |
| `REVERSE_GEO_CACHE_MAX` | FIFO cap for the per-task reverse-geocode grid cache (backstop against unbounded growth). Default `200000`. | `200000` |

> The regions in use **and the home region** are **not** environment variables — they come from `config/country-region-map.json` (its keys, and the `"*"`-marked region). Locally the variables above are set via `export`; in production they are passed as CloudFormation parameters (see below). The two mechanisms are independent.

## The Country→Region Mapping File

`config/country-region-map.json` is region-first (`{ region: [ISO country codes] }`) and is the single source of truth for both the region set and the home region:

```json
{
  "ap-northeast-1": ["*", "JP", "KR"],
  "ap-southeast-1": ["SG", "MY", "TH", "ID", "VN", "PH"],
  "eu-central-1": ["DE", "FR", "NL", "IE", "ES", "IT"],
  "us-east-1": ["US", "CA", "MX"]
}
```

- Each top-level key is an in-use region (gets a CloudFront behavior, needs a key, is validated at startup).
- Exactly one region must include `"*"` in its country list — that marks the **home region** (fallback + reverse-geocode guide). It may also serve specific countries (as above) or be fallback-only (`"ap-northeast-1": ["*"]`).
- A country not listed anywhere falls back to the home region at request time (logged, never an error).

The **real** `config/country-region-map.json` is gitignored (the country list is deployment-specific). The repo tracks `config/country-region-map-example.json`. Create your real file from it:

```bash
cp config/country-region-map-example.json config/country-region-map.json
```

- **Multi-region**: edit the copy to match your business (regions + countries), keeping exactly one region marked `"*"` as home.
- **Single-region**: keep just one region, marked home, e.g. `{ "us-east-1": ["*"] }` (all countries fall back to it).

The file is required at runtime: the app reads it on startup and fails fast if missing (the error tells you to run the `cp` above). `docker build` bakes it into the image, so it must exist before building too.

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
docker build -t location-proxy .
docker tag location-proxy:latest <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
docker push <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
```

**b. Deploy the ECS Fargate stack** (in your deploy region). The regions and the home region both come from the mapping file baked into the image, so only `MultiRegionRouting` / the secret / domain / image are passed:

```bash
aws cloudformation deploy \
  --template-file infra/ecs-fargate.yaml \
  --stack-name location-proxy-ecs \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    LocationApiKeysSecretArn=arn:aws:secretsmanager:<deploy-region>:<ACCOUNT_ID>:secret:location-proxy/api-keys-XXXXXX \
    MultiRegionRouting=true \
    MapTileDomain=d1234567890.cloudfront.net \
    ImageUri=<ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest \
  --region <deploy-region>
```

- **Single-region**: set `MultiRegionRouting=false` (the home region is whatever you marked `"*"` in the mapping).
- **Optional protection params** (sensible defaults, override as needed): `AllowedOrigins=https://app.example.com` (CORS allowlist for `/api`, default same-origin only), `ApiRatePerSec=10` / `ApiRateBurst=20` (per-source-IP `/api` rate limit), `TrustProxy=2` (CloudFront→ALB hop count for the real client IP; default already `2`). See [API protection & security notes](#api-protection--security-notes).

> **Redeploying code/mapping changes**: if you rebuild and push to the **same image tag** (`:latest`), `cloudformation deploy` sees no parameter change and reports *"No changes to deploy. Stack xxx is up to date"* — the running tasks keep the old image. Two ways to actually roll out:
> - Force a new deployment (simplest): `aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment --region <deploy-region>` (get `<cluster>`/`<service>` from the stack's `ClusterName` / `ServiceName` outputs).
> - Or push an **immutable tag** (e.g. a git SHA) and pass it as `ImageUri=...:<sha>` — the changed parameter makes CloudFormation roll out automatically (recommended for production; also gives clean rollbacks).

**c. Get the access URL**:

```bash
aws cloudformation describe-stacks \
  --stack-name location-proxy-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <deploy-region>
```

## Updating the country→region mapping

Edit `config/country-region-map.json`, then rebuild and push the image. Roll it out with `aws ecs update-service --force-new-deployment` (or an immutable image tag — see the note under step b; `cloudformation deploy` alone does nothing when the tag is unchanged). ECS performs a zero-downtime rolling update. If you added a **new region**, first create its key and update the secret (rerun step 1) and regenerate + redeploy the CloudFront stack (step 2). A misconfigured mapping fails the startup validation, so the new task never becomes healthy and the old version keeps serving.

## Tests

```bash
npm test
```
