/**
 * dsh-quote-archive — a local quote library for DeepSeek Harness.
 *
 * A bundle with two halves: this host half registers the `quote` tool backed by
 * SQLite in the DSH home directory, an optional QQ channel that reuses the
 * OneBot v11 HTTP gateway that SnowLuma / qq-bridge expose (usually
 * http://127.0.0.1:3000), and read-only JSON routes for the browser panel. The
 * browser half (client.js) renders the sidebar "语录库" page.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncGroup } from './lib/collect.js';
import { createOneBotClient } from './lib/onebot.js';
import { openStore, resolveArchiveDir, resolveDbPath } from './lib/store.js';
import { createWebRoutes } from './lib/webapi.js';
import { createManageRoutes } from './lib/manage.js';

export const name = 'dsh-quote-archive';

/** The tool registry is the only host service this plugin needs. */
export const inject = ['tools'];

const ACTIONS = ['collect', 'recall', 'search', 'list', 'groups', 'stats', 'channel', 'sync', 'send'];

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';
const CHANNEL_FILE_NAME = 'channel.json';

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


function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function candidateQqBridgePaths(rawChannel) {
  const list = [];
  const push = (value) => {
    const file = expandHome(value);
    if (file && !list.includes(file)) list.push(file);
  };
  push(rawChannel.qqBridgeConfig);
  push('~/.qq-bridge/config.json');
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'qq-bridge', 'config.json'));
  if (process.env.USERPROFILE) push(path.join(process.env.USERPROFILE, 'qq-bridge', 'config.json'));
  push('~/qq-bridge/config.json');
  return list;
}

function readQqBridgeCandidate(file) {
  const parsed = readJsonFile(file);
  if (!parsed || typeof parsed.snowluma !== 'object' || Array.isArray(parsed.snowluma)) return null;
  const snowluma = parsed.snowluma;
  return {
    file,
    httpUrl: readString(snowluma.httpUrl),
    accessToken: readString(snowluma.accessToken),
    homeDir: readString(snowluma.homeDir),
  };
}

function candidateSnowlumaHomes(rawChannel, bridge) {
  const list = [];
  const push = (value) => {
    const dir = expandHome(value);
    if (dir && !list.includes(dir)) list.push(dir);
  };
  push(rawChannel.snowlumaHome);
  push(process.env.SNOWLUMA_HOME);
  if (bridge) push(bridge.homeDir);
  push('~/SnowLuma');
  if (process.env.USERPROFILE) push(path.join(process.env.USERPROFILE, 'SnowLuma'));
  if (process.platform === 'win32') {
    // SnowLuma is a portable app: also look for the usual layouts on every fixed drive.
    for (let code = 67; code <= 90; code += 1) {
      const drive = String.fromCharCode(code) + ':\\';
      push(path.join(drive, 'SnowLuma'));
      push(path.join(drive, 'mission', 'SnowLuma'));
      push(path.join(drive, 'tools', 'SnowLuma'));
    }
  }
  return list;
}

function readSnowlumaAccountConfig(home) {
  try {
    const configDir = path.join(home, 'config');
    if (!existsSync(configDir)) return null;
    const files = readdirSync(configDir).filter((name) => /^onebot_\d+\.json$/i.test(name));
    let best = null;
    for (const name of files) {
      const parsed = readJsonFile(path.join(configDir, name));
      const servers = parsed && parsed.networks && Array.isArray(parsed.networks.httpServers)
        ? parsed.networks.httpServers
        : parsed && Array.isArray(parsed.httpServers)
          ? parsed.httpServers
          : [];
      for (const server of servers) {
        if (!server || server.enabled === false) continue;
        const port = Number(server.port);
        if (!Number.isFinite(port) || port <= 0) continue;
        const candidate = {
          file: path.join(configDir, name),
          uin: name.replace(/^onebot_/i, '').replace(/\.json$/i, ''),
          httpUrl: `http://127.0.0.1:${Math.trunc(port)}`,
          accessToken: readString(server.accessToken),
        };
        if (!best || (!best.accessToken && candidate.accessToken)) best = candidate;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Resolve the QQ channel endpoint without network access.
 *
 * Order: explicit plugin config -> qq-bridge config file(s) -> SnowLuma account
 * config (config/onebot_<uin>.json) -> local default http://127.0.0.1:3000.
 * Returns every candidate plus the first useful one; callers probe it before
 * trusting it (see `probeChannel`).
 */
function discoverChannelConfig(rawChannel = {}) {
  const candidates = [];
  const add = (source, httpUrl, accessToken, extra = {}) => {
    const url = readString(httpUrl);
    const token = readString(accessToken);
    if (!url && !token) return;
    candidates.push({ source, httpUrl: url || DEFAULT_HTTP_URL, accessToken: token, ...extra });
  };

  const explicitHttpUrl = readString(rawChannel.httpUrl);
  const explicitToken = readString(rawChannel.accessToken);
  if (explicitHttpUrl || explicitToken) add('config', explicitHttpUrl || DEFAULT_HTTP_URL, explicitToken);

  const qqBridgeSearched = [];
  let bridge = null;
  for (const file of candidateQqBridgePaths(rawChannel)) {
    if (!existsSync(file)) continue;
    qqBridgeSearched.push(file);
    const parsed = readQqBridgeCandidate(file);
    if (!parsed) continue;
    if (!bridge) bridge = parsed;
    add('qq-bridge', parsed.httpUrl, parsed.accessToken, { file });
  }

  const snowlumaHomes = candidateSnowlumaHomes(rawChannel, bridge);
  let snowluma = null;
  for (const home of snowlumaHomes) {
    const account = readSnowlumaAccountConfig(home);
    if (!account) continue;
    snowluma = { ...account, home };
    add('snowluma', account.httpUrl, account.accessToken, { file: account.file, home, uin: account.uin });
    break;
  }

  if (candidates.length === 0) add('default', DEFAULT_HTTP_URL, '');
  const chosen = candidates[0] || { source: 'default', httpUrl: DEFAULT_HTTP_URL, accessToken: '' };
  // A saved channel.json pins httpUrl/accessToken as explicit config; keep the
  // original discovery label (e.g. "snowluma") instead of showing "config".
  const savedSource = readString(rawChannel.source);
  if (savedSource && chosen.source === 'config' && readString(rawChannel.httpUrl)) chosen.source = savedSource;
  return {
    candidates,
    chosen,
    source: chosen.source,
    httpUrl: chosen.httpUrl,
    accessToken: chosen.accessToken,
    qqBridgeConfig: qqBridgeSearched[0] || '',
    snowlumaHome: snowluma ? snowluma.home : snowlumaHomes.find((home) => existsSync(path.join(home, 'config'))) || '',
    searched: { qqBridge: qqBridgeSearched, snowlumaHomes },
  };
}

function readChannelOverride(archiveDir) {
  const parsed = readJsonFile(path.join(archiveDir, CHANNEL_FILE_NAME));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function saveChannelOverride(archiveDir, patch) {
  const file = path.join(archiveDir, CHANNEL_FILE_NAME);
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(file, JSON.stringify(patch, null, 2), 'utf8');
  return file;
}

function normalizeChannelGroups(value) {
  const groups = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const group = String(entry ?? '').trim();
      if (group && !groups.includes(group)) groups.push(group);
    }
  }
  return groups;
}

/**
 * Build the effective channel settings from the bundle config, the saved
 * `<archive>/channel.json` override, and automatic discovery.
 *
 * `enabled` is tri-state: `false` disables the channel, `true` enables it, and
 * anything else (the shipped default `"auto"`) enables it while discovery looks
 * for a gateway.
 */
function resolveConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
  const rawChannel =
    source.channel && typeof source.channel === 'object' && !Array.isArray(source.channel) ? source.channel : {};
  const dbPath = readString(source.dbPath);
  const archiveDir = resolveArchiveDir({ dbPath });
  const override = readChannelOverride(archiveDir);
  const merged = { ...rawChannel, ...override };
  const discovery = discoverChannelConfig(merged);
  const enabled = merged.enabled === false ? false : true;
  const auto = merged.enabled !== true && merged.enabled !== false;

  return {
    dbPath,
    channel: {
      enabled,
      auto,
      source: discovery.source,
      httpUrl: discovery.httpUrl,
      accessToken: discovery.accessToken,
      qqBridgeConfig: readString(merged.qqBridgeConfig) || discovery.qqBridgeConfig,
      snowlumaHome: readString(merged.snowlumaHome) || discovery.snowlumaHome,
      groups: normalizeChannelGroups(merged.groups),
      autoCollect: merged.autoCollect === true,
      pollIntervalSec: clamp(readNumber(merged.pollIntervalSec) ?? 300, 60, 86400),
      maxMessagesPerSync: clamp(readNumber(merged.maxMessagesPerSync) ?? 50, 1, 200),
      maxImageBytes: clamp(readNumber(merged.maxImageBytes) ?? 10 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024),
      timeoutMs: clamp(readNumber(merged.timeoutMs) ?? 15000, 1000, 120000),
      overridePath: path.join(archiveDir, CHANNEL_FILE_NAME),
      explicit: rawChannel,
      discovery,
    },
  };
}

async function probeChannel(httpUrl, accessToken, timeoutMs = 4000) {
  const client = createOneBotClient({ httpUrl, accessToken, timeoutMs });
  try {
    const login = await client.getLoginInfo();
    let groups = [];
    try {
      const list = await client.getGroupList();
      groups = (Array.isArray(list) ? list : []).slice(0, 300);
    } catch {
      groups = [];
    }
    return {
      reachable: true,
      login: { userId: String(login?.user_id ?? ''), nickname: String(login?.nickname ?? '') },
      groups,
      error: '',
    };
  } catch (error) {
    return {
      reachable: false,
      login: null,
      groups: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
          'QQ 通道未启用。可在管理页右下角「检测通道」一键检测并启用，或在插件配置里设置 channel.enabled=true 并填写 httpUrl / accessToken（也支持自动读取 qq-bridge 与 SnowLuma 配置）。',
        );
      }
      const lines = [
        `QQ 通道：${value.reachable ? '已连接' : '未连接'}（${value.httpUrl}${value.tokenSet ? '，令牌已配置' : ''}）`,
        `来源：${value.source || '未知'}${value.auto ? '（自动发现）' : ''}`,
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
            let reachable = false;
            let login = null;
            let error = '';
            if (channelConfig.enabled) {
              try {
                const info = await getChannel(true).getLoginInfo();
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
              auto: Boolean(channelConfig.auto),
              source: String(channelConfig.source || ''),
              reachable,
              httpUrl: String(channelConfig.httpUrl || ''),
              tokenSet: Boolean(channelConfig.accessToken),
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
  const archiveDir = resolveArchiveDir(config);
  let store;
  let channel;
  let lastSync = null;

  const getStore = () => {
    if (!store) store = openStore(resolveDbPath(config));
    return store;
  };

  const getConfig = () => config;

  const rebuildChannel = (patch) => {
    const override = { ...readChannelOverride(archiveDir), ...(patch || {}) };
    if (patch && typeof patch === 'object') saveChannelOverride(archiveDir, override);
    const discovery = discoverChannelConfig(override);
    config.channel.httpUrl = discovery.httpUrl;
    config.channel.accessToken = discovery.accessToken;
    config.channel.source = discovery.source;
    config.channel.qqBridgeConfig = readString(override.qqBridgeConfig) || discovery.qqBridgeConfig;
    config.channel.snowlumaHome = readString(override.snowlumaHome) || discovery.snowlumaHome;
    config.channel.discovery = discovery;
    if (Array.isArray(override.groups)) config.channel.groups = normalizeChannelGroups(override.groups);
    if (override.enabled === false) config.channel.enabled = false;
    else if (override.enabled === true) config.channel.enabled = true;
    channel = undefined;
    return config.channel;
  };

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
        'QQ 通道未启用：请在管理页「检测通道」一键启用，或在插件配置中设置 channel.enabled=true 并填写 channel.httpUrl / channel.accessToken（也支持自动读取 qq-bridge 与 SnowLuma 配置）',
      );
    }
    return channel;
  };

  const getLastSync = () => lastSync;

  const channelBase = () => ({ ...(config.channel.explicit || {}), ...readChannelOverride(archiveDir) });

  const discoverChannelInfo = async () => {
    const discovery = discoverChannelConfig(channelBase());
    const attempts = [];
    let best = null;
    for (const candidate of discovery.candidates.slice(0, 4)) {
      const result = await probeChannel(
        candidate.httpUrl,
        candidate.accessToken,
        Math.min(config.channel.timeoutMs, 4000),
      );
      attempts.push({
        source: candidate.source,
        httpUrl: candidate.httpUrl,
        token_set: Boolean(candidate.accessToken),
        reachable: result.reachable,
        login: result.login,
        groups: result.groups.length,
        error: result.error,
      });
      if (result.reachable) {
        best = { candidate, result };
        break;
      }
    }
    const chosen =
      (best && best.candidate) || discovery.chosen || { source: 'default', httpUrl: DEFAULT_HTTP_URL, accessToken: '' };
    return {
      channel: {
        enabled: Boolean(config.channel.enabled),
        auto: Boolean(config.channel.auto),
        source: chosen.source,
        httpUrl: chosen.httpUrl,
        token_set: Boolean(chosen.accessToken),
        reachable: Boolean(best),
        login: best ? best.result.login : null,
        groups: best ? best.result.groups.length : 0,
        error: best ? '' : (attempts[attempts.length - 1] && attempts[attempts.length - 1].error) || '未检测到可用的 OneBot 网关',
      },
      candidates: attempts,
      searched: discovery.searched,
      override_path: config.channel.overridePath,
    };
  };

  const applyChannelSettings = (patch = {}) => {
    const merged = { ...channelBase(), ...(patch || {}) };
    const discovery = discoverChannelConfig(merged);
    const chosen = discovery.chosen || { source: 'default', httpUrl: DEFAULT_HTTP_URL, accessToken: '' };
    const next = { enabled: patch.enabled !== false };
    if (next.enabled) {
      next.httpUrl = readString(patch.httpUrl) || chosen.httpUrl;
      next.accessToken = readString(patch.accessToken) || chosen.accessToken;
      if (readString(patch.snowlumaHome)) next.snowlumaHome = readString(patch.snowlumaHome);
      if (discovery.qqBridgeConfig) next.qqBridgeConfig = discovery.qqBridgeConfig;
      if (chosen.source) next.source = chosen.source;
      if (Array.isArray(patch.groups)) next.groups = normalizeChannelGroups(patch.groups);
    }
    const applied = rebuildChannel(next);
    return {
      ok: true,
      channel: {
        enabled: Boolean(applied.enabled),
        auto: Boolean(applied.auto),
        source: String(applied.source || ''),
        httpUrl: String(applied.httpUrl || ''),
        token_set: Boolean(applied.accessToken),
        groups: applied.groups,
      },
      override_path: applied.overridePath,
    };
  };

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
        ...createManageRoutes({
          getStore,
          getChannel,
          getConfig,
          getLastSync,
          discoverChannel: discoverChannelInfo,
          applyChannel: applyChannelSettings,
        }),
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

export { discoverChannelConfig, probeChannel, resolveConfig };
