/**
 * Tests for the annual report (lib/store.js `annualReport`, lib/annual.js SVG).
 *
 * Builds a temporary archive with 3 groups × 20 image quotes (spread across
 * months and hours of 2024), then checks the statistics field by field against
 * AstrBot v3.1.0's `annual_report_sync` contract, renders the SVG poster and
 * finally drives the management API routes the page uses.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';
import {
  REPORT_HEIGHT,
  REPORT_WIDTH,
  annualFileName,
  annualHighlights,
  annualImageDataUrl,
  buildAnnualSvg,
} from '../lib/annual.js';

const YEAR = 2024;
const GROUPS = ['g1001', 'g1002', 'g1003'];
const MINE = { user: 'u1', name: 'Alice' };
const BOB = { user: 'u2', name: 'Bob' };

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-archive-annual-'));
const imagesDir = path.join(tmp, 'images');
const store = openStore(path.join(tmp, 'quotes.db'), { imagesDir });

const ts = (year, month, day, hour) => Math.floor(new Date(year, month, day, hour, 0, 0).getTime() / 1000);

/** Seed 3 groups × 20 quotes, with `u1` owning the first 20 and `u2` the next 15. */
const seeded = [];
for (const [groupIndex, group] of GROUPS.entries()) {
  mkdirSync(path.join(imagesDir, group), { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    const absolute = groupIndex * 20 + index;
    const month = absolute % 12;
    const day = 1 + (absolute % 20);
    const hour = (absolute * 3 + groupIndex) % 24;
    const createdAt = ts(YEAR, month, day, hour);
    const filename = `q${absolute}.png`;
    const content = absolute % 5 === 0 ? '[图片语录]' : `语录 ${absolute}`;
    const tags = absolute % 3 === 0 ? ['tagA', 'tagC'] : absolute % 3 === 1 ? ['tagA'] : [];
    const subject = groupIndex === 0 && index < 20 ? MINE : groupIndex === 1 && index < 15 ? BOB : null;
    const speaker = subject === MINE ? (index < 12 ? '投稿A' : '投稿B') : `speaker${absolute}`;
    store.addQuote({
      group,
      speaker,
      content,
      messageId: `m${absolute}`,
      imagePath: `${group}/${filename}`,
      source: 'qq',
      tag: tags,
      createdAt,
    });
    if (subject) store.setSubject(group, [filename], subject.name, subject.user);
    seeded.push({ absolute, group, filename, content, tags, subject, speaker, createdAt });
  }
}
const mine = seeded.filter((row) => row.subject === MINE);

// Reaction / comment rows inside and outside the 2024 window.
store.recordReaction({ groupId: 'g1001', filename: 'q0.png', userId: 'u9', emoji: '👍', createdAt: ts(2024, 5, 1, 10) });
store.recordReaction({ groupId: 'g1001', filename: 'q0.png', userId: 'u8', emoji: '❤️', createdAt: ts(2024, 5, 2, 11) });
store.recordReaction({ groupId: 'g1001', filename: 'q0.png', userId: 'u7', emoji: '🔥', createdAt: ts(2023, 5, 1, 10) });
store.recordComment({ groupId: 'g1001', filename: 'q0.png', userId: 'u9', content: '太好笑了', createdAt: ts(2024, 5, 1, 10) });
store.recordComment({ groupId: 'g1001', filename: 'q0.png', userId: 'u5', content: '经典', createdAt: ts(2024, 6, 1, 12) });
store.recordComment({ groupId: 'g1001', filename: 'q0.png', userId: 'u9', content: '再来一条', createdAt: ts(2024, 7, 1, 10) });
store.recordComment({ groupId: 'g1001', filename: 'q0.png', userId: 'u4', content: '旧年评论', createdAt: ts(2023, 6, 1, 12) });

const expected = (() => {
  const months = Array(12).fill(0);
  const hours = Array(24).fill(0);
  const weekdays = Array(7).fill(0);
  const tags = new Map();
  const submitters = new Map();
  const groups = new Map();
  let first = 0;
  let last = 0;
  const captions = [];
  for (const row of mine) {
    const date = new Date(row.createdAt * 1000);
    months[date.getMonth()] += 1;
    hours[date.getHours()] += 1;
    weekdays[(date.getDay() + 6) % 7] += 1;
    groups.set(row.group, (groups.get(row.group) || 0) + 1);
    submitters.set(row.speaker, (submitters.get(row.speaker) || 0) + 1);
    for (const tag of row.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
    if (!first || row.createdAt < first) first = row.createdAt;
    if (row.createdAt > last) last = row.createdAt;
    if (row.content !== '[图片语录]') captions.push({ name: row.filename, createdAt: row.createdAt });
  }
  const sortMap = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  captions.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  return {
    months,
    hours,
    weekdays,
    total: mine.length,
    groupTotal: seeded.length,
    tags: sortMap(tags).slice(0, 5).map(([tag, count]) => ({ tag, count })),
    submitters: sortMap(submitters).slice(0, 5).map(([name, count]) => ({ name, count })),
    groups: sortMap(groups).map(([group_id, count]) => ({ group_id, count })),
    first,
    last,
    captions: captions.slice(-3),
  };
})();

// ------------------------------------------------------------------ //
// 1) annualReport: AstrBot-compatible shape and numbers
// ------------------------------------------------------------------ //
{
  const report = store.annualReport({ pid: MINE.user, year: YEAR });
  const astrobotKeys = [
    'pid',
    'person_id',
    'year',
    'display_name',
    'avatar_sha',
    'group_id',
    'total',
    'group_total',
    'share',
    'rank',
    'ranked_total',
    'months',
    'hours',
    'weekdays',
    'top_month',
    'top_hour',
    'top_tags',
    'submitters',
    'reactions',
    'groups',
    'first_ts',
    'last_ts',
    'captions',
  ];
  for (const key of astrobotKeys) {
    assert.ok(Object.hasOwn(report, key), `annual report should expose "${key}" like AstrBot`);
  }
  assert.equal(report.unsupported, undefined);
  assert.equal(report.year, YEAR);
  assert.equal(report.pid, MINE.user);
  assert.equal(report.person_id, MINE.user);
  assert.equal(report.display_name, MINE.name);
  assert.equal(report.avatar_sha, '');
  assert.equal(report.total, expected.total);
  assert.equal(report.total, 20);
  assert.equal(report.group_total, expected.groupTotal);
  assert.equal(report.group_total, 60);
  assert.equal(report.share, Math.round((expected.total / expected.groupTotal) * 10000) / 10000);
  assert.equal(report.rank, 1);
  assert.equal(report.ranked_total, 2);
  assert.deepEqual(report.months, expected.months);
  assert.deepEqual(report.hours, expected.hours);
  assert.deepEqual(report.weekdays, expected.weekdays);
  assert.equal(report.months.reduce((sum, value) => sum + value, 0), expected.total);
  assert.equal(report.top_month, expected.months.indexOf(Math.max(...expected.months)));
  assert.equal(report.top_hour, expected.hours.indexOf(Math.max(...expected.hours)));
  assert.equal(report.top_weekday, expected.weekdays.indexOf(Math.max(...expected.weekdays)));
  assert.deepEqual(report.top_tags, expected.tags);
  assert.deepEqual(report.submitters, expected.submitters);
  assert.deepEqual(report.groups, expected.groups);
  assert.equal(report.first_ts, expected.first);
  assert.equal(report.last_ts, expected.last);
  assert.equal(report.captions.length, 3);
  assert.deepEqual(
    report.captions.map((row) => row.name),
    expected.captions.map((row) => row.name),
  );
  assert.ok(report.captions.every((row) => row.caption && row.caption !== '[图片语录]'));
  assert.ok(report.captions.every((row) => Array.isArray(row.tags)));
  assert.equal(report.captions[report.captions.length - 1].ts, expected.last);

  // Reactions are aggregated inside the same yearly window, without a trend.
  assert.equal(report.reactions.year, YEAR);
  assert.equal(report.reactions.reactions, 2);
  assert.equal(report.reactions.comments, 3);
  assert.equal(report.reactions.trend, undefined);
  assert.ok(report.reactions.emotions.some((row) => row.emotion === '赞' && row.count === 1));
  assert.equal(report.reactions.top_quotes[0].filename, 'q0.png');
  assert.equal(report.reactions.top_commenters[0].uid, 'u9');

  // Group-scoped report only counts that group's quotes.
  const scoped = store.annualReport({ pid: MINE.user, year: YEAR, group: 'g1001' });
  assert.equal(scoped.total, 20);
  assert.equal(scoped.group_total, 20);
  assert.equal(scoped.share, 1);
  assert.equal(scoped.groups.length, 1);

  // Empty year → zero-filled structure, never throws.
  const empty = store.annualReport({ pid: MINE.user, year: 2019 });
  assert.equal(empty.total, 0);
  assert.equal(empty.group_total, 0);
  assert.equal(empty.share, 0);
  assert.equal(empty.rank, 0);
  assert.equal(empty.ranked_total, 0);
  assert.deepEqual(empty.months, Array(12).fill(0));
  assert.deepEqual(empty.hours, Array(24).fill(0));
  assert.deepEqual(empty.weekdays, Array(7).fill(0));
  assert.deepEqual(empty.top_tags, []);
  assert.deepEqual(empty.submitters, []);
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.captions, []);
  assert.equal(empty.first_ts, 0);
  assert.equal(empty.last_ts, 0);
  assert.equal(empty.reactions.reactions, 0);
  assert.equal(empty.reactions.year, 2019);

  // Unknown person resolves to zeros but keeps group totals.
  const ghost = store.annualReport({ pid: 'nobody', year: YEAR });
  assert.equal(ghost.total, 0);
  assert.equal(ghost.group_total, 60);
  assert.equal(ghost.display_name, '');
  assert.equal(ghost.rank, 0);
  assert.equal(ghost.ranked_total, 2);

  // Missing year falls back to the current year (no quotes there yet).
  const current = store.annualReport({ pid: MINE.user });
  assert.equal(current.year, new Date().getFullYear());
  assert.equal(current.total, 0);
}

// ------------------------------------------------------------------ //
// 2) Year window boundaries (local time)
// ------------------------------------------------------------------ //
{
  const boundaryDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-archive-annual-boundary-'));
  const boundaryStore = openStore(path.join(boundaryDir, 'quotes.db'), {
    imagesDir: path.join(boundaryDir, 'images'),
  });
  const year = 2024;
  boundaryStore.addQuote({
    group: 'g1',
    speaker: 's',
    content: '跨年',
    messageId: 'b1',
    imagePath: 'g1/last.png',
    createdAt: ts(year, 11, 31, 23) + 3599,
  });
  boundaryStore.addQuote({
    group: 'g1',
    speaker: 's',
    content: '跨年',
    messageId: 'b2',
    imagePath: 'g1/next.png',
    createdAt: ts(year + 1, 0, 1, 0),
  });
  const first = boundaryStore.annualReport({ pid: 's', year });
  assert.equal(first.group_total, 1, 'only the Dec-31 23:59:59 quote is inside the year');
  const second = boundaryStore.annualReport({ pid: 's', year: year + 1 });
  assert.equal(second.group_total, 1);
  boundaryStore.close();
  rmSync(boundaryDir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ //
// 3) SVG poster
// ------------------------------------------------------------------ //
function assertBalancedSvg(svg) {
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let count = 0;
  let lastIndex = 0;
  let match;
  while ((match = tagRe.exec(svg))) {
    const between = svg.slice(lastIndex, match.index);
    assert.ok(!/[<>]/.test(between), 'text content must not contain raw angle brackets');
    lastIndex = tagRe.lastIndex;
    count += 1;
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      assert.equal(stack.pop(), name, `closing tag </${name}> should match`);
    } else {
      stack.push(name);
    }
  }
  assert.equal(lastIndex, svg.length, 'everything outside tags must be whitespace/newlines');
  assert.deepEqual(stack, [], 'SVG tags should be balanced');
  assert.ok(count > 80, 'poster should contain a rich set of shapes');
}

{
  const report = store.annualReport({ pid: MINE.user, year: YEAR });
  const svg = buildAnnualSvg(report);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes(`width="${REPORT_WIDTH}" height="${REPORT_HEIGHT}"`));
  assert.equal(REPORT_WIDTH, 1080);
  assert.equal(REPORT_HEIGHT, 1500);
  assert.ok(svg.includes('2024 年度语录报告'));
  assert.ok(svg.includes('Alice'));
  assert.ok(svg.includes('#D0E516'));
  assert.ok(svg.includes('#FBF5ED'));
  assertBalancedSvg(svg);

  const highlights = annualHighlights(report);
  assert.equal(highlights.total, 20);
  assert.equal(highlights.group_total, 60);
  assert.equal(highlights.rank, 1);
  assert.ok(highlights.share_text.endsWith('%'));
  assert.equal(highlights.top_tag, expected.tags[0].tag);

  const dataUrl = annualImageDataUrl(svg);
  assert.ok(dataUrl.startsWith('data:image/svg+xml;base64,'));
  const decoded = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8');
  assert.equal(decoded, svg);
  assert.equal(annualFileName(YEAR), 'annual-2024.svg');
  assert.equal(annualFileName(), `annual-${new Date().getFullYear()}.svg`);
  assert.equal(annualFileName('nope'), `annual-${new Date().getFullYear()}.svg`);

  // Empty report renders too.
  const emptySvg = buildAnnualSvg(store.annualReport({ pid: 'nobody', year: 2019 }));
  assert.ok(emptySvg.includes('2019'));
  assert.ok(emptySvg.includes('—'));
  assertBalancedSvg(emptySvg);
}

// Text escaping: captions / names / tags may contain markup characters.
{
  const synthetic = {
    pid: 'u<1>',
    person_id: 'u1',
    year: 2024,
    display_name: 'Alice <b>&"x"',
    group_id: '',
    total: 10,
    group_total: 30,
    share: 0.3333,
    rank: 2,
    ranked_total: 5,
    months: Array.from({ length: 12 }, (_, index) => index),
    hours: Array.from({ length: 24 }, (_, index) => index),
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    top_month: 11,
    top_hour: 23,
    top_weekday: 6,
    top_tags: [{ tag: '<tag>&', count: 5 }],
    submitters: [{ name: 'A & B <i>', count: 4 }],
    groups: [{ group_id: 'g<1>', count: 10 }],
    first_ts: 1,
    last_ts: 9,
    captions: [
      { name: '<x>.png', group_id: 'g<1>', caption: 'A & B <script>alert(1)</script>', tags: ['<t>'], ts: 1 },
      { name: 'y.png', group_id: 'g1', caption: '普通语录', tags: [], ts: 2 },
      { name: 'z.png', group_id: 'g1', caption: '第三条', tags: [], ts: 3 },
      { name: 'w.png', group_id: 'g1', caption: '第四条', tags: [], ts: 4 },
    ],
    reactions: {
      year: 2024,
      reactions: 3,
      comments: 2,
      top_quotes: [{ caption: '<b>好</b>', filename: 'x.png', count: 2 }],
      top_persons: [{ uid: '<u>', display_name: 'A&B', count: 2 }],
      top_commenters: [{ uid: 'u<9>', display_name: 'C<D>', count: 1 }],
    },
  };
  const svg = buildAnnualSvg(synthetic);
  assert.ok(svg.includes('&lt;b&gt;'), 'markup in display names must be escaped');
  assert.ok(svg.includes('&amp;'), 'ampersands must be escaped');
  assert.ok(!svg.includes('<script>'), 'raw script markup must not leak into the SVG');
  assert.ok(!svg.includes('</b>'), 'raw closing markup must not leak into the SVG');
  assertBalancedSvg(svg);
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(svg), 'every ampersand must start a known entity');
}

// ------------------------------------------------------------------ //
// 4) Management API + page wiring
// ------------------------------------------------------------------ //
const fakeChannel = {
  getLoginInfo: async () => ({ user_id: '3266983948', nickname: '末炎Ender' }),
  getGroupList: async () => GROUPS.map((group) => ({ group, name: group })),
  getGroupMsgHistory: async () => [],
  sendGroupImage: async () => ({ message_id: 'fake-1' }),
  sendGroupText: async () => ({ message_id: 'fake-2' }),
};
const routes = createManageRoutes({
  getStore: () => store,
  getChannel: () => fakeChannel,
  getConfig: () => ({ channel: { enabled: true, httpUrl: 'http://127.0.0.1:3000', groups: GROUPS } }),
  getLastSync: () => null,
  discoverChannel: async () => ({ channel: {}, candidates: [], searched: {}, override_path: '' }),
  applyCollect: async () => ({ ok: true, collect: {} }),
  getCollect: () => ({ autoCollect: false, pollIntervalSec: 300, groups: GROUPS }),
  applyChannel: async () => ({ ok: true, channel: {}, override_path: '' }),
});
const apiRoute = routes.find((route) => route.path === ROUTES.api);
assert.ok(apiRoute, 'admin API route should be registered');

function makeReq(method, url, body) {
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:2759' },
    socket: { remoteAddress: '127.0.0.1' },
    _handlers: { data: null, end: null },
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

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(body) {
      if (body !== undefined) this.body = String(body);
      if (this._resolve) this._resolve(this);
    },
  };
}

async function callApi(method, rel, payload) {
  let url = `${ROUTES.api}/${rel}`;
  if (payload) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) query.set(key, String(value));
    url += `?${query}`;
  }
  const req = makeReq(method, url);
  const res = makeRes();
  const done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  apiRoute.handler(req, res);
  const finished = await done;
  return { status: finished.status, body: JSON.parse(finished.body || '{}') };
}

{
  const annual = await callApi('GET', 'insights/annual', { pid: MINE.user, year: YEAR });
  assert.equal(annual.status, 200);
  assert.equal(annual.body.ok, true);
  assert.equal(annual.body.unsupported, undefined);
  assert.equal(annual.body.total, 20);
  assert.equal(annual.body.group_total, 60);
  assert.deepEqual(annual.body.months, expected.months);
  assert.equal(annual.body.reactions.reactions, 2);

  const scoped = await callApi('GET', 'insights/annual', { pid: MINE.user, year: YEAR, group_id: 'g1001' });
  assert.equal(scoped.body.group_total, 20);

  const image = await callApi('GET', 'insights/annual_image', { pid: MINE.user, year: YEAR });
  assert.equal(image.status, 200);
  assert.equal(image.body.ok, true);
  assert.equal(image.body.unsupported, undefined);
  assert.equal(image.body.filename, 'annual-2024.svg');
  assert.ok(String(image.body.image).startsWith('data:image/svg+xml;base64,'));
  assert.equal(image.body.report.display_name, 'Alice');
  assert.equal(image.body.report.total, 20);
  assert.equal(image.body.report.rank, 1);
  assert.equal(image.body.report.ranked_total, 2);
  const svg = Buffer.from(String(image.body.image).split(',')[1], 'base64').toString('utf8');
  assert.ok(svg.includes('2024 年度语录报告'));
  assertBalancedSvg(svg);

  const emptyImage = await callApi('GET', 'insights/annual_image', { pid: MINE.user, year: 2019 });
  assert.equal(emptyImage.body.ok, true);
  assert.equal(emptyImage.body.filename, 'annual-2019.svg');
  assert.equal(emptyImage.body.report.total, 0);

  const missingPid = await callApi('GET', 'insights/annual', { year: YEAR });
  assert.equal(missingPid.body.ok, true);
  assert.equal(missingPid.body.total, 0);
}

// The annual section must be visible in the DSH page (bridge used to hide it).
{
  const bridge = readFileSync(new URL('../web/manage/bridge.js', import.meta.url), 'utf8');
  assert.ok(!bridge.includes("#annual-preview"), 'bridge.js should no longer hide the annual report section');
  assert.ok(!bridge.includes('Annual report needs server-side image rendering'));
  const html = readFileSync(new URL('../web/manage/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="annual-preview"'));
  assert.ok(html.includes('id="btn-annual-load"'));
  const script = readFileSync(new URL('../web/manage/script.js', import.meta.url), 'utf8');
  assert.ok(script.includes("insightsAnnualImage: 'insights/annual_image'"));
  assert.ok(script.includes('loadAnnualPreview'));
}

store.close();
rmSync(tmp, { recursive: true, force: true });
console.log('annual tests passed');
