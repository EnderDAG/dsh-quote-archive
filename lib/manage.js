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
import { readFileSync, readdirSync, statSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function createManageRoutes({ getStore }) {
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
      const effectivePageSize = Math.min(200, Math.max(6, Number.isFinite(pageSize) ? pageSize : 48));
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
      const groups = store.imageGroups();
      const total = groups.reduce((sum, group) => sum + Number(group.count || 0), 0);
      return {
        ok: true,
        embedding: { ready: false, model: '', id: '', dimension: 0 },
        caption_provider_id: '',
        totals: { total, pending: total, failed: 0, done: 0 },
        groups: groups.map((row) => ({
          group_id: row.group,
          done: 0,
          pending: row.count,
          failed: 0,
          vectorless: row.count,
          stale: 0,
        })),
        task: null,
      };
    }
    case 'sent':
      return { ok: true, total: 0, pending: 0, max_age: 21600, keep: 5 };
    case 'tag/queue':
      return { ok: true, paused: false, pending: 0, done: 0, failed: 0, running: false };
    case 'identity/list': {
      const page = Math.max(1, Number(query.get('page') || 1));
      const pageSize = Math.min(500, Math.max(1, Number(query.get('page_size') || 60)));
      const rows = store.listSpeakers({
        group: groupId,
        q: String(query.get('q') || '').trim(),
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return {
        ok: true,
        items: rows.map((row) => ({
          pid: row.speaker,
          person_id: row.speaker,
          display_name: row.speaker,
          name: row.speaker,
          user_ids: [],
          avatar_sha: '',
          quote_count: row.count,
        })),
        total: rows.length,
      };
    }
    case 'identity/clusters':
    case 'quotes/review':
      return { ok: true, items: [] };
    case 'statistics': {
      const groups = store.imageGroups();
      const total = groups.reduce((sum, group) => sum + Number(group.count || 0), 0);
      return { ok: true, totals: { quotes: total, groups: groups.length }, top: [], days: [] };
    }
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
        const file = imageAbsolutePath(store, quote);
        store.deleteQuoteById(quote.id);
        if (file) {
          try {
            unlinkSync(file);
          } catch {
            /* ignore */
          }
        }
        deleted.push(name);
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
      const rows = store.deleteAllInGroup(groupId);
      let deleted = 0;
      for (const row of rows) {
        const file = imageAbsolutePath(store, { imagePath: row.imagePath });
        if (file) {
          try {
            unlinkSync(file);
          } catch {
            /* ignore */
          }
        }
        deleted += 1;
      }
      return { ok: true, deleted };
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
