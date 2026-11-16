/**
 * Offline tests for lib/semantic.js + schema v10 (`semantic_doc`, `semantic_term`,
 * `semantic_meta`) and the real `semantic/*` admin endpoints.
 *
 * The DSH edition has no vision/embedding model, so retrieval is a local BM25
 * index over quote text. These tests cover tokenisation, ranking, incremental
 * builds, the async run/progress state machine, reset, group isolation and the
 * `quotes?mode=semantic` search contract used by the management page.
 * No network, no external dependencies.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import {
  BM25_B,
  BM25_K1,
  DOC_TEXT_LIMIT,
  SEMANTIC_CAPTION_PROVIDER,
  SEMANTIC_PROVIDER,
  SEMANTIC_VERSION,
  buildSemanticText,
  normalizeText,
  semanticSignature,
  tokenize,
} from '../lib/semantic.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';

const GROUP = '1031430106';
const OTHER_GROUP = '478864863';

function withStore(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-semantic-'));
  const imagesDir = path.join(dir, 'images');
  const store = openStore(path.join(dir, 'quotes.db'), { imagesDir });
  try {
    return run(store, imagesDir, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedImage(store, imagesDir, filename, { group = GROUP, speaker = 'tester', content = '[图片语录]', created, tag } = {}) {
  mkdirSync(path.join(imagesDir, group), { recursive: true });
  writeFileSync(path.join(imagesDir, group, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  const added = store.addQuote({
    group,
    speaker,
    content,
    imagePath: `${group}/${filename}`,
    source: 'qq',
    tag,
    createdAt: created ?? 1_700_000_000,
  });
  return Number(added.id) || 0;
}

// ---------------------------------------------------------------------------
// Tokenisation and document text
// ---------------------------------------------------------------------------
assert.equal(normalizeText('ＡＢ　Ｃ！'), 'ab c');
assert.equal(normalizeText(null), '');
assert.equal(SEMANTIC_VERSION, 'local-bm25-v1');
assert.equal(SEMANTIC_PROVIDER.id, 'local-bm25');
assert.equal(SEMANTIC_PROVIDER.dimension, 0);
assert.equal(SEMANTIC_PROVIDER.ready, true);
assert.equal(SEMANTIC_CAPTION_PROVIDER, 'local-bm25');
assert.ok(BM25_K1 > 0 && BM25_B >= 0 && BM25_B <= 1);
assert.ok(DOC_TEXT_LIMIT >= 500);

{
  const tokens = tokenize('今天吃饭了吗 Hello World #tag');
  for (const expected of ['吃', '饭', '吃饭', 'hello', 'world', 'tag']) {
    assert.ok(tokens.includes(expected), `tokenize should include ${expected}`);
  }
  // Function words never survive on their own.
  assert.ok(!tokens.includes('了'));
  assert.ok(!tokens.includes('吗'));
  assert.ok(!tokens.includes('的'));
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(null), []);
  // Single ASCII characters are dropped, CJK characters are kept.
  assert.deepEqual(tokenize('a'), []);
  assert.deepEqual(tokenize('吃'), ['吃']);
}

{
  const text = buildSemanticText({
    content: '今天吃饭了吗',
    speaker: '小明',
    subjectName: '阿零',
    groupName: '测试群',
    tags: ['搞笑', '名场面'],
    collections: ['吃饭合集'],
  });
  for (const part of ['今天吃饭了吗', '小明', '阿零', '测试群', '搞笑', '名场面', '吃饭合集']) {
    assert.ok(text.includes(part), `document text should include ${part}`);
  }
  // Placeholder captions are not worth indexing.
  assert.equal(buildSemanticText({ content: '[图片语录]', speaker: '小明' }), '小明');
  assert.ok(buildSemanticText({ content: 'x'.repeat(5000) }).length <= DOC_TEXT_LIMIT + 32);

  const signature = semanticSignature(text);
  assert.match(signature, /^[0-9a-f]{16}$/);
  assert.equal(semanticSignature(text), signature);
  assert.notEqual(semanticSignature(`${text} `), signature);
}

// ---------------------------------------------------------------------------
// Schema v10: idempotent migration keeps the index across reopens
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-semantic-migrate-'));
  const dbPath = path.join(dir, 'quotes.db');
  const imagesDir = path.join(dir, 'images');
  const first = openStore(dbPath, { imagesDir });
  assert.equal(first.schemaVersion, 10);
  seedImage(first, imagesDir, 'a.png', { content: '今天吃饭了吗' });
  const plan = first.semanticPlan({ group: GROUP });
  assert.equal(plan.total, 1);
  assert.equal(plan.targets.length, 1);
  assert.equal(first.semanticIndex(plan.targets).indexed, 1);
  first.close();

  const second = openStore(dbPath, { imagesDir });
  assert.equal(second.schemaVersion, 10);
  // Already indexed: nothing left to do, and the search index survived.
  assert.equal(second.semanticPlan({ group: GROUP }).targets.length, 0);
  const hits = second.semanticSearch({ group: GROUP, q: '吃饭' });
  assert.ok(hits.items.length >= 1);
  second.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Indexing, ranking, incrementality and group isolation
// ---------------------------------------------------------------------------
withStore((store, imagesDir) => {
  const a = seedImage(store, imagesDir, 'a.png', {
    content: '今天去吃饭了吗',
    speaker: '小明',
    created: 1_700_000_100,
    tag: ['吃饭', '搞笑'],
  });
  seedImage(store, imagesDir, 'b.png', { content: '周末爬山看日落', speaker: '小红', created: 1_700_000_200 });
  seedImage(store, imagesDir, 'c.png', { content: '晚上吃火锅真开心', speaker: '小刚', created: 1_700_000_300 });
  seedImage(store, imagesDir, 'd.png', { content: 'Hello World conference talk', speaker: 'Alice', created: 1_700_000_400 });
  seedImage(store, imagesDir, 'e.png', { content: '无聊的周一早晨', speaker: '小明', created: 1_700_000_500 });
  const other = seedImage(store, imagesDir, 'f.png', { group: OTHER_GROUP, content: '另一个群的爬山记录' });
  assert.ok(a > 0 && other > 0);
  store.setSubject(GROUP, ['a.png'], '小明同学', 'u1');

  const firstPlan = store.semanticPlan({ group: GROUP });
  assert.equal(firstPlan.total, 5);
  assert.equal(firstPlan.targets.length, 5);
  assert.ok(firstPlan.targets.every((doc) => doc.groupId === GROUP));

  const written = store.semanticIndex(firstPlan.targets);
  assert.equal(written.indexed, 5);
  assert.equal(written.failed, 0);

  // Nothing is pending once every document was indexed.
  assert.equal(store.semanticPlan({ group: GROUP }).targets.length, 0);
  const status = store.semanticStatus({ group: GROUP });
  assert.equal(status.totals.total, 5);
  assert.equal(status.totals.done, 5);
  assert.equal(status.totals.pending, 0);
  assert.equal(status.groups.length, 1);
  assert.equal(status.groups[0].group_id, GROUP);

  const hits = store.semanticSearch({ group: GROUP, q: '吃饭' });
  assert.ok(hits.items.length >= 2, 'both eating quotes should match');
  assert.equal(hits.items[0].id, a, 'the exact 吃饭 quote should rank first');
  assert.equal(hits.items[0].score, 1, 'top hit is normalised to 1');
  for (let index = 1; index < hits.items.length; index += 1) {
    assert.ok(hits.items[index - 1].score >= hits.items[index].score);
  }
  assert.ok(String(hits.items[0].semanticText || '').includes('吃饭'));
  assert.ok(hits.terms.includes('吃饭'));

  // Absent topics and empty queries stay empty instead of throwing.
  assert.equal(store.semanticSearch({ group: GROUP, q: '量子物理' }).items.length, 0);
  assert.equal(store.semanticSearch({ group: GROUP, q: '' }).items.length, 0);

  // minScore keeps only strong matches.
  const strong = store.semanticSearch({ group: GROUP, q: '吃饭', minScore: 0.99 });
  assert.equal(strong.items.length, 1);

  // Group isolation: the other group has its own index row only.
  assert.equal(store.semanticSearch({ group: OTHER_GROUP, q: '吃饭' }).items.length, 0);
  assert.equal(store.semanticStatus({ group: OTHER_GROUP }).totals.total, 1);
  assert.equal(store.semanticStatus({ group: OTHER_GROUP }).totals.pending, 1);

  // A brand new quote becomes the only pending target.
  seedImage(store, imagesDir, 'g.png', { content: '新语录关于爬山', created: 1_700_000_600 });
  const incremental = store.semanticPlan({ group: GROUP });
  assert.equal(incremental.total, 6);
  assert.equal(incremental.targets.length, 1);
  store.semanticIndex(incremental.targets);
  assert.equal(store.semanticPlan({ group: GROUP }).targets.length, 0);
  assert.equal(store.semanticStatus({ group: GROUP }).totals.done, 6);

  // Provider metadata is the local BM25 descriptor (no model download).
  const provider = store.semanticProvider();
  assert.equal(provider.embedding.id, 'local-bm25');
  assert.equal(provider.embedding.model, 'char-ngram');
  assert.equal(provider.embedding.dimension, 0);
  assert.equal(provider.captionProviderId, 'local-bm25');
  assert.equal(provider.signature, SEMANTIC_VERSION);

  // Reset only clears the requested group.
  const cleared = store.semanticReset({ group: GROUP });
  assert.ok(cleared >= 6);
  assert.equal(store.semanticStatus({ group: GROUP }).totals.pending, 6);
  assert.equal(store.semanticStatus({ group: OTHER_GROUP }).totals.pending, 1);
  assert.equal(store.semanticSearch({ group: GROUP, q: '吃饭' }).items.length, 0);
});

// ---------------------------------------------------------------------------
// Empty database: everything is a no-op, never a crash
// ---------------------------------------------------------------------------
withStore((store) => {
  assert.equal(store.semanticPlan({}).total, 0);
  assert.equal(store.semanticStatus({}).totals.total, 0);
  assert.deepEqual(store.semanticSearch({ q: 'anything' }).items, []);
  assert.equal(store.semanticReset({}), 0);
  assert.equal(store.semanticProvider().embedding.ready, true);
});

// ---------------------------------------------------------------------------
// Admin API: status / run→progress / semantic search / reset
// ---------------------------------------------------------------------------
await (async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-semantic-api-'));
  const imagesDir = path.join(dir, 'images');
  const store = openStore(path.join(dir, 'quotes.db'), { imagesDir });
    seedImage(store, imagesDir, 'a.png', { content: '今天去吃饭了吗', speaker: '小明' });
    seedImage(store, imagesDir, 'b.png', { content: '周末爬山看日落', speaker: '小红' });
    seedImage(store, imagesDir, 'c.png', { content: '晚上吃火锅真开心', speaker: '小刚' });

    try {
      const routes = createManageRoutes({
      getStore: () => store,
      getChannel: () => null,
      getConfig: () => ({ channel: { enabled: false, groups: [GROUP] } }),
      getLastSync: () => null,
      discoverChannel: async () => ({ channel: { enabled: false, groups: [GROUP] }, candidates: [] }),
      applyCollect: async () => ({ ok: true, collect: {} }),
      getCollect: () => ({}),
      applyChannel: async () => ({ ok: true, channel: {} }),
    });
    const apiRoute = routes.find((route) => route.path === ROUTES.api);
    assert.ok(apiRoute, 'admin api route should be registered');

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

    // Real status: local provider, no model, nothing indexed yet.
    const status = await callApi('GET', 'semantic/status', { group_id: GROUP });
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.embedding.id, 'local-bm25');
    assert.equal(status.body.embedding.model, 'char-ngram');
    assert.equal(status.body.embedding.dimension, 0);
    assert.equal(status.body.embedding.ready, true);
    assert.equal(status.body.caption_provider_id, 'local-bm25');
    assert.equal(status.body.ready, true);
    assert.equal(typeof status.body.signature, 'string');
    assert.equal(status.body.totals.total, 3);
    assert.equal(status.body.totals.pending, 3);
    assert.equal(status.body.task.running, false);

    // Reset requires explicit confirmation.
    const resetDenied = await callApi('POST', 'semantic/reset', { group_id: GROUP });
    assert.equal(resetDenied.body.ok, false);
    assert.match(String(resetDenied.body.error || ''), /确认/);

    // Run builds the index asynchronously; progress converges to finished.
    const run = await callApi('POST', 'semantic/run', { group_id: GROUP, scope: 'pending' });
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true);
    assert.equal(run.body.started, true);
    assert.ok(run.body.task && typeof run.body.task === 'object');

    let progress = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      progress = await callApi('GET', 'semantic/progress');
      if (progress.body.task && progress.body.task.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(progress, 'progress endpoint should answer');
    assert.equal(progress.body.ok, true);
    assert.ok(progress.body.task, 'progress should expose a task');
    assert.equal(progress.body.task.running, false);
    assert.equal(progress.body.task.total, 3);
    assert.equal(progress.body.task.processed, 3);
    assert.equal(progress.body.task.ok, 3);
    assert.equal(progress.body.task.failed, 0);
    assert.ok(progress.body.task.finished_at > 0);
    assert.equal(progress.body.task.error, '');

    // Cancel on an idle task is a harmless no-op.
    const cancel = await callApi('POST', 'semantic/run', { action: 'cancel' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.ok, true);
    assert.equal(cancel.body.cancelled, false);

    // Title the local caption provider so the page does not warn.
    const afterStatus = await callApi('GET', 'semantic/status', { group_id: GROUP });
    assert.equal(afterStatus.body.totals.done, 3);
    assert.equal(afterStatus.body.totals.pending, 0);
    assert.equal(afterStatus.body.caption_provider_id, 'local-bm25');

    // Semantic browse mode used by the page's search box.
    const search = await callApi('GET', 'quotes', {
      group_id: GROUP,
      mode: 'semantic',
      q: '吃饭',
      min_score: 0.2,
      page: 1,
      page_size: 20,
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.ok, true);
    assert.equal(search.body.mode, 'semantic');
    assert.ok(search.body.items.length >= 1);
    assert.ok(search.body.total >= 1);
    assert.deepEqual(search.body.terms, ['吃', '饭', '吃饭']);
    for (const item of search.body.items) {
      assert.ok(typeof item.score === 'number' && item.score > 0 && item.score <= 1);
      assert.equal(item.semantic_status, 'done');
      assert.equal(item.has_vector, true);
      assert.equal(typeof item.semantic_text, 'string');
      assert.ok('name' in item && 'caption' in item && 'tags' in item);
    }
    for (let index = 1; index < search.body.items.length; index += 1) {
      assert.ok(search.body.items[index - 1].score >= search.body.items[index].score);
    }

    // A zero min_score exposes the weaker (single-character) match too.
    const broad = await callApi('GET', 'quotes', { group_id: GROUP, mode: 'semantic', q: '吃饭', min_score: 0 });
    assert.equal(broad.body.ok, true);
    assert.equal(broad.body.items.length, 2);
    assert.equal(broad.body.items[0].score, 1);
    assert.ok(broad.body.items[1].score < 1);

    // A high min_score narrows the result set instead of erroring.
    const narrow = await callApi('GET', 'quotes', { group_id: GROUP, mode: 'semantic', q: '吃饭', min_score: 0.99 });
    assert.equal(narrow.body.ok, true);
    assert.equal(narrow.body.items.length, 1);

    // Confirmed reset clears the group index and reports the row count.
    const cleared = await callApi('POST', 'semantic/reset', { group_id: GROUP, confirm: true });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.ok, true);
    assert.equal(cleared.body.group_id, GROUP);
    assert.ok(cleared.body.cleared >= 3);
    const emptied = await callApi('GET', 'semantic/status', { group_id: GROUP });
    assert.equal(emptied.body.totals.pending, 3);
    assert.equal(emptied.body.totals.done, 0);

  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

console.log('semantic tests passed');
