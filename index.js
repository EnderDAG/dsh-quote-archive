/**
 * dsh-quote-archive — a local quote library for DeepSeek Harness.
 *
 * A bundle with two halves: this host half registers the `quote` tool backed by
 * SQLite in the DSH home directory, an optional QQ channel that reuses the
 * OneBot v11 HTTP gateway that SnowLuma / qq-bridge expose (usually
 * http://127.0.0.1:3000), and read-only JSON routes for the browser panel. The
 * browser half (client.js) renders the sidebar "语录库" page.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncGroup } from './lib/collect.js';
import { createOneBotClient } from './lib/onebot.js';
import { openStore, resolveDbPath } from './lib/store.js';
import { createWebRoutes } from './lib/webapi.js';
import { createManageRoutes } from './lib/manage.js';

export const name = 'dsh-quote-archive';

/** The tool registry is the only host service this plugin needs. */
export const inject = ['tools'];

const ACTIONS = ['collect', 'recall', 'search', 'list', 'groups', 'stats', 'channel', 'sync', 'send'];

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';

const QUOTE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description:
        'Operation to run: collect/recall/search/list/groups/stats work offline; channel/sync/send need the configured QQ gateway.',
    },
    group: {
      type: 'string',
      description: 'Group id (chat id). Scope for recall/search/list, source for sync, and target for send.',
    },
    speaker: {
      type: 'string',
      description: 'Name of the person who said the quote.',
    },
    content: {
      type: 'string',
      description: 'Quote text. Required by action "collect"; at most 4000 characters.',
    },
    messageId: {
      type: 'string',
      description: 'Original IM message id. Action "collect" uses it to avoid storing the same message twice.',
    },
    tag: {
      type: 'string',
      description: 'One or more comma-separated tags, for example "funny,classic".',
    },
    query: {
      type: 'string',
      description: 'Substring matched against quote text. Used by action "search".',
    },
    limit: {
      type: 'number',
      description: 'Max quotes to return (1-50), or max messages scanned for action "sync" (1-200).',
    },
    offset: {
      type: 'number',
      description: 'Number of quotes to skip. Used by action "list".',
    },
    caption: {
      type: 'string',
      description: 'Optional text sent together with the quote image by action "send".',
    },
    download: {
      type: 'boolean',
      description: 'Action "sync": download and keep the quote images (default true).',
    },
  },
  required: ['action'],
};

const QUOTE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    action: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
  },
};

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function expandHome(value) {
  const text = readString(value);
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function readQqBridgeSnowluma(file) {
  const target = expandHome(file);
  if (!target) return {};
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    const snowluma = parsed && typeof parsed.snowluma === 'object' && !Array.isArray(parsed.snowluma) ? parsed.snowluma : {};
    return {
      httpUrl: readString(snowluma.httpUrl),
      accessToken: readString(snowluma.accessToken),
    };
  } catch {
    return {};
  }
}

function resolveConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
  const rawChannel =
    source.channel && typeof source.channel === 'object' && !Array.isArray(source.channel) ? source.channel : {};

  const bridgeConfig = readString(rawChannel.qqBridgeConfig);
  const bridge = readQqBridgeSnowluma(bridgeConfig);
  const httpUrl = readString(rawChannel.httpUrl) || bridge.httpUrl || DEFAULT_HTTP_URL;
  const accessToken = readString(rawChannel.accessToken) || bridge.accessToken || '';
  const groups = [];
  if (Array.isArray(rawChannel.groups)) {
    for (const entry of rawChannel.groups) {
      const group = String(entry ?? '').trim();
      if (group && !groups.includes(group)) groups.push(group);
    }
  }

  return {
    dbPath: readString(source.dbPath),
    channel: {
      enabled: rawChannel.enabled === true,
      httpUrl,
      accessToken,
      qqBridgeConfig: bridgeConfig,
      groups,
      autoCollect: rawChannel.autoCollect === true,
      pollIntervalSec: clamp(readNumber(rawChannel.pollIntervalSec) ?? 300, 60, 86400),
      maxMessagesPerSync: clamp(readNumber(rawChannel.maxMessagesPerSync) ?? 50, 1, 200),
      maxImageBytes: clamp(readNumber(rawChannel.maxImageBytes) ?? 10 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024),
      timeoutMs: clamp(readNumber(rawChannel.timeoutMs) ?? 15000, 1000, 120000),
    },
  };
}

function text(value) {
  return [{ type: 'text', text: value }];
}

function failed(action, error) {
  return { action: String(action || ''), ok: false, error: String(error || 'unknown error') };
}

function formatQuote(quote) {
  const details = [];
  if (quote.group) details.push(`群 ${quote.group}`);
  if (quote.speaker) details.push(`发言人 ${quote.speaker}`);
  const meta = details.length > 0 ? `（${details.join('，')}）` : '';
  const tags = Array.isArray(quote.tags) && quote.tags.length > 0 ? ` [标签：${quote.tags.join('、')}]` : '';
  const image = quote.imagePath ? ' [图片]' : '';
  return `#${quote.id}${meta}${tags}${image}\n"${quote.content}"`;
}

function formatQuoteList(quotes, shown = 5) {
  const lines = quotes.slice(0, shown).map((quote) => formatQuote(quote));
  if (quotes.length > shown) lines.push(`…仅显示前 ${shown} 条`);
  return lines.join('\n');
}

function formatSyncResult(result) {
  const parts = [
    `群 ${result.group}：扫描 ${result.scanned} 条`,
    `新增 ${result.added}`,
    `已存在 ${result.deduped}`,
    `跳过 ${result.skipped}`,
  ];
  if (result.downloaded > 0) parts.push(`下载图片 ${result.downloaded}`);
  if (result.failed > 0) {
    parts.push(`失败 ${result.failed}`);
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      parts.push(`（${result.errors[0].error}）`);
    }
  }
  return parts.join('，');
}

function renderQuoteResult(args, value) {
  const action = String(value?.action || args?.action || '').trim();
  if (!value || value.ok !== true) {
    return text(`quote(${action || '?'}) 调用失败：${value?.error || '未知错误'}`);
  }
  switch (value.action) {
    case 'collect':
      if (value.deduped) {
        return text(`该消息已收录过（#${value.id}），未重复写入。当前语录总数：${value.total}。`);
      }
      return text(`已收录语录 #${value.id}。当前语录总数：${value.total}。`);
    case 'recall':
      if (!value.quote) return text('没有符合条件的语录。');
      return text(`随机抽到一条语录：\n${formatQuote(value.quote)}`);
    case 'search':
      if (!value.quotes || value.quotes.length === 0) return text('没有匹配的语录。');
      return text(`找到 ${value.total} 条语录：\n${formatQuoteList(value.quotes)}`);
    case 'list':
      if (!value.quotes || value.quotes.length === 0) {
        return text(value.group ? `群 ${value.group} 暂无收录的语录。` : '当前语录库为空。');
      }
      return text(`共 ${value.total} 条语录：\n${formatQuoteList(value.quotes)}`);
    case 'stats': {
      const totals = value.totals || {};
      const lines = [
        `语录总数：${totals.quotes ?? 0}；群：${totals.groups ?? 0}；发言人数：${totals.speakers ?? 0}；标签：${totals.tags ?? 0}`,
      ];
      if (Array.isArray(value.groups) && value.groups.length > 0) {
        lines.push(
          `各群语录数：${value.groups
            .slice(0, 5)
            .map((row) => `${row.group || '(未标群)'}：${row.count}`)
            .join('；')}`,
        );
      }
      if (Array.isArray(value.topSpeakers) && value.topSpeakers.length > 0) {
        lines.push(
          `高产发言者：${value.topSpeakers
            .slice(0, 5)
            .map((row) => `${row.speaker}（${row.count}）`)
            .join('；')}`,
        );
      }
      return text(lines.join('\n'));
    }
    case 'groups':
      if (!Array.isArray(value.groups) || value.groups.length === 0) return text('语录库里还没有任何群。');
      return text(
        `共 ${value.total} 个群：\n${value.groups
          .slice(0, 10)
          .map((row) => `${row.group || '(未标群)'}${row.name ? `（${row.name}）` : ''}：${row.count} 条`)
          .join('\n')}`,
      );
    case 'channel': {
      if (!value.configured) {
        return text(
          'QQ 通道未启用。在插件配置里设置 channel.enabled=true，并填写 channel.httpUrl（默认 http://127.0.0.1:3000）与 channel.accessToken；也可以填 channel.qqBridgeConfig 指向 qq-bridge 的 config.json 自动读取 SnowLuma 端点。',
        );
      }
      const lines = [
        `QQ 通道：${value.reachable ? '已连接' : '未连接'}（${value.httpUrl}）`,
        `自动采集：${value.autoCollect ? '开' : '关'}；目标群：${(value.groups || []).join('、') || '未配置'}`,
      ];
      if (value.login) lines.push(`登录账号：${value.login.nickname || ''}（${value.login.userId || '未知'}）`);
      if (value.error) lines.push(`错误：${value.error}`);
      if (value.lastSync) lines.push(`最近同步：${value.lastSync.message}`);
      return text(lines.join('\n'));
    }
    case 'sync': {
      const rows = Array.isArray(value.results) ? value.results : [];
      if (rows.length === 0) return text('没有需要同步的群。');
      const failedRows = rows.filter((row) => row.failed > 0 || row.error);
      const lines = [`同步完成：新增 ${value.added ?? 0} 条语录。`];
      for (const row of rows) {
        lines.push(row.error ? `群 ${row.group}：失败（${row.error}）` : formatSyncResult(row));
      }
      if (failedRows.length > 0) lines.push('部分图片未能下载，完整错误见工具返回值。');
      return text(lines.join('\n'));
    }
    case 'send': {
      const quote = value.quote || {};
      const image = quote.imagePath ? '图片语录' : '文字语录';
      return text(`已把${image} #${quote.id} 发送到群 ${value.group}${value.sent?.messageId ? `（消息 id ${value.sent.messageId}）` : ''}。`);
    }
    default:
      return text(`quote 已完成：${JSON.stringify(value)}`);
  }
}

function buildQuoteTool(context) {
  const { getStore, getChannel, getConfig, getLastSync } = context;

  return {
    name: 'quote',
    description:
      'Archive, search, recall and post group-chat quotes stored in the local dsh-quote-archive library. QQ collection uses the OneBot v11 gateway shared with SnowLuma / qq-bridge.',
    parameters: QUOTE_PARAMETERS,
    output: {
      schema: QUOTE_OUTPUT_SCHEMA,
      render: renderQuoteResult,
    },
    execute: async (args) => {
      const action = readString(args?.action).toLowerCase();
      if (!action) return failed(action, 'action is required');
      try {
        const store = getStore();
        switch (action) {
          case 'collect': {
            const content = readString(args?.content);
            if (!content) return failed(action, 'content is required for action "collect"');
            const saved = store.addQuote({
              group: readString(args?.group),
              speaker: readString(args?.speaker),
              content,
              messageId: readString(args?.messageId),
              tag: readString(args?.tag),
            });
            return {
              action,
              ok: true,
              id: saved.id,
              deduped: saved.deduped,
              total: store.stats().totals.quotes,
            };
          }
          case 'recall': {
            const quote = store.recallQuote({
              group: readString(args?.group),
              speaker: readString(args?.speaker),
              tag: readString(args?.tag),
            });
            return { action, ok: true, quote };
          }
          case 'search': {
            const quotes = store.searchQuotes({
              query: readString(args?.query),
              group: readString(args?.group),
              speaker: readString(args?.speaker),
              tag: readString(args?.tag),
              limit: readNumber(args?.limit),
            });
            return { action, ok: true, quotes, total: quotes.length };
          }
          case 'list': {
            const quotes = store.listQuotes({
              group: readString(args?.group),
              speaker: readString(args?.speaker),
              tag: readString(args?.tag),
              limit: readNumber(args?.limit),
              offset: readNumber(args?.offset),
            });
            return {
              action,
              ok: true,
              quotes,
              total: store.stats().totals.quotes,
              group: readString(args?.group),
            };
          }
          case 'stats': {
            const summary = store.stats();
            return {
              action,
              ok: true,
              totals: summary.totals,
              groups: summary.groups,
              topSpeakers: summary.topSpeakers,
            };
          }
          case 'groups': {
            const groups = store.listGroups();
            return { action, ok: true, groups, total: groups.length };
          }
          case 'channel': {
            const channelConfig = getConfig().channel;
            let channel;
            let reachable = false;
            let login = null;
            let error = '';
            if (channelConfig.enabled) {
              try {
                channel = getChannel(true);
                const info = await channel.getLoginInfo();
                reachable = true;
                login = { userId: String(info?.user_id ?? ''), nickname: String(info?.nickname ?? '') };
              } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause);
              }
            }
            const lastSync = getLastSync();
            return {
              action,
              ok: true,
              configured: channelConfig.enabled,
              reachable,
              httpUrl: channel?.httpUrl || channelConfig.httpUrl,
              groups: channelConfig.groups,
              autoCollect: channelConfig.autoCollect,
              login,
              error,
              lastSync: lastSync
                ? {
                    message: `${lastSync.at ? new Date(lastSync.at).toLocaleString('zh-CN') : ''} ${
                      lastSync.error ? `失败：${lastSync.error}` : `新增 ${lastSync.added ?? 0} 条`
                    }`.trim(),
                  }
                : null,
            };
          }
          case 'sync': {
            const channel = getChannel(true);
            const channelConfig = getConfig().channel;
            const group = readString(args?.group);
            const targets = group ? [group] : channelConfig.groups;
            if (targets.length === 0) {
              return failed(action, '没有目标群：请传 group，或在插件配置 channel.groups 中填写群号');
            }
            const scanLimit = clamp(readNumber(args?.limit) ?? channelConfig.maxMessagesPerSync, 1, 200);
            const download = args?.download !== false;
            const results = [];
            for (const target of targets) {
              try {
                const result = await syncGroup({
                  channel,
                  store,
                  groupId: target,
                  limit: scanLimit,
                  maxImageBytes: channelConfig.maxImageBytes,
                  downloadImages: download,
                });
                results.push(result);
              } catch (cause) {
                results.push({
                  group: target,
                  scanned: 0,
                  added: 0,
                  deduped: 0,
                  skipped: 0,
                  downloaded: 0,
                  failed: 0,
                  errors: [],
                  error: cause instanceof Error ? cause.message : String(cause),
                });
              }
            }
            const added = results.reduce((sum, row) => sum + (row.added || 0), 0);
            return { action, ok: true, results, added, total: store.stats().totals.quotes };
          }
          case 'send': {
            const channel = getChannel(true);
            const channelConfig = getConfig().channel;
            const target = readString(args?.group) || channelConfig.groups[0] || '';
            if (!target) return failed(action, '没有发送目标：请传 group，或在插件配置 channel.groups 中填写群号');
            const quote = store.recallQuote({ speaker: readString(args?.speaker), tag: readString(args?.tag) });
            if (!quote) return failed(action, '语录库里没有可发送的语录');
            const caption = readString(args?.caption);
            let sent;
            if (quote.imagePath) {
              const absolute = path.join(store.imagesDir, ...String(quote.imagePath).split('/'));
              const buffer = readFileSync(absolute);
              sent = await channel.sendGroupImage(target, buffer, { caption });
            } else {
              sent = await channel.sendGroupText(target, caption || quote.content);
            }
            return {
              action,
              ok: true,
              group: target,
              quote,
              sent: { messageId: String(sent?.message_id ?? '') },
            };
          }
          default:
            return failed(action, `unknown action "${action}"; expected one of: ${ACTIONS.join(', ')}`);
        }
      } catch (error) {
        return failed(action, error instanceof Error ? error.message : error);
      }
    },
  };
}

/**
 * Mount the plugin: one tool registration, the store lifecycle hook, and — when
 * enabled — a polling collector for the configured QQ groups.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  let store;
  let channel;
  let lastSync = null;

  const getStore = () => {
    if (!store) store = openStore(resolveDbPath(config));
    return store;
  };

  const getConfig = () => config;

  const getChannel = (required = false) => {
    if (!channel && config.channel.enabled) {
      channel = createOneBotClient({
        httpUrl: config.channel.httpUrl,
        accessToken: config.channel.accessToken,
        timeoutMs: config.channel.timeoutMs,
      });
    }
    if (!channel && required) {
      throw new Error(
        'QQ 通道未启用：请在插件配置中设置 channel.enabled=true，并填写 channel.httpUrl / channel.accessToken（或 channel.qqBridgeConfig）',
      );
    }
    return channel;
  };

  const getLastSync = () => lastSync;

  const quotedChannel = {
    getGroupMsgHistory: (options) => getChannel(true).getGroupMsgHistory(options),
    getLoginInfo: () => getChannel(true).getLoginInfo(),
    getGroupList: () => getChannel(true).getGroupList(),
    getImage: (file) => getChannel(true).getImage(file),
    getMsg: (messageId) => getChannel(true).getMsg(messageId),
    sendGroupImage: (groupId, buffer, options) => getChannel(true).sendGroupImage(groupId, buffer, options),
    sendGroupText: (groupId, content) => getChannel(true).sendGroupText(groupId, content),
    get httpUrl() {
      return getChannel(true).httpUrl;
    },
  };

  ctx.effect(
    () => ctx.tools.register(
      buildQuoteTool({
        getStore,
        getChannel: (required) => getChannel(required),
        getConfig,
        getLastSync,
      }),
    ),
    'dsh-quote-archive:quote',
  );

  // The browser panel reads the archive through these same-origin JSON routes.
  // Mounted lazily so a headless composition without a web server still loads
  // the tool half instead of blocking on an absent service.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = [
        ...createWebRoutes({ getStore, getLastSync }),
        ...createManageRoutes({ getStore }),
      ];
      console.log(
        '[quote-archive] registering web routes:',
        routes.map((route) => `${route.kind} ${route.path}`).join(', '),
      );
      webCtx.effect(
        () => {
          const disposers = routes.map((route) => webCtx.webServer.register(route));
          return () => {
            for (const dispose of disposers.splice(0)) dispose();
          };
        },
        'dsh-quote-archive:web-routes',
      );
    });
  }

  ctx.effect(
    () => () => {
      const current = store;
      store = undefined;
      if (current) current.close();
    },
    'dsh-quote-archive:store',
  );

  if (config.channel.enabled && config.channel.autoCollect && config.channel.groups.length > 0) {
    ctx.effect(() => {
      let disposed = false;
      let running = false;
      const tick = async () => {
        if (disposed || running) return;
        running = true;
        try {
          const result = await syncGroup({
            channel: quotedChannel,
            store: getStore(),
            groupId: config.channel.groups[0],
            limit: config.channel.maxMessagesPerSync,
            maxImageBytes: config.channel.maxImageBytes,
            downloadImages: true,
          });
          lastSync = { at: Date.now(), added: result.added, error: '' };
          if (result.added > 0) {
            console.info(`[quote-archive] auto-collected ${result.added} quote(s) from group ${result.group}`);
          }
        } catch (error) {
          lastSync = { at: Date.now(), added: 0, error: error instanceof Error ? error.message : String(error) };
          console.warn('[quote-archive] auto-collect failed:', error instanceof Error ? error.message : error);
        } finally {
          running = false;
        }
      };
      const timer = setInterval(tick, config.channel.pollIntervalSec * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      void tick();
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    }, 'dsh-quote-archive:auto-collect');
  }
}
