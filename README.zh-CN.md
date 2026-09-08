# Amazon Location Service Proxy

地址自动补全 + 地图定位服务端代理，基于 Amazon Location Service 和 MapLibre GL JS。它把搜索和地图瓦片请求路由到与请求国家最匹配的 Amazon Location Service (ALS) 区域，同时确保所有 API Key 都不出现在客户端。

[English](README.md)

## 项目特点

**API Key 不进客户端**：Amazon Location Service 官方示例通常将 API Key 直接嵌入前端代码，任何人打开浏览器 DevTools 即可获取。本项目通过服务端代理 + CloudFront 边缘注入，使 API Key 不出现在浏览器请求或响应中，降低客户端泄露风险。

- 地址搜索请求由 Express 后端代理，API Key 仅在服务端使用
- 地图瓦片请求通过 CloudFront 代理，CloudFront Function 在边缘节点注入 API Key，浏览器请求中不携带任何凭证
- Style descriptor 由服务端拉取后重写 URL，剥离所有 key 参数再返回前端
- API Key 存储在 AWS Secrets Manager；轮换后需重新部署 CloudFront 地图代理和 ECS task 才会加载新值

**多区域路由**：不同 ALS 区域的地图数据来源不同，且有针对性优化（例如东南亚的 GrabMaps）。本代理根据请求国家路由到对应区域，让用户获得最佳的本地地图/搜索质量。路由由「国家→区域」映射驱动，并可用一个总开关整体开启/关闭。

**弹性伸缩降低成本**：生产环境采用 ECS Fargate + Auto Scaling，根据 CPU 利用率在最小实例数与上限之间调整容量。低流量仍保留高可用所需的最小 task，高峰期自动扩容；CloudFront 边缘缓存进一步减少回源请求。

## 功能

- 🔍 地址搜索自动补全（Amazon Location Service Geo Places API）
- 📍 浏览器定位（Geolocation API）
- 🗺️ 可视化地图展示（MapLibre GL + Amazon Location Map Tiles）
- 🎨 地图模式切换（Standard / Monochrome / Hybrid / Satellite）
- 🌏 按国家路由到对应 ALS 区域（搜索 + 地图瓦片）
- 🔤 地图标注语言可选，缺省按国家码决定（见下文「地图标注语言」）
- 👆 点击地图任意位置识别该处地点（逆地理编码，见下文「点击地图识别地点」）

## 多区域路由如何工作

每个请求先解析出一个**目标区域**，然后代理用该区域的 key 调用该区域的 ALS 端点：

```
请求
  ├── 带 countryCode            → 在映射中查区域 → 目标区域
  ├── 带 lat/lng、无国家         → 用 home 区域逆地理编码得到国家 → 查映射 → 目标区域
  └── 无输入 / 未匹配 / 出错      → home 区域（回落）
```

- **「国家→区域」映射**（`config/country-region-map.json`）是**唯一事实源**：其顶层 key 即为区域集（每个 key 生成一条 CloudFront 行为、需要一个 API key、启动时校验），其中一个区域在国家列表里用 `"*"` 标记为 **home**。
- **home 区域**是缺省/引导区域：用于把坐标逆地理编码为国家，也是任何国家没有匹配时的回落区域。通过在该区域的国家列表里放 `"*"` 来指定（如 `"ap-northeast-1": ["*"]`，或 `["*", "JP"]` 表示它同时也服务具体国家）。必须且只能有一个区域被标记。**没有 `HOME_REGION` 环境变量**——由映射文件定义。
- home 区域在路由开启时必须是全球覆盖区域（不能是 GrabMaps 区 `ap-southeast-1` / `ap-southeast-5`），因为逆地理编码全球任意坐标需要全球覆盖。
- 路由**关闭**时，所有请求都走 home 区域——与普通单区域代理完全一致。

## 架构

```
浏览器
  ├── 地址搜索 → Express 后端 → ALS Geo Places（目标区域，服务端 key）
  ├── 地图样式 → Express 后端（拉取 descriptor + 重写瓦片 URL 到 CloudFront）
  └── 地图瓦片 → CloudFront /<region>/*（边缘缓存 + 注入该区域 key）→ ALS Geo Maps
```

## API 防护与安全说明

**CORS（`/api`）** —— 不设置 `ALLOWED_ORIGINS` 时不发送 CORS 允许头，跨源浏览器 JavaScript 因而无法读取响应；需要跨域时显式配置允许的前端源。CORS 不是身份验证或配额边界：非浏览器客户端可以不发或伪造 `Origin`，且浏览器仍可能发送不受允许的简单请求，只是不把响应暴露给脚本。生产环境避免用 `*`，并用限流、WAF 和回源防护控制滥用。API 不携带 cookie/凭证，因此这里不涉及 CSRF。

> 在 CloudFront 后面必须转发 `Origin`、`Access-Control-Request-Method` 和 `Access-Control-Request-Headers`；`infra/ecs-fargate.yaml` 已配置。

**限流（`/api`）** —— 基于源 IP 的令牌桶做基础防护（`API_RATE_PER_SEC` 持续速率 + `API_RATE_BURST` 突发），`/health` 豁免以免 ALB 健康检查被限流打挂。这是**下限,不是 WAF 的替代**：它是**每 task 内存态**的,N 个 ECS task 时全局速率最高可达 N × `API_RATE_PER_SEC`。要在 CloudFront 边缘做全局上限,挂上可选的 WAF 规则（[步骤 4](#4-可选用-aws-waf-做边缘限流)）。`TRUST_PROXY=2`（CloudFront→ALB 的跳数）确保限流以真实、不可伪造的客户端 IP 为键,而非 ALB 的 IP。

**CloudFront → ALB 回源防护** —— ALB 虽是 internet-facing,但有两道控制确保只能经过*本*分发访问它:其**安全组**只放行 [CloudFront 托管前缀列表](https://docs.aws.amazon.com/vpc/latest/userguide/working-with-aws-managed-prefix-lists.html);其监听器**在请求缺少本分发注入的 `X-Origin-Verify` 共享密钥头时直接返回 403**（`OriginVerifySecret`）。由于前缀列表覆盖*所有* CloudFront 分发,这个密钥头才是阻止别人把自己的分发指向你 ALB 的 DNS 的关键。（健康检查直连目标,不受影响。）

**CloudFront → ALB 回源流量（明文）** —— 对外 HTTPS 在 CloudFront 终结,CloudFront→ALB 这一跳是 HTTP,但走 **AWS 骨干网**、不经公共互联网。因此残留暴露面是"AWS 自有网络上的明文查询词/坐标",而非凭证(ALS key 和 `X-Origin-Verify` 密钥都不会离开骨干网)。默认保持明文;若要加密:用自有域名给 ALB 配 ACM 证书,并把 CloudFront 回源指向该域名(缺省的 `*.elb.amazonaws.com` 域名无法绑 ACM 证书)。

**安全响应头** —— 每个响应都带有 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'` 和 `Referrer-Policy: no-referrer`。CSP 只限于 `frame-ancestors`,因为 API 返回的是 JSON;把 API 嵌入自建前端的一方应在其渲染层施加完整的 CSP。

## API 端点

所有端点都是 `GET`，返回 JSON。`/api/*` 应用 CORS 响应策略和每源 IP 令牌桶限流；`/health` 刻意不在 `/api` 下，以便 ALB 健康检查不被限流。

| 端点 | 参数 | 返回 |
|---|---|---|
| `/health` | — | `{"status":"ok"}` |
| `/api/suggest` | `query`(必填) + 路由参数 + `lang` + `limit` | `[{placeId, text, address, position, region}]`。`query` 为空时返回 `[]`（200） |
| `/api/place/:placeId` | `region` + 路由参数 + `lang` | `{label, position, address, tileRegion, country}` |
| `/api/reverse-geocode` | `lat`+`lng`(**必填**), `lang` | `{place, country, tileRegion, language}`，`place` 可为 `null` |
| `/api/tile-region` | `lat`+`lng` | `{tileRegion, country}` |
| `/api/map-style` | `style`, `region` + 路由参数 | MapLibre style JSON（瓦片 URL 已改写、key 已剥除） |
| `/api/map-labels` | 同 `/api/map-style` | `{language, source, layers}` |
| `/api/map-styles` | — | `["Standard","Monochrome",…]`（启动时探测到的） |
| `/api/map-languages` | — | `{languages:[…], default:"en"}` |
| `/api/map-config` | — | `{center:[lng,lat], zoom, region}` |

**共用的路由参数**（决定请求落到哪个 ALS 区域，优先级见「多区域路由如何工作」）：

| 参数 | 说明 |
|---|---|
| `countryCode` | ISO 3166-1 alpha-2。优先级最高，同时作为硬过滤条件。必须是映射文件里服务的国家，否则 400 |
| `lat` / `lng` | 十进制度数，**必须成对出现**。范围 `lat∈[-90,90]`、`lng∈[-180,180]`，否则 400 |

**语言参数：** `lang` 可选，接受 `zh-CN` 这类 BCP 47 标签。`/api/map-style` 与 `/api/map-labels` 会提取主语言 ISO 639-1 代码，并要求它属于配置的 68 种标注语言；`/api/suggest`、`/api/place` 与 `/api/reverse-geocode` 则采用独立的 GeoPlaces 语言契约：保留规范化后的完整标签（`zh-CN` 仍是 `zh-CN`），格式错误的标签返回 400，主语言不在 Amazon Location 任何一份清单里的标签（如 `lang=cn`、`lang=xx`）同样返回 400；路由到 GrabMaps 时会钳制到该提供方公开支持的子集。

**省略 `lang` 时，这三个端点不会退回英文**——它们走与地图标注相同的链路：先看请求的 `countryCode`（或由 `lat`/`lng` 逆地理编码出的国家），再看 `DEFAULT_MAP_LANGUAGE`。因此在东京搜索无需客户端指定就会返回日文。两点需要知道：

- 这与直接调用 GeoPlaces 不同（后者默认英文）。想要固定英文的客户端必须显式传 `lang=en`。
- 由 `lat`/`lng` 推导国家需要调用 ALS 做一次逆地理编码：每个任务、每个约 1.1 km 网格的结果缓存 1 小时；同一冷网格的并发请求会合并为一次上游调用。


几处需要注意的地方：

- **`/api/suggest` 的 `limit` 是上限，不是条数。** 它对应 Suggest API 的 `MaxResults`（1–100 的整数；其它取值在本代理层直接返回 400，不再浪费一次上游调用）。不传时代理请求 5 条，而 Amazon Location 自身的默认值是 20。实际返回可能更少：服务本身可能返回更少，且非 `Place` 类型的建议会被过滤掉。计费按请求次数而非结果条数，所以放大 `limit` 只增加响应体大小，不额外产生费用。
- **`limit` 取大值是为了「多取后处理」，不是为了多显示。** API 允许到 100，是给需要后处理的调用方用的：按类别或距离过滤、去重、重新排序、与自有数据关联，先拿到更大的候选集，再只显示挑出来的那几条。这是服务端或客户端有意设计的处理流水线，而不是把下拉列表拉长。所以本 demo 前端只提供 5/10/20——一个没人会去滚动的自动补全列表，拿 50 条原始建议没有意义。
- **`/api/place` 的 `region` 必须回传。** PlaceId 是**区域作用域**的，GetPlace 必须在产生它的区域执行——所以 `/api/suggest` 的每条结果都带 `region`，客户端要原样传回。不传则退回常规区域解析，可能因区域不匹配而查不到。
- **`tileRegion` ≠ 查询所用区域。** 它是覆盖**结果所在国家**的区域，供客户端切换地图瓦片；跨境结果两者会不同。
- **`/api/map-style` 与 `/api/map-labels` 额外返回两个响应头**：`X-Map-Label-Language` 和 `X-Map-Label-Language-Source`（值为 `explicit` / `country-map` / `config-default` / `fallback`），并通过 `Access-Control-Expose-Headers` 暴露给跨源调用方。
- **`/api/reverse-geocode` 的 `place: null` 是正常结果**（海面或无数据区域），不是错误。两个分支返回相同的键（`country` 为 `null`），客户端无需判断哪些字段存在。

**错误响应**统一为 `{"error":"…"}`：

| 状态码 | 含义 |
|---|---|
| 400 | 请求参数有问题（坐标格式/范围、不支持的 `countryCode`/`region`/地图标注 `lang`/`style`，或 Places 的 BCP 47 `lang` 格式错误**或不受支持**），或上游 ALS 返回了调用方导致的 4xx。响应体为通用文案，细节只记在服务端日志 |
| 429 | 超出每源 IP 限流，带 `Retry-After` 头（秒） |
| 500 | 服务端或上游问题（含 ALS 403 密钥错误、重试后仍被 429 限流、超时或 5xx）。响应体固定为 `{"error":"Internal server error"}`，绝不泄漏区域、key 或上游细节 |

## 前置条件

1. AWS 账号，已开通 Amazon Location Service
2. 为**映射中的每个区域**创建一个 Location Service **API Key**（每个 key 需同时包含 `geo-places` 和 `geo-maps` 权限）。之所以每区域一个 key，是因为 ALS API key 是按区域绑定的。
3. 已安装 `node`（v20+）和已配置凭证的 `aws` CLI。

全文使用两个刻意区分的区域概念：

| 术语 | 含义 |
|---|---|
| **部署区域**（`<deploy-region>`） | 承载基础设施的**单一**区域：Secrets Manager secret、CloudFront 栈、ECS 栈、ECR 仓库都在这里。 |
| **ALS 区域**（`<als-region>`） | 代理要路由到的区域——映射文件里的某个 key，**可以有多个**。 |

home 区域与部署区域相互独立，可相同也可不同（例如：为降低延迟部署在新加坡，但由于新加坡是 GrabMaps 区、不能作逆地理编码引导，于是把 `ap-northeast-1` 用 `"*"` 标记为 home）。

## 环境变量

| 变量 | 说明 | 示例 |
|---|---|---|
| `MULTI_REGION_ROUTING` | 总开关，默认 `false`（单区域：一切走 home 区域）。 | `true` |
| `LOCATION_API_KEYS` | region→API Key 的 JSON（每 key 含 geo-places + geo-maps）。以一个 Secrets Manager secret 提供。 | `{"ap-northeast-1":"v1.public.xxx"}` |
| `MAP_TILE_DOMAIN` | CloudFront 瓦片域名（CloudFront 栈的输出）。 | `d123.cloudfront.net` |
| `ALLOWED_ORIGINS` | `/api` 的 CORS 允许源列表（逗号分隔）。不设置则不发 CORS 允许头；这只控制浏览器脚本能否读取跨源响应，不是身份验证。 | `https://app.example.com` |
| `API_RATE_PER_SEC` | `/api` 每源 IP 的持续速率（令牌桶补充速率）。默认 `10`。 | `20` |
| `API_RATE_BURST` | `/api` 每源 IP 的突发容量（令牌桶大小）。默认 `20`。 | `40` |
| `TRUST_PROXY` | Express `trust proxy` 值——代理跳数，使限流拿到真实、不可伪造的客户端 IP。**默认 `false`**（安全兜底：未设置/为空或无法识别的值都不信任客户端传来的 `X-Forwarded-For`，限流无法被绕过；坏值还会打告警）。在 CloudFront→ALB 之后应设为 `2`（跳数）——ECS 栈默认已传 `TrustProxy=2`。 | `2` |
| `REVERSE_GEO_CACHE_MAX` | 逆地理编码网格缓存的 FIFO 上限（每任务，防止无界增长的兜底）。默认 `200000`。 | `200000` |
| `DEFAULT_MAP_LANGUAGE` | 兜底的地图标注语言（ISO 639-1）。仅在既无显式 `lang`、也无法从国家码推断时使用。默认 `en`。取值非法则**启动即失败**（避免全站悄悄退回英文）。 | `zh` |

> 在用区域**和 home 区域**都**不是**环境变量——它们来自 `config/country-region-map.json`（其 key,以及被 `"*"` 标记的区域）。本地通过 `export` 设置上面这些变量；生产环境通过 CloudFormation 参数传入（见下文）。两种机制相互独立。

## 国家→区域映射文件

`config/country-region-map.json` 采用区域优先结构（`{ 区域: [ISO 国家代码] }`），是区域集与 home 区域的唯一事实源：

```json
{
  "ap-northeast-1": ["*", "JP", "KR"],
  "ap-southeast-1": ["SG", "MY", "TH", "ID", "VN", "PH"],
  "eu-central-1": ["GB", "DE", "FR", "NL", "IE", "ES", "IT"],
  "us-east-1": ["US", "CA", "MX"]
}
```

- 每个顶层 key 都是一个在用区域（生成 CloudFront 行为、需要 key、启动时校验）。
- 必须且只能有一个区域在国家列表里含 `"*"`——它标记 **home 区域**（回落 + 逆地理编码引导）。该区域也可同时服务具体国家（如上），或仅作回落（`"ap-northeast-1": ["*"]`）。
- 未列出的国家分两种情况，取决于请求怎么给出这个国家：**显式传 `countryCode`** 会被拒绝并返回 **400**（`Unsupported countryCode "XX" (not a served country in the mapping)`）——映射表就是「已服务国家」的准入名单，光是合法的 ISO 码还不够；而由 **`lat`/`lng` 反查得到的国家**则回落到 home 区域（记日志，不报错）。所以新开一个市场，必须把它加进这个文件。
- 加入某个国家之前，先确认目标区域的地图数据提供方对它的覆盖质量。把一个国家路由到本地数据薄弱的区域，比不列出、让它走 home 区域更糟——所以示例文件故意只列了一部分国家，它是一份需要你逐个核实的起点，而不是照着往下抄的清单。

**真实的** `config/country-region-map.json` 已加入 `.gitignore`（国家清单因部署而异），仓库只跟踪 `config/country-region-map-example.json`。请从示例创建你的真实文件：

```bash
cp config/country-region-map-example.json config/country-region-map.json
```

- **多区域**：按业务修改副本（区域 + 国家），并保持恰好一个区域用 `"*"` 标记为 home。
- **单区域**：只保留一个区域并标记为 home，例如 `{ "us-east-1": ["*"] }`（所有国家都回落到它）。

该文件是运行时必需的：应用启动时读取它，缺失会直接启动失败（错误信息会提示执行上面的 `cp`）。`docker build` 也会把它打包进镜像，因此构建前同样需先准备好。

## 点击地图识别地点

在地图上缩放、平移到任意位置后点击，即可获得该处的地点信息（逆地理编码）。前端把点击坐标发给 `GET /api/reverse-geocode?lat=&lng=&lang=`，返回：

```json
{ "place": { "label": "東京駅", "address": { "Label": "…", "Locality": "千代田区" },
             "position": [139.7671, 35.6812], "placeType": "PointAddress", "distanceMeters": 12.5 },
  "country": "JP", "tileRegion": "ap-northeast-1", "language": "ja" }
```

点击同样会跟随国家上下文：勾选「跟随所选结果的国家上下文」时会回填国家框，并按需切换瓦片区域（保持当前视野不动）和标注语言。

> **GrabMaps 区域的语言子集。** AWS 公开说明 `ap-southeast-1` / `ap-southeast-5` 的 GeoPlaces 支持 `en, id, km, lo, ms, my, pt, th, tl, vi, zh`。因此标注语言为日文时请求新加坡，代码会先把语言钳到该子集（`clampPlacesLanguage`）。钳制时优先用 `DEFAULT_MAP_LANGUAGE`（前提是它本身也在该区域的公开子集中），都不行才回落 `en`。注意这个集合和地图标注的 68 种语言互不包含——它含 `lo`/`tl`，而标注语言集不含。参见 [GeoPlaces `Language` 参考](https://docs.aws.amazon.com/cli/latest/reference/geo-places/reverse-geocode.html)。
>
> 响应里的 `language` 字段回报实际使用的语言，且当它与用户所选语言不同时，演示页面会在信息面板里标出来——这样「日文标注下出现英文地址」读起来是有意的降级，而不是 bug。

> **`IntendedUse` 保持默认的 `SingleUse`（不持久化）。** 若要把逆地理编码结果落库，按服务条款必须显式设为 `Storage`，且计费更高——这必须是一个明确的决定，不能是默认行为。

## 地图标注语言

Amazon Location 的**动态（矢量瓦片）地图没有服务端语言参数**——`GetStyleDescriptor` 只接受 `ColorScheme` / `PoliticalView` / `Terrain` 等；带 `Language` 参数的只有栅格的 `GetStaticMap`。因此本代理按 AWS 文档的做法，在 style descriptor 里把 symbol 图层的 `text-field` 改写为优先取瓦片的 `name:<语言>` 属性（[首选语言指南](https://docs.aws.amazon.com/location/latest/developerguide/how-to-set-preferred-language-map.html)）：

```
["coalesce", ["get","name:zh"], ["get","name:en"], ["get","name"]]
```

`config/map-languages.js` 的 68 个代码抄录自 [`GetStaticMap Language` 的公开取值](https://docs.aws.amazon.com/cli/latest/reference/geo-maps/get-static-map.html)，并保守地复用于矢量瓦片的 `name:<lang>` 属性。AWS 并未公开保证栅格 API 枚举与矢量瓦片属性集合今后始终完全一致。

保留 `name:en` 与 `name` 作为兜底，所以缺少该语言译名的要素仍有标注。改写只发生在 `/api/map-style` 的响应里，**瓦片 URL 不变**，因此 CloudFront 缓存与瓦片代理都不受影响（瓦片本身已内含各语言的 name 字段）。

语言的决定顺序：

1. `GET /api/map-style?lang=<ISO 639-1>` —— 显式指定，优先级最高。接受完整 BCP 47 标签（`zh-CN` → `zh`）。**不支持的取值返回 400**（例如 `lang=cn`，中文的 ISO 639-1 是 `zh`），而不是悄悄退回英文。
2. **按国家码**（缺省行为）：由请求里的 `countryCode`，或 `lat`/`lng` 逆地理编码出的国家，查 `config/map-languages.js` 的 `COUNTRY_LANGUAGE` 表得到。逆地理编码结果复用路由已经算出的国家，不会多调一次 ALS。
3. `DEFAULT_MAP_LANGUAGE`（默认 `en`）。

注意 `?region` 只决定**瓦片来自哪个区域**，不影响语言——一个区域覆盖多个国家，两件事是独立的决策。

响应头 `X-Map-Label-Language` 与 `X-Map-Label-Language-Source` 会回报实际生效的语言及其来源（`explicit` / `country-map` / `config-default` / `fallback`），前端在「自动」模式下据此显示当前语言。`GET /api/map-languages` 返回可选语言列表与默认值，供前端渲染下拉框，避免在前端另存一份会过期的清单。

按国家的默认语言在 `config/map-languages.js` 里维护。若某国的主要语言不在 ALS 支持的 68 种之列（如僧伽罗语 LK、尼泊尔语 NP、乌尔都语 PK、斯瓦希里语 KE/TZ、蒙古语 MN），表里退回该国通用的行政语言（通常是 `en`）——用不支持的代码只会得到没有译名的标注。

Satellite 样式没有标注图层，ALS 文档也说明它不支持语言，此时改写为空操作。

> **CJK 标注依赖本地字形栅格化。** 实测线上服务，ALS 的 glyph 端点对 CJK 汉字、假名、谚文区间返回**零个字形**，而其它文字都正常提供（拉丁、西里尔、阿拉伯、天城体、泰文、希腊、希伯来、格鲁吉亚、高棉、缅甸以及各印度系文字均有内容）。MapLibre **默认**就会用本地字体栅格化这些区间——`localIdeographFontFamily` 的默认值是 `'sans-serif'`——所以前端那一行只是指定更合适的平台字体。把该选项设为 `false` 会关闭本地栅格化，导致所有 CJK 标注消失，只剩数字路牌。

### 只改语言时的轻量路径

在一个区域内换国家（`eu-central-1` 有 67 个国家、38 种语言）只需要换语言，不需要换瓦片。为此重新拉取整份 descriptor 代价过高：约 136 KB，且 `map.setStyle()` 会重建整个样式——重新请求 glyph 与 sprite、抹掉客户端自行添加的图层、还要用回调把视图恢复回去。

`GET /api/map-labels` 只返回改写后的标注表达式，按图层 id 索引：

```json
{ "language": "fr", "source": "country-map",
  "layers": { "place_label": ["coalesce",["get","name:fr"],["get","name:en"],["get","name"]], "...": [] } }
```

约 3 KB（比完整 descriptor 小 45 倍），前端用 `map.setLayoutProperty(id, "text-field", expr)` 原地赋值。查询参数与 `/api/map-style` 完全一致，且服务端复用同一个 `applyPreferredLanguage`，因此结果与完整重载逐字节相同——语言决策和表达式改写都不下移到前端，前端只做赋值。

区域切换和地图样式切换仍走 `/api/map-style`：它们本来就需要新的 descriptor，而那个请求已经带上了正确的语言。

注意这条路径省的是浏览器流量和样式重建，**不省上游那次 ALS `GetStyleDescriptor` 调用**。若要减少 ALS 调用量，应另外给 `(region, style)` 加服务端 descriptor 缓存——下一节记录了为此实测到的上游行为。

### 上游缓存行为（实测）

`getStyleDescriptor` 会按 `(region, style)` 各打印一次上游缓存头（去重，且不打印 URL——URL 带 `?key=`）。跨 7 个区域、3 种样式共 11 个组合的实测结果完全一致：

```
cache-control=max-age=86400,must-revalidate   etag=(none)
```

由此确定的三件事：

- **`max-age` 是 24 小时，很长。** 命中率 `λT/(1+λT)`，TTL=24h 的盈亏平衡线是「每个 key 每任务每天 1 次请求」，任何真实流量都能跨过。TTL 不会是约束项。
- **没有 `ETag`。** 尽管 AWS 文档把 `ETag` 列为该 API 的响应头，真实响应里并没有（已排除日志漏读与中间层剥头：ECS 直连 `maps.geo.<region>.amazonaws.com`，瓦片才走 CloudFront）。所以**无法用 `If-None-Match` 做廉价 revalidate**，到期只能整份重取，拿不到 304。
- **`must-revalidate`** 意味着过期后不得在未验证的情况下继续使用。结合上一条，"验证"等于"整份重取"，因此 TTL 不要超过 86400，也不要做 stale-while-revalidate。

因为没有 validator，**限制陈旧程度的唯一手段就是缩短 TTL**。26 条 descriptor 合计约 2.1 MB，刷新成本很低（TTL=1h 且 26 个 key 全活跃约 50 MB/天/任务，实际只有少数热 key，约 3 MB/天/任务），所以建议默认 1 小时、可配置到 86400——用几 MB 流量换「AWS 更新样式后 1 小时内生效」，比 24 小时的盲区划算。

真要实现时有两点提醒：

- **缓存原始 JSON 字符串，不要缓存解析后的对象。** `als.rewriteStyle()` 会**原地**改写传入对象的 `sources[*].tiles`、`glyphs`、`sprite`；把缓存对象直接交给它，第一次请求就会把缓存副本改成"已代理"状态，之后再进去 `replace` 找不到原始域名，会静默返回一份被改过的 style。存字符串每次 `JSON.parse`（135 KB 实测约 1 ms）既天然安全，内存也小得多（26 份实测 2.1 MB vs 存对象 15.1 MB）。
- **不需要 Redis/ElastiCache。** 26 个条目、2.1 MB，任务内存是 512 MB；且同一 `(region, style)` 在 TTL 内等价，没有跨任务失效的语义，不存在必须共享缓存才能解决的一致性问题。仿 `src/reverseGeocoder.js` 的进程内 `Map` + FIFO 上限即可。


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
docker build --platform linux/arm64 -t location-proxy .
docker tag location-proxy:latest <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
docker push <ACCOUNT_ID>.dkr.ecr.<deploy-region>.amazonaws.com/location-proxy:latest
```

**b. 部署 ECS Fargate 栈**（在部署区域）。区域集与 home 区域都来自镜像里打包的映射文件。首次部署需提供路由开关、API key secret、地图瓦片域名、镜像和回源校验密钥；`DefaultMapLanguage` 可选，默认 `en`。先为首次部署生成一个强随机的 `OriginVerifySecret`（它让 ALB 拒绝任何不是经由本 CloudFront 分发而来的请求）：

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

- **单区域**：设 `MultiRegionRouting=false`（home 区域即你在映射里用 `"*"` 标记的那个）。
- **`DefaultMapLanguage`**：对应 `DEFAULT_MAP_LANGUAGE`，默认 `en`，所以可省略；上面的命令显式写出 `en` 以说明默认使用英文。它仅在请求既无显式语言、也无可推断国家时使用。可改成 `zh` 等受支持的两字母语言代码；取值非法会导致任务启动失败。
- **`OriginVerifySecret`**（首次部署必填，至少 16 字符）：CloudFront 注入为 `X-Origin-Verify` 的共享密钥；缺少它的请求 ALB 一律返回 403。**更新现有栈时无需找回这个 `NoEcho` 参数的明文，也不要重新生成：从 `--parameter-overrides` 中省略 `OriginVerifySecret` 即可沿用栈中的现有值。**只有明确轮换时才传入新值。
- **可选防护参数**（均有合理默认，按需覆盖）：`AllowedOrigins=https://app.example.com`（允许该前端读取 `/api` 的跨源响应）、`ApiRatePerSec=10` / `ApiRateBurst=20`（`/api` 每源 IP 限流）、`TrustProxy=2`（CloudFront→ALB 跳数，用于取真实客户端 IP；默认已是 `2`）、`WebACLArn=...`（挂载边缘 WAF——见下面的可选步骤）。详见[API 防护与安全说明](#api-防护与安全说明)。

> **以后仅更新代码/映射时**：如果重新 build 并推送到同一个镜像 tag（`:latest`），模板和参数都没有变化，`cloudformation deploy` 会提示 *"No changes to deploy"*，此时需要：
> - 执行 `aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment --region <deploy-region>`。

**c. 获取访问地址**：

```bash
aws cloudformation describe-stacks \
  --stack-name location-proxy-ecs \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region <deploy-region>
```

> **页面缓存（仅在更新部署后仍看到旧页面时处理）**：CloudFront 配置部署本身不承诺清除所有已有对象缓存，因此若某个边缘节点仍返回旧的 `public/index.html`，或业务要求立即保证页面刷新，请按需失效 ECS 栈创建的**应用 CloudFront**（不是步骤 2 的地图瓦片代理）：
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
> `/api/*` 使用禁用缓存策略，不需要失效 API 缓存。

### 4. 可选：用 AWS WAF 做边缘限流

WAF 速率规则在 CloudFront 边缘按客户端 IP 限流——是每 task 应用内限流之上的全局兜底。跳过此步则仅用应用内限流。

`CLOUDFRONT` 作用域的 WebACL **只能**在 **us-east-1** 创建,因此无论你的部署区域是哪里,它都单独放在一个小栈（`infra/waf-webacl.yaml`）里。在 us-east-1 部署：

```bash
aws cloudformation deploy \
  --template-file infra/waf-webacl.yaml \
  --stack-name location-proxy-waf \
  --parameter-overrides WafRateLimit=2000 \
  --region us-east-1
```

取得 WebACL ARN 后,加上 `WebACLArn=<arn>` 重跑 ECS 部署（步骤 b）——CloudFront 是全局服务,所以尽管 ECS 栈在你的业务区域,us-east-1 的 WebACL 仍能挂到分发上：

```bash
aws cloudformation describe-stacks \
  --stack-name location-proxy-waf \
  --query 'Stacks[0].Outputs[?OutputKey==`WebACLArn`].OutputValue' \
  --output text --region us-east-1
```

> `WafRateLimit` 是每个 IP 每滚动 5 分钟窗口的请求数（默认 `2000`，最小 `100`）。

## 更新国家→区域映射

编辑 `config/country-region-map.json`，然后重建并推送镜像。用 `aws ecs update-service --force-new-deployment` 触发滚动更新（或用不可变镜像 tag——见步骤 b 下的说明；tag 不变时单跑 `cloudformation deploy` 不会生效）。模板会维持至少两个健康 task 并执行滚动更新，但下游超时、容量不足或平台故障仍可能影响可用性。如果新增了**新区域**，需先创建其 key 并更新 secret（重跑步骤 1），并重新生成 + 部署 CloudFront 栈（步骤 2）。映射配错会导致启动校验失败，新任务无法通过健康检查，旧版本继续服务。

## 测试

```bash
npm test
```

## 安全

更多信息请参阅 [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications)。

## 许可

本项目基于 MIT-0 许可证授权。详见 LICENSE 文件。

---

⭐ 如果这个项目对你有帮助，欢迎[给仓库点个 star](https://github.com/aws-samples/sample-api-proxy-for-multi-region-location-service) —— 这能帮助更多人发现它。
