# Amazon Location Service Demo

地址自动补全 + 地图定位 Demo，基于 Amazon Location Service 和 MapLibre GL JS。

[English](README.md)

## 项目特点

**API Key 零暴露**：Amazon Location Service 官方示例通常将 API Key 直接嵌入前端代码，任何人打开浏览器 DevTools 即可获取。本项目通过服务端代理 + CloudFront 边缘注入的双层架构，确保 API Key 完全不出现在客户端，从根本上消除密钥泄露风险。

- 地址搜索请求由 Express 后端代理，API Key 仅在服务端使用
- 地图瓦片请求通过 CloudFront 代理，CloudFront Function 在边缘节点注入 API Key，浏览器请求中不携带任何凭证
- Style descriptor 由服务端拉取后重写 URL，剥离所有 key 参数再返回前端
- API Key 存储在 AWS Secrets Manager 中，支持安全轮换

**弹性伸缩降低成本**：生产环境采用 ECS Fargate + Auto Scaling，根据 CPU 利用率自动调整服务实例数量。低流量时缩容至最小实例数，高峰期自动扩容，避免为固定容量持续付费。CloudFront 边缘缓存进一步减少回源请求，降低 API 调用成本。

## 功能

- 🔍 地址搜索自动补全（Amazon Location Service Geo Places API）
- 📍 浏览器定位（Geolocation API）
- 🗺️ 可视化地图展示（MapLibre GL + Amazon Location Map Tiles）
- 🎨 地图模式切换（Standard / Monochrome / Hybrid / Satellite）

## 架构

```
浏览器
  ├── 地址搜索 → Express 后端 → Amazon Location Service (API Key)
  ├── 地图样式 → Express 后端（代理 style descriptor + 重写瓦片 URL）
  └── 地图瓦片 → CloudFront (边缘缓存 + 注入 API Key) → Amazon Location Service
```


## 前置条件

1. AWS 账号，已开通 Amazon Location Service
2. 创建 Location Service **API Key**（需要包含 `geo-places` 和 `geo-maps` 权限）

### 创建 API Key（AWS CLI）

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

## 部署

### 0. 将 API Key 存入 Secrets Manager

```bash
aws secretsmanager create-secret \
  --name location-demo/api-key \
  --secret-string "v1.public.xxxxx" \
  --region <your-region>
```

### 1. 部署 CloudFront 地图瓦片代理

```bash
aws cloudformation deploy \
  --template-file infra/cloudfront-map-proxy.yaml \
  --stack-name location-map-proxy \
  --parameter-overrides \
    LocationApiKeySecretName=location-demo/api-key \
    AwsRegion=<your-location-service-region> \
  --region <your-region>
```

部署完成后获取 CloudFront 域名：

```bash
aws cloudformation describe-stacks \
  --stack-name location-map-proxy \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomain`].OutputValue' \
  --output text \
  --region <your-region>
```

### 2. 启动应用

```bash
npm install

export AWS_REGION=<your-region>
export LOCATION_API_KEY=v1.public.xxxxx
export MAP_TILE_DOMAIN=d1234567890.cloudfront.net  # 上一步获取的域名

npm start
```

打开 http://localhost:3000

## 生产部署（CloudFront + ALB + ECS Fargate）

高可用架构：CloudFront 边缘加速 + ALB + 多 AZ ECS Fargate + Auto Scaling。

```
浏览器
  ├── 静态资源 → CloudFront (边缘缓存) → ALB → ECS Fargate
  ├── API 请求 → CloudFront (AWS 骨干网) → ALB → ECS Fargate → Amazon Location Service
  └── 地图瓦片 → CloudFront (边缘缓存 + 注入 API Key) → Amazon Location Service
```

### 1. 创建 ECR 仓库并推送镜像

```bash
aws ecr create-repository --repository-name location-demo --region <your-region>

# 登录 ECR
aws ecr get-login-password --region <your-region> | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<your-region>.amazonaws.com

# 构建并推送
docker build -t location-demo .
docker tag location-demo:latest <ACCOUNT_ID>.dkr.ecr.<your-region>.amazonaws.com/location-demo:latest
docker push <ACCOUNT_ID>.dkr.ecr.<your-region>.amazonaws.com/location-demo:latest
```

### 2. 部署 ECS Fargate 栈

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

### 3. 获取访问地址

```bash
aws cloudformation describe-stacks \
  --stack-name location-demo-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <your-region>
```
