# dsh-newapi-provider

**NewAPI（new-api 网关）模型 Provider 插件** — 为 DeepSeek Harness 的 LLM 适配层
(`ctx.llm`) 注册 `newapi` provider 路由。纯 ESM、零运行时依赖（仅 `fetch`）。
无静态模型清单——一切自动发现、自动驱动：

1. **自动获取模型** — 从网关实时拉取模型列表：
   - 首选 `GET {base}/v1/models`（OpenAI 兼容，返回每个模型的
     `supported_endpoint_types` —— 即该模型“支持的请求格式”）；
   - 兜底 `GET {base}/api/user/models`（管理 API，扁平 id 列表）。
2. **models.dev 参数自动控制模型** — 用 <https://models.dev/models.json> 的
   参数（`limit.context` / `limit.output` / `reasoning` / `family` / 描述等）
   自动补齐每个模型的 context window、输出上限、推理等级、显示名与描述；
   命名空间键（`minimax/MiniMax-M3`）模糊匹配，缺失时回退到配置默认值。
3. **按模型支持的请求格式自动拼接地址** — 每个请求根据该模型在网关列表里
   声明的 `supported_endpoint_types` × 插件优先级，自动选择 wire 格式并拼 URL：
   - `openai` → `POST {base}/v1/chat/completions`
   - `anthropic` → `POST {base}/v1/messages`
   - `gemini` → `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`
4. **思考级别直接引用 harness 官方模型目录（pi-ai）** — 推理等级选择器不再
   机械推导，而是复用 DeepSeek Harness 自带的 pi-ai 模型目录（官方
   `llm-pi-ai` 适配器的底层库，随发行版安装）：每个模型条目带 `reasoning`
   与 `thinkingLevelMap`（逐思考级别声明提供方原生 wire 值），可选级别用
   pi-ai 的 `getSupportedThinkingLevels` 计算（`off` / `minimal` / `low` /
   `medium` / `high` / `xhigh` / `max`，含目录级的支持矩阵——例如 GLM-5.2
   声明不支持 off、GPT-5.5 暴露 xhigh、Kimi K2.6 只发 thinking）。wire
   序列化照搬 pi-ai 的 openai-completions 分发（`thinkingFormat ===
   "deepseek"` → `thinking` + `reasoning_effort`，其余模型走 OpenAI 风格
   `reasoning_effort` 并经 `thinkingLevelMap` 映射）；MiniMax 保留网关实测
   的 `thinking: {type: adaptive|disabled}`。目录未收录的模型回退到
   models.dev 推断（`reasoning: true` + 家族）。网关 id 先归一化（去 `provider/` 前缀与
    `-highspeed`/`-lowspeed` 等渠道后缀），同名模型多 provider 按官方优先
    （zai/deepseek/minimax/… 先于 openrouter/opencode 等聚合器）解析，因此
    `glm-5.2-highspeed` 会归一到 `glm-5.2`。
5. **自动化治理** — 模型列表按 TTL 缓存、惰性刷新；image/speech/embedding 等
   非对话模型默认从选择器剔除（`excludePatterns`）；HTTP 错误统一映射
   （AUTH / RATE_LIMIT / QUOTA_EXCEEDED / CONTEXT_WINDOW_EXCEEDED / SERVER /
   TRANSPORT…），支持 `retry-after` 与 `x-request-id`，流空闲看门狗防挂死。

## 目录结构

```
dsh-newapi-provider/
├── index.js            # 插件入口：Config 校验、provider 注册、设置/凭据接线
├── cordis.patch.yml    # dsh.bundle 补丁（标准 `dsh plugin add` 可安装）
├── lib/
│   ├── catalog.js      # 网关模型列表自动发现 + models.dev 合并 + TTL 缓存 + 过滤
│   ├── modelsdev.js    # models.dev 拉取/模糊匹配/参数提取
│   ├── wire.js         # endpoint 选择 + 按格式拼接请求 URL
│   ├── serialize.js    # harness 消息 → openai/anthropic/gemini 三种请求体
│   ├── translate.js    # 三种格式 SSE → harness StreamChunk
│   ├── sse.js          # 零依赖 SSE 解析器
│   └── adapter.js      # NewapiAdapter（LlmAdapter 子类）
├── test/smoke.mjs      # 直连网关的集成冒烟测试
└── scripts/link.sh     # 链接 harness profile node_modules（单实例保证）
```

## 安装

### 方式一：标准 `dsh plugin add`（发布包）

包已声明 `dsh.bundle` manifest，按标准流程加入 profile 层栈：

```bash
dsh plugin --profile web add dsh-newapi-provider
```

然后：

1. **凭据** — 在 `$DSH_HOME/.credentials.yaml`（0600，Models 页同款写法，
   热加载）写入网关 key：

   ```yaml
   NEWAPI_API_KEY: sk-REPLACE_WITH_YOUR_KEY
   ```

   或在启动环境中导出 `NEWAPI_API_KEY`。

2. **网关地址** — 逐请求解析：`llm-newapi.baseURL` 设置 → 环境变量
   `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → 公共默认 `https://api.newapi.ai`。

3. 重启 profile（bundle 在启动时读取），打开 Web 设置 → 模型：出现
   **NewAPI (newapi)** 提供方，网关全部对话模型（含 models.dev 参数）可选。

### 方式二：本地源码挂载（无需重启）

web profile 的用户补丁层支持 HMR，本地检出可直接热挂载：

1. `bash scripts/link.sh` — 把本包 `node_modules` 软链到 profile 的
   node_modules，保证 `@deepseek-ai/*` 裸导入解析到 harness 进程正在使用的
   同一份模块实例（单实例 `instanceof` 安全）。
2. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 加一行：

   ```yaml
   - insert:
       - id: llm-newapi
         name: '<指向本包的绝对/相对路径>/index.js'
   ```

   修改插件源码后，给 `name` 追加查询串（如 `index.js?v=3`）强制重新 import。

## Web 配置（模型设置页）

官方 **设置 → 模型** 编辑页只认识自带的 `llm-deepseek` 与 `llm-pi-ai` 命名空间；
第三方 provider 的命名空间只会渲染提示且禁用保存。本包附带一个小补丁，让
Models 页对 `llm-newapi` 使用 deepseek 编辑布局（API 密钥 + API 地址 + 模型目录）：

```bash
node scripts/patch-web-ui.mjs apply     # 给 profile bundle 打补丁（幂等）
node scripts/patch-web-ui.mjs verify    # 检查状态
node scripts/patch-web-ui.mjs restore   # 还原
```

执行 `apply` 后刷新浏览器：**设置 → 模型 → 编辑 NewAPI** 出现 API 密钥输入框，
"自定义设置"里有 API 地址——保存即写入 `$DSH_HOME/settings.yaml` 的 `llm-newapi:`
节（热加载）与凭据库。

> ⚠️ DeepSeek Harness 升级会重装 bundle 并丢掉补丁——升级后重跑
> `node scripts/patch-web-ui.mjs apply`。该补丁只改你本机 profile 安装，
> 发布的插件包本身是未经修改的上游代码。

其余高级参数（`catalogMode`、`endpointPriority`、`excludePatterns` 等）在
`$DSH_HOME/settings.yaml` 的 `llm-newapi:` 节中编辑。

## 配置（`$DSH_HOME/settings.yaml` 的 `llm-newapi:` 节）

| 字段 | 默认 | 说明 |
|------|------|------|
| `apiKeyEnv` | `NEWAPI_API_KEY` | 凭据引用（环境变量名） |
| `baseURL` | env `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → `https://api.newapi.ai` | 网关地址 |
| `modelsUrl` | `https://models.dev/models.json` | models.dev 数据源（file: URL 可离线） |
| `useModelsDev` | `true` | 是否用 models.dev 参数增强模型 |
| `extendedReasoningLevels` | `false` | 未知模型的推理等级兜底是否放宽到全量 off~max（默认仅 off/low/medium/high） |
| `catalogMode` | `auto` | `auto` / `v1` / `management`（模型列表来源） |
| `catalogTtlMs` | `1800000` | 模型列表缓存时长 |
| `includeChatOnly` | `true` | 仅把对话模型放进选择器 |
| `excludePatterns` | image/speech/embed/… | 选择器剔除的正则列表 |
| `endpointPriority` | `["openai","anthropic","gemini"]` | wire 格式优先级 |
| `userId` | `1` | 管理 API 的 `New-Api-User` 头 |
| `maxTokens` | `32768` | 无 models.dev 数据时的输出上限兜底 |
| `defaultContextWindow` | `128000` | 无 models.dev 数据时的上下文兜底 |
| `streamIdleTimeoutMs` | `300000` | 流空闲看门狗 |
| `retryPolicy` | 标准重试 | 与 llm-deepseek 同构 |

示例：

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  endpointPriority: [openai, anthropic, gemini]
  excludePatterns: ["(^|/|-)image", "(^|/|-)speech"]
```

## 测试

```bash
cd dsh-newapi-provider
node test/smoke.mjs            # 全部：catalog/openai×2/工具调用/anthropic/gemini
node test/smoke.mjs --only catalog
```

冒烟测试环境来源优先级：进程环境变量 → 插件目录 `.env` →
`~/Documents/dev/Agents/dsh-newapi/.env`（可用 `NEWAPI_ENV_FILE` 覆盖）。
覆盖项：网关模型列表自动发现与过滤、models.dev 参数合并（deepseek-v4-flash=
1M 上下文 / MiniMax-M3=512K）、三种 wire 格式实测、工具调用往返。

## 安全说明

- API Key 只经 `$DSH_HOME/.credentials.yaml`（0600）或环境变量解析，绝不写入
  日志、配置或对话；`credential-ref` 字段在 Models 页以掩码形式编辑。
- 插件自身无 `dependencies`；`peerDependencies` 复用 harness 已装的
  `@deepseek-ai/*`，本地检出用 `scripts/link.sh` 保证单实例。

## License

MIT
