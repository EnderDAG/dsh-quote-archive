/**
 * Tests for the AstrBot-compatible management API (lib/manage.js).
 *
 * Runs against a temporary database + image folder and drives the registered
 * web routes with fake IncomingMessage / ServerResponse objects.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-archive-manage-'));
const imagesDir = path.join(tmp, 'images');
const store = openStore(path.join(tmp, 'quotes.db'), { imagesDir });
const routes = createManageRoutes({ getStore: () => store });
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

  // identity list
  {
    const people = await callApi('GET', 'identity/list', { group_id: '1031430106', page: 1, page_size: 60 });
    assert.equal(people.body.items.length, 1);
    assert.equal(people.body.items[0].display_name, 'tester');
  }

  // unknown route is not ported
  {
    const { body } = await callApi('GET', 'collections');
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

  console.log('manage OK: page + admin API contract verified');
} finally {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
}
