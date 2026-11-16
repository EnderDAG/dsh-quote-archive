/**
 * dsh-quote-archive — host side of the ported AstrBot management page.
 *
 * Serves the original quote_collocter admin page (HTML/CSS/JS copied under
 * `web/manage/`) and a small AstrBot-compatible JSON API under
 * `/quote-archive/admin-api`. Routes deliberately live outside `/api`: the
 * Web carrier's connection service owns that prefix for RPC. Only the "quotes library" module is
 * wired up; every other endpoint answers `{ok:false,error:'not ported: …'}`
 * so the page degrades gracefully.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { syncGroup } from './collect.js';
import { annualFileName, annualImageDataUrl, buildAnnualSvg } from './annual.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web', 'manage');

export const ROUTES = {
  page: '/quote-archive/ui',
  api: '/quote-archive/admin-api',
  diag: '/quote-archive/diag',
};

const STATIC_FILES = {
  'index.html': 'text/html; charset=utf-8',
  'script.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'bridge.js': 'text/javascript; charset=utf-8',
};

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const DEFAULT_SETTINGS = {
  mode: 1,
  coldown: 60,
  poke_prob: 0.05,
  remember: true,
  recall: true,
  auto_recall: false,
  auto_tag: true,
  trash_keep_days: 30,
  alias_learn: true,
  alias_learn_every: 40,
  auto_semantic: true,
  auto_semantic_hours: 24,
  auto_rating: true,
  allow_restricted: false,
};

const SETTINGS_KEYS = [
  'mode',
  'coldown',
  'poke_prob',
  'remember',
  'recall',
  'auto_recall',
  'auto_tag',
  'trash_keep_days',
  'alias_learn',
  'alias_learn_every',
  'auto_semantic',
  'auto_semantic_hours',
  'auto_rating',
  'allow_restricted',
];

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  return (
    value === '' ||
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '[::1]' ||
    value.startsWith('127.0.0.1:') ||
    value.startsWith('localhost:') ||
    value.startsWith('[::1]:')
  );
}

function isLoopbackSocket(socket) {
  const address = String(socket?.remoteAddress || '');
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('invalid JSON body: ' + error.message));
      }
    });
    req.on('error', reject);
  });
}

function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function imageAbsolutePath(store, quote) {
  if (!quote || !quote.imagePath) return '';
  const root = path.resolve(store.imagesDir);
  const target = path.resolve(root, ...quote.imagePath.split('/'));
  if (target !== root && !target.startsWith(root + path.sep)) return '';
  return target;
}

function imageMime(file) {
  return IMAGE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function dataUrlForFile(file) {
  try {
    const buffer = readFileSync(file);
    return `data:${imageMime(file)};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

function basenameOf(imagePath) {
  return String(imagePath || '').split('/').pop() || '';
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(file);
      else if (entry.isFile()) total += statSync(file).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}


function trashRoot(store) {
  return path.join(store.imagesDir, '.trash');
}

function pathUnder(root, relPath) {
  const target = path.resolve(root, ...String(relPath || '').split('/'));
  if (target !== root && !target.startsWith(root + path.sep)) return '';
  return target;
}

function moveFileToTrash(store, imagePath) {
  const source = pathUnder(store.imagesDir, imagePath);
  const target = pathUnder(trashRoot(store), imagePath);
  if (!source || !target) return false;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(source, target);
    return true;
  } catch {
    return false;
  }
}

function moveFileFromTrash(store, imagePath) {
  const source = pathUnder(trashRoot(store), imagePath);
  const target = pathUnder(store.imagesDir, imagePath);
  if (!source || !target) return false;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target)) unlinkSync(target);
    renameSync(source, target);
    return true;
  } catch {
    return false;
  }
}

function removeTrashedFile(store, imagePath) {
  const target = pathUnder(trashRoot(store), imagePath);
  if (!target) return;
  try {
    unlinkSync(target);
  } catch {
    /* ignore */
  }
}

function quoteToItem(quote) {
  return {
    name: basenameOf(quote.imagePath),
    size: fileSize(quote.__file || ''),
    ts: Number(quote.createdAt) || 0,
    user_id: '',
    nickname: quote.speaker || '',
    speaker: quote.speaker || '',
    message_id: '',
    caption: quote.content && quote.content !== '[图片语录]' ? quote.content : '',
    tags: quote.tags || [],
    tone: '',
    semantic_text: '',
    semantic_status: 'pending',
    has_vector: false,
    subject_user_id: quote.subjectUser || '',
    subject_name: quote.subjectName || '',
    subject_source: quote.subjectUser || quote.subjectName ? 'manual' : '',
    restricted: quote.restricted ? 1 : 0,
    rating_source: quote.rating > 0 ? 'auto' : '',
  };
}

function withFiles(store, items) {
  return items.map((quote) => ({ ...quote, __file: imageAbsolutePath(store, quote) }));
}

// ---------------------------------------------------------------------- //
// Local semantic index runner (v0.16.0).
//
// AstrBot's edition runs a vision + embedding job. The DSH edition has no
// models, so `semantic/run` just builds the local BM25 index in small
// setImmediate batches to keep the event loop responsive while still exposing
// the same task state the management page polls.
// ---------------------------------------------------------------------- //

const SEMANTIC_BATCH_SIZE = 20;

function blankSemanticTask() {
  return {
    running: false,
    scope: 'pending',
    groups: [],
    total: 0,
    processed: 0,
    ok: 0,
    failed: 0,
    current: '',
    started_at: 0,
    finished_at: 0,
    error: '',
    cancel_requested: false,
    provider: {},
  };
}

let semanticTask = blankSemanticTask();
let semanticTimer = null;

function semanticTaskState() {
  return { ...semanticTask, running: Boolean(semanticTask.running) };
}

function finishSemanticTask() {
  if (semanticTimer) {
    clearImmediate(semanticTimer);
    semanticTimer = null;
  }
  semanticTask.running = false;
  semanticTask.current = '';
  semanticTask.finished_at = Math.floor(Date.now() / 1000);
}

/**
 * Start indexing in the background.
 * @returns {{ok:boolean, started?:boolean, error?:string, task:object}}
 */
function startSemanticTask(store, { group = '', scope = 'pending' } = {}) {
  if (semanticTask.running) {
    return { ok: false, error: '已有一个语义化任务在运行中，请等待完成或先取消', task: semanticTaskState() };
  }
  const plan = store.semanticPlan({ group, scope });
  const provider = store.semanticProvider();
  semanticTask = {
    ...blankSemanticTask(),
    running: true,
    scope: plan.scope,
    groups: plan.groups,
    total: plan.targets.length,
    started_at: Math.floor(Date.now() / 1000),
    provider: provider.embedding,
  };
  const targets = plan.targets;
  let cursor = 0;
  const step = () => {
    semanticTimer = null;
    if (!semanticTask.running) return;
    if (semanticTask.cancel_requested) {
      finishSemanticTask();
      return;
    }
    if (cursor >= targets.length) {
      semanticTask.processed = semanticTask.total;
      finishSemanticTask();
      return;
    }
    const batch = targets.slice(cursor, cursor + SEMANTIC_BATCH_SIZE);
    cursor += batch.length;
    try {
      const result = store.semanticIndex(batch);
      semanticTask.ok += Number(result.indexed || 0);
      semanticTask.failed += Number(result.failed || 0);
      if (!semanticTask.error && Array.isArray(result.errors) && result.errors.length) {
        semanticTask.error = String(result.errors[0]);
      }
    } catch (error) {
      semanticTask.failed += batch.length;
      if (!semanticTask.error) semanticTask.error = error instanceof Error ? error.message : String(error);
    }
    semanticTask.processed = Math.min(semanticTask.total, cursor);
    semanticTask.current = `#${batch[batch.length - 1].quoteId}`;
    if (semanticTask.cancel_requested) {
      finishSemanticTask();
      return;
    }
    semanticTimer = setImmediate(step);
  };
  semanticTimer = setImmediate(step);
  return { ok: true, started: true, task: semanticTaskState() };
}

function cancelSemanticTask() {
  const wasRunning = Boolean(semanticTask.running);
  semanticTask.cancel_requested = true;
  if (wasRunning) finishSemanticTask();
  return { ok: true, cancelled: wasRunning, task: semanticTaskState() };
}

function normalizeGroupList(store) {
  return store.imageGroups().map((row) => {
    const settings = store.getGroupSettings(row.group) || {};
    return {
      group_id: row.group,
      count: row.count,
      latest_ts: row.latestTs,
      settings: { mode: Number(settings.mode ?? DEFAULT_SETTINGS.mode) },
    };
  });
}

function loadSettings(store, groupId) {
  const settings = store.getGroupSettings(groupId);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export function createManageRoutes({
  getStore,
  getChannel,
  getSender,
  getTransportStatus,
  getConfig,
  getLastSync,
  discoverChannel,
  applyChannel,
  applyCollect,
  getCollect,
} = {}) {
  function pageHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    }
    const raw = String(req.url || '/').split('?')[0].split('#')[0];
    const prefix = ROUTES.page;
    // The host may pass the full request path or a prefix-relative path.
    const rel = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw.replace(/^\/+/, '');
    const file = rel.replace(/^\/+/, '') || 'index.html';
    console.log('[quote-archive] page request', req.method, raw, '->', file);
    if (!Object.prototype.hasOwnProperty.call(STATIC_FILES, file)) {
      return writeJson(res, 404, { ok: false, error: 'not found' });
    }
    try {
      const buffer = readFileSync(path.join(WEB_DIR, file));
      res.writeHead(200, {
        'content-type': STATIC_FILES[file],
        'content-length': String(buffer.length),
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : buffer);
    } catch (error) {
      writeJson(res, 500, { ok: false, error: String(error.message || error) });
    }
  }

  async function apiHandler(req, res) {
    if (!isLoopbackSocket(req.socket) || !isLoopbackHost(req.headers.host)) {
      return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
    }
    const store = getStore();
    const raw = String(req.url || '/');
    const prefix = ROUTES.api;
    // The host may pass the full request path or a prefix-relative path.
    const relWithQuery = raw.startsWith(prefix)
      ? raw.slice(prefix.length)
      : raw.replace(/^\/+/, '');
    const [rel, queryString = ''] = relWithQuery.split('?');
    const route = rel.replace(/^\/+|\/+$/g, '');
    const query = new URLSearchParams(queryString);
    console.log('[quote-archive] api request', req.method, raw, '->', route);
    if (!route) return writeJson(res, 404, { ok: false, error: 'not found' });
    try {
      if (route.startsWith('dsh/')) {
        const dshBody = req.method === 'POST' ? await readBody(req) : null;
        const handled = await handleDsh(store, route, req.method, query, dshBody, {
          getChannel,
          getSender,
          getTransportStatus,
          getConfig,
          getLastSync,
          discoverChannel,
          applyChannel,
          applyCollect,
          getCollect,
        });
        return writeJson(res, 200, handled);
      }
      if (req.method === 'GET') {
        const handled = handleGet(store, route, query);
        if (handled) return writeJson(res, 200, handled);
        return writeJson(res, 200, { ok: false, error: `not ported: ${route}` });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const handled = handlePost(store, route, body);
        if (handled) return writeJson(res, 200, handled);
        return writeJson(res, 200, { ok: false, error: `not ported: ${route}` });
      }
      return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String(error.message || error) });
    }
  }

  function diagHandler(req, res) {
    const raw = String(req.url || '/');
    console.log('[quote-archive] diag', req.method, raw.slice(0, 800));
    return writeJson(res, 200, { ok: true });
  }

  return [
    { kind: 'prefix', path: ROUTES.page, handler: pageHandler },
    { kind: 'exact', path: ROUTES.diag, handler: diagHandler },
    {
      kind: 'prefix',
      path: ROUTES.api,
      handler: (req, res) => {
        void apiHandler(req, res);
      },
    },
  ];
}


/**
 * Handlers for the DSH-only quick actions that bridge.js adds to the page.
 *
 * The AstrBot page has no concept of "sync now" or "send to QQ"; those are DSH
 * capabilities, so they live in the same admin API under the `dsh/*` namespace.
 */
async function handleDsh(store, route, method, query, body, context = {}) {
  const getChannel = context.getChannel;
  const getSender = context.getSender;
  const getTransportStatus = context.getTransportStatus;
  const config = typeof context.getConfig === 'function' ? context.getConfig() : null;
  const channelConfig = (config && config.channel) || {};
  if (typeof getChannel !== 'function' && typeof getSender !== 'function') {
    return { ok: false, error: 'QQ 通道依赖不可用（当前宿主未提供 getChannel）' };
  }
  const discoverChannel = context.discoverChannel;
  const applyChannel = context.applyChannel;
  const applyCollect = context.applyCollect;
  const getCollect = context.getCollect;
  const queryGroup = String((query && query.get('group_id')) || '').trim();
  const bodyGroup = String((body && body.group_id) || '').trim();
  const groupId = bodyGroup || queryGroup;
  const groups = Array.isArray(channelConfig.groups) ? channelConfig.groups.map(String) : [];

  if (route === 'dsh/status') {
    let reachable = false;
    let login = null;
    let groupList = [];
    let error = '';
    if (channelConfig.enabled) {
      try {
        const channel = getChannel(true);
        login = await channel.getLoginInfo();
        reachable = true;
        try {
          const list = await channel.getGroupList();
          groupList = (Array.isArray(list) ? list : []).slice(0, 300);
        } catch (cause) {
          groupList = [];
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    } else {
      error = 'QQ 通道未启用';
    }
    const totals = store.stats().totals;
    const transport = typeof getTransportStatus === 'function' ? getTransportStatus() : null;
    return {
      ok: true,
      channel: {
        enabled: Boolean(channelConfig.enabled),
        reachable,
        httpUrl: String(channelConfig.httpUrl || ''),
        groups,
        group_list: groupList,
        source: String(channelConfig.source || ''),
        auto: Boolean(channelConfig.auto),
        token_set: Boolean(channelConfig.accessToken),
        driver: (transport && transport.active) || String(channelConfig.driver || ''),
        login,
        error,
      },
      transport,
      collect: typeof getCollect === 'function' ? getCollect() : null,
      archive: { quotes: totals.quotes, groups: totals.groups },
    };
  }

  if (route === 'dsh/discover' && method === 'GET') {
    if (typeof discoverChannel !== 'function') {
      return { ok: false, error: '当前宿主不支持自动检测 QQ 通道' };
    }
    return { ok: true, ...(await discoverChannel()) };
  }

  if (route === 'dsh/enable' && method === 'POST') {
    if (typeof applyChannel !== 'function') {
      return { ok: false, error: '当前宿主不支持保存 QQ 通道配置' };
    }
    const patch = { enabled: true };
    if (body && typeof body.httpUrl === 'string' && body.httpUrl.trim()) patch.httpUrl = body.httpUrl.trim();
    if (body && Array.isArray(body.groups)) patch.groups = body.groups;
    const info = typeof discoverChannel === 'function' ? await discoverChannel() : null;
    if (info && !info.channel.reachable && !patch.httpUrl) {
      return { ok: false, error: info.channel.error || '未检测到可用的 OneBot 网关', discovery: info };
    }
    const applied = await applyChannel(patch);
    return { ok: true, ...applied, discovery: info || null };
  }

  if (route === 'dsh/disable' && method === 'POST') {
    if (typeof applyChannel !== 'function') {
      return { ok: false, error: '当前宿主不支持保存 QQ 通道配置' };
    }
    return { ok: true, ...(await applyChannel({ enabled: false })) };
  }

  if (route === 'dsh/collect' && method === 'POST') {
    if (typeof applyCollect !== 'function') {
      return { ok: false, error: '当前宿主不支持保存采集设置' };
    }
    const patch = {};
    if (body && typeof body.autoCollect === 'boolean') patch.autoCollect = body.autoCollect;
    if (body && body.pollIntervalSec !== undefined) patch.pollIntervalSec = Number(body.pollIntervalSec);
    if (body && typeof body.group === 'string' && body.group.trim()) patch.groups = [body.group.trim()];
    if (Object.keys(patch).length === 0) return { ok: false, error: '没有可保存的采集设置' };
    return applyCollect(patch);
  }

  if (route === 'dsh/random' && method === 'GET') {
    let quote = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      quote = store.recallQuote({ group: groupId || undefined });
      if (!quote || quote.imagePath) break;
    }
    if (!quote) return { ok: false, error: '语录库里还没有可抽取的语录' };
    const payload = {
      id: quote.id,
      group_id: String(quote.group || ''),
      speaker: String(quote.speaker || ''),
      caption: quote.content && quote.content !== '[图片语录]' ? String(quote.content) : '',
      ts: Number(quote.createdAt) || 0,
    };
    if (quote.imagePath) payload.name = basenameOf(quote.imagePath);
    return { ok: true, quote: payload };
  }

  if (route === 'dsh/send' && method === 'POST') {
    const id = Number((body && body.quote_id) || 0);
    const quote = Number.isInteger(id) && id > 0 ? store.getQuote(id) : null;
    if (!quote) return { ok: false, error: '找不到要发送的语录' };
    const target = groupId || groups[0] || '';
    if (!target) return { ok: false, error: '没有发送目标：请选择群或在插件配置 channel.groups 中填写群号' };
    const caption = String((body && body.caption) || '').trim();
    let sent;
    try {
      const channel = typeof getSender === 'function' ? getSender() : getChannel(true);
      if (quote.imagePath) {
        const absolute = path.join(store.imagesDir, ...String(quote.imagePath).split('/'));
        const buffer = readFileSync(absolute);
        sent = await channel.sendGroupImage(target, buffer, caption ? { caption } : undefined);
      } else {
        sent = await channel.sendGroupText(target, caption || quote.content);
      }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    const messageId = String((sent && sent.message_id) || '');
    // Keep the QQ message id so emoji-like notices and reply comments can be
    // mapped back to this archived image (see lib/reactions.js).
    if (messageId && quote.imagePath) {
      try {
        store.recordSentQuote({ messageId, groupId: target, filename: basenameOf(quote.imagePath) });
      } catch {
        // Best effort: sending succeeded, the association is secondary.
      }
    }
    return {
      ok: true,
      group_id: target,
      quote: { id: quote.id },
      message_id: messageId,
    };
  }

  if (route === 'dsh/sync' && method === 'POST') {
    const targets = groupId ? [groupId] : groups;
    if (targets.length === 0) {
      return { ok: false, error: '没有目标群：请选择群或在插件配置 channel.groups 中填写群号' };
    }
    let channel;
    try {
      channel = getChannel(true);
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    const limit = Math.min(200, Math.max(1, Number(channelConfig.maxMessagesPerSync) || 50));
    const maxImageBytes = Number(channelConfig.maxImageBytes) || 10 * 1024 * 1024;
    const results = [];
    for (const target of targets) {
      try {
        results.push(await syncGroup({ channel, store, groupId: target, limit, maxImageBytes, downloadImages: true }));
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
    const added = results.reduce((sum, row) => sum + Number(row.added || 0), 0);
    return { ok: true, results, added, total: store.stats().totals.quotes };
  }

  return { ok: false, error: `not ported: ${route}` };
}

function handleGet(store, route, query) {
  const groupId = String(query.get('group_id') || '').trim();
  switch (route) {
    case 'overview': {
      const groups = normalizeGroupList(store);
      const totalQuotes = groups.reduce((sum, group) => sum + Number(group.count || 0), 0);
      let totalBytes = 0;
      for (const group of groups) totalBytes += dirSize(path.join(store.imagesDir, group.group_id));
      return {
        ok: true,
        groups,
        data_root: store.imagesDir,
        thumbnail: false,
        total_quotes: totalQuotes,
        total_bytes: totalBytes,
      };
    }
    case 'quotes':
    case 'quotes/search': {
      const page = Number(query.get('page') || 1);
      const pageSize = Number(query.get('page_size') || 48);
      const effectivePageSize = Math.min(200, Math.max(6, Number.isFinite(pageSize) ? pageSize : 48));
      const mode = String(query.get('mode') || 'browse').trim();
      const keyword = String(query.get('q') || '').trim();
      if (mode === 'semantic' && keyword) {
        const assigned = String(query.get('assigned') || '').trim();
        const restricted = String(query.get('restricted') || '').trim();
        const rawMinScore = Number(query.get('min_score') || 0);
        const found = store.semanticSearch({
          group: groupId,
          q: keyword,
          limit: 1000,
          minScore: Number.isFinite(rawMinScore) ? rawMinScore : 0,
        });
        let filtered = found.items;
        if (assigned === '1') filtered = filtered.filter((quote) => quote.subjectName);
        else if (assigned === '0') filtered = filtered.filter((quote) => !quote.subjectName);
        if (restricted === '1') filtered = filtered.filter((quote) => quote.restricted);
        else if (restricted === '0') filtered = filtered.filter((quote) => !quote.restricted);
        const start = (Math.max(1, page) - 1) * effectivePageSize;
        const items = filtered.slice(start, start + effectivePageSize).map((quote) => {
          const item = quoteToItem(quote);
          item.semantic_status = 'done';
          item.has_vector = true;
          item.semantic_text = String(quote.semanticText || '').slice(0, 600);
          item.score = quote.score;
          return item;
        });
        const preferred = store.preferredNames({ group: groupId });
        for (const item of items) {
          const alias = item.subject_user_id ? preferred.get(item.subject_user_id) : '';
          if (alias) item.subject_name = alias;
        }
        return {
          ok: true,
          items,
          total: filtered.length,
          pages: Math.max(1, Math.ceil(filtered.length / effectivePageSize)),
          page: Math.max(1, page),
          page_size: effectivePageSize,
          total_bytes: dirSize(path.join(store.imagesDir, groupId)),
          mode: 'semantic',
          terms: found.terms,
        };
      }
      const result = store.listImageQuotes({
        group: groupId,
        page,
        pageSize,
        sort: String(query.get('sort') || 'new'),
        q: String(query.get('q') || '').trim(),
        tag: String(query.get('tag') || '').trim(),
        assigned: String(query.get('assigned') || '').trim(),
        restricted: String(query.get('restricted') || '').trim(),
        speaker: String(query.get('person_id') || '').trim(),
        fromTs: Number(query.get('from_ts') || 0),
      });
      const items = withFiles(store, result.items).map((quote) => quoteToItem(quote));
      const preferred = store.preferredNames({ group: groupId });
      for (const item of items) {
        const alias = item.subject_user_id ? preferred.get(item.subject_user_id) : '';
        if (alias) item.subject_name = alias;
      }
      return {
        ok: true,
        items,
        total: result.total,
        pages: Math.max(1, Math.ceil(result.total / effectivePageSize)),
        page: Math.max(1, page),
        page_size: effectivePageSize,
        total_bytes: dirSize(path.join(store.imagesDir, groupId)),
        mode: 'browse',
      };
    }
    case 'image': {
      const name = String(query.get('name') || '').trim();
      const quote = store.findImageQuote(groupId, name);
      if (!quote) return { ok: false, error: 'not found' };
      const dataUrl = dataUrlForFile(imageAbsolutePath(store, quote));
      if (!dataUrl) return { ok: false, error: '找不到图片文件' };
      return { ok: true, data_url: dataUrl };
    }
    case 'images/batch': {
      const names = String(query.get('names') || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 15);
      const items = {};
      for (const name of names) {
        const quote = store.findImageQuote(groupId, name);
        if (!quote) continue;
        const dataUrl = dataUrlForFile(imageAbsolutePath(store, quote));
        if (dataUrl) items[name] = dataUrl;
      }
      return { ok: true, items };
    }
    case 'settings':
      return { ok: true, ...loadSettings(store, groupId) };
    case 'semantic/status': {
      const provider = store.semanticProvider();
      const stats = store.semanticStatus({ group: groupId });
      return {
        ok: true,
        embedding: provider.embedding,
        signature: provider.signature,
        caption_provider_id: provider.captionProviderId,
        ready: true,
        concurrency: 1,
        min_score: 0,
        totals: stats.totals,
        groups: stats.groups,
        task: semanticTaskState(),
      };
    }
    case 'sent':
      return { ok: true, total: 0, pending: 0, max_age: 21600, keep: 5 };
    case 'semantic/progress':
      return { ok: true, task: semanticTaskState() };
    case 'tag/queue':
      return { ok: true, paused: false, pending: 0, done: 0, failed: 0, running: false };
    case 'identity/list':
      return {
        ok: true,
        ...store.identityList({
          group: groupId,
          q: String(query.get('q') || '').trim(),
          page: Number(query.get('page') || 1),
          pageSize: Number(query.get('page_size') || 60),
        }),
      };
    case 'identity/overview':
      return { ok: true, ...store.identityOverview() };
    case 'identity/detail': {
      const personId = String(query.get('person_id') || query.get('pid') || '').trim();
      if (!personId) return { ok: false, error: 'person_id required' };
      return store.identityDetail(personId);
    }
    case 'identity/schedule':
      return {
        ok: true,
        enabled: false,
        interval_hours: 24,
        last_sync_at: 0,
        next_sync_at: 0,
        last_result: {},
      };
    case 'alias/candidates': {
      const status = String(query.get('status') || 'pending').trim() || 'pending';
      const limit = Number(query.get('limit') || 100) || 100;
      const items = store.listAliasCandidates({ group: groupId, status, limit });
      return { ok: true, group_id: groupId, status, total: items.length, items };
    }
    case 'identity/aliases': {
      const userId = String(query.get('user_id') || '').trim();
      return { ok: true, user_id: userId, items: store.aliasesForUser(userId) };
    }
    case 'identity/clusters':
      return store.identityClusters({ group: groupId, limit: Number(query.get('limit') || 40) });
    case 'quotes/review':
      return { ok: true, ...store.identityReview() };
    case 'collections': {
      const collectionId = String(query.get('collection_id') || '').trim();
      const collections = store.listCollections(groupId);
      if (!collectionId) return { ok: true, collections };
      const collection = store.getCollection(groupId, collectionId);
      if (!collection) return { ok: false, error: 'collection not found' };
      return { ok: true, collections, collection };
    }
    case 'weekly': {
      const saved = store.getMeta('weekly_settings') || {};
      const settings = {
        enabled: Boolean(saved.enabled),
        weekday: Number(saved.weekday ?? 1),
        hour: Number(saved.hour ?? 9),
        groups: Array.isArray(saved.groups) ? saved.groups.map(String) : [],
        last_week: String(saved.last_week || ''),
      };
      const groups = store.imageGroups().map((row) => String(row.group));
      return { ok: true, settings, groups, previews: {}, week_label: '' };
    }
    case 'trash': {
      return { ok: true, ...store.listTrash(groupId) };
    }
    case 'statistics': {
      const top = Math.max(1, Math.min(50, Number(query.get('top') || 10)));
      const days = Math.max(1, Math.min(90, Number(query.get('days') || 30)));
      const data = store.manageStatistics({ group: groupId, top, days });
      let bytes = 0;
      for (const group of data.groups) {
        group.bytes = dirSize(path.join(store.imagesDir, String(group.group_id)));
        bytes += group.bytes;
      }
      data.totals.bytes = bytes;
      // Emoji reactions and reply comments (AstrBot v3.1.0 statistics shape).
      // Kept in a nested object so the legacy top-level fields stay untouched.
      try {
        data.reactions = store.reactionStats({
          group: groupId,
          top: Math.max(3, Math.min(10, Number(query.get('top') || 10))),
          trendDays: 30,
        });
      } catch {
        data.reactions = {};
      }
      data.generated_at = Math.floor(Date.now() / 1000);
      return { ok: true, ...data };
    }
    case 'insights/heatmap':
      return { ok: true, ...store.insightsHeatmap({ group: groupId, days: Number(query.get('days') || 365) }) };
    case 'insights/timeline':
      return {
        ok: true,
        ...store.insightsTimeline({ pid: String(query.get('pid') || ''), group: groupId }),
      };
    case 'insights/annual': {
      // Real yearly report, field-for-field compatible with AstrBot v3.1.0.
      const pid = String(query.get('pid') || query.get('person_id') || '').trim();
      const year = Number(query.get('year') || 0) || 0;
      return { ok: true, ...store.annualReport({ pid, year, group: groupId }) };
    }
    case 'insights/annual_image': {
      // Real poster: pure-JS SVG rendered from the same report data.
      const pid = String(query.get('pid') || query.get('person_id') || '').trim();
      const year = Number(query.get('year') || 0) || 0;
      const report = store.annualReport({ pid, year, group: groupId });
      const svg = buildAnnualSvg(report);
      return {
        ok: true,
        filename: annualFileName(report.year),
        image: annualImageDataUrl(svg),
        report: {
          pid: report.pid,
          person_id: report.person_id,
          year: report.year,
          display_name: report.display_name,
          total: report.total,
          share: report.share,
          rank: report.rank,
          ranked_total: report.ranked_total,
          group_total: report.group_total,
        },
      };
    }
    case 'collab/members':
      return { ok: true, items: store.collabMembers(groupId) };
    case 'collab/tokens':
      return { ok: true, items: store.collabTokens(groupId) };
    case 'collab/audit':
      return { ok: true, items: store.collabAudit(groupId, Number(query.get('limit') || 40)) };
    case 'collab/base':
      return { ok: true, public_base: String(store.getMeta('collab_public_base') || '') };
    default:
      return null;
  }
}

function handlePost(store, route, body) {
  const groupId = String(body?.group_id || '').trim();
  switch (route) {
    case 'settings': {
      const next = {};
      for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body || {}, key)) next[key] = body[key];
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'cooldown') && next.coldown === undefined) {
        next.coldown = body.cooldown;
      }
      if (next.mode !== undefined) next.mode = Number(next.mode) || 0;
      if (next.coldown !== undefined) next.coldown = Math.max(0, Number(next.coldown) || 0);
      if (next.poke_prob !== undefined) next.poke_prob = Math.max(0, Number(next.poke_prob) || 0);
      store.saveGroupSettings(groupId, next);
      return { ok: true, ...loadSettings(store, groupId) };
    }
    case 'quotes/delete': {
      const names = Array.isArray(body?.names) ? body.names : [];
      const deleted = [];
      for (const name of names) {
        const quote = store.findImageQuote(groupId, name);
        if (!quote) continue;
        moveFileToTrash(store, quote.imagePath);
        if (store.trashQuote(groupId, name)) deleted.push(name);
      }
      return { ok: true, deleted };
    }
    case 'quotes/move': {
      const from = String(body?.from_group || '').trim();
      const to = String(body?.to_group || '').trim();
      const names = Array.isArray(body?.names) ? body.names : [];
      if (!from || !to) return { ok: false, error: 'from_group/to_group required' };
      const moved = [];
      for (const name of names) {
        const quote = store.findImageQuote(from, name);
        if (!quote) continue;
        const source = imageAbsolutePath(store, quote);
        const safeGroup = to.replace(/[\\/]/g, '_');
        const targetDir = path.join(store.imagesDir, safeGroup);
        mkdirSync(targetDir, { recursive: true });
        const target = path.join(targetDir, name);
        try {
          renameSync(source, target);
        } catch {
          continue;
        }
        store.updateImageQuoteRef(quote.id, to, `${safeGroup}/${name}`);
        moved.push(name);
      }
      return { ok: true, moved };
    }
    case 'group/delete': {
      const refs = store.imageQuoteRefs(groupId);
      for (const ref of refs) moveFileToTrash(store, ref.imagePath);
      const trashed = store.trashGroup(groupId);
      return { ok: true, deleted: trashed.length };
    }
    case 'collections': {
      const action = String(body?.action || '');
      const collectionId = String(body?.collection_id || '');
      if (!groupId) return { ok: false, error: 'group_id required' };
      if (action === 'create') {
        const created = store.createCollection(groupId, body?.name, body?.desc, body?.ids);
        if (!created) return { ok: false, error: 'name required' };
        return { ok: true, collections: store.listCollections(groupId), collection: created };
      }
      if (action === 'update') {
        const updated = store.updateCollection(groupId, collectionId, { name: body?.name, desc: body?.desc });
        if (!updated) return { ok: false, error: 'collection not found' };
        return { ok: true, collections: store.listCollections(groupId), collection: updated };
      }
      if (action === 'delete') {
        if (!store.deleteCollection(groupId, collectionId)) return { ok: false, error: 'collection not found' };
        return { ok: true, collections: store.listCollections(groupId) };
      }
      if (action === 'add') {
        const updated = store.addToCollection(groupId, collectionId, body?.add_ids);
        if (!updated) return { ok: false, error: 'collection not found' };
        return { ok: true, collections: store.listCollections(groupId), collection: updated };
      }
      if (action === 'remove') {
        const updated = store.removeFromCollection(groupId, collectionId, body?.remove_ids);
        if (!updated) return { ok: false, error: 'collection not found' };
        return { ok: true, collections: store.listCollections(groupId), collection: updated };
      }
      return { ok: false, error: 'unknown collection action' };
    }
    case 'weekly': {
      const current = store.getMeta('weekly_settings') || {};
      const next = {
        ...current,
        enabled: Boolean(body?.enabled ?? current.enabled),
        weekday: Number(body?.weekday ?? current.weekday ?? 1),
        hour: Number(body?.hour ?? current.hour ?? 9),
        groups: Array.isArray(body?.groups) ? body.groups.map(String) : current.groups || [],
      };
      store.setMeta('weekly_settings', next);
      const groups = store.imageGroups().map((row) => String(row.group));
      return {
        ok: true,
        settings: {
          enabled: next.enabled,
          weekday: next.weekday,
          hour: next.hour,
          groups: next.groups,
          last_week: String(next.last_week || ''),
        },
        groups,
        previews: {},
        week_label: '',
      };
    }
    case 'weekly/test':
      return { ok: true, results: [] };
    case 'trash/restore': {
      const names = Array.isArray(body?.names) ? body.names : [];
      const restored = [];
      for (const name of names) {
        const row = store.findTrash(groupId, name);
        if (!row) continue;
        if (!moveFileFromTrash(store, row.image_path)) continue;
        if (store.restoreTrashQuote(groupId, name)) restored.push(name);
      }
      return { ok: true, restored };
    }
    case 'trash/purge': {
      const all = Boolean(body?.all);
      const names = Array.isArray(body?.names) ? body.names : [];
      const rows = store.purgeTrash(groupId, names, all);
      for (const row of rows) removeTrashedFile(store, row.imagePath);
      return { ok: true, purged: rows.length };
    }
    case 'quotes/subject': {
      const names = Array.isArray(body?.names) ? body.names : [];
      const display = String(body?.name || body?.display_name || body?.subject_name || '').trim();
      const updated = store.setSubject(groupId, names, display, body?.user_id || '');
      return { ok: true, updated, display_name: display };
    }
    case 'quotes/restricted': {
      const names = Array.isArray(body?.names) ? body.names : [];
      return { ok: true, updated: store.setRestricted(groupId, names, Boolean(body?.restricted)) };
    }
    case 'quotes/rebind': {
      const groups = store.imageGroups();
      const scanned = groups.reduce((sum, group) => sum + Number(group.count || 0), 0);
      return { ok: true, scanned, assigned: 0, renamed: 0, semantic: 0 };
    }
    case 'quotes/auto_rating': {
      const groups = store.imageGroups();
      const scanned = groups
        .filter((group) => !groupId || group.group === groupId)
        .reduce((sum, group) => sum + Number(group.count || 0), 0);
      return { ok: true, scanned, updated: 0, restricted: 0 };
    }
    case 'quotes/rating':
      return { ok: true };
    case 'sent':
      return { ok: true, cleared: 0 };
    case 'tag/queue':
      return { ok: true, queued: 0 };
    case 'identity/avatars':
      return { ok: true, items: {} };
    case 'identity/merge':
      return store.identityMerge(Array.isArray(body?.user_ids) ? body.user_ids : []);
    case 'identity/split':
      return store.identitySplit({
        personId: body?.person_id || body?.pid || '',
        userId: body?.user_id || '',
      });
    case 'identity/match':
      return { ok: true, threshold: 0, candidates: [] };
    case 'identity/sync':
      return { ok: true, member_users: 0, new_users: 0, synced: 0, tried: 0, remaining: 0 };
    case 'identity/schedule':
      return {
        ok: true,
        enabled: false,
        interval_hours: 24,
        last_sync_at: 0,
        next_sync_at: 0,
        last_result: {},
      };
    case 'identity/match_names':
      return { ok: true, items: [] };
    case 'identity/cluster_merge': {
      // Body: { group_id, names: [nickname variants], person_id? | user_id? }.
      // AstrBot persists an alias table here; the DSH port binds the variants
      // straight onto the quotes so the person card shows one merged name.
      const names = [
        ...new Set(
          (Array.isArray(body?.names) ? body.names : [])
            .map((name) => String(name ?? '').trim().slice(0, 120))
            .filter(Boolean),
        ),
      ];
      if (!names.length) return { ok: false, error: '没有要合并的昵称' };
      const target = String(body?.person_id || body?.pid || body?.user_id || '').trim();
      const resolved = target ? store.identityResolve(target) : null;
      if (!resolved) return { ok: false, error: '目标人物不存在' };
      const display = resolved.display_name || names[0];
      const targets = groupId ? [groupId] : store.imageGroups().map((row) => String(row.group || ''));
      let updated = 0;
      let aliases = 0;
      for (const gid of targets) {
        if (!gid) continue;
        updated += store.bindSubjectNames({
          group: gid,
          names,
          subjectName: display,
          subjectUser: resolved.user_id,
        });
        for (const name of names) {
          const entry = store.upsertAlias({
            group: gid,
            aliasName: name,
            targetUserId: resolved.user_id,
            personId: resolved.person_id,
            displayName: display,
            source: 'merge',
            confidence: 0.95,
          });
          if (entry) aliases += 1;
        }
      }
      return {
        ok: true,
        person_id: resolved.person_id,
        user_id: resolved.user_id,
        names,
        display_name: display,
        updated,
        aliases,
        unsupported: [],
      };
    }
    case 'identity/cleanup': {
      const dryRun = body?.dry_run !== false;
      const result = store.cleanupSubjects({ group: groupId, apply: !dryRun });
      return {
        ...result,
        group_id: groupId,
        dry_run: dryRun,
        samples: result.samples || [],
        unsupported: [],
      };
    }
    case 'quotes/auto_subject':
      return { ok: true, scanned: 0, updated: 0 };
    case 'quotes/bind_name': {
      const subjectName = String(body?.subject_name || '').trim();
      const target = String(body?.person_id || body?.pid || body?.user_id || '').trim();
      if (!subjectName) return { ok: false, error: '缺少昵称' };
      const resolved = target ? store.identityResolve(target) : null;
      if (!resolved) return { ok: false, error: '目标人物不存在' };
      const display = resolved.display_name || subjectName;
      const updated = store.bindSubjectNames({
        group: groupId,
        names: [subjectName],
        subjectName: display,
        subjectUser: resolved.user_id,
      });
      if (groupId) {
        store.upsertAlias({
          group: groupId,
          aliasName: subjectName,
          targetUserId: resolved.user_id,
          personId: resolved.person_id,
          displayName: display,
          source: 'manual',
          confidence: 1,
        });
      }
      return {
        ok: true,
        subject_name: subjectName,
        updated,
        display_name: display,
        person_id: resolved.person_id,
        user_id: resolved.user_id,
      };
    }
    case 'alias/candidate_confirm': {
      const id = Number(body?.id || 0);
      if (!id) return { ok: false, error: '缺少候选 id' };
      const alias = store.confirmAliasCandidate(id);
      if (!alias) return { ok: false, error: '候选不存在或已处理' };
      return { ok: true, id, status: 'confirmed', alias };
    }
    case 'alias/candidate_reject': {
      const id = Number(body?.id || 0);
      if (!id) return { ok: false, error: '缺少候选 id' };
      const changed = store.rejectAliasCandidate(id);
      if (!changed) return { ok: false, error: '候选不存在或已处理' };
      return { ok: true, id, status: 'rejected' };
    }
    case 'alias/learn':
      return store.learnAliases({
        group: groupId,
        limit: Number(body?.limit || 20) || 20,
      });
    case 'semantic/run': {
      const action = String(body?.action || 'start').trim().toLowerCase();
      if (action === 'cancel') return cancelSemanticTask();
      if (semanticTask.running) {
        return {
          ok: false,
          error: '已有一个语义化任务在运行中，请等待完成或先取消',
          task: semanticTaskState(),
        };
      }
      return startSemanticTask(store, {
        group: groupId,
        scope: String(body?.scope || 'pending').trim() || 'pending',
      });
    }
    case 'semantic/reset': {
      if (!body?.confirm) return { ok: false, error: '需要确认后才可清空语义索引' };
      cancelSemanticTask();
      const cleared = store.semanticReset({ group: groupId });
      return { ok: true, group_id: groupId, cleared };
    }
    case 'semantic/backfill_speaker':
      return { ok: true, scanned: 0, updated: 0, skipped: 0 };
    case 'collab/members': {
      const action = String(body?.action || '');
      const qq = String(body?.qq || '').trim();
      if (!/^\d{5,}$/.test(qq)) return { ok: false, error: '请输入正确的 QQ 号' };
      const role = String(body?.role || 'maintainer');
      if (action === 'add') {
        const previous = store.collabMembers(groupId).find((item) => item.qq === qq) || null;
        store.collabSetMember({ groupId, qq, role, actor: '本机管理页' });
        store.collabLog({
          groupId,
          actorName: '本机管理页',
          action: 'member_set',
          target: qq,
          payload: { qq, role, previous: previous ? { role: previous.role } : null },
        });
        return { ok: true, items: store.collabMembers(groupId) };
      }
      if (action === 'remove') {
        const previous = store.collabMembers(groupId).find((item) => item.qq === qq) || null;
        if (!previous) return { ok: false, error: '成员不存在' };
        store.collabRemoveMember(groupId, qq);
        store.collabLog({
          groupId,
          actorName: '本机管理页',
          action: 'member_remove',
          target: qq,
          payload: { qq, role: previous.role, added_by: previous.added_by, added_at: previous.added_at },
        });
        return { ok: true, items: store.collabMembers(groupId) };
      }
      return { ok: false, error: 'unknown collab member action' };
    }
    case 'collab/tokens': {
      const action = String(body?.action || '');
      if (action === 'create') {
        const qq = String(body?.qq || '').trim();
        if (!/^\d{5,}$/.test(qq)) return { ok: false, error: '请输入正确的 QQ 号' };
        const hours = Math.max(0, Math.min(87600, Number(body?.hours) || 0));
        const token = randomBytes(24).toString('base64url');
        const item = store.collabCreateToken({ groupId, qq, role: String(body?.role || 'maintainer'), hours, token });
        store.collabLog({
          groupId,
          actorName: '本机管理页',
          action: 'token_create',
          target: qq,
          payload: { token_id: item ? item.id : 0 },
        });
        const base = String(store.getMeta('collab_public_base') || '').replace(/\/+$/, '');
        const link = base ? `${base}/?token=${token}` : `令牌：${token}（未设置协作入口地址）`;
        return { ok: true, link, item };
      }
      if (action === 'revoke') {
        const tokenId = Number(body?.token_id || 0);
        if (!tokenId) return { ok: false, error: 'missing token id' };
        store.collabRevokeToken(groupId, tokenId);
        store.collabLog({
          groupId,
          actorName: '本机管理页',
          action: 'token_revoke',
          target: String(tokenId),
          payload: { token_id: tokenId },
        });
        return { ok: true, items: store.collabTokens(groupId) };
      }
      return { ok: false, error: 'unknown collab token action' };
    }
    case 'collab/base': {
      const value = String(body?.public_base || '').trim();
      const previous = String(store.getMeta('collab_public_base') || '');
      store.setMeta('collab_public_base', value);
      store.collabLog({ groupId, actorName: '本机管理页', action: 'base_set', target: value, payload: { previous } });
      return { ok: true, public_base: value };
    }
    case 'collab/audit': {
      const changed = store.collabUndoAudit(Number(body?.id || 0));
      return { ok: true, changed };
    }
    default:
      return null;
  }
}

export const _internal = {
  ROUTES,
  STATIC_FILES,
  DEFAULT_SETTINGS,
  readBody,
  isLoopbackHost,
  isLoopbackSocket,
};
