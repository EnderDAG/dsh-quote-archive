/**
 * Tests for the AstrBot-compatible management API (lib/manage.js).
 *
 * Runs against a temporary database + image folder and drives the registered
 * web routes with fake IncomingMessage / ServerResponse objects.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-archive-manage-'));
const imagesDir = path.join(tmp, 'images');
const store = openStore(path.join(tmp, 'quotes.db'), { imagesDir });
const fakeChannel = {
  getLoginInfo: async () => ({ user_id: '3266983948', nickname: '末炎Ender' }),
  getGroupList: async () => [{ group: '1031430106', name: '主群' }],
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
      groups: ['1031430106'],
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
    candidates: [
      {
        source: 'snowluma',
        httpUrl: 'http://127.0.0.1:3000',
        token_set: true,
        reachable: true,
        login: { userId: '3266983948', nickname: '末炎Ender' },
        groups: 1,
        error: '',
      },
    ],
    searched: { qqBridge: [], snowlumaHomes: ['C:/SnowLuma'] },
    override_path: '/tmp/channel.json',
  }),
  applyCollect: async (patch) => ({
    ok: true,
    collect: {
      autoCollect: Boolean(patch && patch.autoCollect),
      pollIntervalSec: (patch && patch.pollIntervalSec) || 300,
      groups: (patch && patch.groups) || ['1031430106'],
    },
  }),
  getCollect: () => ({ autoCollect: false, pollIntervalSec: 300, groups: ['1031430106'] }),
  applyChannel: async (patch) => ({
    ok: true,
    channel: {
      enabled: !patch || patch.enabled !== false,
      auto: false,
      source: 'snowluma',
      httpUrl: 'http://127.0.0.1:3000',
      token_set: true,
      groups: ['1031430106'],
    },
    override_path: '/tmp/channel.json',
  }),
});
const pageRoute = routes.find((route) => route.path === ROUTES.page);
const apiRoute = routes.find((route) => route.path === ROUTES.api);
assert.ok(pageRoute && apiRoute, 'routes should be registered');

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
  return { status: res.status, body: JSON.parse(res.body || '{}') };
}

function seed() {
  mkdirSync(path.join(imagesDir, '1031430106'), { recursive: true });
  writeFileSync(path.join(imagesDir, '1031430106', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  mkdirSync(path.join(imagesDir, '478864863'), { recursive: true });
  writeFileSync(path.join(imagesDir, '478864863', 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));
  store.addQuote({
    group: '1031430106',
    speaker: 'tester',
    content: '[图片语录]',
    messageId: 'm1',
    imagePath: '1031430106/a.png',
    source: 'qq',
    createdAt: 1_700_000_000,
  });
  store.addQuote({
    group: '478864863',
    speaker: 'other',
    content: '这是一条带图的语录',
    messageId: 'm2',
    imagePath: '478864863/b.png',
    source: 'qq',
    createdAt: 1_700_000_100,
  });
}

try {
  seed();

  // overview
  {
    const { body } = await callApi('GET', 'overview');
    assert.equal(body.ok, true);
    assert.equal(body.total_quotes, 2);
    assert.equal(body.groups.length, 2);
    assert.equal(body.thumbnail, false);
    assert.ok(body.data_root.replace(/\\/g, '/').endsWith('/images'));
    assert.ok(body.total_bytes > 0);
  }

  // quotes list (group one)
  {
    const { body } = await callApi('GET', 'quotes', { group_id: '1031430106', page: 1, page_size: 48 });
    assert.equal(body.ok, true);
    assert.equal(body.total, 1);
    assert.equal(body.items[0].name, 'a.png');
    assert.equal(body.items[0].caption, '');
    assert.equal(body.items[0].restricted, 0);
    assert.ok(Array.isArray(body.items[0].tags));
    assert.equal(body.pages, 1);
  }

  // quotes/search with keyword
  {
    const { body } = await callApi('GET', 'quotes/search', { group_id: '478864863', q: '带图' });
    assert.equal(body.total, 1);
    assert.equal(body.items[0].caption, '这是一条带图的语录');
  }

  // image + batch
  {
    const image = await callApi('GET', 'image', { group_id: '1031430106', name: 'a.png', size: 'original' });
    assert.equal(image.body.ok, true);
    assert.ok(String(image.body.data_url).startsWith('data:image/png;base64,'));
    const batch = await callApi('GET', 'images/batch', {
      group_id: '1031430106',
      names: 'a.png,missing.png',
      size: 'thumb',
    });
    assert.ok(batch.body.items['a.png']);
    assert.equal(batch.body.items['missing.png'], undefined);
  }

  // settings get + post
  {
    const initial = await callApi('GET', 'settings', { group_id: '1031430106' });
    assert.equal(initial.body.mode, 1);
    assert.equal(initial.body.coldown, 60);
    const saved = await callApi('POST', 'settings', { group_id: '1031430106', mode: 2, coldown: 5 });
    assert.equal(saved.body.mode, 2);
    assert.equal(saved.body.coldown, 5);
    const reloaded = await callApi('GET', 'settings', { group_id: '1031430106' });
    assert.equal(reloaded.body.coldown, 5);
  }

  // restricted toggle
  {
    const marked = await callApi('POST', 'quotes/restricted', {
      group_id: '478864863',
      names: ['b.png'],
      restricted: true,
    });
    assert.equal(marked.body.updated, 1);
    const listed = await callApi('GET', 'quotes', { group_id: '478864863', restricted: '1' });
    assert.equal(listed.body.total, 1);
  }

  // subject assignment
  {
    const assigned = await callApi('POST', 'quotes/subject', {
      group_id: '478864863',
      names: ['b.png'],
      name: '末炎',
    });
    assert.equal(assigned.body.updated, 1);
    const listed = await callApi('GET', 'quotes', { group_id: '478864863' });
    assert.equal(listed.body.items[0].subject_name, '末炎');
  }

  // move between groups
  {
    const moved = await callApi('POST', 'quotes/move', {
      from_group: '478864863',
      to_group: '1090327436',
      names: ['b.png'],
    });
    assert.deepEqual(moved.body.moved, ['b.png']);
    const overview = await callApi('GET', 'overview');
    assert.equal(overview.body.groups.length, 2);
    const target = await callApi('GET', 'quotes', { group_id: '1090327436' });
    assert.equal(target.body.total, 1);
  }

  // people module: assign subjects, list, detail, merge, split
  {
    await callApi('POST', 'quotes/subject', {
      group_id: '1031430106',
      names: ['a.png'],
      name: '测试者',
      user_id: '1001',
    });
    await callApi('POST', 'quotes/subject', {
      group_id: '1090327436',
      names: ['b.png'],
      name: '末炎',
      user_id: '1002',
    });

    const people = await callApi('GET', 'identity/list', { group_id: '1031430106', page: 1, page_size: 60 });
    assert.equal(people.body.total, 1);
    assert.equal(people.body.items[0].display_name, '测试者');
    assert.deepEqual(people.body.items[0].user_ids, ['1001']);

    const overview = await callApi('GET', 'identity/overview');
    assert.equal(overview.body.persons, 2);
    assert.equal(overview.body.users, 2);
    assert.equal(overview.body.assigned_quotes, 2);

    const detail = await callApi('GET', 'identity/detail', { person_id: '1001' });
    assert.equal(detail.body.ok, true);
    assert.equal(detail.body.is_merged, false);
    assert.equal(detail.body.user_ids.length, 1);
    assert.equal(detail.body.quotes.length, 1);

    const merged = await callApi('POST', 'identity/merge', { user_ids: ['1001', '1002'] });
    assert.equal(merged.body.ok, true);
    const overviewMerged = await callApi('GET', 'identity/overview');
    assert.equal(overviewMerged.body.persons, 1);
    const mergedDetail = await callApi('GET', 'identity/detail', { person_id: '1001' });
    assert.equal(mergedDetail.body.user_ids.length, 2);
    assert.equal(mergedDetail.body.is_merged, true);

    const split = await callApi('POST', 'identity/split', { person_id: '1001' });
    assert.equal(split.body.ok, true);
    const overviewSplit = await callApi('GET', 'identity/overview');
    assert.equal(overviewSplit.body.persons, 2);
  }

  // collections module: create / list / detail / update / add / remove / delete
  {
    const created = await callApi('POST', 'collections', {
      group_id: '1031430106',
      action: 'create',
      name: '名场面',
      desc: '测试合集',
      ids: ['a.png', 'missing.png'],
    });
    assert.equal(created.body.ok, true);
    assert.equal(created.body.collection.name, '名场面');
    assert.deepEqual(created.body.collection.ids, ['a.png']);
    const collectionId = created.body.collection.collection_id;

    const listed = await callApi('GET', 'collections', { group_id: '1031430106' });
    assert.equal(listed.body.collections.length, 1);
    assert.equal(listed.body.collections[0].count, 1);

    const detail = await callApi('GET', 'collections', {
      group_id: '1031430106',
      collection_id: collectionId,
    });
    assert.deepEqual(detail.body.collection.ids, ['a.png']);

    const updated = await callApi('POST', 'collections', {
      group_id: '1031430106',
      action: 'update',
      collection_id: collectionId,
      name: '名场面2',
    });
    assert.equal(updated.body.collection.name, '名场面2');

    const added = await callApi('POST', 'collections', {
      group_id: '1031430106',
      action: 'add',
      collection_id: collectionId,
      add_ids: ['a.png', 'missing.png'],
    });
    assert.deepEqual(added.body.collection.ids, ['a.png']);

    const removed = await callApi('POST', 'collections', {
      group_id: '1031430106',
      action: 'remove',
      collection_id: collectionId,
      remove_ids: ['a.png'],
    });
    assert.deepEqual(removed.body.collection.ids, []);

    const deleted = await callApi('POST', 'collections', {
      group_id: '1031430106',
      action: 'delete',
      collection_id: collectionId,
    });
    assert.equal(deleted.body.ok, true);
    const after = await callApi('GET', 'collections', { group_id: '1031430106' });
    assert.equal(after.body.collections.length, 0);
  }

  // weekly settings (stats panel stub, persisted in meta)
  {
    const weekly = await callApi('GET', 'weekly');
    assert.equal(weekly.body.ok, true);
    assert.equal(weekly.body.settings.enabled, false);
    const saved = await callApi('POST', 'weekly', {
      enabled: true,
      weekday: 3,
      hour: 20,
      groups: ['1031430106'],
    });
    assert.equal(saved.body.settings.enabled, true);
    assert.equal(saved.body.settings.weekday, 3);
    const reloaded = await callApi('GET', 'weekly');
    assert.equal(reloaded.body.settings.weekday, 3);
    const test = await callApi('POST', 'weekly/test', {});
    assert.deepEqual(test.body.results, []);
  }

  // DSH quick actions: status / random / send / sync
  {
    const imageDir = path.join(imagesDir, '1031430106');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(path.join(imageDir, 'dsh-qa.png'), Buffer.from('fake-image'));
    store.addQuote({
      group: '1031430106',
      speaker: 'dsh-qa',
      content: '[图片语录]',
      messageId: 'dsh-qa-1',
      imagePath: '1031430106/dsh-qa.png',
      source: 'test',
      createdAt: 1_700_000_500,
    });

    const status = await callApi('GET', 'dsh/status');
    assert.equal(status.body.ok, true);
    assert.equal(status.body.channel.enabled, true);
    assert.equal(status.body.channel.reachable, true);
    assert.equal(status.body.channel.login.nickname, '末炎Ender');

    const random = await callApi('GET', 'dsh/random', { group_id: '1031430106' });
    assert.equal(random.body.ok, true);
    assert.ok(random.body.quote && random.body.quote.name, 'random quote should carry an image name');

    const sent = await callApi('POST', 'dsh/send', {
      quote_id: random.body.quote.id,
      group_id: '1031430106',
      caption: '测试发送',
    });
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.group_id, '1031430106');
    assert.equal(sent.body.quote.id, random.body.quote.id);

    const sync = await callApi('POST', 'dsh/sync', { group_id: '1031430106' });
    assert.equal(sync.body.ok, true);
    assert.equal(sync.body.added, 0);

    // Keep the archive state used by the later assertions unchanged.
    const seeded = store.findImageQuote('1031430106', 'dsh-qa.png');
    assert.ok(seeded, 'quick-action test quote should exist before cleanup');
    store.deleteQuoteById(seeded.id);
    try {
      unlinkSync(path.join(imageDir, 'dsh-qa.png'));
    } catch (error) {
      /* ignore */
    }
  }

  // collaboration module (local records only)
  {
    const empty = await callApi('GET', 'collab/members', { group_id: '1031430106' });
    assert.deepEqual(empty.body.items, []);

    const added = await callApi('POST', 'collab/members', {
      group_id: '1031430106',
      action: 'add',
      qq: '20001',
      role: 'maintainer',
    });
    assert.equal(added.body.ok, true);
    assert.equal(added.body.items.length, 1);
    assert.equal(added.body.items[0].role_label, '维护员');

    const baseGet = await callApi('GET', 'collab/base');
    assert.equal(baseGet.body.public_base, '');
    const baseSet = await callApi('POST', 'collab/base', { public_base: 'https://example.com/quote-collab/' });
    assert.equal(baseSet.body.public_base, 'https://example.com/quote-collab/');

    const created = await callApi('POST', 'collab/tokens', {
      group_id: '1031430106',
      action: 'create',
      qq: '20001',
      role: 'maintainer',
      hours: 168,
    });
    assert.equal(created.body.ok, true);
    assert.match(created.body.link, /token=/);

    const tokens = await callApi('GET', 'collab/tokens', { group_id: '1031430106' });
    assert.equal(tokens.body.items.length, 1);
    assert.equal(tokens.body.items[0].qq, '20001');
    assert.equal(tokens.body.items[0].permanent, false);
    assert.equal(tokens.body.items[0].revoked, 0);
    assert.ok(tokens.body.items[0].expires_in > 0);

    const revoked = await callApi('POST', 'collab/tokens', {
      group_id: '1031430106',
      action: 'revoke',
      token_id: tokens.body.items[0].id,
    });
    assert.equal(revoked.body.ok, true);
    assert.equal(revoked.body.items[0].revoked, 1);

    const audit = await callApi('GET', 'collab/audit', { group_id: '1031430106', limit: 40 });
    assert.ok(audit.body.items.length >= 3);
    const actions = new Set(audit.body.items.map((item) => item.action));
    for (const action of ['member_set', 'token_create', 'token_revoke']) {
      assert.ok(actions.has(action), `missing audit action ${action}`);
    }
    const tokenCreate = audit.body.items.find((item) => item.action === 'token_create');
    const undo = await callApi('POST', 'collab/audit', { id: tokenCreate.id });
    assert.equal(undo.body.ok, true);
    assert.equal(undo.body.changed, 1);

    const removed = await callApi('POST', 'collab/members', {
      group_id: '1031430106',
      action: 'remove',
      qq: '20001',
    });
    assert.equal(removed.body.ok, true);
    assert.deepEqual(removed.body.items, []);
    await callApi('POST', 'collab/base', { public_base: '' });
  }

  // unknown route is not ported
  {
    const { body } = await callApi('GET', 'nope/route');
    assert.equal(body.ok, false);
    assert.match(body.error, /not ported/);
  }

  // non-loopback client rejected
  {
    const { status, body } = await callApi('GET', 'overview', undefined, { remoteAddress: '10.1.2.3' });
    assert.equal(status, 403);
    assert.equal(body.ok, false);
  }

  // static page + traversal guard
  {
    const page = await call(pageRoute, 'GET', ROUTES.page + '/index.html');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('语录'));
    assert.match(page.headers['content-type'], /text\/html/);
    const script = await call(pageRoute, 'GET', ROUTES.page + '/bridge.js');
    assert.equal(script.status, 200);
    assert.ok(script.body.includes('AstrBotPluginPage'));
    const denied = await call(pageRoute, 'GET', ROUTES.page + '/..%2Fpackage.json');
    assert.equal(denied.status, 404);
  }

  // delete quote + whole group
  {
    const deleted = await callApi('POST', 'quotes/delete', { group_id: '1031430106', names: ['a.png'] });
    assert.deepEqual(deleted.body.deleted, ['a.png']);
    const remaining = await callApi('GET', 'overview');
    assert.equal(remaining.body.total_quotes, 1);
    const wiped = await callApi('POST', 'group/delete', { group_id: '1090327436', confirm: true });
    assert.equal(wiped.body.deleted, 1);
    const empty = await callApi('GET', 'overview');
    assert.equal(empty.body.total_quotes, 0);
  }

  // trash round-trip + statistics + insights
  {
    const trashA = await callApi('GET', 'trash', { group_id: '1031430106' });
    assert.ok(trashA.body.total >= 1);
    assert.equal(trashA.body.items[0].name, 'a.png');
    assert.equal(trashA.body.items[0].meta.nickname, 'tester');
    const restored = await callApi('POST', 'trash/restore', { group_id: '1031430106', names: ['a.png'] });
    assert.deepEqual(restored.body.restored, ['a.png']);
    const afterRestore = await callApi('GET', 'quotes', { group_id: '1031430106' });
    assert.equal(afterRestore.body.total, 1);
    assert.ok(existsSync(path.join(imagesDir, '1031430106', 'a.png')));
    const trashB = await callApi('GET', 'trash', { group_id: '1090327436' });
    assert.equal(trashB.body.total, 1);
    const purged = await callApi('POST', 'trash/purge', { group_id: '1090327436', all: true });
    assert.equal(purged.body.purged, 1);
    const trashAfter = await callApi('GET', 'trash', { group_id: '1090327436' });
    assert.equal(trashAfter.body.total, 0);

    const stats = await callApi('GET', 'statistics', { top: 10, days: 30 });
    assert.equal(stats.body.totals.quotes, 1);
    assert.equal(stats.body.totals.groups, 1);
    assert.equal(stats.body.totals.contributors, 1);
    assert.ok(stats.body.trend.length === 30);
    assert.equal(stats.body.trend[29].count, 0);
    assert.equal(stats.body.groups[0].group_id, '1031430106');

    const heat = await callApi('GET', 'insights/heatmap', { days: 3650 });
    assert.equal(heat.body.hours.length, 24);
    assert.equal(heat.body.hours[0].length, 7);
    assert.equal(heat.body.total, 1);
    assert.equal(heat.body.calendar.length, 182);

    const timeline = await callApi('GET', 'insights/timeline', { pid: 'tester' });
    assert.equal(timeline.body.total, 1);
    assert.equal(timeline.body.months.length, 1);
    assert.ok(Array.isArray(timeline.body.top_tags));
  }

  // dsh/collect: persist auto-collect settings from the quick-actions panel
  const collectStatus = await callApi('GET', 'dsh/status');
  assert.equal(collectStatus.status, 200);
assert.ok(collectStatus.body.collect, 'status should include collect settings');
assert.equal(collectStatus.body.collect.pollIntervalSec, 300);

  const collectSaved = await callApi('POST', 'dsh/collect', {
  autoCollect: true,
  pollIntervalSec: 120,
  group: '1031430106',
});
assert.equal(collectSaved.status, 200);
assert.equal(collectSaved.body.ok, true);
assert.equal(collectSaved.body.collect.autoCollect, true);
assert.equal(collectSaved.body.collect.pollIntervalSec, 120);

  const collectEmpty = await callApi('POST', 'dsh/collect', {});
assert.equal(collectEmpty.body.ok, false);
assert.match(collectEmpty.body.error, /采集设置/);

// dsh/discover, dsh/enable and dsh/disable
const discovery = await callApi('GET', 'dsh/discover');
assert.equal(discovery.status, 200);
assert.equal(discovery.body.ok, true);
assert.equal(discovery.body.channel.reachable, true);
assert.equal(discovery.body.channel.source, 'snowluma');
const enabled = await callApi('POST', 'dsh/enable', {});
assert.equal(enabled.body.ok, true);
assert.equal(enabled.body.channel.enabled, true);
const disabledChannel = await callApi('POST', 'dsh/disable', {});
assert.equal(disabledChannel.body.channel.enabled, false);

console.log('manage OK: page + admin API contract verified');
} finally {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
}
