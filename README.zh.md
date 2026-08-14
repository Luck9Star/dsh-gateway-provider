# dsh-gateway-provider

> English: [README.md](README.md)

**通用 LLM 网关 Provider 插件** — 为 DeepSeek Harness 的 LLM 适配层
(`ctx.llm`) 注册一个或多个网关 provider 路由（`newapi` 默认路由 + 可选的
`gateway:<id>` 路由），支持 newapi / LiteLLM / 任意 OpenAI 兼容网关。
纯 ESM。无静态模型清单——一切自动发现、自动驱动：

1. **多网关同时连接** — 旧的单连接配置（`baseURL`/`apiKeyEnv` 等扁平字段）自动
   构建默认 `newapi` 路由（完全向后兼容）；新增 `gateways` 数组可挂载更多网关，
   每个成为独立的 `gateway:<id>` provider 路由，各自独立 catalog 缓存。
2. **逐模型 wire 协议（pi-ai SDK 驱动）** — 网关广告的每个模型的
   `supported_endpoint_types` 映射到 pi-ai API 标识符
   （`openai-completions` / `openai-responses` / `anthropic-messages` /
   `google-generative-ai`），由官方 `@earendil-works/pi-ai` 协议层分发。
   无需手写 SSE 或请求体序列化——SDK 原生支持每种 wire 格式。
3. **自动获取模型** — 从网关实时拉取模型列表：
   - 首选 `GET {base}/v1/models`（OpenAI 兼容，返回每个模型的
     `supported_endpoint_types` —— 即该模型"支持的请求格式"）；
   - 兜底 `GET {base}/api/user/models`（管理 API，扁平 id 列表）。
4. **models.dev 参数自动控制模型** — 用 <https://models.dev/models.json> 的
   参数（`limit.context` / `limit.output` / `reasoning` / `family` / `release_date`）
   自动补齐每个模型的 context window、输出上限、推理等级、发布日期；缺失时回退到配置默认值。
5. **模型级开关 / 覆写 / 自定义添加** — 通过自建的"网关模型"设置页（独立于官方
   Models 页）提供：
   - 网关类型**模板**（newapi / LiteLLM / Higress / OpenAI 兼容 / 完全自定义）：
     模板决定添加网关表单的形态 —— 完全自定义模板直接填写各协议**完整**端点地址
     （`openaiURL` / `responsesURL` / `anthropicURL`），留空的协议不启用，
     模型仅以已启用协议请求；
   - 网关配置表单：回填当前值、脏检查、http(s) URL 校验、清空即继承语义
     （label / apiKeyEnv / flavor / catalogMode 均可按网关覆盖）；
   - 逐模型覆写编辑器（显示名 / 协议 / 上下文窗口 / 输出上限 / 思考级别），
     以发现值作 placeholder（`128K` 格式提示），保存/取消而非逐键写盘；
   - 模型搜索 + 已隐藏/自定义筛选（带计数）、自定义模型添加与删除、
     连接测试与"已同步 N 个模型"反馈。
   设置页通过转发的 settings/llm API 读写，无需额外 RPC。
6. **思考级别直接引用 harness 官方模型目录（pi-ai）** — 推理等级选择器复用
   pi-ai 模型目录：每个模型条目带 `reasoning` 与 `thinkingLevelMap`，可选级别用
   pi-ai 的 `getSupportedThinkingLevels` 计算。网关 id 先归一化（去 `provider/`
   前缀与 `-highspeed`/`-lowspeed` 等渠道后缀），同名模型多 provider 按官方优先
   （zai/deepseek/minimax/… 先于聚合器）解析，`glm-5.2-highspeed` 归一到
   `glm-5.2` 但保留独立显示名。
7. **发布日期排序** — 选择器按 models.dev 的 `release_date` 倒序排列（最新在上，
   未知日期排最前），可经 `sortModelsByRelease` 关闭。
8. **自动化治理** — 模型列表按 TTL 缓存、惰性刷新；image/speech/embedding 等非对话
   模型默认从选择器剔除（`excludePatterns`）；HTTP 错误统一映射。

## 架构：pi-ai 协议层

适配器把所有 wire 格式细节委托给 `@earendil-works/pi-ai`（官方
`dsh-llm-pi-ai` 适配器使用的同一 SDK）。每次请求的转换链：

```
harness GenerateOptions
  → toPiContext()         (lib/pi-bridge.js — harness 消息 → pi-ai Context)
  → models.streamSimple()  (pi-ai SDK — 按 model.api 分发协议)
  → toStreamChunks()       (lib/pi-bridge.js — pi-ai 事件 → harness chunk)
```

每个发现的模型通过 `buildModel()` 构造，其 `api` 字段由网关广告的
`supported_endpoint_types` 映射而来，遵循配置的 `endpointPriority`。
pi-ai 的 `createProvider()` 收到的是一个 api **map**（不是单个工厂），
所以每个模型路由到各自的协议实现——OpenAI Responses 模型走
`openai-responses`、Anthropic 模型走 `anthropic-messages`，以此类推。

`sdkBaseURL()` 助手为 OpenAI 协议模型补上 `/v1`（OpenAI Node SDK 期望
`baseURL` 已含 `/v1`，自己再拼 `/responses`），而 Anthropic/Google 的
baseURL 保持不变（那些 SDK 自行构建完整路径）。

## 目录结构

```
dsh-gateway-provider/
├── index.js            # 插件入口：多网关 Config 校验、provider 注册、设置/凭据接线
├── cordis.patch.yml    # dsh.bundle 补丁（经 `dsh plugin add` 或 link 依赖自动挂载）
├── lib/
│   ├── adapter.js      # NewapiAdapter：pi-ai 驱动的 LlmAdapter（多网关，按 provider 解析连接）
│   ├── pi-provider.js  # 网关 → pi-ai Provider：buildModel / buildProvider / pickModelApi / sdkBaseURL
│   ├── pi-bridge.js    # harness ↔ pi-ai 转换：toPiContext / toStreamChunks / mapStopReason / replay
│   ├── catalog.js      # 网关模型列表自动发现 + models.dev 合并 + 模型覆写/自定义 + TTL 缓存
│   ├── modelsdev.js    # models.dev 拉取/模糊匹配/参数提取
│   ├── thinking.js     # pi-ai 思考级别 + 变体归一化（baseModelId/variantLabel/findPiModel）
│   └── client.js       # 客户端：自建"网关模型"设置页（settings.section）
├── test/smoke.mjs      # 直连网关的集成冒烟测试
└── scripts/link.sh     # 链接 harness profile node_modules（单实例保证）
```

## 安装

### 方式一：标准 `dsh plugin add`（发布包）

包已声明 `dsh.bundle` manifest，按标准流程加入 profile 层栈：

```bash
dsh plugin --profile web add dsh-gateway-provider
```

`package.json` 的 `dsh.bundle.patch` 字段指向 `cordis.patch.yml`，后者在
**bundle 层**插入 `id: llm-newapi` 加载行——dsh 启动时读取，无需手动编辑
`cordis.patch.yml`。

然后：

1. **凭据** — 在 `$DSH_HOME/.credentials.yaml`（0600，Models 页同款写法，
   热加载）写入网关 key：

   ```yaml
   NEWAPI_API_KEY: sk-REPLACE_WITH_YOUR_KEY
   ```

   或在启动环境中导出 `NEWAPI_API_KEY`。

2. **网关地址** — 逐请求解析：`llm-newapi.baseURL` 设置 → 环境变量
   `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → 公共默认 `https://api.newapi.ai`。

3. 重启 profile（bundle 在启动时读取），打开 **设置 → 网关模型**：出现提供方，
   网关全部对话模型（含 models.dev 参数）可选。

### 方式二：本地源码挂载（按包名安装）

把本地检出按**包名** link 依赖挂载——与本机其它正常工作的第三方插件（dsh-ssh、
dsh-web-ui-all 等）完全一致。bundle 自带的 `cordis.patch.yml` 负责 bundle 层的
加载行插入，所以只需注册依赖即可。

1. `bash scripts/link.sh` — 把本包 `node_modules` 软链到 profile 的
   node_modules，保证 `@deepseek-ai/*` 裸导入解析到 harness 进程正在使用的
   同一份模块实例（单实例 `instanceof` 安全）。
2. 把检出注册为 profile 的 link 依赖并安装：

   ```bash
   cd "$DSH_HOME/profiles/web"
   # 在 package.json 的 dependencies 中追加：
   #   "dsh-gateway-provider": "link:/本包绝对路径/dsh-gateway-provider"
   # 然后把 "dsh-gateway-provider" 加到同一文件的 bundles 列表
   pnpm install
   ```

3. 重启 profile。bundle 层自动插入 `id: llm-newapi` 行（来自
   `cordis.patch.yml`），设置里出现自建的**网关模型**页（与官方 Models 页并存）。

> ⚠️ **不要**同时在 profile 的 `cordis.patch.yml`（用户 patch 层）再插入
> `id: llm-newapi`——bundle 层已挂载，重复会导致启动时报
> `duplicate loader entry id` 错误。

客户端 bundle 改动刷新浏览器即生效（rev 为内容哈希）；宿主侧改动需要重启
profile。

## 配置（`$DSH_HOME/settings.yaml` 的 `llm-newapi:` 节）

| 字段 | 默认 | 说明 |
|------|------|------|
| `label` | `NewAPI` | 默认网关路由的显示名（设置页可改） |
| `apiKeyEnv` | `NEWAPI_API_KEY` | 凭据引用（环境变量名） |
| `baseURL` | env `NEWAPI_BASE_URL` / `NEWAPI_API_URL` → `https://api.newapi.ai` | 网关地址（配置了协议 URL 后不再使用） |
| `flavor` | `newapi` | 网关模板标注：`newapi` / `litellm` / `higress` / `openai-compatible` / `custom` |
| `openaiURL` | – | OpenAI 兼容完整端点地址（完全自定义模板；留空 = 不启用该协议） |
| `responsesURL` | – | Responses 完整端点地址（完全自定义模板；留空 = 不启用该协议） |
| `anthropicURL` | – | Anthropic messages 完整端点地址（完全自定义模板；留空 = 不启用该协议） |
| `modelsUrl` | `https://models.dev/models.json` | models.dev 数据源（file: URL 可离线） |
| `useModelsDev` | `true` | 是否用 models.dev 参数增强模型 |
| `extendedReasoningLevels` | `false` | 未知模型的推理等级兜底是否放宽到全量 off~max（默认仅 off/low/medium/high） |
| `sortModelsByRelease` | `true` | 选择器按发布日期倒序排列（最新在上，未知日期排最前） |
| `catalogMode` | `auto` | `auto` / `v1` / `management`（模型列表来源） |
| `catalogTtlMs` | `1800000` | 模型列表缓存时长 |
| `includeChatOnly` | `true` | 仅把对话模型放进选择器 |
| `excludePatterns` | image/speech/embed/… | 选择器剔除的正则列表 |
| `endpointPriority` | `["openai-response","anthropic","openai","gemini"]` | wire 格式优先级（每模型取首个匹配） |
| `userId` | `1` | 管理 API 的 `New-Api-User` 头 |
| `maxTokens` | `32768` | 无 models.dev 数据时的输出上限兜底 |
| `defaultContextWindow` | `128000` | 无 models.dev 数据时的上下文兜底 |
| `streamIdleTimeoutMs` | `300000` | 流空闲看门狗 |
| `retryPolicy` | 标准重试 | 与 llm-deepseek 同构 |

示例（单网关，向后兼容）：

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  flavor: newapi
  endpointPriority: [openai-response, anthropic, openai, gemini]
  excludePatterns: ["(^|/|-)image", "(^|/|-)speech"]
```

多网关 + 模型级覆盖示例：

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  flavor: newapi
  # 默认网关的模型级覆写（隐藏 / 覆写 / 自定义添加）
  models:
    - id: glm-5.2
      disabled: true              # 从选择器隐藏
    - id: glm-5.2-highspeed
      contextWindow: 1000000      # 覆写上下文
      protocol: openai            # 强制协议（openai/anthropic/gemini/openai-response）
    - id: my-internal-model       # 自定义内测模型（网关未列出）
      name: 我的内测模型
      contextWindow: 200000
  # 额外网关：每个成为独立的 gateway:<id> 路由
  gateways:
    - id: litellm-prod
      label: LiteLLM 生产
      baseURL: https://litellm.example.com
      apiKeyEnv: LITELLM_API_KEY
      flavor: litellm
    - id: custom-gw
      label: 自定义网关
      baseURL: https://custom.example.com
      apiKeyEnv: CUSTOM_API_KEY
      endpointPriority: [openai-response, openai]  # 逐网关覆写
    # 完全自定义网关：三个协议地址写全，不共享基础地址。留空的协议
    # 不启用；模型发现用 OpenAI 形态地址的基础路径，只填 anthropicURL
    # 时则不做发现（仅使用手动声明的模型）。
    - id: edge
      label: 边缘网关
      flavor: custom
      openaiURL: https://edge.example.com/openai/v1/chat/completions
      responsesURL: https://edge.example.com/openai/v1/responses
      anthropicURL: https://edge.example.com/anthropic/v1/messages
      apiKeyEnv: EDGE_API_KEY
```

## 测试

```bash
cd dsh-gateway-provider
node test/smoke.mjs            # 全部：catalog/openai×2/工具调用/anthropic/gemini/custom-urls
node test/smoke.mjs --only custom-urls
node test/protocol-urls.mjs    # 离线：URL 派生 + 网关解析单元测试
node test/client-render.mjs    # 离线：设置页渲染树（中/英）
```

冒烟测试环境来源优先级：进程环境变量 → 插件目录 `.env` →
`~/Documents/dev/Agents/dsh-newapi/.env`（可用 `NEWAPI_ENV_FILE` 覆盖）。
覆盖项：网关模型列表自动发现与过滤、models.dev 参数合并（deepseek-v4-flash=
1M 上下文 / MiniMax-M3=512K）、四种 pi-ai 协议实测、工具调用往返。

## 安全说明

- API Key 只经 `$DSH_HOME/.credentials.yaml`（0600）或环境变量解析，绝不写入
  日志、配置或对话；`credential-ref` 字段在 Models 页以掩码形式编辑。
- 插件自身无 `dependencies`；`peerDependencies` 复用 harness 已装的
  `@deepseek-ai/*` 与 `@earendil-works/pi-ai`，本地检出用 `scripts/link.sh`
  保证单实例。

## License

MIT
