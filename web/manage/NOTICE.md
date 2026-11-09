# 管理页来源与许可 / Provenance and license of the management page

`index.html`、`script.js`、`style.css` 复制自同作者的 AstrBot 插件：

- 项目：astrbot_plugin_quote_collocter（语录收集器）
- 仓库：https://github.com/EnderDAG/astrbot_plugin_quote_collocter
- 来源路径：`pages/manage/`
- 许可：AGPL-3.0

这三份文件按 AGPL-3.0 原样使用/分发，版权归原作者 enderdag 所有。本插件（dsh-quote-archive）的其余代码为 MIT；如需修改这三份文件，请注意其仍受 AGPL-3.0 约束。

`bridge.js` 是为在 DSH 中复用上述页面而新写的适配层（MIT），它把页面所用的 `window.AstrBotPluginPage` 桥接对象映射到本插件的 Node 兼容 API，不包含上述三份文件的内容。

---

The files `index.html`, `script.js` and `style.css` are copied verbatim from the
AstrBot plugin `astrbot_plugin_quote_collocter` (same author, AGPL-3.0) and remain
licensed under AGPL-3.0. Everything else in this package is MIT.

`bridge.js` is an original MIT-licensed adapter that maps the page's
`window.AstrBotPluginPage` bridge onto this plugin's Node-compatible API.
