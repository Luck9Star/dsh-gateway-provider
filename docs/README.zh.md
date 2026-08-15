# dsh-gateway-provider

[![gitleaks](https://github.com/Luck9Star/dsh-gateway-provider/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/Luck9Star/dsh-gateway-provider/actions/workflows/gitleaks.yml)

> English: [README.md](../README.md)

把任意 LLM 网关 —— **newapi、LiteLLM、Higress 或任何 OpenAI 兼容端点** —— 接入
DeepSeek Harness。插件自动发现网关的模型列表，用 [models.dev](https://models.dev)
的真实参数补齐每个模型，并通过 pi-ai SDK 以模型原生协议（OpenAI / Anthropic /
Gemini）分发请求。

## 为什么需要它

DeepSeek Harness 自带的适配器（`llm-deepseek`、`llm-pi-ai`）各自只服务一个官方
provider。如果你的模型都在网关后面，就得手工维护一份静态模型清单，上下文窗口、
输出上限全靠猜。

本插件直接把网关挂进来：**N 个网关 = N 个 provider 路由，零静态清单。** 每个模型
带着真实参数，网关侧加模型即可生效——无需重新部署。

## 你能得到什么

- **多网关** — 默认 `newapi` 路由 + 每个额外网关一条 `gateway:<id>` 路由，
  各自独立 catalog 缓存。
- **自动发现** — 首选 `GET {base}/v1/models`（含每个模型支持的请求格式），
  管理 API 兜底。
- **真实参数** — models.dev 补齐上下文窗口、输出上限、推理等级、发布日期；
  配置默认值只是兜底。
- **全协议覆盖** — 每个模型路由到自己的协议（`openai-completions` /
  `openai-responses` / `anthropic-messages` / `google-generative-ai`），
  无手写 SSE、无手写请求序列化。
- **图形设置页** — **设置 → 网关模型**：按模板添加/编辑网关、测试连接、
  隐藏/覆写/自定义添加模型——不用碰 YAML。
- **干净的选择器** — 按发布日期新到旧排序、只保留对话模型、正则剔除。

## 环境要求

- 装有 profile 的 DeepSeek Harness（`dsh`）
- 一个可达网关：newapi / LiteLLM / Higress / 任意 OpenAI 兼容端点
- 该网关的 API Key

## 快速开始

1. 把插件装进 profile（已发布到 npm）：

   ```bash
   dsh plugin --profile web add dsh-gateway-provider          # 最新版
   dsh plugin --profile web add dsh-gateway-provider@1.0.2    # 钉住版本
   ```

   `dsh plugin add` 会在 profile 目录里转发执行 `pnpm add`。bundle 补丁
   （`cordis.patch.yml`）随后自动挂载 `llm-newapi` 加载行——无需手工改 patch。

2. 把网关 key 写入 `$DSH_HOME/.credentials.yaml`（权限 0600，热加载）：

   ```yaml
   NEWAPI_API_KEY: sk-REPLACE_WITH_YOUR_KEY
   ```

   或在启动环境中导出 `NEWAPI_API_KEY`。

3. 重启 profile，打开 **设置 → 网关模型**。

**成功的样子：** 网关出现并带"已同步 N 个模型"徽标，全部对话模型可选、
上下文窗口是真实值。基础地址解析顺序：`llm-newapi.baseURL` 设置 →
`NEWAPI_BASE_URL` / `NEWAPI_API_URL` 环境变量 → 公共默认
`https://api.newapi.ai`。

## 添加更多网关

额外网关写在 `gateways` 数组——每个成为独立的 `gateway:<id>` provider 路由：

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  gateways:
    - id: litellm-prod
      label: LiteLLM 生产
      baseURL: https://litellm.example.com
      apiKeyEnv: LITELLM_API_KEY
      flavor: litellm            # 表单模板：newapi / litellm / higress / openai-compatible / custom

    # 完全自定义网关：各协议写完整端点地址，不共享基础地址；
    # 留空的协议不启用。
    - id: edge
      label: 边缘网关
      flavor: custom
      openaiURL: https://edge.example.com/openai/v1/chat/completions
      responsesURL: https://edge.example.com/openai/v1/responses
      anthropicURL: https://edge.example.com/anthropic/v1/messages
      apiKeyEnv: EDGE_API_KEY
```

也可以在设置页里用同样的模板添加网关，不必编辑 YAML。

## 按网关控制模型清单

隐藏模型、修正错误元数据、添加网关未列出的模型：

```yaml
llm-newapi:
  models:
    - id: glm-5.2
      disabled: true              # 从选择器隐藏
    - id: glm-5.2-highspeed
      contextWindow: 1000000      # 覆盖发现值
      protocol: openai            # 强制协议（openai/anthropic/gemini/openai-response）
    - id: my-internal-model       # 自定义模型（网关未列出）
      name: 我的内测模型
      contextWindow: 200000
```

**网关模型**设置页提供同样的操作：搜索、带计数的已隐藏/自定义筛选、逐模型覆写
编辑器（placeholder 显示发现值）、连接测试、保存/取消语义。

## 配置参考

`$DSH_HOME/settings.yaml` 的 `llm-newapi:` 节。扁平字段（`baseURL` /
`apiKeyEnv` 等）构建默认 `newapi` 路由；`gateways` 数组里的每个网关支持
大部分同名字段（`label` / `apiKeyEnv` / `flavor` / `catalogMode` /
`endpointPriority` / …）。

| 字段 | 默认 | 说明 |
|------|------|------|
| `label` | `NewAPI` | 默认网关路由的显示名 |
| `apiKeyEnv` | `NEWAPI_API_KEY` | 凭据引用（环境变量名） |
| `baseURL` | env `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → `https://api.newapi.ai` | 网关地址（配置协议 URL 后不再使用） |
| `flavor` | `newapi` | 网关模板：`newapi` / `litellm` / `higress` / `openai-compatible` / `custom` |
| `openaiURL` | – | OpenAI 兼容完整端点地址（自定义模板；留空 = 不启用） |
| `responsesURL` | – | Responses 完整端点地址（自定义模板；留空 = 不启用） |
| `anthropicURL` | – | Anthropic messages 完整端点地址（自定义模板；留空 = 不启用） |
| `modelsUrl` | `https://models.dev/models.json` | models.dev 数据源（`file:` URL 可离线） |
| `useModelsDev` | `true` | 是否用 models.dev 参数增强模型 |
| `extendedReasoningLevels` | `false` | 未知模型推理等级兜底放宽到 off~max（默认仅 off/low/medium/high） |
| `sortModelsByRelease` | `true` | 选择器按发布日期新到旧排列（未知日期排最前） |
| `catalogMode` | `auto` | 模型列表来源：`auto` / `v1` / `management` |
| `catalogTtlMs` | `1800000` | 模型列表缓存时长 |
| `includeChatOnly` | `true` | 仅把对话模型放进选择器 |
| `excludePatterns` | image/speech/embed/… | 选择器剔除的正则列表 |
| `endpointPriority` | `["openai-response","anthropic","openai","gemini"]` | wire 格式优先级（每模型取首个匹配） |
| `userId` | `1` | 管理 API 的 `New-Api-User` 头 |
| `maxTokens` | `32768` | 无 models.dev 数据时的输出上限兜底 |
| `defaultContextWindow` | `128000` | 无 models.dev 数据时的上下文兜底 |
| `streamIdleTimeoutMs` | `300000` | 流空闲看门狗 |
| `retryPolicy` | 标准重试 | 与 `llm-deepseek` 同构 |

## 工作原理

所有 wire 格式细节都委托给
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
—— 官方 `dsh-llm-pi-ai` 适配器用的同一 SDK。每次请求：

```
harness GenerateOptions
  → toPiContext()          lib/pi-bridge.js   harness 消息 → pi-ai Context
  → models.streamSimple()  pi-ai SDK          按每个模型的 `api` 分发协议
  → toStreamChunks()       lib/pi-bridge.js   pi-ai 事件 → harness chunk
```

每个发现的模型带一个 `api` 字段，由网关广告的 `supported_endpoint_types`
映射而来，遵循 `endpointPriority`；pi-ai provider 收到的是 api *映射表*，
所以每个模型路由到自己的协议实现。`sdkBaseURL()` 为 OpenAI 协议模型补
`/v1`，Anthropic/Google 的基础地址保持不变。

```
dsh-gateway-provider/
├── index.js            # 插件入口：Config 校验、provider 注册、设置/凭据接线
├── cordis.patch.yml    # dsh.bundle 补丁（经 `dsh plugin add` 自动挂载）
├── lib/                # adapter、pi-provider、pi-bridge、catalog、modelsdev、thinking、client
├── test/               # 冒烟（直连网关）+ 离线单元 + 设置页渲染
└── scripts/link.sh     # 本地检出时链接 profile 的 node_modules
```

## 从本地检出开发

1. `bash scripts/link.sh` — 把本包 `node_modules` 软链到 profile 的，
   保证 `@deepseek-ai/*` 裸导入解析到 harness 进程使用的同一份模块实例
   （单实例 `instanceof` 安全）。
2. 把检出注册为 profile 的 link 依赖并安装：

   ```bash
   cd "$DSH_HOME/profiles/web"
   # package.json dependencies 追加："dsh-gateway-provider": "link:/本包绝对路径/dsh-gateway-provider"
   # 再把 "dsh-gateway-provider" 加进同一文件的 bundles 列表
   pnpm install
   ```

3. 重启 profile。

> ⚠️ **不要**再往 profile 自己的 `cordis.patch.yml` 里插入 `id: llm-newapi`
> ——bundle 层已挂载，重复会导致启动时报 `duplicate loader entry id`。

客户端 bundle 改动刷新浏览器即生效；宿主侧改动需要重启 profile。

### 测试

```bash
node test/smoke.mjs            # 直连网关：catalog / openai × 2 / 工具调用 / anthropic / gemini / custom-urls
node test/smoke.mjs --only custom-urls
node test/protocol-urls.mjs    # 离线：URL 派生 + 网关解析单元测试
node test/client-render.mjs    # 离线：设置页渲染树（中/英）
```

冒烟测试凭据解析顺序：进程环境变量 → 插件目录 `.env` →
`$NEWAPI_ENV_FILE`（另有一个作者本地遗留兜底路径）。

## 安全说明

- API Key 只经 `$DSH_HOME/.credentials.yaml`（0600）或环境变量解析，
  绝不写入日志、配置或对话；凭据字段在 Web UI 中以掩码编辑。
- 无运行时 `dependencies`；`peerDependencies` 复用 harness 已装的
  `@deepseek-ai/*` 与 `@earendil-works/pi-ai`。提交在本地（pre-commit）
  与 CI 双层接受 gitleaks 扫描把关。

## License

MIT
