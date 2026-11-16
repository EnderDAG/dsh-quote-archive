/**
 * Endpoint coverage for the ported AstrBot management page.
 *
 * The ported page (`web/manage/script.js`) is the contract: this test parses its
 * `EP` table plus every `apiGet(...)` / `apiPost(...)` call site, then drives the
 * DSH admin-API compatibility layer (`lib/manage.js`) for each used endpoint and
 * asserts a JSON 200 response that is not a "not ported" placeholder.
 *
 * It also smoke-tests the seven page modules (archive / statistics / insights /
 * trash / people / collections / collab) against a temporary SQLite store, and
 * checks that the page shell still loads bridge.js before script.js.
 *
 * Note: read-only modules are exercised before the coverage sweep; the sweep is
 * allowed to send destructive payloads (delete / move / purge) but only against
 * throwaway groups, so the assertions above it stay deterministic.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web', 'manage');

const realLog = console.log;
const realWarn = console.warn;
// The handlers log every request; keep the test output readable.
console.log = () => {};
console.warn = () => {};

const G1 = '1031430106';
const G2 = '478864863';
const THROWAWAY = '999999999';
const MOVE_TARGET = '999999998';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-archive-coverage-'));
const imagesDir = path.join(tmp, 'images');
const store = openStore(path.join(tmp, 'quotes.db'), { imagesDir });

const fakeChannel = {
  getLoginInfo: async () => ({ user_id: '3266983948', nickname: '末炎Ender' }),
  getGroupList: async () => [{ group: G1, name: '主群' }],
  getGroupMsgHistory: async () => [],
  sendGroupImage: async () => ({ message_id: 'fake-1' }),
  sendGroupText: async () => ({ message_id: 'fake-2' }),
};

const routes = createManageRoutes({
  getStore: () => store,
  getChannel: () => fakeChannel,
  getConfig: () => ({
    channel: {
      enabled: true,
      httpUrl: 'http://127.0.0.1:3000',
      groups: [G1],
      maxMessagesPerSync: 50,
      maxImageBytes: 10 * 1024 * 1024,
    },
  }),
  getLastSync: () => null,
  discoverChannel: async () => ({
    channel: {
      enabled: true,
      auto: true,
      source: 'snowluma',
      httpUrl: 'http://127.0.0.1:3000',
      token_set: true,
      reachable: true,
      login: { userId: '3266983948', nickname: '末炎Ender' },
      groups: 1,
      error: '',
    },
    candidates: [],
    searched: { qqBridge: [], snowlumaHomes: ['C:/SnowLuma'] },
    override_path: path.join(tmp, 'channel.json'),
  }),
  applyCollect: async (patch) => ({
    ok: true,
    collect: {
      autoCollect: Boolean(patch && patch.autoCollect),
      pollIntervalSec: (patch && patch.pollIntervalSec) || 300,
      groups: (patch && patch.groups) || [G1],
    },
  }),
  getCollect: () => ({ autoCollect: false, pollIntervalSec: 300, groups: [G1] }),
  applyChannel: async (patch) => ({
    ok: true,
    channel: {
      enabled: !patch || patch.enabled !== false,
      auto: false,
      source: 'snowluma',
      httpUrl: 'http://127.0.0.1:3000',
      token_set: true,
      groups: [G1],
    },
    override_path: path.join(tmp, 'channel.json'),
  }),
});

const pageRoute = routes.find((route) => route.path === ROUTES.page);
const apiRoute = routes.find((route) => route.path === ROUTES.api);
assert.ok(pageRoute, 'page route should be registered');
assert.ok(apiRoute, 'admin-api route should be registered');

function makeReq(method, url, body, options = {}) {
  const req = {
    method,
    url,
    headers: { host: options.host ?? '127.0.0.1:2759' },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    _handlers: { data: null, end: null, error: null },
    on(event, handler) {
      this._handlers[event] = handler;
      return this;
    },
    destroy() {},
  };
  if (body !== undefined) {
    setImmediate(() => {
      if (body !== null) req._handlers.data && req._handlers.data(Buffer.from(JSON.stringify(body)));
      req._handlers.end && req._handlers.end();
    });
  }
  return req;
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    ended: false,
    _resolve: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
      return this;
    },
    end(body) {
      this.ended = true;
      if (body !== undefined) this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
      if (this._resolve) this._resolve(this);
    },
  };
}

function call(route, method, url, body, options) {
  const req = makeReq(method, url, body, options);
  const res = makeRes();
  const done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  route.handler(req, res);
  return done;
}

async function callApi(method, rel, payload, options) {
  let url = ROUTES.api + '/' + rel;
  if (method === 'GET' && payload) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    if (qs) url += '?' + qs;
  }
  const res = await call(apiRoute, method, url, method === 'POST' ? payload || {} : undefined, options);
  const text = res.body || '{}';
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${rel} returned non-JSON body: ${text.slice(0, 200)}`);
  }
  return { status: res.status, headers: res.headers, body };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
function png(byte) {
  return Buffer.concat([PNG, Buffer.from([byte])]);
}

function writeImage(group, name, byte) {
  mkdirSync(path.join(imagesDir, group), { recursive: true });
  writeFileSync(path.join(imagesDir, group, name), png(byte));
}

function seed() {
  writeImage(G1, 'a.png', 1);
  writeImage(G1, 'c.png', 2);
  writeImage(G1, 'e.png', 3);
  writeImage(G2, 'b.png', 4);
  writeImage(THROWAWAY, 'z.png', 5);
  writeImage(THROWAWAY, 'zz.png', 6);

  const a = store.addQuote({
    group: G1,
    speaker: 'tester',
    content: '[图片语录]',
    messageId: 'cov-a',
    imagePath: `${G1}/a.png`,
    source: 'qq',
    tag: ['精选', '名场面'],
    createdAt: 1_700_000_000,
  });
  store.addQuote({
    group: G1,
    speaker: 'tester',
    content: '[图片语录]',
    messageId: 'cov-c',
    imagePath: `${G1}/c.png`,
    source: 'qq',
    createdAt: 1_700_000_200,
  });
  store.addQuote({
    group: G1,
    speaker: 'tester',
    content: '[图片语录]',
    messageId: 'cov-e',
    imagePath: `${G1}/e.png`,
    source: 'qq',
    createdAt: 1_700_000_300,
  });
  store.addQuote({
    group: G2,
    speaker: 'other',
    content: '带图语录',
    messageId: 'cov-b',
    imagePath: `${G2}/b.png`,
    source: 'qq',
    createdAt: 1_700_000_100,
  });
  store.addQuote({
    group: THROWAWAY,
    speaker: 'trash',
    content: '[图片语录]',
    messageId: 'cov-z',
    imagePath: `${THROWAWAY}/z.png`,
    source: 'qq',
    createdAt: 1_700_000_400,
  });
  store.addQuote({
    group: THROWAWAY,
    speaker: 'trash',
    content: '[图片语录]',
    messageId: 'cov-zz',
    imagePath: `${THROWAWAY}/zz.png`,
    source: 'qq',
    createdAt: 1_700_000_500,
  });

  // Two OCR-style name variants bound to the same person id -> one cluster.
  store.setSubject(G1, ['c.png'], '小明', '10001');
  store.setSubject(G1, ['e.png'], '小朋', '10001');

  // Emoji-reaction / reply-comment fixtures used by the statistics module.
  store.recordSentQuote({ messageId: 'cov-sent', groupId: G1, filename: 'a.png' });
  store.recordReaction({ groupId: G1, filename: 'a.png', userId: 'u1', emoji: '👍' });
  store.recordReaction({ groupId: G1, filename: 'a.png', userId: 'u2', emoji: '128293' });
  store.recordComment({ groupId: G1, filename: 'a.png', userId: 'u1', content: '好笑' });

  // Pending alias candidates used by the alias module block and the page-driven
  // sweep (which confirms/rejects them by id).
  const confirmId = store.addAliasCandidate({
    group: G1,
    aliasName: '小明同学',
    targetUserId: '10001',
    displayName: '小明',
    evidence: '群昵称变体',
    confidence: 0.66,
    occurrences: 2,
  });
  const rejectId = store.addAliasCandidate({
    group: G1,
    aliasName: '小朋同学',
    targetUserId: '10001',
    displayName: '小朋',
    evidence: '群昵称变体',
    confidence: 0.5,
    occurrences: 2,
  });

  return {
    quoteAId: Number(a.id),
    confirmCandidateId: Number(confirmId),
    rejectCandidateId: Number(rejectId),
  };
}

/**
 * Parse `web/manage/script.js` and return the endpoints the page really calls.
 * @returns {{ used: Map<string, Set<'GET'|'POST'>>, ep: Record<string,string> }}
 */
function parsePageContract() {
  const script = readFileSync(path.join(WEB_DIR, 'script.js'), 'utf8');
  const epStart = script.indexOf('const EP = {');
  assert.ok(epStart >= 0, 'script.js should declare an EP endpoint table');
  const epEnd = script.indexOf('};', epStart);
  assert.ok(epEnd > epStart, 'EP table should be closed');
  const epBlock = script.slice(epStart, epEnd + 2);

  const ep = {};
  const epEntries = [...epBlock.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/g)];
  for (const match of epEntries) ep[match[1]] = match[2];
  assert.ok(epEntries.length >= 50, `EP table should list the full page API (got ${epEntries.length})`);

  const used = new Map();
  const callRe = /api(Get|Post)\(\s*(?:EP\.([A-Za-z_$][\w$]*)|'([^']+)')/g;
  for (const match of script.matchAll(callRe)) {
    const method = match[1] === 'Get' ? 'GET' : 'POST';
    const endpoint = match[2] ? ep[match[2]] : match[3];
    assert.ok(endpoint, `call site should resolve to an endpoint (${match[0]})`);
    if (!used.has(endpoint)) used.set(endpoint, new Set());
    used.get(endpoint).add(method);
  }
  assert.ok(used.size >= 50, `page should call the full API surface (got ${used.size} endpoints)`);

  // Guard against absolute/host-specific prefixes leaking into the ported page.
  assert.ok(!script.includes('/quote_collocter/admin-api'), 'script.js should not hardcode the AstrBot API prefix');
  assert.ok(!script.includes('http://127.0.0.1:'), 'script.js should not hardcode a host');

  return { used, ep };
}

/**
 * Safe payloads for the coverage sweep, keyed by `<METHOD> <path>`.
 * Every endpoint used by the page must have one; the sweep fails loudly when a
 * future page edit adds a call site without a payload here.
 */
const GET_PARAMS = {
  'GET overview': {},
  'GET quotes': { group_id: G1, page: 1, page_size: 48 },
  'GET quotes/search': { group_id: G1, q: '图', page: 1 },
  'GET image': { group_id: G1, name: 'a.png' },
  'GET images/batch': { group_id: G1, names: 'a.png,c.png' },
  'GET settings': { group_id: G1 },
  'GET semantic/status': { group_id: G1 },
  'GET semantic/progress': { group_id: G1 },
  'GET sent': { group_id: G1 },
  'GET identity/overview': { group_id: G1 },
  'GET identity/list': { group_id: G1, page: 1, page_size: 20 },
  'GET identity/detail': { person_id: '10001' },
  'GET identity/clusters': { group_id: G1, limit: 40 },
  'GET identity/schedule': {},
  'GET quotes/review': { group_id: G1 },
  'GET alias/candidates': { group_id: G1 },
  'GET statistics': { group_id: G1, top: 10, days: 30 },
  'GET collections': { group_id: G1 },
  'GET weekly': { group_id: G1 },
  'GET trash': { group_id: G1 },
  'GET tag/queue': { group_id: G1 },
  'GET insights/heatmap': { group_id: G1, days: 365 },
  'GET insights/timeline': { group_id: G1, pid: '10001' },
  'GET insights/annual_image': { pid: '10001', year: 2024 },
  'GET collab/members': { group_id: G1 },
  'GET collab/tokens': { group_id: G1 },
  'GET collab/audit': { group_id: G1 },
  'GET collab/base': { group_id: G1 },
};

const POST_BODIES = {
  'POST settings': { group_id: G1, mode: 1, coldown: 60 },
  'POST semantic/run': { group_id: G1, scope: 'group' },
  'POST semantic/reset': { group_id: G1, confirm: true },
  'POST identity/merge': { user_ids: ['20001', '20002'] },
  'POST identity/split': { user_id: '20001' },
  'POST identity/match': { group_id: G1 },
  'POST identity/sync': { group_id: G1 },
  'POST identity/schedule': { group_id: G1, enabled: false, interval_hours: 24 },
  'POST identity/avatars': { group_id: G1 },
  'POST identity/cluster_merge': { group_id: G1, names: ['小明', '小朋'], user_id: '10001' },
  'POST identity/cleanup': { group_id: G1, dry_run: true },
  'POST alias/candidate_confirm': { group_id: G1 },
  'POST alias/candidate_reject': { group_id: G1 },
  'POST alias/learn': { group_id: G1 },
  'POST quotes/subject': { group_id: G1, names: ['a.png'], name: '覆盖测试' },
  'POST quotes/auto_subject': { group_id: G1 },
  'POST quotes/bind_name': { group_id: G1, subject_name: '小明', user_id: '10001' },
  'POST quotes/rebind': { group_id: G1 },
  'POST quotes/delete': { group_id: THROWAWAY, names: ['z.png'] },
  'POST quotes/move': { from_group: THROWAWAY, to_group: MOVE_TARGET, names: ['zz.png'] },
  'POST group/delete': { group_id: THROWAWAY },
  'POST quotes/restricted': { group_id: G1, names: ['a.png'], restricted: false },
  'POST quotes/auto_rating': { group_id: G1 },
  'POST semantic/backfill_speaker': { group_id: G1 },
  'POST weekly': { group_id: G1, enabled: false },
  'POST weekly/test': { group_id: G1 },
  'POST trash/restore': { group_id: G1, names: [] },
  'POST trash/purge': { group_id: G1, names: [], all: false },
  'POST tag/queue': { group_id: G1, action: 'enqueue' },
  'POST sent': { group_id: G1 },
  'POST collections': { group_id: G1, action: 'create', name: '覆盖集合' },
  'POST collab/members': { group_id: G1, action: 'add', qq: '123456789', role: 'maintainer' },
  'POST collab/tokens': { group_id: G1, action: 'create', qq: '123456789', role: 'maintainer', hours: 24 },
  'POST collab/audit': { group_id: G1, id: 0 },
  'POST collab/base': { group_id: G1, public_base: 'https://example.com/quotes' },
};

async function main() {
  const { quoteAId, confirmCandidateId, rejectCandidateId } = seed();

  // ---------------------------------------------------------------- page shell
  {
    const html = readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    const bridgeAt = html.indexOf('bridge.js');
    const scriptAt = html.indexOf('script.js');
    assert.ok(bridgeAt >= 0, 'index.html should load bridge.js');
    assert.ok(scriptAt >= 0, 'index.html should load script.js');
    assert.ok(bridgeAt < scriptAt, 'bridge.js must load before script.js');
    assert.ok(html.includes('stats-reactions-total'), 'page should contain the emoji-reaction section');

    for (const [file, mime] of [
      ['index.html', 'text/html'],
      ['script.js', 'text/javascript'],
      ['style.css', 'text/css'],
      ['bridge.js', 'text/javascript'],
    ]) {
      const res = await call(pageRoute, 'GET', `${ROUTES.page}/${file}`);
      assert.equal(res.status, 200, `${file} should be served with 200`);
      assert.ok(String(res.headers['content-type'] || '').includes(mime), `${file} content-type`);
      assert.ok(res.body.length > 100, `${file} should not be empty`);
    }
    const missing = await call(pageRoute, 'GET', `${ROUTES.page}/nope.txt`);
    assert.equal(missing.status, 404, 'unknown page asset should be 404');
  }

  // ------------------------------------------------------------ archive module
  {
    const overview = await callApi('GET', 'overview');
    assert.equal(overview.body.ok, true);
    assert.equal(overview.body.total_quotes, 6);
    assert.equal(overview.body.groups.length, 3);

    const quotes = await callApi('GET', 'quotes', { group_id: G1, page: 1, page_size: 48 });
    assert.equal(quotes.body.total, 3);
    const aItem = quotes.body.items.find((item) => item.name === 'a.png');
    assert.ok(aItem, 'archive list should include a.png');
    assert.deepEqual(aItem.tags.sort(), ['名场面', '精选'].sort());
    assert.equal(quotes.body.items[0].name, 'e.png', 'list should be newest first');

    const search = await callApi('GET', 'quotes/search', { group_id: G2, q: '带图' });
    assert.equal(search.body.total, 1);
    assert.equal(search.body.items[0].caption, '带图语录');

    const image = await callApi('GET', 'image', { group_id: G1, name: 'a.png' });
    assert.ok(String(image.body.data_url).startsWith('data:image/png;base64,'));

    const batch = await callApi('GET', 'images/batch', { group_id: G1, names: 'a.png,missing.png' });
    assert.ok(batch.body.items['a.png']);
    assert.equal(batch.body.items['missing.png'], undefined);

    const restricted = await callApi('POST', 'quotes/restricted', {
      group_id: G1,
      names: ['a.png'],
      restricted: true,
    });
    assert.equal(restricted.body.updated, 1);
    const restrictedList = await callApi('GET', 'quotes', { group_id: G1, restricted: '1' });
    assert.equal(restrictedList.body.total, 1);
    await callApi('POST', 'quotes/restricted', { group_id: G1, names: ['a.png'], restricted: false });

    const saved = await callApi('POST', 'settings', { group_id: G1, mode: 2, coldown: 5 });
    assert.equal(saved.body.mode, 2);
    assert.equal(saved.body.coldown, 5);
    assert.equal(saved.body.alias_learn_every, 40, 'untouched settings keep their defaults');
    const reloaded = await callApi('GET', 'settings', { group_id: G1 });
    assert.equal(reloaded.body.coldown, 5);

    const queue = await callApi('GET', 'tag/queue', { group_id: G1 });
    assert.equal(queue.body.ok, true);
    assert.equal(typeof queue.body.pending, 'number');
    const enqueued = await callApi('POST', 'tag/queue', { group_id: G1, action: 'enqueue' });
    assert.equal(enqueued.body.ok, true);
  }

  // --------------------------------------------------------- statistics module
  {
    const stats = await callApi('GET', 'statistics', { group_id: G1, top: 10, days: 30 });
    assert.equal(stats.body.ok, true);
    assert.equal(stats.body.totals.quotes, 3);
    assert.equal(stats.body.trend.length, 30);
    const reactions = stats.body.reactions;
    assert.ok(reactions, 'statistics should expose the reactions sub-object');
    assert.equal(reactions.reactions, 2);
    assert.equal(reactions.comments, 1);
    assert.equal(reactions.trend.length, 30);
    assert.equal(reactions.trend[29].reactions, 2);
    assert.deepEqual(
      reactions.emotions.map((row) => row.emotion),
      ['赞', '热烈'],
    );
    assert.equal(reactions.top_quotes[0].filename, 'a.png');
    assert.equal(reactions.top_quotes[0].count, 2);
    assert.equal(reactions.top_comment_quotes[0].filename, 'a.png');
    assert.equal(reactions.top_commenters[0].uid, 'u1');
  }

  // ----------------------------------------------------------- insights module
  {
    const heatmap = await callApi('GET', 'insights/heatmap', { group_id: G1, days: 365 });
    assert.equal(heatmap.body.ok, true);
    assert.equal(heatmap.body.hours.length, 24);
    assert.equal(heatmap.body.calendar.length, 182);
    assert.equal(heatmap.body.weekdays.length, 7);

    const timeline = await callApi('GET', 'insights/timeline', { group_id: G1, pid: '10001' });
    assert.equal(timeline.body.ok, true);

    const annual = await callApi('GET', 'insights/annual', { pid: '10001', year: 2024 });
    assert.equal(annual.body.ok, true);
    assert.equal(annual.body.unsupported, undefined, 'annual report is a real implementation now');
    assert.equal(annual.body.year, 2024);
    assert.equal(annual.body.months.length, 12);
    assert.equal(annual.body.hours.length, 24);
    assert.equal(annual.body.weekdays.length, 7);
    assert.equal(typeof annual.body.total, 'number');
    assert.equal(typeof annual.body.group_total, 'number');
    assert.equal(typeof annual.body.reactions, 'object');
    assert.equal(annual.body.reactions.year, 2024);
    assert.ok(Array.isArray(annual.body.top_tags));
    assert.ok(Array.isArray(annual.body.submitters));
    assert.ok(Array.isArray(annual.body.captions));

    const annualImage = await callApi('GET', 'insights/annual_image', { pid: '10001', year: 2024 });
    assert.equal(annualImage.body.ok, true);
    assert.equal(annualImage.body.unsupported, undefined, 'annual poster is a real implementation now');
    assert.ok(String(annualImage.body.image).startsWith('data:image/svg+xml;base64,'));
    assert.equal(String(annualImage.body.filename), 'annual-2024.svg');
    assert.equal(annualImage.body.report.year, 2024);
    const posterSvg = Buffer.from(String(annualImage.body.image).split(',')[1] || '', 'base64').toString('utf8');
    assert.ok(posterSvg.startsWith('<svg'));
    assert.ok(posterSvg.includes('width="1080" height="1500"'));
    assert.ok(posterSvg.includes('2024'));
  }

  // -------------------------------------------------------------- trash module
  {
    const before = await callApi('GET', 'trash', { group_id: G2 });
    assert.equal(before.body.ok, true);
    assert.equal(before.body.total, 0);

    const deleted = await callApi('POST', 'quotes/delete', { group_id: G2, names: ['b.png'] });
    assert.deepEqual(deleted.body.deleted, ['b.png']);
    assert.ok(!existsSync(path.join(imagesDir, G2, 'b.png')), 'deleted image should leave the archive folder');

    const trashed = await callApi('GET', 'trash', { group_id: G2 });
    assert.equal(trashed.body.total, 1);
    assert.equal(trashed.body.items[0].name, 'b.png');

    const restored = await callApi('POST', 'trash/restore', { group_id: G2, names: ['b.png'] });
    assert.deepEqual(restored.body.restored, ['b.png']);
    assert.ok(existsSync(path.join(imagesDir, G2, 'b.png')), 'restore should bring the image back');

    await callApi('POST', 'quotes/delete', { group_id: G2, names: ['b.png'] });
    const purged = await callApi('POST', 'trash/purge', { group_id: G2, names: ['b.png'] });
    assert.equal(purged.body.purged, 1);
    const after = await callApi('GET', 'trash', { group_id: G2 });
    assert.equal(after.body.total, 0);
  }

  // ------------------------------------------------------------- people module
  {
    const overview = await callApi('GET', 'identity/overview', { group_id: G1 });
    assert.equal(overview.body.ok, true);

    const list = await callApi('GET', 'identity/list', { group_id: G1, page: 1, page_size: 20 });
    assert.equal(list.body.ok, true);
    assert.ok(Array.isArray(list.body.items));

    const detail = await callApi('GET', 'identity/detail', { person_id: '10001' });
    assert.equal(detail.body.ok, true);
    assert.ok(detail.body.user_ids.includes('10001'));

    const clusters = await callApi('GET', 'identity/clusters', { group_id: G1, limit: 40 });
    assert.equal(clusters.body.ok, true);
    assert.equal(clusters.body.total, 1, 'two name variants should form one cluster');
    assert.equal(clusters.body.items[0].names.length, 2);
    assert.equal(clusters.body.items[0].quote_count, 2);

    const merged = await callApi('POST', 'identity/cluster_merge', {
      group_id: G1,
      names: ['小明', '小朋'],
      user_id: '10001',
    });
    assert.equal(merged.body.ok, true);
    assert.equal(merged.body.updated, 2);
    assert.ok(merged.body.display_name);
    assert.deepEqual(merged.body.names.sort(), ['小明', '小朋'].sort());
    assert.equal(merged.body.user_id, '10001');

    const afterMerge = await callApi('GET', 'quotes', { group_id: G1 });
    const bound = afterMerge.body.items.filter((item) => item.name === 'c.png' || item.name === 'e.png');
    assert.equal(bound.length, 2);
    for (const item of bound) assert.equal(item.subject_name, merged.body.display_name);

    const clustersAfter = await callApi('GET', 'identity/clusters', { group_id: G1, limit: 40 });
    assert.equal(clustersAfter.body.total, 0, 'cluster should collapse after merging its names');

    const cleanup = await callApi('POST', 'identity/cleanup', { group_id: G1, dry_run: true });
    assert.equal(cleanup.body.ok, true);
    assert.equal(cleanup.body.dry_run, true);
    assert.deepEqual(cleanup.body.unsupported, [], 'nickname cleanup is a real implementation now');
    assert.equal(typeof cleanup.body.scanned, 'number');
    const cleanupReal = await callApi('POST', 'identity/cleanup', { group_id: G1, dry_run: false });
    assert.equal(cleanupReal.body.ok, true);
    assert.equal(typeof cleanupReal.body.quotes_unbound, 'number');

    const peopleMerge = await callApi('POST', 'identity/merge', { user_ids: ['10001', '30001'] });
    assert.equal(peopleMerge.body.ok, true);
    assert.equal(peopleMerge.body.person_id, '10001');
    const split = await callApi('POST', 'identity/split', { user_id: '30001' });
    assert.equal(split.body.ok, true);
    assert.equal(split.body.restored, 1);
  }

  // -------------------------------------------------------- collections module
  {
    const created = await callApi('POST', 'collections', {
      group_id: G1,
      action: 'create',
      name: '精选合集',
      desc: '覆盖测试',
      ids: [quoteAId],
    });
    assert.equal(created.body.ok, true);
    assert.equal(created.body.collection.name, '精选合集');
    const collectionId = created.body.collection.collection_id;
    assert.ok(collectionId);

    const listed = await callApi('GET', 'collections', { group_id: G1 });
    assert.equal(listed.body.collections.length, 1);
    const one = await callApi('GET', 'collections', { group_id: G1, collection_id: collectionId });
    assert.equal(one.body.collection.name, '精选合集');

    const updated = await callApi('POST', 'collections', {
      group_id: G1,
      action: 'update',
      collection_id: collectionId,
      name: '精选合集 2',
    });
    assert.equal(updated.body.collection.name, '精选合集 2');

    const removed = await callApi('POST', 'collections', {
      group_id: G1,
      action: 'delete',
      collection_id: collectionId,
    });
    assert.equal(removed.body.ok, true);
    assert.equal(removed.body.collections.length, 0);
  }

  // ------------------------------------------------------------- collab module
  {
    const base = await callApi('GET', 'collab/base', { group_id: G1 });
    assert.equal(base.body.public_base, '');
    const savedBase = await callApi('POST', 'collab/base', {
      group_id: G1,
      public_base: 'https://example.com/quotes',
    });
    assert.equal(savedBase.body.ok, true);
    assert.equal(savedBase.body.public_base, 'https://example.com/quotes');

    const addMember = await callApi('POST', 'collab/members', {
      group_id: G1,
      action: 'add',
      qq: '123456789',
      role: 'maintainer',
    });
    assert.equal(addMember.body.ok, true);
    assert.equal(addMember.body.items[0].qq, '123456789');
    const members = await callApi('GET', 'collab/members', { group_id: G1 });
    assert.equal(members.body.items.length, 1);

    const created = await callApi('POST', 'collab/tokens', {
      group_id: G1,
      action: 'create',
      qq: '123456789',
      role: 'maintainer',
      hours: 24,
    });
    assert.equal(created.body.ok, true);
    assert.ok(created.body.item.id);
    assert.ok(String(created.body.link).includes('token='));
    const tokens = await callApi('GET', 'collab/tokens', { group_id: G1 });
    assert.equal(tokens.body.items.length, 1);

    const revoked = await callApi('POST', 'collab/tokens', {
      group_id: G1,
      action: 'revoke',
      token_id: created.body.item.id,
    });
    assert.equal(revoked.body.ok, true);
    assert.equal(revoked.body.items[0].revoked, 1, 'revoked token stays listed but is marked revoked');

    const audit = await callApi('GET', 'collab/audit', { group_id: G1 });
    assert.equal(audit.body.ok, true);
    assert.ok(audit.body.items.length >= 3);
    const undone = await callApi('POST', 'collab/audit', { group_id: G1, id: audit.body.items[0].id });
    assert.equal(undone.body.ok, true);
    assert.equal(typeof undone.body.changed, 'number');

    const removed = await callApi('POST', 'collab/members', {
      group_id: G1,
      action: 'remove',
      qq: '123456789',
    });
    assert.equal(removed.body.ok, true);
    assert.equal(removed.body.items.length, 0);
  }

  // ------------------------------------------------- shim-only surfaces (DSH)
  {
    const status = await callApi('GET', 'semantic/status', { group_id: G1 });
    assert.equal(status.body.ok, true);
    assert.equal(status.body.task, null);
    assert.ok(Array.isArray(status.body.groups));

    const run = await callApi('POST', 'semantic/run', { group_id: G1, scope: 'group' });
    assert.equal(run.body.ok, true);
    assert.equal(run.body.started, false);
    assert.deepEqual(run.body.unsupported, ['semantic_task']);
    const cancel = await callApi('POST', 'semantic/run', { group_id: G1, action: 'cancel' });
    assert.equal(cancel.body.cancelled, true);

    const progress = await callApi('GET', 'semantic/progress', { group_id: G1 });
    assert.equal(progress.body.ok, true);
    assert.equal(progress.body.task, null);

    const reset = await callApi('POST', 'semantic/reset', { group_id: G1, confirm: true });
    assert.equal(reset.body.cleared, 0);
    assert.deepEqual(reset.body.unsupported, ['semantic_index']);

    const sent = await callApi('GET', 'sent', { group_id: G1 });
    assert.deepEqual(
      { ok: sent.body.ok, total: sent.body.total, pending: sent.body.pending },
      { ok: true, total: 0, pending: 0 },
    );
    const sentClear = await callApi('POST', 'sent', { group_id: G1 });
    assert.equal(sentClear.body.ok, true);
    assert.equal(sentClear.body.cleared, 0);

    const schedule = await callApi('GET', 'identity/schedule', { group_id: G1 });
    assert.equal(schedule.body.enabled, false);
    assert.equal(schedule.body.interval_hours, 24);

    const weekly = await callApi('GET', 'weekly', { group_id: G1 });
    assert.equal(weekly.body.ok, true);
    assert.equal(weekly.body.settings.weekday, 1);
    const weeklySaved = await callApi('POST', 'weekly', { group_id: G1, enabled: true, weekday: 5, hour: 20 });
    assert.equal(weeklySaved.body.settings.weekday, 5);
    const weeklyTest = await callApi('POST', 'weekly/test', { group_id: G1 });
    assert.deepEqual(weeklyTest.body.results, []);

    const review = await callApi('GET', 'quotes/review', { group_id: G1 });
    assert.equal(review.body.ok, true);
    assert.ok(Array.isArray(review.body.items));

    const candidates = await callApi('GET', 'alias/candidates', { group_id: G1 });
    assert.equal(candidates.body.ok, true);
    assert.ok(Array.isArray(candidates.body.items));
    assert.equal(typeof candidates.body.total, 'number');
    assert.ok(candidates.body.total >= 2, 'seeded pending candidates should be listed');
    for (const item of candidates.body.items) {
      assert.ok(item.alias_name);
      assert.ok(item.target_user_id);
      assert.equal(typeof item.confidence, 'number');
    }
    const missingConfirm = await callApi('POST', 'alias/candidate_confirm', { group_id: G1 });
    assert.equal(missingConfirm.body.ok, false, 'confirm without a candidate id is rejected');
    assert.ok(String(missingConfirm.body.error || '').length > 0);
    const learn = await callApi('POST', 'alias/learn', { group_id: G1 });
    assert.equal(learn.body.ok, true);
    assert.equal(learn.body.note, 'local-rule');
    assert.equal(typeof learn.body.added, 'number');

    const backfill = await callApi('POST', 'semantic/backfill_speaker', { group_id: G1 });
    assert.equal(backfill.body.ok, true);
    assert.equal(backfill.body.scanned, 0);
    const match = await callApi('POST', 'identity/match', { group_id: G1 });
    assert.ok(Array.isArray(match.body.candidates));
    const sync = await callApi('POST', 'identity/sync', { group_id: G1 });
    assert.equal(sync.body.ok, true);
    const avatars = await callApi('POST', 'identity/avatars', { group_id: G1 });
    assert.equal(avatars.body.ok, true);
    const rebind = await callApi('POST', 'quotes/rebind', { group_id: G1 });
    assert.equal(rebind.body.ok, true);
    const autoSubject = await callApi('POST', 'quotes/auto_subject', { group_id: G1 });
    assert.equal(autoSubject.body.ok, true);
    const bindName = await callApi('POST', 'quotes/bind_name', {
      group_id: G1,
      subject_name: '小明',
      user_id: '10001',
    });
    assert.equal(bindName.body.ok, true);
    assert.equal(bindName.body.subject_name, '小明');
  }

  // --------------------------------------------- full sweep driven by the page
  {
    // Alias candidate confirm/reject need a live candidate id; the seed above
    // left two pending rows for exactly this purpose.
    POST_BODIES['POST alias/candidate_confirm'] = { group_id: G1, id: confirmCandidateId };
    POST_BODIES['POST alias/candidate_reject'] = { group_id: G1, id: rejectCandidateId };
    const { used } = parsePageContract();
    const covered = [];
    const skipped = [];
    for (const [endpoint, methods] of used) {
      for (const method of ['GET', 'POST']) {
        if (!methods.has(method)) continue;
        const key = `${method} ${endpoint}`;
        const table = method === 'GET' ? GET_PARAMS : POST_BODIES;
        const payload = table[key];
        assert.ok(payload !== undefined, `coverage payload missing for page endpoint: ${key}`);
        const res = await callApi(method, endpoint, payload);
        assert.equal(res.status, 200, `${key} should answer with HTTP 200 (got ${res.status})`);
        assert.ok(res.body && typeof res.body === 'object', `${key} should answer JSON`);
        assert.notEqual(
          res.body.ok,
          false,
          `${key} should succeed, got: ${JSON.stringify(res.body).slice(0, 300)}`,
        );
        assert.ok(
          !String(res.body.error || '').includes('not ported'),
          `${key} should be handled by lib/manage.js, not the fallback`,
        );
        if (res.body.unsupported !== undefined) {
          assert.ok(Array.isArray(res.body.unsupported), `${key} unsupported marker should be an array`);
        }
        covered.push(key);
      }
    }
    assert.equal(covered.length, [...used].reduce((sum, [, methods]) => sum + methods.size, 0));
    assert.ok(covered.length >= 58, `page calls at least 58 endpoint/method pairs (got ${covered.length})`);

    // Sanity: every endpoint the page uses is present in the coverage tables,
    // i.e. the page never calls something the DSH port forgot about.
    const orphans = [...used.keys()].filter((endpoint) =>
      [...used.get(endpoint)].every((method) => {
        const key = `${method} ${endpoint}`;
        return GET_PARAMS[key] === undefined && POST_BODIES[key] === undefined;
      }),
    );
    assert.deepEqual(orphans, [], 'all page endpoints should have coverage payloads');
    assert.deepEqual(skipped, []);
  }

  realLog(
    `coverage OK: ${parsePageContract().used.size} page endpoints / ${
      Object.keys(GET_PARAMS).length + Object.keys(POST_BODIES).length
    } request cases, page shell + 7 modules smoke-tested`,
  );
}

try {
  await main();
} finally {
  console.log = realLog;
  console.warn = realWarn;
  try {
    store.close();
  } catch {
    /* ignore */
  }
  rmSync(tmp, { recursive: true, force: true });
}
