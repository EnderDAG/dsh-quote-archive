# dsh-quote-archive

[![npm](https://img.shields.io/npm/v/dsh-quote-archive)](https://www.npmjs.com/package/dsh-quote-archive)

Local group-chat quote archive for [DeepSeek Harness](https://github.com/deepseek-ai): a `quote` tool your agent can call, and the original AstrBot management page as a sidebar “语录库” entry (library, statistics with emoji-reaction & reply-comment charts, insights, trash, people, collections, collaboration). Requires Node.js 22.13+. The QQ channel — capturing and reposting images via SnowLuma / OneBot v11, and listening for emoji-like notices over a forward WebSocket — is optional and auto-discovered from local SnowLuma or qq-bridge config files.

DeepSeek Harness 的本地群聊语录库：提供 Agent 可调用的 `quote` 工具，并把 AstrBot 版管理页（语录库 / 统计 / 数据可视化（含表情回应、引用评论图表） / 回收站 / 人物 / 专题合集 / 协作维护）作为侧栏「语录库」入口整页移植进来。需要 Node.js 22.13+；QQ 通道（经 SnowLuma / OneBot v11 采集与回发图片，并通过正向 WebSocket 接收表情回应通知）为可选功能，会自动从本机 SnowLuma 或 qq-bridge 配置文件发现网关地址与令牌。它是 AstrBot 版《语录收集器》的 DSH 姊妹项目，按「插件的插件」思路独立开发——本插件不自己登录 QQ，只负责语录域能力。

## 状态 / Status

v0.13.0：管理页 API 全量对齐。从 AstrBot 版 `main.py` 与移植页 `script.js` 反推页面真正调用的端点（56 个端点 / 58 个请求方法组合），与 DSH 兼容层逐个对齐，补齐了原先缺失的 6 个端点：`semantic/run`、`semantic/progress`、`semantic/reset`（语义任务，DSH 无向量模型→兼容占位）、`identity/cluster_merge`（形近昵称变体合并到同一人物，真实写库）、`identity/cleanup`（整理旧别名，按无别名表的实际情况返回计数）、`insights/annual_image`（年度长图，返回占位 SVG）。`identity/clusters` 由空列表升级为真实的 OCR 昵称变体聚类，`insights/annual` 返回完整 AstrBot 形状的年度报告数据（统计值为 0 并标注 `unsupported`）。所有无法真实实现的端点都不报错，而是在 JSON 响应里带 `unsupported: [...]` 与 `reason` 字段。新增 `tests/coverage.test.mjs`：直接解析 `script.js` 的 `EP` 表与全部 `apiGet/apiPost` 调用点，逐端点断言 HTTP 200 / JSON / `ok !== false` / 无 "not ported" 回退，覆盖由页面自身驱动，页面以后新增调用点而兼容层没跟上时测试会直接失败。本版没有新增配置项，`cordis.patch.yml` 保持不变。

v0.12.0：同步 AstrBot 版 v3.1.0 的「表情回应 / 引用评论」采集与统计图表——新增 `sent_quote` / `quote_reaction` / `quote_comment` 三张表（schema v8），`statistics` 响应新增向后兼容的 `reactions` 子对象，管理页新增表情回应总量、情绪分布、热门回应语录、回应者与评论者排行、回应趋势图。QQ 通道在原有 OneBot v11 HTTP 基础上新增正向 WebSocket（默认 `ws://127.0.0.1:3001`，自动从 SnowLuma `wsServers` 发现，token 可用 `channel.wsToken` 覆盖）以接收 `group_msg_emoji_like` 通知；WS 不可用时静默降级，不影响其它功能。Host 工具 + 配置 + QQ 采集/回发 + 管理页七个模块（语录库 / 统计 / 数据可视化 / 回收站 / 人物 / 专题合集 / 协作维护，AstrBot 管理页整页 iframe 移植）。QQ 通道复用 SnowLuma / qq-bridge 所使用的 OneBot v11 HTTP 网关（同一传输层），不打包、不复制 qq-bridge 的代码。管理页当前接通「语录库」（浏览、检索、删除/移动、限制级、归属、群设置）、「统计」、「数据可视化」（热力图/日历/人物时间线）、「回收站」（删除进回收站、恢复、彻底删除）、「人物」（按 QQ 归属聚合、合并/拆分、待确认名单）、「专题合集」（新建/编辑/删除合集、加入/移除语录，群内用 /合集 随机看图）；协作维护已接通（本地维护成员、邀请令牌与操作记录；DSH 单机版不提供外网协作页，邀请链接里的入口地址需要你自己填写）。年度报告需要服务端图片渲染，暂未开放。管理页右下角还有一块「DSH 快捷操作」面板：立即采集、随机抽一条、发送到群，并可直接保存自动采集开关与采集间隔（需要 QQ 通道在线）。

## 安装 / Install

需要安装了 `tools` 服务的 DSH（本机 DSH NEXT 已验证），运行时 Node 内置 `node:sqlite`，无需编译原生依赖。

**QQ 通道是可选的 / The QQ channel is optional**：不配置 SnowLuma / OneBot v11 网关时，语录库、`quote` 工具与管理页全部可用，只是不自动采集、不发送。只有在需要从 QQ 采集或回发图片时，才需要「首次使用」里的三步配置。

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-quote-archive

# 或通过 DSH 插件管理器安装本地源码包
# plugin_manager install_bundle target=/absolute/path/to/dsh-quote-archive
```

npm 包：https://www.npmjs.com/package/dsh-quote-archive

安装后工具表中会出现 `quote` 工具，侧栏会出现「语录库」入口（Web GUI 需要加载浏览器半，即 `client.js`；若热重载提示 HMR 事务冲突，重启一次 DSH 即可）。点开入口加载的是原 AstrBot 版管理页（iframe），需要 Web GUI 的 `webServer` 路由可用；无 `webServer` 的无头组合只加载工具半。

## 首次使用 / First run

让「语录库」连上 QQ 只需三步（不需要手抄 access token）：

1. 启动 SnowLuma（或任何兼容 OneBot v11 的网关），确认它的 OneBot HTTP 服务在运行（默认 `http://127.0.0.1:3000`）；
2. 刷新 DSH 界面 → 侧栏「语录库」→ 右下角「DSH 快捷操作」卡片 → 点「检测通道」；
3. 检测到账号后会自动启用并保存到本地，之后即可用「立即采集」「随机一条」「发送到群」。

插件按以下顺序自动发现通道：

1. 插件配置里显式填写的 `channel.httpUrl` / `channel.accessToken`；
2. qq-bridge 的 `config.json`：`~/.qq-bridge/config.json`、`%APPDATA%\qq-bridge\config.json`、`%USERPROFILE%\qq-bridge\config.json`，或 `channel.qqBridgeConfig` 显式指定的路径；插件读取其中的 `snowluma.httpUrl` / `snowluma.accessToken`；
3. SnowLuma 账号配置 `config/onebot_<QQ号>.json` 的 `networks.httpServers`（HTTP 地址与 token）和 `networks.wsServers`（表情回应通知用的正向 WS 地址与 token）：来自 `channel.snowlumaHome`、环境变量 `SNOWLUMA_HOME`、默认的 `~/SnowLuma` / `%USERPROFILE%\SnowLuma`，以及 Windows 各盘符根目录和其下 `mission`、`tools` 目录里的 `SnowLuma`；
4. 默认 `http://127.0.0.1:3000`。

自动找不到时（例如 SnowLuma 放在非常规目录），在快捷面板左侧输入 SnowLuma 目录（含 `config/onebot_<QQ号>.json`）后重试「检测通道」，插件会把该目录与探测结果保存到 `channel.json`。

检测结果只显示通道来源；access token 不会返回给浏览器。启用后配置保存在 `<DSH_HOME>/storages/quote-archive/channel.json`（仅本地）。把 `channel.enabled` 设为 `false` 会关闭通道；默认 `"auto"` 表示按需探测。

## 配置 / Configuration

`cordis.patch.yml` 的默认配置：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dbPath` | 空 | SQLite 文件绝对路径。留空时使用 `<DSH_HOME>/storages/quote-archive/quotes.db`，`DSH_HOME` 未设置时回退到 `~/.dsh`。 |
| `channel.enabled` | `"auto"` | 三态：`"auto"`（默认，按需自动发现并探测）、`true`（强制启用）、`false`（关闭；`channel`/`sync`/`send` 返回配置提示，其余动作完全离线可用）。 |
| `channel.httpUrl` | 空 | 留空时自动发现 SnowLuma/qq-bridge 的 OneBot HTTP 地址。 |
| `channel.accessToken` | 空 | OneBot HTTP access token（SnowLuma `accessToken`）。 |
| `channel.wsUrl` | 空 | 正向 WebSocket 地址，用于接收 `group_msg_emoji_like` 表情回应通知。留空时优先用 SnowLuma `networks.wsServers` 发现到的地址，否则按 `httpUrl` 端口 +1 推导（默认 `ws://127.0.0.1:3001/`）。 |
| `channel.wsToken` | 空 | WS access token；留空时用 SnowLuma `wsServers` 的 token，再回退到 `channel.accessToken`。SnowLuma 的 HTTP 与 WS token 可以不同。 |
| `channel.qqBridgeConfig` | 空 | 可选：指向 qq-bridge 的 `config.json`，自动读取 `snowluma.httpUrl` / `snowluma.accessToken`。 |
| `channel.groups` | `[]` | 目标群号列表；`sync` 默认同步这些群，`send` 默认发往第一个群。 |
| `channel.autoCollect` | `false` | 后台定时采集开关（需要 `enabled` 与 `groups` 同时配置）。 |
| `channel.pollIntervalSec` | `300` | 后台采集间隔，60–86400 秒。 |
| `channel.maxMessagesPerSync` | `50` | 每次每群扫描的最近消息数，1–200。 |
| `channel.maxImageBytes` | `10485760` | 单张语录图片大小上限（字节）。 |
| `channel.timeoutMs` | `15000` | 单次 OneBot HTTP 请求超时。 |

## QQ 接入 / QQ channel

DSH 版与 AstrBot 版共用同一思路：QQ 连接交给上游，本插件只做语录域能力。推荐链路：

```text
QQ → SnowLuma（OneBot v11 网关，默认 http://127.0.0.1:3000）
        ├─ qq-bridge（可选，把 QQ 消息接给 DSH agent 对话）
        └─ dsh-quote-archive（本插件，用同一 HTTP 网关采集图片语录 / 回发语录图）
```

只需要本插件的语录能力时，启动 SnowLuma 并拿到它的 HTTP 地址与 access token 即可，不必安装 qq-bridge。若已经用 qq-bridge 接入了 DSH，则把 `channel.qqBridgeConfig` 指向它的 `config.json` 就能复用同一份 SnowLuma 端点配置。

> 许可说明：qq-bridge 使用 PolyForm-Noncommercial-1.0.0，本插件不打包、不复制其代码，仅调用其同样依赖的 OneBot v11 HTTP 接口。

## 管理页 / Management page

侧栏「语录库」打开的是 AstrBot 版《语录收集器》的管理页整页移植：`web/manage/` 里的 `index.html`、`script.js`、`style.css` 保持原样，仅新增 `bridge.js` 把 `window.AstrBotPluginPage` 桥接对象适配到本插件的 Node 兼容 API，因此页面逻辑和管理交互与 AstrBot 版一致。页面在 iframe 里运行，样式和脚本与 DSH 外壳完全隔离。

已接通（基于本地图片语录库）：

- 语录库：群列表与总数/体积、分页、关键词搜索、按群筛选、图片灯箱、限制级标记；
- 统计：总量 / 群排行 / 语录趋势，以及表情回应与引用评论图表（回应总数、情绪分布、热门回应语录、回应者与评论者排行、近 30 天趋势，v0.12.0）；
- 操作：删除选中、移动到其他群、整群删除、设置归属、设置限制级；
- 群设置：mode / coldown / 自动标签 / 语义 / 回收站等字段的读写（存在 `group_settings` 表）；
- 人物筛选来自本地发言人列表；语义状态、发送队列、标签队列返回占位状态。
- API 覆盖：页面 `script.js` 里出现的全部端点（56 个 / 58 个请求方法组合）都由兼容层应答，没有 "not ported" 回退；`tests/coverage.test.mjs` 直接解析页面源码做覆盖断言（详见下文「管理页 API 对齐」）。

### 管理页 API 对齐 / Admin API parity

兼容层从 AstrBot 版 `main.py` 的 `/quote_collocter/*` 路由反推页面契约，再以本地 SQLite 能力实现。按实现程度分三类：

- **真实实现**：语录库（列表 / 搜索 / 图片 / 缩略图批取）、统计（含 `reactions` 子对象）、数据可视化（热力图 / 日历 / 人物时间线）、回收站（删除 / 恢复 / 彻底删除）、人物（聚合 / 合并 / 拆分 / 待确认名单 / **形近昵称变体聚类与合并**）、专题合集、协作维护（成员 / 令牌 / 操作记录与撤销）、设置读写。
- **兼容占位**：语义任务 `semantic/run|progress|reset`（DSH 版没有视觉模型与向量索引，返回 `task: null`、`started: false`）、别名整理 `identity/cleanup`（无别名表，返回全 0 计数）、`insights/annual` 年度报告数据（形状完整、统计为 0）、`insights/annual_image` 年度长图（返回占位 SVG，而非 AstrBot 的 PNG）、发送队列 / 标签队列 / 人物定时同步等。
- 占位响应统一带 `unsupported: [...]`（如 `["semantic_task"]`、`["annual_image"]`、`["alias_table","ocr_cluster_cleanup"]`）与 `reason` 说明，页面拿到的是可消费结构，不会 404 / 500，也不会抛异常。

验证方式：`tests/coverage.test.mjs` 解析 `web/manage/script.js` 的 `EP` 表与 `apiGet/apiPost` 调用点，对每个请求组合断言 `200 + JSON + ok !== false + 非 not ported`，再用临时库对七个模块做功能冒烟；`node tests/coverage.test.mjs` 单独运行即可。

协作维护模块说明：DSH 版是单机实现——维护成员、邀请令牌与操作记录都只写入本地 SQLite；「邀请链接」只是记录令牌并拼接你在「保存入口」里填写的协作页外网地址，本插件不会启动外网协作服务。

路由（均只允许回环地址访问；Web GUI 由 Electron 渲染进程携带原生会话 token 访问，普通浏览器直连会收到宿主门禁的 403）：

- `/quote-archive/ui`：静态页面，只服务 `index.html`、`script.js`、`style.css`、`bridge.js` 四个白名单文件；
- `/quote-archive/admin-api`：AstrBot 兼容 JSON API（overview / quotes / quotes-search / image / images-batch / settings / 删除 / 移动 / 归属 / 限制级 / 绑定等）。
- `/quote-archive/list`、`/quote-archive/image`：给旧 JSON 客户端的只读接口（保留，页面本身不用）。
- 以上路由都不在 `/api` 下：Web 载体的 connection 服务独占 `/api` 前缀做 RPC，插件路由必须另起命名空间。

页面只读写本机 SQLite 与图片目录，不访问网络。

## 表情回应 / 引用评论 / 统计图表

v0.12.0 起，管理页「统计」模块除了原有总量、群排行与语录趋势，还会显示一块「表情回应与引用评论」区域：回应总次数、引用评论总数、情绪分布环图（喜欢 / 欢乐 / 赞 / 心动 / 惊讶 / 热烈 / 伤感 / 生气 / 其他）、热门回应语录条形图、回应者与评论者排行、被引用最多的语录，以及近 30 天的回应 / 评论双线趋势图。数据来自新增的三张表，全部在本地 SQLite，零外部依赖。

采集链路（都需要 QQ 通道在线，即 SnowLuma / OneBot v11 可用）：

1. **发送回填**：每次通过 `quote` 工具的 `send` 动作或管理页「发送到群」发图时，插件保留 OneBot 响应里的 `message_id`，把「消息 ID → 群号 → 图片文件名」写入 `sent_quote`；这是后续把表情回应、引用评论关联回具体语录图片的唯一依据。
2. **表情回应**：插件用 Node 24 内置的全局 `WebSocket` 连接 SnowLuma 的正向 WS（自动发现 `wsServers`，或 `channel.wsUrl` 显式指定，token 用 `channel.wsToken`；断线按指数退避重连）。收到 `post_type: "notice"`、`notice_type: "group_msg_emoji_like"` 的通知时，按 `message_id` 命中的 `sent_quote` 记录回应者的 `emoji` 与情绪；`is_add: false` 表示取消回应，会删除对应行。`likes` 兼容数组与单个对象，`emoji_id` 兼容码点数字（如 `128077` → 👍）与 emoji 字符，FE0F 变体选择符会被归一，因此 ❤️ / ❤ 视为同一个表情。自己给自己点表情会被忽略。
3. **引用评论**：后台定时采集（或「立即采集」）扫描群历史消息时，若某条消息带 `reply` 段且被回复的 `message_id` 命中 `sent_quote`，就把它当作对该语录的引用评论，记录评论者与纯文本内容（`source: "reply"`）。图片采集逻辑不变。

已知限制 / Known limitations：

- **AI 召回多图只关联第一张**：一次发送多张语录图时，`send` 只保留返回的第一个 `message_id`，其它图片的回应/评论无法关联；
- **历史无法回填**：`sent_quote` 只记录插件启用之后发出的语录，插件安装前发出的老消息即使被回应也不会统计；
- **WS 依赖 SnowLuma**：表情回应依赖 SnowLuma 的正向 WebSocket（默认端口 3001）。qq-bridge 或其它网关若未开 WS、或 token 与 HTTP 不同且未配置 `channel.wsToken`，则回应采集静默失效（其它功能不受影响）；WS 不可用时插件不会重试报错刷屏，只是没有新回应数据；
- **评论去重窗口 30 秒**：同一用户对同一语录 30 秒内重复的相同文本回复只记一条，跨 30 秒的重复回复会分别计数（按真实评论次数统计）；
- **表情文本依赖 OneBot 实现**：不同 QQ 实现上报的 `emoji_id` 可能是码点、emoji 字符或平台专属 ID，未知 ID 归入「其他」情绪，不会丢失计数。

## 工具用法 / Tool actions

工具名 `quote`，参数 `action` 必填，其余按需：

```json
{"action": "collect", "group": "1031430106", "speaker": "小明", "content": "这个需求我熟", "messageId": "123456", "tag": "搞笑,经典"}
{"action": "recall", "group": "1031430106"}
{"action": "search", "query": "摆烂", "group": "1031430106", "limit": 10}
{"action": "list", "limit": 10, "offset": 0}
{"action": "groups"}
{"action": "stats"}
{"action": "channel"}
{"action": "sync", "group": "1031430106", "limit": 50, "download": true}
{"action": "send", "group": "1031430106", "tag": "经典", "caption": "今日份语录"}
```

- `collect`：收录一条语录；`messageId` 相同的消息只会写入一次（去重），`tag` 支持逗号分隔多个。
- `recall`：按群 / 发言人 / 标签过滤后随机抽一条。
- `search`：`query` 按内容子串匹配，可叠加群 / 发言人 / 标签过滤。
- `list`：按时间倒序分页列出，`limit` 1–50，`offset` 跳过条数。
- `groups`：列出已有群及其语录数。
- `stats`：总数、群数、发言人数、标签数，附各群语录数与高产发言者。
- `channel`：探测 QQ 通道是否可用（返回连接状态、登录账号、目标群、最近一次自动采集结果）。
- `sync`：从目标群拉取最近的图片消息入库，图片落盘、按 `message_id` 去重，可传 `download: false` 只记文字。
- `send`：按发言人 / 标签随机抽一条语录发到目标群；有图片时发图片（可带 `caption`），否则发文字。发送成功会记住 OneBot 返回的 `message_id`（写入 `sent_quote`），之后该消息收到的表情回应 / 引用评论才能关联回这张语录。

失败时返回 `{ "ok": false, "error": "..." }`，不会抛异常。

## DSH 快捷操作 / Quick actions

管理页右下角常驻一块 DSH 快捷操作面板（由 `web/manage/bridge.js` 注入，AstrBot 原页面没有这几个动作）：

- **立即采集**：对当前选中的群调用 `quote` 的采集链路（OneBot `get_group_msg_history` → 下载图片 → 去重入库），完成后显示新增条数；
- **随机一条**：从当前群的图片语录里随机抽一张并预览；
- **发送到群**：把刚抽到的语录（原图 + 可选附言）通过已配置的 QQ 通道发回选中的群；
- **自动采集**：勾选「自动采集」并填写间隔（秒，最小 60）后点「保存」，宿主会定时对选中的群执行上面的采集链路（重启后仍生效）。

面板状态每 30 秒刷新一次；QQ 通道未启用或离线时按钮会提示原因。自动采集设置在 `channel.json` 里持久化，token 不会回传给浏览器。对应的宿主接口在 `/quote-archive/admin-api/dsh/{status,random,send,sync,collect}` 路由下（仅回环可访问）。

## 数据结构 / Data model

`meta`（键值）、`groups`、`quotes`（`message_id` UNIQUE 去重，`created_at` 为 Unix 秒，`image_path` 为图片相对路径，`source` 标记来源 `local` / `qq`；schema v3 起还有 `restricted`、`rating`、`subject_user`、`subject_name` 四个管理页字段）、`tags`、`quote_tags`（多对多）、`group_settings`（管理页的群级设置 JSON）、`trash`（回收站：被删除图片的元数据 JSON 与删除时间，schema v4）、`sent_quote`（已发送语录的 `message_id`、群号与图片文件名，schema v8，保留 120 天）、`quote_reaction`（表情回应：群/文件名/用户/emoji/情绪，`UNIQUE(group_id, filename, user_id, emoji)` 保证同一用户对同一图同一表情只计一次，schema v8）、`quote_comment`（引用评论：群/文件名/用户/内容/来源，schema v8）。数据库默认启用 WAL、外键与 5s busy timeout；旧库启动时自动 ALTER 补列并建新表（迁移幂等）。

图片存放在 `<DSH_HOME>/storages/quote-archive/images/<群号>/<message_id>.<扩展名>`，数据库里只保存相对路径；删除的图片移到同目录下的 `.trash/<群号>/`，彻底删除时清理。

## 路线图 / Roadmap

- v0.1：Host 工具 + SQLite 存储（P0，已完成）
- v0.2：OneBot v11 / SnowLuma 通道，QQ 群图片语录采集与回发（已完成）
- v0.3：侧栏「语录库」页面（React 版，已被 v0.4 替换）
- v0.4：AstrBot 管理页整页 iframe 移植（已完成，先接语录库模块）
- v0.5：管理页接通知统计、数据可视化、回收站；删除改为进回收站，支持恢复与彻底删除
- v0.6：管理页接通人物模块（归属聚合、合并/拆分、待确认名单）（已完成）
- v0.7：管理页接通专题合集模块（新建/编辑/删除、加入/移除语录）；统计面板的周报设置保存到本地 meta（不推送）（已完成）
- v0.8：管理页右下角「DSH 快捷操作」面板——立即采集、随机一条、发送到群（需 QQ 通道在线）（已完成）
- v0.9：管理页接通协作维护（本地维护成员、邀请令牌、操作记录与撤销；邀请链接需自行填写协作入口地址）（已完成）
- v0.10：首次使用自动发现 SnowLuma / qq-bridge 通道，快捷面板「检测通道」一键启用（已完成）
- v0.11：快捷面板保存自动采集开关与采集间隔，宿主热重启定时器（已完成）
- v0.12：同步 AstrBot v3.1.0——表情回应（WS 通知）、引用评论采集、统计页回应图表（已完成）
- v0.13（当前）：管理页 API 全量对齐——补齐 6 个缺失端点、人物变体聚类真实化、占位端点统一 `unsupported` 标记、页面驱动式端点覆盖测试（已完成）
- 后续：标签编辑、dsh-im（`ctx.im`）通道、周报 / 年度报告图、标签与语义检索
- 发布：DSH 插件市场（P4）

## 开发 / Development

```bash
node --check index.js
node --check lib/store.js
node --check lib/reactions.js
node --check lib/onebot.js
node --check lib/collect.js
node --check lib/webapi.js
node --check lib/manage.js
node --check client.js
node --check web/manage/bridge.js
node tests/smoke.mjs       # 存储层冒烟
node tests/apply.mjs       # 插件注册 / 工具调用冒烟（伪 ctx）
node tests/onebot.test.mjs # OneBot HTTP 客户端 + 正向 WS 客户端（假 fetch / 假 WebSocket）
node tests/reactions.test.mjs # 表情回应 / 引用评论 / 统计（临时库 + schema 迁移幂等）
node tests/collect.test.mjs# 群采集与去重（假通道 + 临时库）
node tests/webapi.test.mjs  # 宿主 JSON / 图片路由（回环围栏、分页、路径越界）
node tests/manage.test.mjs # AstrBot 兼容 API 与静态管理页（分页/图片/设置/删除/统计 reactions/越界）
node tests/coverage.test.mjs # 端点覆盖（解析页面 EP + 调用点）+ 七个页面模块功能冒烟
```

以上全部由 `npm test` 串行执行。

插件采用零外部依赖：宿主半只 import `node:*` 内置模块与全局 `fetch`，浏览器半只 `require('react')`，因此从本地目录安装（pnpm link）也能直接解析。

## 许可 / License

MIT © 2026 enderdag。

例外：`web/manage/` 下的 `index.html`、`script.js`、`style.css` 复制自同作者的 AstrBot 插件 [astrbot_plugin_quote_collocter](https://github.com/EnderDAG/astrbot_plugin_quote_collocter)（AGPL-3.0），这三份文件继续以 AGPL-3.0 分发，详见 `web/manage/NOTICE.md`；本插件的其余代码仍为 MIT。
