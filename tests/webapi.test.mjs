/**
 * Route-level tests for lib/webapi.js: loopback fence, list JSON, image
 * streaming, path fencing, and the v0.3.0 stats fix (only groups that really
 * own quotes are counted).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';
import { createWebRoutes, ROUTES } from '../lib/webapi.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082', 'hex');

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'quote-webapi-test-'));
const imagesDir = path.join(tempRoot, 'images');

function makeRequest({ method = 'GET', url, host = '127.0.0.1:2759', remoteAddress = '127.0.0.1' }) {
  return { method, url, headers: { host }, socket: { remoteAddress } };
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    writableEnded: false,
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.writableEnded = true;
      if (body !== undefined) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    },
    get body() {
      return Buffer.concat(this.chunks);
    },
    get json() {
      return JSON.parse(this.body.toString('utf8'));
    },
  };
}

function routeFor(name) {
  return routes.find((route) => route.path === ROUTES[name]);
}

async function call(name, request) {
  const response = makeResponse();
  await routeFor(name).handler(request, response);
  return response;
}

const store = openStore(':memory:', { imagesDir });
const routes = createWebRoutes({ getStore: () => store, getLastSync: () => ({ at: 1700000000000, added: 2 }) });

try {
  mkdirSync(path.join(imagesDir, '1027349864'), { recursive: true });
  writeFileSync(path.join(imagesDir, '1027349864', '-112962201.png'), PNG_BYTES);

  const imageQuote = store.addQuote({
    group: '1027349864',
    speaker: 'tester',
    content: '[图片语录]',
    messageId: 'img-1',
    imagePath: '1027349864/-112962201.png',
    source: 'qq',
  });
  const textQuote = store.addQuote({ group: '1090327436', speaker: 'alice', content: '缺人不', tag: '日常' });
  // A group with no quotes must not appear in the stats group count.
  store.setGroupName('721804705', '罗德岛泥分公司');

  // 1) list returns quotes, image URL, groups and the quoted-groups count.
  const list = await call('list', makeRequest({ url: ROUTES.list + '?limit=10' }));
  assert.equal(list.statusCode, 200);
  const listBody = list.json;
  assert.equal(listBody.ok, true);
  assert.equal(listBody.total, 2);
  assert.equal(listBody.quotes.length, 2);
  const imageRow = listBody.quotes.find((row) => row.id === imageQuote.id);
  assert.equal(imageRow.hasImage, true);
  assert.equal(imageRow.imageUrl, 'quote-archive/image?id=' + imageQuote.id);
  assert.equal(imageRow.speaker, 'tester');
  assert.equal(listBody.stats.totals.quotes, 2);
  assert.equal(listBody.stats.totals.groups, 2, 'only groups that own quotes are counted');
  assert.equal(listBody.lastSync.added, 2);
  assert.ok(listBody.groups.some((row) => row.group === '721804705' && row.name === '罗德岛泥分公司'));

  // 2) search filter narrows the rows.
  const search = await call('list', makeRequest({ url: ROUTES.list + '?query=' + encodeURIComponent('缺人') }));
  assert.equal(search.statusCode, 200);
  assert.equal(search.json.quotes.length, 1);
  assert.equal(search.json.quotes[0].id, textQuote.id);
  assert.deepEqual(search.json.quotes[0].tags, ['日常']);

  // 3) fence: non-loopback peer, non-loopback Host, and POST are refused.
  const remote = await call('list', makeRequest({ url: ROUTES.list, remoteAddress: '192.168.1.20' }));
  assert.equal(remote.statusCode, 403);
  const host = await call('list', makeRequest({ url: ROUTES.list, host: 'evil.example:2759' }));
  assert.equal(host.statusCode, 403);
  const post = await call('list', makeRequest({ url: ROUTES.list, method: 'POST' }));
  assert.equal(post.statusCode, 405);

  // 4) image streams the stored bytes.
  const image = await call('image', makeRequest({ url: ROUTES.image + '?id=' + imageQuote.id }));
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.ok(image.body.equals(PNG_BYTES));

  // 5) missing / text-only / traversal image requests answer 404.
  const textImage = await call('image', makeRequest({ url: ROUTES.image + '?id=' + textQuote.id }));
  assert.equal(textImage.statusCode, 404);
  const unknownImage = await call('image', makeRequest({ url: ROUTES.image + '?id=99999' }));
  assert.equal(unknownImage.statusCode, 404);
  const escaping = store.addQuote({
    group: 'g',
    speaker: 's',
    content: 'escape',
    messageId: 'esc-1',
    imagePath: '../../etc/passwd',
  });
  const escaped = await call('image', makeRequest({ url: ROUTES.image + '?id=' + escaping.id }));
  assert.equal(escaped.statusCode, 404);

  console.log('webapi OK:', JSON.stringify({ quotes: listBody.quotes.length, groups: listBody.stats.totals.groups }));
} finally {
  store.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
