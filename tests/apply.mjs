// Mounts the plugin with a fake Cordis context and a throwaway DSH_HOME, then
// exercises every tool action. No DSH host needed:
//   node tests/apply.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, inject, name } from '../index.js';

assert.equal(name, 'dsh-quote-archive');
assert.deepEqual(inject, ['tools']);

const home = mkdtempSync(path.join(os.tmpdir(), 'quote-archive-'));
process.env.DSH_HOME = home;

const tools = [];
const cleanups = [];
const ctx = {
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  effect(callback) {
    const dispose = callback();
    if (typeof dispose === 'function') cleanups.push(dispose);
    return dispose;
  },
};

try {
  apply(ctx, {});
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'quote');

  const collect = await tool.execute({
    action: 'collect',
    group: 'g1',
    speaker: 'alice',
    content: 'hello world',
    messageId: 'm1',
    tag: 'fun',
  });
  assert.equal(collect.ok, true);
  assert.equal(collect.deduped, false);
  assert.equal(collect.total, 1);

  const duplicate = await tool.execute({
    action: 'collect',
    group: 'g1',
    speaker: 'alice',
    content: 'hello world',
    messageId: 'm1',
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.id, collect.id);

  const recall = await tool.execute({ action: 'recall', group: 'g1' });
  assert.equal(recall.quote.content, 'hello world');
  assert.deepEqual(recall.quote.tags, ['fun']);

  const search = await tool.execute({ action: 'search', query: 'ell' });
  assert.equal(search.quotes.length, 1);

  const list = await tool.execute({ action: 'list', limit: 10 });
  assert.equal(list.quotes.length, 1);

  const stats = await tool.execute({ action: 'stats' });
  assert.equal(stats.totals.quotes, 1);
  assert.equal(stats.totals.speakers, 1);

  const groups = await tool.execute({ action: 'groups' });
  assert.equal(groups.groups.length, 1);

  assert.equal((await tool.execute({ action: 'collect' })).ok, false);
  assert.equal((await tool.execute({ action: 'nope' })).ok, false);

  const rendered = tool.output.render({ action: 'stats' }, stats);
  assert.ok(Array.isArray(rendered));
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('语录总数'));

  const recallText = tool.output.render({ action: 'recall' }, recall)[0].text;
  assert.ok(recallText.includes('随机抽到'));

  const dbFile = path.join(home, 'storages', 'quote-archive', 'quotes.db');
  assert.ok(existsSync(dbFile), `expected database at ${dbFile}`);

  // ---- QQ channel wiring, against a fake OneBot v11 gateway ----------------
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push(String(url));
    const target = String(url);
    if (target === 'http://img.example/q.png') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => PNG,
        text: async () => '',
      };
    }
    const action = target.split('/').pop();
    const payload = (() => {
      switch (action) {
        case 'get_login_info':
          return { status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'tester' } };
        case 'get_group_list':
          return { status: 'ok', retcode: 0, data: [{ group_id: 'g1', group_name: '主群' }] };
        case 'get_group_msg_history':
          return {
            status: 'ok',
            retcode: 0,
            data: {
              messages: [
                {
                  message_id: 77,
                  time: 1700000000,
                  sender: { user_id: 7, nickname: '小明', card: '小明' },
                  message: [
                    { type: 'text', data: { text: '新语录' } },
                    { type: 'image', data: { file: 'q.png', url: 'http://img.example/q.png' } },
                  ],
                },
              ],
            },
          };
        case 'send_group_msg':
          return { status: 'ok', retcode: 0, data: { message_id: 9001 } };
        default:
          return { status: 'failed', retcode: 1404, wording: `unknown action ${action}` };
      }
    })();
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload),
      arrayBuffer: async () => Buffer.alloc(0),
    };
  };

  const qqHome = mkdtempSync(path.join(os.tmpdir(), 'quote-archive-qq-'));
  process.env.DSH_HOME = qqHome;
  const qqTools = [];
  const qqCleanups = [];
  const qqCtx = {
    tools: {
      register(definition) {
        qqTools.push(definition);
        return () => {};
      },
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') qqCleanups.push(dispose);
      return dispose;
    },
  };
  try {
    apply(qqCtx, {
      channel: {
        enabled: true,
        httpUrl: 'http://127.0.0.1:3999',
        accessToken: 'tok',
        groups: ['g1'],
      },
    });
    const qqTool = qqTools[0];
    assert.ok(fetchCalls.length === 0, 'nothing connects before the first tool call');

    const status = await qqTool.execute({ action: 'channel' });
    assert.equal(status.ok, true);
    assert.equal(status.configured, true);
    assert.equal(status.reachable, true);
    assert.equal(status.login.nickname, 'tester');
    assert.deepEqual(status.groups, ['g1']);

    const synced = await qqTool.execute({ action: 'sync', group: 'g1' });
    assert.equal(synced.ok, true);
    assert.equal(synced.added, 1);
    assert.equal(synced.results[0].downloaded, 1);

    const stored = await qqTool.execute({ action: 'search', query: '新语录' });
    assert.equal(stored.quotes.length, 1);
    assert.equal(stored.quotes[0].source, 'qq');
    assert.ok(stored.quotes[0].imagePath);
    const imageFile = path.join(qqHome, 'storages', 'quote-archive', 'images', ...stored.quotes[0].imagePath.split('/'));
    assert.ok(existsSync(imageFile), `expected image at ${imageFile}`);

    const sent = await qqTool.execute({ action: 'send', group: 'g1', caption: '今日语录' });
    assert.equal(sent.ok, true);
    assert.equal(sent.group, 'g1');
    assert.ok(fetchCalls.some((url) => url === 'http://127.0.0.1:3999/send_group_msg'));

    const renderedChannel = qqTool.output.render({ action: 'channel' }, status)[0].text;
    assert.ok(renderedChannel.includes('已连接'));
    const renderedSync = qqTool.output.render({ action: 'sync' }, synced)[0].text;
    assert.ok(renderedSync.includes('新增'));

    // Explicitly disabled channel: actions explain how to configure it instead of throwing.
    const offHome = mkdtempSync(path.join(os.tmpdir(), 'quote-archive-off-'));
    process.env.DSH_HOME = offHome;
    const offTools = [];
    const offCleanups = [];
    const offCtx = {
      tools: { register: (definition) => { offTools.push(definition); return () => {}; } },
      effect(callback) { const dispose = callback(); if (typeof dispose === 'function') offCleanups.push(dispose); return dispose; },
    };
    apply(offCtx, { channel: { enabled: false } });
    const off = await offTools[0].execute({ action: 'channel' });
    assert.equal(off.ok, true);
    assert.equal(off.configured, false);
    const offSync = await offTools[0].execute({ action: 'sync', group: 'g1' });
    assert.equal(offSync.ok, false);
    assert.match(offSync.error, /QQ 通道未启用/);
    const offSend = await offTools[0].execute({ action: 'send', group: 'g1' });
    assert.equal(offSend.ok, false);
    assert.match(offSend.error, /QQ 通道未启用/);
    for (const cleanup of offCleanups.reverse()) cleanup();
    rmSync(offHome, { recursive: true, force: true });
  } finally {
    for (const cleanup of qqCleanups.reverse()) cleanup();
    rmSync(qqHome, { recursive: true, force: true });
  }

  console.log('apply OK:', dbFile);
} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
  rmSync(home, { recursive: true, force: true });
}
