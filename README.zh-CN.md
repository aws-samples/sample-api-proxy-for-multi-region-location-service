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
2. 为**每个启用的区域**创建一个 Location Service **API Key**（每个 key 需同时包含 `geo-places` 和 `geo-maps` 权限）

### 创建 API Key（AWS CLI）

在每个要启用的区域各执行一次（`--region` 换成对应区域）：

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

## 环境变量

多区域路由通过以下环境变量配置：

| 变量 | 说明 | 示例 |
|---|---|---|
| `HOME_REGION` | ALS 缺省/引导区域（路由开关开时必须为全球覆盖区，不能是 GrabMaps 区 ap-southeast-1/5） | `ap-northeast-1` |
| `MULTI_REGION_ROUTING` | 多区域路由总开关，默认 `false`（= 现状单区域行为） | `true` |
| `ENABLED_REGIONS` | 在用 ALS 区域，逗号分隔 | `ap-northeast-1,eu-west-1,us-east-1` |
| `LOCATION_API_KEYS` | JSON secret：region→API Key（每 key 含 geo-places + geo-maps 权限） | `{"ap-northeast-1":"v1.public.xxx"}` |
| `MAP_TILE_DOMAIN` | CloudFront 瓦片域名 | `d123.cloudfront.net` |

国家→区域映射在 `config/country-region-map.json`（区域优先结构）维护，改后重新部署即可生效（零停机滚动更新）。

## 部署

### 0. 将各区域 API Key 存入 Secrets Manager

所有区域的 key 存入**同一个 JSON secret**（key 为区域名，value 为该区域的 API Key）：

```bash
aws secretsmanager create-secret \
  --name location-demo/api-keys \
  --secret-string '{"ap-northeast-1":"v1.public.xxx","eu-west-1":"v1.public.yyy"}' \
  --region <deploy-region>
```

### 1. 生成并部署 CloudFront 地图瓦片代理

CloudFront 模板 `infra/cloudfront-map-proxy.yaml` 由脚本根据 `ENABLED_REGIONS` 生成（每个区域生成一个 origin、一条 `/<region>/*` 行为，以及一个在边缘注入该区域 key 并剥掉区域路径前缀的 CloudFront Function）。先生成模板：

```bash
ENABLED_REGIONS=ap-northeast-1,eu-west-1,us-east-1 node scripts/generate-cloudfront-template.js
```

生成的模板会通过 `{{resolve:secretsmanager:location-demo/api-keys:SecretString:<region>}}` 直接读取上一步的 JSON secret，无需再传参。然后部署：

```bash
aws cloudformation deploy \
  --template-file infra/cloudfront-map-proxy.yaml \
  --stack-name location-map-proxy \
  --region <deploy-region>
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

export HOME_REGION=ap-northeast-1
export MULTI_REGION_ROUTING=true
export ENABLED_REGIONS=ap-northeast-1,eu-west-1,us-east-1
export LOCATION_API_KEYS='{"ap-northeast-1":"v1.public.xxx","eu-west-1":"v1.public.yyy","us-east-1":"v1.public.zzz"}'
export MAP_TILE_DOMAIN=d1234567890.cloudfront.net  # 上一步获取的域名

npm start
```

如需保持现状单区域行为，将 `MULTI_REGION_ROUTING` 设为 `false`（默认值），并将 `HOME_REGION` / `ENABLED_REGIONS` 设为同一个区域即可。

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
    LocationApiKeysSecretArn=arn:aws:secretsmanager:<deploy-region>:<ACCOUNT_ID>:secret:location-demo/api-keys-XXXXXX \
    HomeRegion=ap-northeast-1 \
    EnabledRegions=ap-northeast-1,eu-west-1,us-east-1 \
    MultiRegionRouting=true \
    MapTileDomain=d1234567890.cloudfront.net \
    ImageUri=<ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-demo:latest \
  --region <deploy-region>
```

### 3. 获取访问地址

```bash
aws cloudformation describe-stacks \
  --stack-name location-demo-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <your-region>
```
