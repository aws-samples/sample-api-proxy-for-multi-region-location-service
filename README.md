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
2. A Location Service **API Key** with `geo-places` and `geo-maps` permissions

### Create an API Key (AWS CLI)

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

## Deployment

### 0. Store the API Key in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name location-demo/api-key \
  --secret-string "v1.public.xxxxx" \
  --region <your-region>
```

### 1. Deploy the CloudFront Map Tile Proxy

```bash
aws cloudformation deploy \
  --template-file infra/cloudfront-map-proxy.yaml \
  --stack-name location-map-proxy \
  --parameter-overrides \
    LocationApiKeySecretName=location-demo/api-key \
    AwsRegion=<your-location-service-region> \
  --region <your-region>
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

export AWS_REGION=<your-region>
export LOCATION_API_KEY=v1.public.xxxxx
export MAP_TILE_DOMAIN=d1234567890.cloudfront.net  # domain from previous step

npm start
```

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

# Build and push
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
    LocationApiKeySecretArn=arn:aws:secretsmanager:<your-region>:<ACCOUNT_ID>:secret:location-demo/api-key-XXXXXX \
    MapTileDomain=d1234567890.cloudfront.net \
    AwsRegion=<your-location-service-region> \
    ImageUri=<ACCOUNT_ID>.dkr.ecr.<your-region>.amazonaws.com/location-demo:latest \
  --region <your-region>
```

### 3. Get the Access URL

```bash
aws cloudformation describe-stacks \
  --stack-name location-demo-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <your-region>
```
