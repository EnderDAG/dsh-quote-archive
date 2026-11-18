/**
 * Offline tests for the people relationship star map (`lib/star.js`, v0.19.0).
 *
 * Everything runs against a temporary SQLite store: quotes with subject users
 * and manual/learned/merge aliases are seeded by hand, then
 * `store.starMap()`, `store.starIndex()` and the management API endpoints
 * (`identity/star_map`, `identity/star_index`) are checked for shape, node/edge
 * rules, per-person isolation, group filtering and empty/unknown handling.
 *
 * The last block also asserts the ported page actually wires the new modal and
 * canvas up. No network, no external dependencies.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web', 'manage');
const G1 = '1031430106';
const G2 = '478864863';

const realLog = console.log;
const realWarn = console.warn;
console.log = () => {};
console.warn = () => {};

function withStore(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-star-'));
  const imagesDir = path.join(dir, 'images');
  const store = openStore(path.join(dir, 'quotes.db'), { imagesDir });
  try {
    return run(store, imagesDir, dir);
  } finally {
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may keep the WAL handle around for a moment */
    }
  }
}

async function withStoreAsync(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-star-'));
  const imagesDir = path.join(dir, 'images');
  const store = openStore(path.join(dir, 'quotes.db'), { imagesDir });
  try {
    return await run(store, imagesDir, dir);
  } finally {
    store.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may keep the WAL handle around for a moment */
    }
  }
}

let quoteSeq = 0;
function seedImage(store, imagesDir, group, filename, {
  speaker = '投稿人',
  content = '[图片语录]',
  createdAt = 1_700_000_000,
  subjectUser = '',
  subjectName = '',
  tag,
} = {}) {
  mkdirSync(path.join(imagesDir, group), { recursive: true });
  writeFileSync(path.join(imagesDir, group, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  quoteSeq += 1;
  const quote = store.addQuote({
    group,
    speaker,
    content,
    imagePath: `${group}/${filename}`,
    source: 'qq',
    createdAt: createdAt + quoteSeq,
    tag,
  });
  if (subjectUser) store.setSubject(group, [filename], subjectName, subjectUser);
  return quote;
}

function addAlias(store, source, aliasName, targetUserId, extra = {}) {
  return store.upsertAlias({
    group: extra.group ?? G1,
    aliasName,
    targetUserId,
    personId: extra.personId ?? targetUserId,
    displayName: extra.displayName ?? aliasName,
    source,
    confidence: extra.confidence ?? (source === 'manual' ? 1 : 0.8),
  });
}

// ---------------------------------------------------------------------------
// Build a small but realistic universe: u1 (aliases + nicknames + weak speaker),
// u2 (only nicknames), u9 (unrelated person in another group), and a merged pair.
// ---------------------------------------------------------------------------
withStore((store, imagesDir) => {
  seedImage(store, imagesDir, G1, 'a.png', { speaker: '投稿A', content: '经典语录', createdAt: 1_700_000_000, subjectUser: 'u1', subjectName: '小明同学' });
  seedImage(store, imagesDir, G1, 'b.png', { speaker: '投稿B', content: '第二条', createdAt: 1_700_000_100, subjectUser: 'u1', subjectName: '小明' });
  seedImage(store, imagesDir, G1, 'c.png', { speaker: '投稿A', content: '第三条', createdAt: 1_700_000_200, subjectUser: 'u1', subjectName: '小明同学' });
  seedImage(store, imagesDir, G1, 'f.png', { speaker: '投稿A', content: '第四条', createdAt: 1_700_000_250, subjectUser: 'u1', subjectName: '阿明' });
  seedImage(store, imagesDir, G2, 'd.png', { speaker: '投稿C', content: '群二语录', createdAt: 1_700_000_300, subjectUser: 'u1', subjectName: '明明' });
  seedImage(store, imagesDir, G1, 'e.png', { speaker: '投稿B', content: '另一个人的', createdAt: 1_700_000_400, subjectUser: 'u9', subjectName: '路人甲' });

  addAlias(store, 'manual', '小明', 'u1');
  addAlias(store, 'learned', '小明同学', 'u1', { confidence: 0.78 });
  addAlias(store, 'merge', '明明', 'u1', { confidence: 0.6 });

  const map = store.starMap({ personId: 'u1' });
  assert.equal(map.ok, true);
  assert.equal(map.person.person_id, 'u1');
  assert.equal(map.person.target_user_id, 'u1');
  assert.equal(map.person.display_name, '小明', 'manual alias wins the centre label');
  assert.equal(map.person.avatar_sha, '');
  assert.equal(map.person.total, 5);
  assert.deepEqual(map.person.groups, [G1, G2]);

  // Nodes: exactly one centre, aliases keep their source/confidence, nicknames
  // keep counts, and submitter names never appear (v0.19.0 dropped weak spokes).
  const centre = map.nodes.find((node) => node.kind === 'person');
  assert.ok(centre);
  assert.equal(centre.id, 'person:u1');
  assert.equal(centre.label, '小明');
  assert.equal(centre.count, 5);

  const aliases = map.nodes.filter((node) => node.kind === 'alias');
  // The manual alias that becomes the centre label is not duplicated as a spoke.
  assert.deepEqual(aliases.map((node) => node.source).sort(), ['learned', 'merge']);
  assert.equal(centre.source, 'manual');
  assert.ok(!aliases.some((node) => node.label === '小明'), 'centre alias is not repeated');
  const learned = aliases.find((node) => node.source === 'learned');
  assert.equal(learned.label, '小明同学');
  assert.ok(Math.abs(learned.confidence - 0.78) < 1e-9);
  for (const node of aliases) {
    assert.equal(node.group_id, G1);
    assert.equal(node.weak, undefined, 'alias nodes carry no weak flag');
    assert.equal(node.kind, 'alias');
  }
  // The person payload lists every recorded alias (with source/confidence/group)
  // and every remembered subject_name, so the page can render both lists.
  assert.deepEqual(
    map.person.aliases.map((row) => [row.name, row.source]).sort(),
    [['小明', 'manual'], ['小明同学', 'learned'], ['明明', 'merge']].sort(),
    'every recorded alias is listed',
  );
  const aliasRow = map.person.aliases.find((row) => row.name === '小明同学');
  assert.ok(Math.abs(aliasRow.confidence - 0.78) < 1e-9);
  assert.equal(aliasRow.group_id, G1);
  assert.deepEqual(
    map.person.names.map((row) => row.name),
    ['阿明'],
    'remembered names are de-duplicated against aliases',
  );
  assert.equal(map.person.names[0].count, 1);
  assert.deepEqual(map.person.names[0].groups, [G1]);

  // The alias 小明同学 shadows the identical subject_name: one node, not two.
  const nicknames = map.nodes.filter((node) => node.kind === 'nickname');
  assert.ok(nicknames.length >= 1);
  assert.ok(nicknames.some((node) => node.label === '阿明'), 'a fresh nickname becomes a spoke');
  assert.ok(!nicknames.some((node) => node.label === '小明同学'), 'alias/nickname duplicates collapse');

  // Submitters used to show up as weak spokes; v0.19.0 removed them entirely.
  assert.equal(map.nodes.filter((node) => node.weak).length, 0, 'no weak nodes remain');
  for (const name of ['投稿A', '投稿B', '投稿C']) {
    assert.ok(!map.nodes.some((node) => node.label === name), `${name} never becomes a node`);
  }
  assert.ok(!map.nodes.some((node) => node.label === '路人甲'), 'other people never leak in');

  // Edges: every edge points at the centre, and only spokes are ever sources.
  assert.ok(map.edges.length === map.nodes.length - 1);
  const ids = new Set(map.nodes.map((node) => node.id));
  for (const edge of map.edges) {
    assert.equal(edge.to, centre.id);
    assert.ok(ids.has(edge.from), 'edge.from must reference a node');
    assert.notEqual(edge.from, centre.id);
    assert.ok(['alias', 'nickname'].includes(edge.kind));
    assert.ok(edge.weight > 0 && edge.weight <= 1);
  }
  // No alias-to-alias or nickname-to-nickname edges.
  const sources = new Set(map.edges.map((edge) => edge.from));
  assert.equal(sources.size, map.edges.length);

  assert.equal(map.stats.aliases, map.person.aliases.length, 'stats counts every recorded alias');
  assert.equal(map.stats.aliases, aliases.length + 1, 'the centre alias is counted in stats only');
  assert.equal(map.stats.nicknames, map.person.names.length, 'stats counts every remembered name');
  assert.equal(map.stats.weak, undefined, 'stats no longer counts weak spokes');
  assert.equal(map.stats.groups, 2);
  assert.equal(map.stats.quotes, 5);
  assert.ok(map.stats.last_updated >= 1_700_000_000);

  // Group filtering: alias rows of G1 drop out, nickname/county focus on G2.
  const onlyG2 = store.starMap({ personId: 'u1', group: G2 });
  assert.equal(onlyG2.ok, true);
  assert.deepEqual(onlyG2.person.groups, [G2]);
  assert.equal(onlyG2.person.total, 1);
  assert.equal(onlyG2.person.display_name, '明明');
  assert.equal(onlyG2.nodes.filter((node) => node.kind === 'alias').length, 0);
  const onlyG2Centre = onlyG2.nodes.find((node) => node.kind === 'person');
  assert.equal(onlyG2Centre.label, '明明');
  assert.ok(!onlyG2.nodes.some((node) => node.kind === 'nickname'), 'single-name group has no nickname spokes');
  assert.equal(onlyG2.stats.weak, undefined);

  // Lookup by user_id works the same way as person_id.
  const byUser = store.starMap({ userId: 'u1' });
  assert.equal(byUser.ok, true);
  assert.equal(byUser.person.display_name, '小明');

  // A person without aliases is still a valid (single-spoke) star.
  const bare = store.starMap({ personId: 'u9' });
  assert.equal(bare.ok, true);
  assert.equal(bare.person.display_name, '路人甲');
  assert.equal(bare.nodes.filter((node) => node.kind === 'alias').length, 0);
  assert.equal(bare.nodes.filter((node) => node.kind === 'person').length, 1);

  // Unknown people fail softly instead of throwing.
  const missing = store.starMap({ personId: 'nope' });
  assert.equal(missing.ok, false);
  assert.ok(missing.error);
  assert.equal(store.starMap({}).ok, false);
  assert.ok(store.starMap({}).error.includes('required'));

  // Index: one row per person, with alias/nickname/quote counters.
  const index = store.starIndex({});
  assert.equal(index.ok, true);
  assert.equal(index.total, 2);
  const u1row = index.items.find((item) => item.person_id === 'u1');
  assert.ok(u1row);
  assert.equal(u1row.target_user_id, 'u1');
  assert.equal(u1row.display_name, '小明');
  assert.equal(u1row.aliases, 3);
  assert.equal(u1row.quotes, 5);
  assert.deepEqual(u1row.groups, [G1, G2]);
  const u9row = index.items.find((item) => item.person_id === 'u9');
  assert.ok(u9row);
  assert.equal(u9row.aliases, 0);
  assert.equal(u9row.quotes, 1);
  assert.deepEqual(index.items.map((item) => item.person_id), ['u1', 'u9'], 'sorted by quote count');

  // Group-scoped index only contains people mentioned in that group.
  const indexG2 = store.starIndex({ group: G2 });
  assert.deepEqual(indexG2.items.map((item) => item.person_id), ['u1']);
  assert.equal(indexG2.items[0].quotes, 1);
});

// ---------------------------------------------------------------------------
// Merged identities collapse into one person in both the map and the index.
// ---------------------------------------------------------------------------
withStore((store, imagesDir) => {
  seedImage(store, imagesDir, G1, 'm1.png', { subjectUser: 'm1', subjectName: '甲' });
  seedImage(store, imagesDir, G1, 'm2.png', { subjectUser: 'm2', subjectName: '乙' });
  const merged = store.identityMerge(['m1', 'm2']);
  assert.equal(merged.ok, true);

  const map = store.starMap({ personId: 'm1' });
  assert.equal(map.ok, true);
  assert.equal(map.person.person_id, 'm1');
  assert.equal(map.person.total, 2);
  const mergedCentre = map.nodes.find((node) => node.kind === 'person');
  assert.equal(mergedCentre.label, '乙');
  assert.ok(map.nodes.some((node) => node.kind === 'nickname' && node.label === '甲'));

  const index = store.starIndex({});
  const row = index.items.find((item) => item.person_id === 'm1');
  assert.ok(row);
  assert.equal(row.quotes, 2);
  assert.equal(index.items.filter((item) => item.person_id === 'm2').length, 0);
});

// ---------------------------------------------------------------------------
// Management API: identity/star_map + identity/star_index
// ---------------------------------------------------------------------------
await withStoreAsync(async (store, imagesDir) => {
  seedImage(store, imagesDir, G1, 'x.png', { speaker: '投稿A', subjectUser: 'u1', subjectName: '小明同学' });
  seedImage(store, imagesDir, G1, 'y.png', { speaker: '投稿A', subjectUser: 'u1', subjectName: '小明' });
  addAlias(store, 'manual', '小明', 'u1');
  addAlias(store, 'learned', '明哥', 'u1', { confidence: 0.7 });

  const routes = createManageRoutes({
    getStore: () => store,
    getChannel: () => null,
    getConfig: () => ({ channel: { enabled: false, groups: [G1] } }),
    getLastSync: () => null,
    discoverChannel: async () => ({ channel: { enabled: false, groups: [G1] }, candidates: [] }),
    applyCollect: async () => ({ ok: true, collect: {} }),
    getCollect: () => ({}),
    applyChannel: async () => ({ ok: true, channel: {} }),
  });
  const apiRoute = routes.find((route) => route.path === ROUTES.api);
  assert.ok(apiRoute);

  function makeReq(method, url, body) {
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:2759' },
      socket: { remoteAddress: '127.0.0.1' },
      _handlers: {},
      on(event, handler) {
        this._handlers[event] = handler;
        return this;
      },
      destroy() {},
    };
    if (body !== undefined) {
      setImmediate(() => {
        req._handlers.data && req._handlers.data(Buffer.from(JSON.stringify(body)));
        req._handlers.end && req._handlers.end();
      });
    }
    return req;
  }

  function callApi(method, rel, payload) {
    let url = `${ROUTES.api}/${rel}`;
    if (method === 'GET' && payload) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null) query.set(key, String(value));
      }
      const qs = query.toString();
      if (qs) url += `?${qs}`;
    }
    const req = makeReq(method, url, method === 'POST' ? payload || {} : undefined);
    const res = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status;
        return this;
      },
      end(body) {
        if (body !== undefined) this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
      },
    };
    return new Promise((resolve) => {
      const originalEnd = res.end.bind(res);
      res.end = (body) => {
        originalEnd(body);
        resolve({ status: res.status, body: JSON.parse(res.body || '{}') });
      };
      apiRoute.handler(req, res);
    });
  }

  await (async () => {
    const mapRes = await callApi('GET', 'identity/star_map', { person_id: 'u1', group_id: G1 });
    assert.equal(mapRes.status, 200);
    assert.equal(mapRes.body.ok, true);
    assert.equal(mapRes.body.person.display_name, '小明');
    assert.equal(mapRes.body.person.total, 2);
    assert.ok(Array.isArray(mapRes.body.nodes));
    assert.ok(Array.isArray(mapRes.body.edges));
    assert.ok(mapRes.body.nodes.some((node) => node.kind === 'alias'));
    assert.equal(mapRes.body.unsupported, undefined);

    const byUser = await callApi('GET', 'identity/star_map', { user_id: 'u1' });
    assert.equal(byUser.status, 200);
    assert.equal(byUser.body.ok, true);

    const missing = await callApi('GET', 'identity/star_map', {});
    assert.equal(missing.status, 200);
    assert.equal(missing.body.ok, false);
    assert.ok(missing.body.error);

    const unknown = await callApi('GET', 'identity/star_map', { person_id: 'nope' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.error, 'person not found');

    const indexRes = await callApi('GET', 'identity/star_index', { group_id: G1, limit: 100 });
    assert.equal(indexRes.status, 200);
    assert.equal(indexRes.body.ok, true);
    assert.equal(indexRes.body.total, 1);
    assert.equal(indexRes.body.items[0].person_id, 'u1');
    assert.ok(indexRes.body.items[0].aliases >= 1);
    assert.equal(indexRes.body.unsupported, undefined);
  })();
});

// ---------------------------------------------------------------------------
// The ported page really renders the star map (modal + canvas + endpoints).
// ---------------------------------------------------------------------------
{
  const html = readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  assert.ok(html.includes('id="star-modal"'), 'star modal markup exists');
  assert.ok(html.includes('id="star-canvas"'), 'star canvas exists');
  assert.ok(html.includes('id="star-person"'), 'person picker exists');
  assert.ok(html.includes('id="btn-people-star"'), 'people module links to the star map');
  assert.ok(html.includes('id="star-tooltip"'), 'hover tooltip exists');
  assert.ok(html.includes('id="star-legend"') || html.includes('class="star-legend"'), 'legend exists');
  assert.ok(!html.includes('star-dot weak'), 'legend no longer advertises weak spokes');
  assert.ok(html.includes('star-list') || html.includes('id="star-detail"'), 'detail panel hosts the lists');

  const script = readFileSync(path.join(WEB_DIR, 'script.js'), 'utf8');
  assert.ok(script.includes("identityStarMap: 'identity/star_map'"));
  assert.ok(script.includes("identityStarIndex: 'identity/star_index'"));
  assert.ok(script.includes('function openStarMap('));
  assert.ok(script.includes('function drawStar('));
  assert.ok(script.includes("getContext('2d')"), 'canvas rendering is hand-written');
  assert.ok(!/d3|chart\.js|vis-network/i.test(script), 'no graph library is bundled');

  assert.ok(script.includes('function renderStarLists('), 'star panel renders alias/name lists');
  assert.ok(script.includes('function focusStarNodeByLabel('));
  assert.ok(script.includes('function togglePersonNames('), 'person cards expose an expandable alias list');
  assert.ok(script.includes('function layoutStar('), 'multi-ring layout exists');
  assert.ok(!script.includes('weak'), 'no weak-spoke code paths remain in the page');

  const css = readFileSync(path.join(WEB_DIR, 'style.css'), 'utf8');
  assert.ok(css.includes('.star-stage'));
  assert.ok(css.includes('#star-canvas'));
  assert.ok(css.includes('.star-list-scroll'), 'alias/name list scrolls');
  assert.ok(css.includes('.person-actions'));
  assert.ok(css.includes('.detail-names'));
  assert.ok(!css.includes('.star-dot.weak'), 'weak legend dot was dropped');

  const bridge = readFileSync(path.join(WEB_DIR, 'bridge.js'), 'utf8');
  assert.ok(!bridge.includes("star-modal"), 'bridge must not hide the star modal');
}

console.log = realLog;
console.warn = realWarn;
console.log('star tests passed');
