# dsh-newapi-provider

> English: [README.md](README.md)

**通用 LLM 网关 Provider 插件** — 为 DeepSeek Harness 的 LLM 适配层
(`ctx.llm`) 注册一个或多个网关 provider 路由（`newapi` 默认路由 + 可选的
`gateway:<id>` 路由），支持 newapi / LiteLLM / 任意 OpenAI 兼容网关。
纯 ESM、零运行时依赖（仅 `fetch`）。无静态模型清单——一切自动发现、自动驱动：

1. **多网关同时连接** — 旧的单连接配置（`baseURL`/`apiKeyEnv` 等扁平字段）自动
   构建默认 `newapi` 路由（完全向后兼容）；新增 `gateways` 数组可挂载更多网关，
   每个成为独立的 `gateway:<id>` provider 路由，各自独立 catalog 缓存。
2. **统一网关协议 + 模型级覆盖** — 每个网关设置 `flavor`（`newapi` /
   `litellm` / `openai-compatible`）决定默认的请求协议地址模板，也可用
   `protocolPaths` 逐协议覆写完整地址；单个模型还能用 `protocol` 强制覆盖其协议。
3. **自动获取模型** — 从网关实时拉取模型列表：
   - 首选 `GET {base}/v1/models`（OpenAI 兼容，返回每个模型的
     `supported_endpoint_types` —— 即该模型"支持的请求格式"）；
   - 兜底 `GET {base}/api/user/models`（管理 API，扁平 id 列表）。
4. **models.dev 参数自动控制模型** — 用 <https://models.dev/models.json> 的
   参数（`limit.context` / `limit.output` / `reasoning` / `family` / `release_date`）
   自动补齐每个模型的 context window、输出上限、推理等级、发布日期；缺失时回退到配置默认值。
5. **模型级开关 / 覆写 / 自定义添加** — 通过自建的"网关模型"设置页（独立于官方
   Models 页），可逐模型：隐藏/显示、覆写 context/maxTokens/协议、添加网关未列出的
   自定义内测模型。设置页通过转发的 settings/llm API 读写，无需额外 RPC。
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

## 目录结构

```
dsh-newapi-provider/
├── index.js            # 插件入口：多网关 Config 校验、provider 注册、设置/凭据接线
├── cordis.patch.yml    # dsh.bundle 补丁（标准 `dsh plugin add` 可安装）
├── lib/
│   ├── gateways.js     # 协议 URL 模板（newapi/litellm/openai-compatible）+ endpoint 选择
│   ├── catalog.js      # 网关模型列表自动发现 + models.dev 合并 + 模型覆写/自定义 + TTL 缓存
│   ├── modelsdev.js    # models.dev 拉取/模糊匹配/参数提取
│   ├── thinking.js     # pi-ai 思考级别 + 变体归一化（baseModelId/variantLabel/findPiModel）
│   ├── wire.js         # endpoint 选择 + URL 拼接（向后兼容，委托 gateways.js）
│   ├── serialize.js    # harness 消息 → openai/openai-response/anthropic/gemini 请求体
│   ├── translate.js    # 各格式 SSE → harness StreamChunk
│   ├── sse.js          # 零依赖 SSE 解析器
│   ├── adapter.js      # NewapiAdapter（多网关，按 provider 解析连接）
│   └── client.js       # 客户端：自建"网关模型"设置页（settings.section）
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

### 方式二：本地源码挂载（按包名安装）

把本地检出按**包名**挂载——与本机其它正常工作的第三方插件（dsh-ssh、
dsh-web-ui-all 等）完全一致。dsh 解析一行的客户端半边（自建"网关模型"设置页）
用的是 `require.resolve('<包名>/package.json')`（以 profile 目录为基准）；
裸路径行只能贡献宿主半边，设置 UI 会静默地永远不出现——无论重启多少次。

1. `bash scripts/link.sh` — 把本包 `node_modules` 软链到 profile 的
   node_modules，保证 `@deepseek-ai/*` 裸导入解析到 harness 进程正在使用的
   同一份模块实例（单实例 `instanceof` 安全）。
2. 把检出注册为 profile 的 link 依赖并安装：

   ```bash
   cd "$DSH_HOME/profiles/web"
   # 在 package.json 的 dependencies 中追加：
   #   "dsh-newapi-provider": "link:/本包绝对路径/dsh-newapi-provider"
   pnpm install
   ```

3. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 用**包名**加一行：

   ```yaml
   - insert:
       - id: llm-newapi
         name: 'dsh-newapi-provider'
   ```

4. 重启 profile。启动图会开始提供 `/plugins/dsh-newapi-provider/client.js`，
   设置里出现自建的**网关模型**页（与官方 Models 页并存）。

客户端 bundle 改动刷新浏览器即生效（rev 为内容哈希）；宿主侧改动需要重启
profile。**不要**给 `name`（`index.js?v=3`）或内部 import 追加查询串——
那会破坏客户端半边解析，而重启本来就会重新 import 全部模块。

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
| `sortModelsByRelease` | `true` | 选择器按发布日期倒序排列（最新在上，未知日期排最前） |
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

示例（单网关，向后兼容）：

```yaml
llm-newapi:
  baseURL: https://your-newapi-instance.com
  flavor: newapi
  endpointPriority: [openai, anthropic, gemini]
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
      protocol: openai            # 强制协议
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
      protocolPaths:
        anthropic: /v1/messages   # 逐协议覆写完整地址
    - id: custom-gw
      label: 自定义网关
      baseURL: https://custom.example.com
      apiKeyEnv: CUSTOM_API_KEY
      protocolPaths:
        openai: /api/chat         # 自定义 openai 路径
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
