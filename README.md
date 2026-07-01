# Amazon Location Service Demo

Address autocomplete + map positioning demo built with Amazon Location Service and MapLibre GL JS.

[中文文档](README.zh-CN.md)

## Highlights

**Zero API Key Exposure**: Official Amazon Location Service examples typically embed the API Key directly in frontend code, making it visible to anyone via browser DevTools. This project uses a dual-layer architecture — server-side proxy + CloudFront edge injection — to ensure the API Key never reaches the client, eliminating the risk of key leakage.

- Address search requests are proxied through the Express backend; the API Key is used only on the server side
- Map tile requests go through CloudFront, where a CloudFront Function injects the API Key at the edge; browser requests carry no credentials
- The style descriptor is fetched server-side, tile URLs are rewritten, and all key parameters are stripped before returning to the frontend
- The API Key is stored in AWS Secrets Manager for secure rotation

**Auto Scaling to Reduce Cost**: The production environment uses ECS Fargate with Auto Scaling, automatically adjusting the number of service instances based on CPU utilization. Scales down to minimum instances during low traffic and scales out during peak hours, avoiding the cost of fixed capacity. CloudFront edge caching further reduces origin requests and API call costs.

## Features

- 🔍 Address search autocomplete (Amazon Location Service Geo Places API)
- 📍 Browser geolocation (Geolocation API)
- 🗺️ Interactive map display (MapLibre GL + Amazon Location Map Tiles)
- 🎨 Map style switching (Standard / Monochrome / Hybrid / Satellite)

## Architecture

```
Browser
  ├── Address search → Express backend → Amazon Location Service (API Key)
  ├── Map style → Express backend (proxy style descriptor + rewrite tile URLs)
  └── Map tiles → CloudFront (edge cache + inject API Key) → Amazon Location Service
```

## Prerequisites

1. An AWS account with Amazon Location Service enabled
2. One Location Service **API Key per enabled region** (each key needs both `geo-places` and `geo-maps` permissions)

### Create an API Key (AWS CLI)

Run once per region you want to enable (swap `--region` for each region):

```bash
aws location create-key \
  --key-name DemoApiKey-xxx \
  --restrictions '{
    "AllowActions":["geo-places:*","geo-maps:*"],
    "AllowResources":[
      "arn:aws:geo-maps:<your-region>::provider/*",
      "arn:aws:geo-places:<your-region>::provider/*"
    ]}' \
  --expire-time "2028-08-08T08:08:08Z" \
  --region <your-region>
```

## Environment Variables

Multi-region routing is configured through the following environment variables:

| Variable | Description | Example |
|---|---|---|
| `HOME_REGION` | Default/guide ALS region (must be a global-coverage region when routing is on — not a GrabMaps region ap-southeast-1/5) | `ap-northeast-1` |
| `MULTI_REGION_ROUTING` | Master switch for multi-region routing; defaults to `false` (= current single-region behavior) | `true` |
| `ENABLED_REGIONS` | ALS regions in use, comma-separated | `ap-northeast-1,eu-west-1,us-east-1` |
| `LOCATION_API_KEYS` | JSON secret: region→API Key (each key has geo-places + geo-maps permissions) | `{"ap-northeast-1":"v1.public.xxx"}` |
| `MAP_TILE_DOMAIN` | CloudFront map-tile domain | `d123.cloudfront.net` |

The country→region mapping is maintained in `config/country-region-map.json` (region-first structure); changing it takes effect after a redeploy (zero-downtime rolling update).

> **Note**: The real `config/country-region-map.json` is gitignored (each environment's country list may differ and it is treated as deployment config); the repo only tracks the example file `config/country-region-map-example.json`. On first use, copy it and edit as needed:
>
> ```bash
> cp config/country-region-map-example.json config/country-region-map.json
> ```
>
> This file is required at runtime: the app reads it on startup and fails fast if missing (the error tells you to run the `cp` above). `docker build` also bakes it into the image, so **it must exist before building the image** too.

## Deployment

### 0. Store the per-region API Keys in Secrets Manager

Store all region keys in a **single JSON secret** (key = region name, value = that region's API Key):

```bash
aws secretsmanager create-secret \
  --name location-demo/api-keys \
  --secret-string '{"ap-northeast-1":"v1.public.xxx","eu-west-1":"v1.public.yyy"}' \
  --region <deploy-region>
```

### 1. Generate and Deploy the CloudFront Map Tile Proxy

The CloudFront template `infra/cloudfront-map-proxy.yaml` is generated from `ENABLED_REGIONS` (per region: an origin, a `/<region>/*` behavior, and a CloudFront Function that injects that region's key at the edge and strips the region path prefix). Generate the template first:

```bash
ENABLED_REGIONS=ap-northeast-1,eu-west-1,us-east-1 node scripts/generate-cloudfront-template.js
```

The generated template reads the JSON secret from the previous step directly via `{{resolve:secretsmanager:location-demo/api-keys:SecretString:<region>}}`, so no parameters are needed. Then deploy:

```bash
aws cloudformation deploy \
  --template-file infra/cloudfront-map-proxy.yaml \
  --stack-name location-map-proxy \
  --region <deploy-region>
```

Get the CloudFront domain after deployment:

```bash
aws cloudformation describe-stacks \
  --stack-name location-map-proxy \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomain`].OutputValue' \
  --output text \
  --region <your-region>
```

### 2. Start the Application

```bash
npm install

# Prepare the country→region mapping (copy from the example, then edit as needed)
cp config/country-region-map-example.json config/country-region-map.json

export HOME_REGION=ap-northeast-1
export MULTI_REGION_ROUTING=true
export ENABLED_REGIONS=ap-northeast-1,eu-west-1,us-east-1
export LOCATION_API_KEYS='{"ap-northeast-1":"v1.public.xxx","eu-west-1":"v1.public.yyy","us-east-1":"v1.public.zzz"}'
export MAP_TILE_DOMAIN=d1234567890.cloudfront.net  # domain from previous step

npm start
```

To keep the current single-region behavior, set `MULTI_REGION_ROUTING` to `false` (the default) and point `HOME_REGION` / `ENABLED_REGIONS` at the same region.

Open http://localhost:3000

## Production Deployment (CloudFront + ALB + ECS Fargate)

High-availability architecture: CloudFront edge acceleration + ALB + multi-AZ ECS Fargate + Auto Scaling.

```
Browser
  ├── Static assets → CloudFront (edge cache) → ALB → ECS Fargate
  ├── API requests → CloudFront (AWS backbone) → ALB → ECS Fargate → Amazon Location Service
  └── Map tiles → CloudFront (edge cache + inject API Key) → Amazon Location Service
```

### 1. Create an ECR Repository and Push the Image

```bash
aws ecr create-repository --repository-name location-demo --region <your-region>

# Log in to ECR
aws ecr get-login-password --region <your-region> | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<your-region>.amazonaws.com

# Build and push (ensure config/country-region-map.json exists, created from the example)
cp -n config/country-region-map-example.json config/country-region-map.json 2>/dev/null || true
docker build -t location-demo .
docker tag location-demo:latest <ACCOUNT_ID>.dkr.ecr.<your-region>.amazonaws.com/location-demo:latest
docker push <ACCOUNT_ID>.dkr.ecr.<your-region>.amazonaws.com/location-demo:latest
```

### 2. Deploy the ECS Fargate Stack

```bash
aws cloudformation deploy \
  --template-file infra/ecs-fargate.yaml \
  --stack-name location-demo-ecs \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    LocationApiKeysSecretArn=arn:aws:secretsmanager:<deploy-region>:<ACCOUNT_ID>:secret:location-demo/api-keys-XXXXXX \
    HomeRegion=ap-northeast-1 \
    EnabledRegions=ap-northeast-1,eu-west-1,us-east-1 \
    MultiRegionRouting=true \
    MapTileDomain=d1234567890.cloudfront.net \
    ImageUri=<ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-demo:latest \
  --region <deploy-region>
```

### 3. Get the Access URL

```bash
aws cloudformation describe-stacks \
  --stack-name location-demo-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <your-region>
```
