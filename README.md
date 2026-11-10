# dsh-quote-archive

Local quote archive for [DeepSeek Harness](https://github.com/deepseek-ai). A DSH bundle that stores group-chat quotes in SQLite, exposes one `quote` tool for collecting, recalling, searching, listing, reporting on and — optionally — syncing them from QQ, and ships the original AstrBot management page as a sidebar “语录库” entry in the Web GUI.

DeepSeek Harness 的本地语录库插件：把群聊里的金句收进 SQLite，通过一个 `quote` 工具完成收录、随机抽语录、检索、列表与统计；管理页直接复用 AstrBot 版的整页 UI。它是 AstrBot 版《语录收集器》的 DSH 姊妹项目，按「插件的插件」思路独立开发——本插件不自己登录 QQ，只负责语录域能力。

## 状态 / Status

v0.5.0：Host 工具 + 配置 + QQ 采集/回发 + 管理页四个模块（语录库 / 统计 / 数据可视化 / 回收站，AstrBot 管理页整页 iframe 移植）。QQ 通道复用 SnowLuma / qq-bridge 所使用的 OneBot v11 HTTP 网关（同一传输层），不打包、不复制 qq-bridge 的代码。管理页当前接通「语录库」（浏览、检索、删除/移动、限制级、归属、群设置）、「统计」、「数据可视化」（热力图/日历/人物时间线）、「回收站」（删除进回收站、恢复、彻底删除）；其余模块（人物/合集/协作）暂未移植：导航里隐藏，直接请求时返回 `not ported`。年度报告需要服务端图片渲染，暂未开放。

## 安装 / Install

需要安装了 `tools` 服务的 DSH（本机 DSH NEXT 已验证），运行时 Node 内置 `node:sqlite`，无需编译原生依赖。

```bash
# 通过 DSH 的插件管理器（本地包绝对路径）
# plugin_manager install_bundle target=/absolute/path/to/dsh-quote-archive
```

安装后工具表中会出现 `quote` 工具，侧栏会出现「语录库」入口（Web GUI 需要加载浏览器半，即 `client.js`；若热重载提示 HMR 事务冲突，重启一次 DSH 即可）。点开入口加载的是原 AstrBot 版管理页（iframe），需要 Web GUI 的 `webServer` 路由可用；无 `webServer` 的无头组合只加载工具半。

## 配置 / Configuration

`cordis.patch.yml` 的默认配置：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dbPath` | 空 | SQLite 文件绝对路径。留空时使用 `<DSH_HOME>/storages/quote-archive/quotes.db`，`DSH_HOME` 未设置时回退到 `~/.dsh`。 |
| `channel.enabled` | `false` | 是否启用 QQ 通道。关闭时 `channel`/`sync`/`send` 会返回配置提示，其余动作完全离线可用。 |
| `channel.httpUrl` | `http://127.0.0.1:3000` | SnowLuma OneBot v11 HTTP 网关地址。 |
| `channel.accessToken` | 空 | OneBot HTTP access token（SnowLuma `accessToken`）。 |
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
- 操作：删除选中、移动到其他群、整群删除、设置归属、设置限制级；
- 群设置：mode / coldown / 自动标签 / 语义 / 回收站等字段的读写（存在 `group_settings` 表）；
- 人物筛选来自本地发言人列表；语义状态、发送队列、标签队列返回占位状态。

尚未移植的模块：人物、统计、合集、可视化、回收站、协作。它们入口在导航里隐藏，直接请求对应端点会返回 `{"ok":false,"error":"not ported: <route>"}`。后续按模块补 Node 后端即可逐步点亮。

路由（均只允许回环地址访问；Web GUI 由 Electron 渲染进程携带原生会话 token 访问，普通浏览器直连会收到宿主门禁的 403）：

- `/quote-archive/ui`：静态页面，只服务 `index.html`、`script.js`、`style.css`、`bridge.js` 四个白名单文件；
- `/quote-archive/admin-api`：AstrBot 兼容 JSON API（overview / quotes / quotes-search / image / images-batch / settings / 删除 / 移动 / 归属 / 限制级 / 绑定等）。
- `/quote-archive/list`、`/quote-archive/image`：给旧 JSON 客户端的只读接口（保留，页面本身不用）。
- 以上路由都不在 `/api` 下：Web 载体的 connection 服务独占 `/api` 前缀做 RPC，插件路由必须另起命名空间。

页面只读写本机 SQLite 与图片目录，不访问网络。

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
- `send`：按发言人 / 标签随机抽一条语录发到目标群；有图片时发图片（可带 `caption`），否则发文字。

失败时返回 `{ "ok": false, "error": "..." }`，不会抛异常。

## 数据结构 / Data model

`meta`（键值）、`groups`、`quotes`（`message_id` UNIQUE 去重，`created_at` 为 Unix 秒，`image_path` 为图片相对路径，`source` 标记来源 `local` / `qq`；schema v3 起还有 `restricted`、`rating`、`subject_user`、`subject_name` 四个管理页字段）、`tags`、`quote_tags`（多对多）、`group_settings`（管理页的群级设置 JSON）、`trash`（回收站：被删除图片的元数据 JSON 与删除时间，schema v4）。数据库默认启用 WAL、外键与 5s busy timeout；旧库启动时自动 ALTER 补列。

图片存放在 `<DSH_HOME>/storages/quote-archive/images/<群号>/<message_id>.<扩展名>`，数据库里只保存相对路径；删除的图片移到同目录下的 `.trash/<群号>/`，彻底删除时清理。

## 路线图 / Roadmap

- v0.1：Host 工具 + SQLite 存储（P0，已完成）
- v0.2：OneBot v11 / SnowLuma 通道，QQ 群图片语录采集与回发（已完成）
- v0.3：侧栏「语录库」页面（React 版，已被 v0.4 替换）
- v0.4：AstrBot 管理页整页 iframe 移植（已完成，先接语录库模块）
- v0.5（当前）：管理页接通知统计、数据可视化、回收站；删除改为进回收站，支持恢复与彻底删除
- v0.6：补齐人物、合集、协作模块的 Node 后端，以及页面内随机抽语录 / 发送到群 / 标签编辑、按群自动采集配置
- 后续：dsh-im（`ctx.im`）通道、周报 / 年度报告图、标签与语义检索
- 发布：DSH 插件市场（P4）

## 开发 / Development

```bash
node --check index.js
node --check lib/store.js
node --check lib/onebot.js
node --check lib/collect.js
node --check lib/webapi.js
node --check lib/manage.js
node --check client.js
node --check web/manage/bridge.js
node tests/smoke.mjs       # 存储层冒烟
node tests/apply.mjs       # 插件注册 / 工具调用冒烟（伪 ctx）
node tests/onebot.test.mjs # OneBot HTTP 客户端（假 fetch）
node tests/collect.test.mjs# 群采集与去重（假通道 + 临时库）
node tests/webapi.test.mjs  # 宿主 JSON / 图片路由（回环围栏、分页、路径越界）
node tests/manage.test.mjs # AstrBot 兼容 API 与静态管理页（分页/图片/设置/删除/越界）
```

插件采用零外部依赖：宿主半只 import `node:*` 内置模块与全局 `fetch`，浏览器半只 `require('react')`，因此从本地目录安装（pnpm link）也能直接解析。

## 许可 / License

MIT © 2026 enderdag。

例外：`web/manage/` 下的 `index.html`、`script.js`、`style.css` 复制自同作者的 AstrBot 插件 [astrbot_plugin_quote_collocter](https://github.com/EnderDAG/astrbot_plugin_quote_collocter)（AGPL-3.0），这三份文件继续以 AGPL-3.0 分发，详见 `web/manage/NOTICE.md`；本插件的其余代码仍为 MIT。
