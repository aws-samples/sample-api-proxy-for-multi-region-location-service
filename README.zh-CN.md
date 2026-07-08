# Amazon Location Service Proxy

地址自动补全 + 地图定位服务端代理，基于 Amazon Location Service 和 MapLibre GL JS。它把搜索和地图瓦片请求路由到与请求国家最匹配的 Amazon Location Service (ALS) 区域，同时确保所有 API Key 都不出现在客户端。

[English](README.md)

## 项目特点

**API Key 零暴露**：Amazon Location Service 官方示例通常将 API Key 直接嵌入前端代码，任何人打开浏览器 DevTools 即可获取。本项目通过服务端代理 + CloudFront 边缘注入的双层架构，确保 API Key 完全不出现在客户端，从根本上消除密钥泄露风险。

- 地址搜索请求由 Express 后端代理，API Key 仅在服务端使用
- 地图瓦片请求通过 CloudFront 代理，CloudFront Function 在边缘节点注入 API Key，浏览器请求中不携带任何凭证
- Style descriptor 由服务端拉取后重写 URL，剥离所有 key 参数再返回前端
- API Key 存储在 AWS Secrets Manager 中，支持安全轮换

**多区域路由**：不同 ALS 区域的地图数据来源不同，且有针对性优化（例如东南亚的 GrabMaps）。本代理根据请求国家路由到对应区域，让用户获得最佳的本地地图/搜索质量。路由由「国家→区域」映射驱动，并可用一个总开关整体开启/关闭。

**弹性伸缩降低成本**：生产环境采用 ECS Fargate + Auto Scaling，根据 CPU 利用率自动调整服务实例数量。低流量时缩容至最小实例数，高峰期自动扩容，避免为固定容量持续付费。CloudFront 边缘缓存进一步减少回源请求，降低 API 调用成本。

## 功能

- 🔍 地址搜索自动补全（Amazon Location Service Geo Places API）
- 📍 浏览器定位（Geolocation API）
- 🗺️ 可视化地图展示（MapLibre GL + Amazon Location Map Tiles）
- 🎨 地图模式切换（Standard / Monochrome / Hybrid / Satellite）
- 🌏 按国家路由到对应 ALS 区域（搜索 + 地图瓦片）

## 多区域路由如何工作

每个请求先解析出一个**目标区域**，然后代理用该区域的 key 调用该区域的 ALS 端点：

```
请求
  ├── 带 countryCode            → 在映射中查区域 → 目标区域
  ├── 带 lat/lng、无国家         → 用 home 区域反解经纬度得国家 → 查映射 → 目标区域
  └── 无输入 / 未匹配 / 出错      → home 区域（回落）
```

- **「国家→区域」映射**（`config/country-region-map.json`）是**唯一事实源**：其顶层 key 即为区域集（每个 key 生成一条 CloudFront 行为、需要一个 API key、启动时校验），其中一个区域在国家列表里用 `"*"` 标记为 **home**。
- **home 区域**是缺省/引导区域：用于把经纬度反解为国家，也是任何国家没有匹配时的回落区域。通过在该区域的国家列表里放 `"*"` 来指定（如 `"ap-northeast-1": ["*"]`，或 `["*", "JP"]` 表示它同时也服务具体国家）。必须且只能有一个区域被标记。**没有 `HOME_REGION` 环境变量**——由映射文件定义。
- home 区域在路由开启时必须是全球覆盖区域（不能是 GrabMaps 区 `ap-southeast-1` / `ap-southeast-5`），因为反解全球任意坐标需要全球覆盖。
- 路由**关闭**时，所有请求都走 home 区域——与普通单区域代理完全一致。

## 架构

```
浏览器
  ├── 地址搜索 → Express 后端 → ALS Geo Places（目标区域，服务端 key）
  ├── 地图样式 → Express 后端（拉取 descriptor + 重写瓦片 URL 到 CloudFront）
  └── 地图瓦片 → CloudFront /<region>/*（边缘缓存 + 注入该区域 key）→ ALS Geo Maps
```

## API 防护与安全说明

**CORS（`/api`）** —— 默认关闭：不设置 `ALLOWED_ORIGINS` 时不发送任何 CORS 头，仅同源调用可用。由于后端是交付物、客户可能把自建前端部署在不同源,需要跨域时用 `ALLOWED_ORIGINS` 显式放行这些源。生产环境避免用 `*` —— 那会让任意网站都能调用你的 API、烧掉账号的 ALS 配额。API 不携带 cookie/凭证（key 全在服务端），所以这只关乎"谁能调用",与 CSRF 无关。

**限流（`/api`）** —— 基于源 IP 的令牌桶做基础防护（`API_RATE_PER_SEC` 持续速率 + `API_RATE_BURST` 突发），`/health` 豁免以免 ALB 健康检查被限流打挂。这是**下限,不是 WAF 的替代**：它是**每 task 内存态**的,N 个 ECS task 时全局有效速率最高可达 N × `API_RATE_PER_SEC`。要真正的全局限流,请在其上叠加 WAF 速率规则(或共享存储如 ElastiCache)。`TRUST_PROXY=2`（CloudFront→ALB 的跳数）确保限流以真实、不可伪造的客户端 IP 为键,而非 ALB 的 IP。

**CloudFront → ALB 回源流量（明文）** —— ECS 栈里,对外 HTTPS 在 CloudFront 终结,CloudFront→ALB 这一跳是 HTTP。ALB 虽是 internet-facing,但其**安全组(security group)**只放行 [CloudFront 托管前缀列表](https://docs.aws.amazon.com/vpc/latest/userguide/working-with-aws-managed-prefix-lists.html),因此无法从公网直接访问。CloudFront 到 AWS 源的回源流量走 **AWS 网络骨干网**、不经公共互联网(AWS 甚至对此免收数据传输费)—— 因此残留暴露面是"运行在 AWS 自有网络上的明文查询词/坐标",而非凭证(ALS key 从不经过这一跳)。我们判断这可接受,默认保持明文。若要连这点也消除:做回源 HTTPS —— 用自有域名给 ALB 配 ACM 证书,并把 CloudFront 回源指向该域名(ALB 缺省的 `*.elb.amazonaws.com` 域名无法绑 ACM 证书,所以需要一个你拥有的域名)。

## 前置条件

1. AWS 账号，已开通 Amazon Location Service
2. 为**映射中的每个区域**创建一个 Location Service **API Key**（每个 key 需同时包含 `geo-places` 和 `geo-maps` 权限）。之所以每区域一个 key，是因为 ALS API key 是按区域绑定的。
3. 已安装 `node`（v20+）和已配置凭证的 `aws` CLI。

全文使用两个刻意区分的区域概念：

| 术语 | 含义 |
|---|---|
| **部署区域**（`<deploy-region>`） | 承载基础设施的**单一**区域：Secrets Manager secret、CloudFront 栈、ECS 栈、ECR 仓库都在这里。 |
| **ALS 区域**（`<als-region>`） | 代理要路由到的区域——映射文件里的某个 key，**可以有多个**。 |

home 区域与部署区域相互独立，可相同也可不同（例如：为降低延迟部署在新加坡，但由于新加坡是 GrabMaps 区、不能作反解引导，于是把 `ap-northeast-1` 用 `"*"` 标记为 home）。

## 环境变量

| 变量 | 说明 | 示例 |
|---|---|---|
| `MULTI_REGION_ROUTING` | 总开关，默认 `false`（单区域：一切走 home 区域）。 | `true` |
| `LOCATION_API_KEYS` | region→API Key 的 JSON（每 key 含 geo-places + geo-maps）。以一个 Secrets Manager secret 提供。 | `{"ap-northeast-1":"v1.public.xxx"}` |
| `MAP_TILE_DOMAIN` | CloudFront 瓦片域名（CloudFront 栈的输出）。 | `d123.cloudfront.net` |
| `ALLOWED_ORIGINS` | `/api` 的 CORS 白名单（逗号分隔）。**默认关闭**：不设置则不发 CORS 头，仅同源可调。用 `*` 放行所有源。 | `https://app.example.com` |
| `API_RATE_PER_SEC` | `/api` 每源 IP 的持续速率（令牌桶补充速率）。默认 `10`。 | `20` |
| `API_RATE_BURST` | `/api` 每源 IP 的突发容量（令牌桶大小）。默认 `20`。 | `40` |
| `TRUST_PROXY` | Express `trust proxy` 值——代理跳数，使限流拿到真实、不可伪造的客户端 IP。本地默认 `true`；在 CloudFront→ALB 之后设为 `2`。 | `2` |

> 在用区域**和 home 区域**都**不是**环境变量——它们来自 `config/country-region-map.json`（其 key,以及被 `"*"` 标记的区域）。本地通过 `export` 设置上面这些变量；生产环境通过 CloudFormation 参数传入（见下文）。两种机制相互独立。

## 国家→区域映射文件

`config/country-region-map.json` 采用区域优先结构（`{ 区域: [ISO 国家代码] }`），是区域集与 home 区域的唯一事实源：

```json
{
  "ap-northeast-1": ["*", "JP", "KR"],
  "ap-southeast-1": ["SG", "MY", "TH", "ID", "VN", "PH"],
  "eu-central-1": ["DE", "FR", "NL", "IE", "ES", "IT"],
  "us-east-1": ["US", "CA", "MX"]
}
```

- 每个顶层 key 都是一个在用区域（生成 CloudFront 行为、需要 key、启动时校验）。
- 必须且只能有一个区域在国家列表里含 `"*"`——它标记 **home 区域**（回落 + 反解引导）。该区域也可同时服务具体国家（如上），或仅作回落（`"ap-northeast-1": ["*"]`）。
- 未列出的国家在请求时回落到 home 区域（会记日志，不报错）。

**真实的** `config/country-region-map.json` 已加入 `.gitignore`（国家清单因部署而异），仓库只跟踪 `config/country-region-map-example.json`。请从示例创建你的真实文件：

```bash
cp config/country-region-map-example.json config/country-region-map.json
```

- **多区域**：按业务修改副本（区域 + 国家），并保持恰好一个区域用 `"*"` 标记为 home。
- **单区域**：只保留一个区域并标记为 home，例如 `{ "us-east-1": ["*"] }`（所有国家都回落到它）。

该文件是运行时必需的：应用启动时读取它，缺失会直接启动失败（错误信息会提示执行上面的 `cp`）。`docker build` 也会把它打包进镜像，因此构建前同样需先准备好。

## 部署

以下步骤**单区域与多区域通用**。有差异处用 **单区域** / **多区域** 提示标出。全程 `<deploy-region>` 是你唯一的基础设施区域，`<als-region>` 是映射里的某个区域。

### 0. 创建映射文件

```bash
cp config/country-region-map-example.json config/country-region-map.json
# 然后按你的区域/国家编辑 config/country-region-map.json
```

- **单区域**：精简为一个区域并标记为 home，例如 `{ "us-east-1": ["*"] }`。
- **多区域**：列出每个区域及其国家；恰好一个区域用 `"*"` 标记为 home。

### 1. 创建各区域 API Key 并存入 Secrets Manager

ALS API key 按区域绑定，因此映射里每个区域各需一个 key。辅助脚本会从映射文件推导区域集、在每个区域创建 key、拼出 `LOCATION_API_KEYS` JSON，并（在 `--write-secret` 时）写入 Secrets Manager：

```bash
scripts/create-api-keys.sh \
  --mapping-file config/country-region-map.json \
  --secret-name location-proxy/api-keys \
  --deploy-region <deploy-region> \
  --write-secret
```

不加 `--write-secret` 时，脚本只把 JSON 打印到 stdout 供你先行审阅。它会为每个区域创建一个名为 `ProxyApiKey-<als-region>` 的 key。单/多区域通用（单区域即只有一个区域 → 一个 key）。

<details>
<summary>想手动执行？</summary>

对映射里的每个 `<als-region>` 各执行一次，然后自行把各 key 合并成一个 JSON secret：

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

### 2. 生成并部署 CloudFront 地图瓦片代理

CloudFront 模板 `infra/cloudfront-map-proxy.yaml` 由映射文件生成（每个区域生成一个 origin、一条 `/<region>/*` 行为，以及一个在边缘注入该区域 key 并剥掉区域路径前缀的 CloudFront Function）：

```bash
node scripts/generate-cloudfront-template.js
```

模板里的 CachePolicy / OriginRequestPolicy 名称是账号级全局唯一的（CloudFront 是全局服务），因此生成器会自动追加一个短随机后缀，避免跨 stack、跨区域或重复部署时出现 `AlreadyExists` 冲突。可用 `POLICY_NAME_SUFFIX` 固定它（如需可复现的输出）：`POLICY_NAME_SUFFIX=v1 node scripts/generate-cloudfront-template.js`。

生成的模板会通过 `{{resolve:secretsmanager:location-proxy/api-keys:SecretString:<region>}}` 直接读取 JSON secret，无需再传参。在部署区域部署：

```bash
aws cloudformation deploy \
  --template-file infra/cloudfront-map-proxy.yaml \
  --stack-name location-map-proxy \
  --region <deploy-region>
```

获取 CloudFront 域名（即你的 `MAP_TILE_DOMAIN`）：

```bash
aws cloudformation describe-stacks \
  --stack-name location-map-proxy \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomain`].OutputValue' \
  --output text \
  --region <deploy-region>
```

### 3. 运行应用

#### 本地运行

```bash
npm install
# （映射文件已在步骤 0 创建；被 "*" 标记的区域即为 home 区域）

export MULTI_REGION_ROUTING=true   # 单区域：false
export LOCATION_API_KEYS='{"ap-northeast-1":"v1.public.xxx","eu-central-1":"v1.public.yyy"}'
export MAP_TILE_DOMAIN=d1234567890.cloudfront.net   # 步骤 2 获取

npm start
```

> `LOCATION_API_KEYS` 必须为**映射文件里的每个区域**都包含一个条目（上面示例是两个区域——请与你的映射保持一致）。缺少某区域的 key 会导致启动校验失败。步骤 1 的 `create-api-keys.sh` 脚本会帮你拼好这段 JSON。

打开 http://localhost:3000

- **单区域**：设 `MULTI_REGION_ROUTING=false`，映射和 `LOCATION_API_KEYS` 里都只放一个区域。

#### 生产部署（CloudFront + ALB + ECS Fargate）

高可用架构：CloudFront 边缘加速 + ALB + 多 AZ ECS Fargate + Auto Scaling。配置通过 CloudFormation 参数传入（不是 `export`）。

```
浏览器
  ├── 静态资源 → CloudFront（边缘缓存）→ ALB → ECS Fargate
  ├── API 请求 → CloudFront（AWS 骨干网）→ ALB → ECS Fargate → Amazon Location Service
  └── 地图瓦片 → CloudFront（边缘缓存 + 注入 API Key）→ Amazon Location Service
```

**a. 创建 ECR 仓库并推送镜像**（在部署区域）：

```bash
aws ecr create-repository --repository-name location-proxy --region <deploy-region>

# 登录 ECR
aws ecr get-login-password --region <deploy-region> | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com

# 构建并推送（config/country-region-map.json 必须存在——它会被打包进镜像）
docker build -t location-proxy .
docker tag location-proxy:latest <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
docker push <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
```

**b. 部署 ECS Fargate 栈**（在部署区域）。区域集与 home 区域都来自镜像里打包的映射文件，因此只需传 `MultiRegionRouting` / secret / 域名 / 镜像：

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

- **单区域**：设 `MultiRegionRouting=false`（home 区域即你在映射里用 `"*"` 标记的那个）。
- **可选防护参数**（均有合理默认，按需覆盖）：`AllowedOrigins=https://app.example.com`（`/api` 的 CORS 白名单，默认仅同源）、`ApiRatePerSec=10` / `ApiRateBurst=20`（`/api` 每源 IP 限流）、`TrustProxy=2`（CloudFront→ALB 跳数,用于取真实客户端 IP;默认已是 `2`）。详见[API 防护与安全说明](#api-防护与安全说明)。

> **重新部署代码/映射改动**：如果重新 build 并推送到**同一个镜像 tag**（`:latest`），`cloudformation deploy` 会因为参数没变而提示 *"No changes to deploy. Stack xxx is up to date"* ——运行中的任务仍是旧镜像。两种真正生效的方式：
> - 强制新部署（最简单）：`aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment --region <deploy-region>`（`<cluster>`/`<service>` 取自 stack 的 `ClusterName` / `ServiceName` 输出）。
> - 或推送**不可变 tag**（如 git SHA）并传 `ImageUri=...:<sha>` ——参数变了 CloudFormation 就会自动滚动更新（生产推荐，也便于回滚）。

**c. 获取访问地址**：

```bash
aws cloudformation describe-stacks \
  --stack-name location-proxy-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <deploy-region>
```

## 更新国家→区域映射

编辑 `config/country-region-map.json`，然后重建并推送镜像。用 `aws ecs update-service --force-new-deployment` 触发滚动更新（或用不可变镜像 tag——见步骤 b 下的说明;tag 不变时单跑 `cloudformation deploy` 不会生效）。ECS 会执行零停机滚动更新。如果新增了**新区域**，需先创建其 key 并更新 secret（重跑步骤 1），并重新生成 + 部署 CloudFront 栈（步骤 2）。映射配错会导致启动校验失败，新任务无法通过健康检查，旧版本继续服务。

## 测试

```bash
npm test
```
