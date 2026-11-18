/**
 * Offline tests for lib/alias.js + schema v9 (`person_alias` / `alias_candidate`).
 *
 * Covers nickname normalization, alias CRUD, the candidate confirm/reject flow,
 * the conservative local learning rules, the real `identity/cleanup` pass and
 * the effect of confirmed aliases on display names (people list, statistics,
 * reaction rankings and the management API). No network, no external deps.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import {
  ALIAS_CONFIRM_RATIO,
  cleanAliasName,
  looksLikeTitle,
  nameRatio,
  namesAlike,
  normalizeAliasKey,
} from '../lib/alias.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';

const GROUP = '1031430106';

function withStore(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-alias-'));
  const imagesDir = path.join(dir, 'images');
  const store = openStore(path.join(dir, 'quotes.db'), { imagesDir });
  try {
    return run(store, imagesDir, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedImage(store, imagesDir, filename, { speaker = 'tester', content = '[图片语录]', created } = {}) {
  mkdirSync(path.join(imagesDir, GROUP), { recursive: true });
  writeFileSync(path.join(imagesDir, GROUP, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  return store.addQuote({
    group: GROUP,
    speaker,
    content,
    imagePath: `${GROUP}/${filename}`,
    source: 'qq',
    createdAt: created ?? 1_700_000_000,
  });
}

// ---------------------------------------------------------------------------
// Nickname normalization helpers
// ---------------------------------------------------------------------------
assert.equal(normalizeAliasKey('  Xiao Ming  '), 'xiaoming');
assert.equal(normalizeAliasKey('阿零。'), '阿零');
assert.equal(normalizeAliasKey('ＡＢ　Ｃ'), 'abc');
assert.equal(normalizeAliasKey(''), '');
assert.ok(normalizeAliasKey('x'.repeat(120)).length <= 64);

assert.equal(looksLikeTitle('LV12 小明'), true);
assert.equal(looksLikeTitle('管理员'), true);
assert.equal(looksLikeTitle('群主：阿零'), true);
assert.equal(looksLikeTitle('小明'), false);

assert.equal(cleanAliasName('[管理]张三'), '张三');
assert.equal(cleanAliasName('LV12 小明'), '小明');
assert.equal(cleanAliasName('群主：阿零'), '阿零');
assert.equal(cleanAliasName('小明（备考中）'), '小明');
assert.equal(cleanAliasName('🌟阿零🌟'), '阿零');
assert.equal(cleanAliasName('@阿零'), '阿零');
assert.equal(cleanAliasName('   '), '');
assert.ok(cleanAliasName('很长'.repeat(30)).length <= 20);

assert.equal(nameRatio('小明', '小明'), 1);
assert.equal(namesAlike('小明', '小明同学'), true);
assert.equal(namesAlike('小明', '小红'), false);
assert.ok(ALIAS_CONFIRM_RATIO >= 0.7 && ALIAS_CONFIRM_RATIO <= 1);

// ---------------------------------------------------------------------------
// Schema v9: tables, idempotent migration and persistence
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-alias-migrate-'));
  const dbPath = path.join(dir, 'quotes.db');
  const first = openStore(dbPath);
  assert.equal(first.schemaVersion, 10);
  const alias = first.upsertAlias({ group: GROUP, aliasName: '阿零', targetUserId: 'u1', source: 'manual' });
  assert.ok(alias && alias.id > 0);
  const candidateId = first.addAliasCandidate({
    group: GROUP,
    aliasName: '零零',
    targetUserId: 'u1',
    evidence: 'test',
    confidence: 0.85,
    occurrences: 2,
  });
  assert.ok(candidateId > 0);
  first.close();

  // Reopening the same database must keep both tables and their rows.
  const second = openStore(dbPath);
  assert.equal(second.schemaVersion, 10);
  assert.equal(second.listAliases({ group: GROUP }).length, 1);
  assert.equal(second.aliasCandidateCount({ group: GROUP }), 1);
  second.close();
  const third = openStore(dbPath);
  assert.equal(third.schemaVersion, 10);
  assert.equal(third.listAliases({ group: GROUP })[0].alias_name, '阿零');
  third.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Alias CRUD, group isolation and lookup
// ---------------------------------------------------------------------------
withStore((store) => {
  const manual = store.upsertAlias({
    group: GROUP,
    aliasName: '小明',
    targetUserId: 'u1',
    personId: 'u1',
    displayName: '小明',
    source: 'manual',
    confidence: 1,
  });
  assert.equal(manual.alias_name, '小明');
  assert.equal(manual.alias_key, '小明');
  assert.equal(manual.source, 'manual');
  assert.equal(manual.group_id, GROUP);

  // Re-adding the same key for the same person updates in place.
  const updated = store.upsertAlias({ group: GROUP, aliasName: '小明', targetUserId: 'u1', confidence: 0.9 });
  assert.equal(updated.id, manual.id);
  assert.equal(updated.confidence, 1);

  // A learned entry must not downgrade a manual one.
  const afterLearned = store.upsertAlias({ group: GROUP, aliasName: '小明', targetUserId: 'u1', source: 'learned' });
  assert.equal(afterLearned.id, manual.id);
  assert.equal(afterLearned.source, 'manual');

  // Same nickname pointing at another person replaces the old target.
  const replanted = store.upsertAlias({ group: GROUP, aliasName: '小明', targetUserId: 'u2', source: 'learned' });
  assert.equal(replanted.target_user_id, 'u2');
  assert.equal(store.listAliases({ group: GROUP }).length, 1);
  // ...and the previous owner may keep a different nickname.
  store.upsertAlias({ group: GROUP, aliasName: '明明', targetUserId: 'u1', source: 'manual' });
  store.upsertAlias({ group: GROUP, aliasName: '明明同学', targetUserId: 'u1', source: 'learned' });

  // Group isolation: the same key is allowed in another group.
  store.upsertAlias({ group: '478864863', aliasName: '小明', targetUserId: 'u3', source: 'manual' });
  assert.equal(store.listAliases().length, 4);
  assert.equal(store.listAliases({ group: '478864863' }).length, 1);
  assert.equal(store.aliasesForUser('u1').length, 2);
  assert.deepEqual(
    store.aliasesForUser('u1').map((row) => row.alias_name).sort(),
    ['明明', '明明同学'],
  );

  const exact = store.lookupAlias(' 明明 ', GROUP);
  assert.equal(exact && exact.target_user_id, 'u1');
  const similar = store.lookupAlias('明明同', GROUP);
  assert.ok(similar && similar.target_user_id === 'u1');
  // Re-pointing a nickname deleted the row it used to own.
  assert.equal(store.getAlias(manual.id), null);
  assert.equal(store.getAlias(replanted.id).target_user_id, 'u2');

  assert.equal(store.deleteAlias({ id: replanted.id }), 1);
  assert.equal(store.getAlias(replanted.id), null);
  assert.equal(store.deleteAlias({ group: '478864863', aliasName: '小明' }), 1);
});

// ---------------------------------------------------------------------------
// Candidate confirm / reject flow
// ---------------------------------------------------------------------------
withStore((store) => {
  const pending = store.addAliasCandidate({
    group: GROUP,
    aliasName: '阿零',
    targetUserId: 'u1',
    personId: 'u1',
    displayName: '阿零同学',
    evidence: '群昵称变体：阿零 ≈ 阿零同学',
    confidence: 0.85,
    occurrences: 3,
  });
  assert.ok(pending > 0);
  const again = store.addAliasCandidate({
    group: GROUP,
    aliasName: '阿零',
    targetUserId: 'u1',
    evidence: 'repeat',
    confidence: 0.8,
    occurrences: 2,
  });
  assert.equal(again, pending, 'repeated pending candidates upsert in place');
  const rows = store.listAliasCandidates({ group: GROUP });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].occurrences, 3);
  assert.equal(rows[0].confidence, 0.85, 'confidence keeps the larger value');

  const alias = store.confirmAliasCandidate(pending);
  assert.ok(alias);
  assert.equal(alias.alias_name, '阿零');
  assert.equal(alias.source, 'learned');
  assert.equal(alias.target_user_id, 'u1');
  assert.equal(store.listAliasCandidates({ group: GROUP }).length, 0);
  assert.equal(store.listAliasCandidates({ group: GROUP, status: 'confirmed' }).length, 1);
  assert.equal(store.confirmAliasCandidate(pending), null, 'confirming twice is a no-op');
  // Confirmed aliases block re-learning the same nickname.
  assert.equal(
    store.addAliasCandidate({ group: GROUP, aliasName: '阿零', targetUserId: 'u1' }),
    0,
  );

  const rejected = store.addAliasCandidate({
    group: GROUP,
    aliasName: '阿零零',
    targetUserId: 'u1',
    confidence: 0.9,
    occurrences: 2,
  });
  assert.ok(rejected > 0);
  assert.equal(store.rejectAliasCandidate(rejected), true);
  assert.equal(store.rejectAliasCandidate(rejected), false);
  assert.equal(store.listAliasCandidates({ group: GROUP, status: 'rejected' }).length, 1);
  assert.equal(store.getAlias(alias.id).source, 'learned');
});

// ---------------------------------------------------------------------------
// Local learning rules (conservative)
// ---------------------------------------------------------------------------
withStore((store, imagesDir) => {
  // u1 is bound under two variants; the short one occurs twice.
  seedImage(store, imagesDir, 'a.png');
  seedImage(store, imagesDir, 'b.png');
  seedImage(store, imagesDir, 'c.png');
  seedImage(store, imagesDir, 'd.png');
  store.setSubject(GROUP, ['a.png', 'b.png'], '小明同学', 'u1');
  store.setSubject(GROUP, ['c.png', 'd.png'], '小明', 'u1');
  // u2 only has one occurrence of each name: not enough evidence.
  seedImage(store, imagesDir, 'e.png');
  seedImage(store, imagesDir, 'f.png');
  store.setSubject(GROUP, ['e.png'], '小红', 'u2');
  store.setSubject(GROUP, ['f.png'], '小红同学', 'u2');
  // Titles must never be learned as nicknames.
  seedImage(store, imagesDir, 'g.png');
  seedImage(store, imagesDir, 'h.png');
  store.setSubject(GROUP, ['g.png'], '管理员', 'u3');
  store.setSubject(GROUP, ['h.png'], '管理员', 'u3');

  const learned = store.learnAliases({ group: GROUP });
  assert.equal(learned.ok, true);
  assert.equal(learned.note, 'local-rule');
  assert.equal(learned.group_id, GROUP);
  assert.equal(typeof learned.scanned, 'number');
  assert.ok(learned.scanned >= 3);
  assert.ok(Array.isArray(learned.items));
  assert.ok(learned.added >= 1, 'the repeated variant should become a candidate');
  const names = learned.items.map((item) => item.alias_name);
  assert.ok(names.includes('小明同学'), 'the less frequent variant becomes a candidate');
  assert.ok(!names.includes('小红'), 'single occurrences stay out of the queue');
  assert.ok(!names.includes('小红同学'), 'single occurrences stay out of the queue');
  assert.ok(!names.includes('管理员'), 'titles are never aliases');
  for (const item of learned.items) {
    assert.ok(item.id > 0);
    assert.ok(item.confidence >= 0.8 && item.confidence <= 1, 'learned candidates clear the manual-review gate');
    assert.ok(item.occurrences >= 2);
    assert.ok(String(item.evidence).length > 0);
  }
  const pending = store.listAliasCandidates({ group: GROUP });
  assert.equal(pending.length, learned.added);
  // Learning twice only refreshes the same pending row.
  const second = store.learnAliases({ group: GROUP });
  assert.equal(second.added, learned.added);
  assert.equal(store.aliasCandidateCount({ group: GROUP }), learned.added);
});

// ---------------------------------------------------------------------------
// Alias "activation": display names in people/stats/reactions
// ---------------------------------------------------------------------------
withStore((store, imagesDir) => {
  seedImage(store, imagesDir, 'a.png', { speaker: '投稿A' });
  seedImage(store, imagesDir, 'b.png', { speaker: '投稿A' });
  seedImage(store, imagesDir, 'c.png', { speaker: '投稿B' });
  store.setSubject(GROUP, ['a.png', 'b.png'], '小明同学', 'u1');
  store.setSubject(GROUP, ['c.png'], '小红', 'u2');
  store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u1', emoji: '👍' });
  store.recordReaction({ groupId: GROUP, filename: 'b.png', userId: 'u2', emoji: '🔥' });

  const before = store.identityList({ group: GROUP, page: 1, pageSize: 10 });
  assert.ok(before.items.some((item) => item.display_name === '小明同学'));

  store.upsertAlias({
    group: GROUP,
    aliasName: '小明',
    targetUserId: 'u1',
    personId: 'u1',
    displayName: '小明',
    source: 'manual',
    confidence: 1,
  });

  assert.equal(store.preferredName({ userId: 'u1', group: GROUP }), '小明');
  assert.equal(store.preferredNames({ group: GROUP }).get('u1'), '小明');
  assert.equal(store.preferredPersonNames({ group: GROUP }).get('u1'), '小明');

  const people = store.identityList({ group: GROUP, page: 1, pageSize: 10 });
  const u1 = people.items.find((item) => item.person_id === 'u1' || item.user_ids.includes('u1'));
  assert.ok(u1);
  assert.equal(u1.display_name, '小明');

  const stats = store.manageStatistics({ group: GROUP });
  const ranking = stats.ranking.find((row) => row.count === 2);
  assert.ok(ranking);
  assert.equal(ranking.display_name, '小明');
  const reactionStats = store.reactionStats({ group: GROUP });
  const topPerson = reactionStats.top_persons.find((row) => row.count === 1);
  assert.ok(topPerson);
  assert.equal(topPerson.display_name, '小明');
  assert.equal(store.identityResolve('u1').display_name, '小明');
  assert.equal(store.annualReport({ pid: 'u1', year: new Date().getFullYear() }).display_name, '小明');
});

// ---------------------------------------------------------------------------
// identity/cleanup (tidy titles + OCR variants)
// ---------------------------------------------------------------------------
withStore((store, imagesDir) => {
  seedImage(store, imagesDir, 'a.png');
  seedImage(store, imagesDir, 'b.png');
  seedImage(store, imagesDir, 'c.png');
  seedImage(store, imagesDir, 'd.png');
  store.setSubject(GROUP, ['a.png'], '[管理]张三', 'u1');
  store.setSubject(GROUP, ['b.png'], '张三（备考）', 'u1');
  store.setSubject(GROUP, ['c.png'], '张三', 'u1');
  store.setSubject(GROUP, ['d.png'], '管理员', 'u2');

  const preview = store.cleanupSubjects({ group: GROUP, apply: false });
  assert.equal(preview.ok, true);
  assert.equal(preview.dry_run, true);
  assert.equal(preview.apply, false);
  assert.ok(Array.isArray(preview.unsupported) && preview.unsupported.length === 0);
  assert.equal(preview.scanned, 4);
  assert.equal(preview.bound_quotes, 4);
  assert.ok(preview.title_aliases >= 1);
  assert.ok(preview.title_quotes >= 1);
  assert.ok(preview.samples.length >= 1);
  assert.ok(preview.samples.some((line) => line.includes('张三')));
  assert.equal(preview.quotes_unbound, 0, 'dry run never writes');
  assert.ok(store.findImageQuote(GROUP, 'a.png').subjectName === '[管理]张三');

  const applied = store.cleanupSubjects({ group: GROUP, apply: true });
  assert.equal(applied.dry_run, false);
  assert.equal(applied.apply, true);
  assert.ok(applied.quotes_unbound >= 1);
  assert.equal(store.findImageQuote(GROUP, 'd.png').subjectName, '');
  assert.equal(store.findImageQuote(GROUP, 'a.png').subjectName, '张三');
  assert.equal(store.findImageQuote(GROUP, 'b.png').subjectName, '张三');
  assert.equal(store.findImageQuote(GROUP, 'c.png').subjectName, '张三');
  // The canonical name was persisted as a merge alias.
  const alias = store.lookupAlias('张三', GROUP);
  assert.ok(alias);
  assert.equal(alias.target_user_id, 'u1');
  assert.equal(alias.source, 'merge');

  // Running the pass again is idempotent.
  const again = store.cleanupSubjects({ group: GROUP, apply: true });
  assert.equal(again.quotes_unbound, 0);
  assert.equal(again.title_quotes, 0);
});

// ---------------------------------------------------------------------------
// Management API: alias endpoints are real (not shims)
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-alias-api-'));
  const imagesDir = path.join(dir, 'images');
  const store = openStore(path.join(dir, 'quotes.db'), { imagesDir });
  try {
    seedImage(store, imagesDir, 'a.png');
    seedImage(store, imagesDir, 'b.png');
    seedImage(store, imagesDir, 'c.png');
    seedImage(store, imagesDir, 'd.png');
    seedImage(store, imagesDir, 'e.png');
    seedImage(store, imagesDir, 'f.png');
    store.setSubject(GROUP, ['a.png', 'b.png'], '小明同学', 'u1');
    store.setSubject(GROUP, ['c.png', 'e.png'], '小红', 'u2');
    store.setSubject(GROUP, ['d.png', 'f.png'], '小红同学', 'u2');
    store.upsertAlias({ group: GROUP, aliasName: '小明', targetUserId: 'u1', source: 'manual' });

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

    // GET alias/candidates returns the real pending queue.
    const learn = await callApi('POST', 'alias/learn', { group_id: GROUP });
    assert.equal(learn.status, 200);
    assert.equal(learn.body.ok, true);
    assert.equal(learn.body.note, 'local-rule');
    assert.ok(learn.body.added >= 1, 'the API should enqueue local-rule candidates');

    const pending = await callApi('GET', 'alias/candidates', { group_id: GROUP, status: 'pending', limit: 100 });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.ok, true);
    assert.ok(Array.isArray(pending.body.items));
    assert.ok(pending.body.items.length >= 1);
    const candidate = pending.body.items[0];
    for (const field of ['id', 'alias_name', 'target_user_id', 'confidence', 'occurrences', 'evidence', 'status']) {
      assert.ok(field in candidate, `candidate should expose ${field}`);
    }
    assert.equal(candidate.status, 'pending');

    // Confirm → persisted alias + status change.
    const confirmed = await callApi('POST', 'alias/candidate_confirm', { id: candidate.id });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.ok, true);
    assert.equal(confirmed.body.status, 'confirmed');
    assert.equal(confirmed.body.alias.alias_name, candidate.alias_name);
    assert.equal(confirmed.body.alias.source, 'learned');
    assert.equal(
      store.lookupAlias(candidate.alias_name, GROUP).target_user_id,
      candidate.target_user_id,
    );

    // Reject → status change, no alias written.
    const extra = store.addAliasCandidate({
      group: GROUP,
      aliasName: '零零',
      targetUserId: 'u1',
      confidence: 0.9,
      occurrences: 2,
    });
    assert.ok(extra > 0);
    const rejected = await callApi('POST', 'alias/candidate_reject', { id: extra });
    assert.equal(rejected.body.ok, true);
    assert.equal(rejected.body.status, 'rejected');
    assert.equal(store.lookupAlias('零零', GROUP), null);

    // GET identity/aliases lists the person's nicknames.
    const aliases = await callApi('GET', 'identity/aliases', { user_id: 'u1' });
    assert.equal(aliases.body.ok, true);
    assert.equal(aliases.body.user_id, 'u1');
    assert.ok(aliases.body.items.some((row) => row.alias_name === '小明'));

    // quotes/bind_name binds quotes and remembers the nickname.
    const bound = await callApi('POST', 'quotes/bind_name', {
      group_id: GROUP,
      subject_name: '小红',
      person_id: 'u2',
    });
    assert.equal(bound.body.ok, true);
    assert.equal(bound.body.subject_name, '小红');
    assert.ok(bound.body.display_name);
    assert.ok(store.lookupAlias('小红', GROUP));
    assert.equal(store.lookupAlias('小红', GROUP).source, 'manual');

    // identity/cluster_merge persists merge aliases and drops the placeholder.
    const merged = await callApi('POST', 'identity/cluster_merge', {
      group_id: GROUP,
      names: ['小红', '小红同学'],
      person_id: 'u2',
    });
    assert.equal(merged.body.ok, true);
    assert.equal(merged.body.person_id, 'u2');
    assert.deepEqual(merged.body.names, ['小红', '小红同学']);
    assert.ok(merged.body.aliases >= 2);
    assert.deepEqual(merged.body.unsupported, []);
    assert.ok(!('reason' in merged.body));
    assert.equal(store.lookupAlias('小红同学', GROUP).target_user_id, 'u2');

    // identity/cleanup returns the real report and supports apply.
    const cleanupPreview = await callApi('POST', 'identity/cleanup', { group_id: GROUP, dry_run: true });
    assert.equal(cleanupPreview.body.ok, true);
    assert.equal(cleanupPreview.body.dry_run, true);
    assert.deepEqual(cleanupPreview.body.unsupported, []);
    assert.equal(typeof cleanupPreview.body.scanned, 'number');
    assert.equal(typeof cleanupPreview.body.bound_quotes, 'number');
    assert.equal(typeof cleanupPreview.body.title_aliases, 'number');
    assert.equal(typeof cleanupPreview.body.quotes_unbound, 'number');
    assert.ok(Array.isArray(cleanupPreview.body.samples));
    assert.ok(!('reason' in cleanupPreview.body));

    const cleanupApply = await callApi('POST', 'identity/cleanup', { group_id: GROUP, dry_run: false });
    assert.equal(cleanupApply.body.ok, true);
    assert.equal(cleanupApply.body.dry_run, false);
    assert.equal(cleanupApply.body.apply, true);

    // The quotes list uses the alias as the displayed subject name.
    const quotes = await callApi('GET', 'quotes', { group_id: GROUP, page: 1, page_size: 20 });
    assert.equal(quotes.body.ok, true);
    const assigned = quotes.body.items.filter((item) => item.subject_user_id === 'u1');
    assert.ok(assigned.length >= 1);
    assert.equal(assigned[0].subject_name, '小明');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('alias tests passed');
