/**
 * Tests for the optional dsh-im transport (lib/transport.js).
 *
 * dsh-im itself is NOT a dependency: everything here feeds fake `ctx.im`
 * services so the plugin's driver selection, outbound calls, inbound bridge and
 * silent fallback can be verified on any machine.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { createManageRoutes, ROUTES } from '../lib/manage.js';
import {
  attachImInbound,
  createImDriver,
  createTransport,
  imageExtension,
  imTargetOf,
  normalizeDriver,
} from '../lib/transport.js';

// ---------------------------------------------------------------------------
// Config helpers
assert.equal(normalizeDriver(undefined), 'auto');
assert.equal(normalizeDriver('  OneBot '), 'onebot');
assert.equal(normalizeDriver('im'), 'im');
assert.equal(normalizeDriver('telegram'), 'auto');

assert.equal(imTargetOf({}), null);
assert.equal(imTargetOf({ imPlatform: 'qq' }), null);
assert.deepEqual(imTargetOf({ imPlatform: ' qq ', imChatId: ' 12345 ' }), { platform: 'qq', chatId: '12345' });

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
assert.equal(imageExtension('quote.PNG', png), 'png');
assert.equal(imageExtension('', png), 'png');
assert.equal(imageExtension('', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
assert.equal(imageExtension('', Buffer.alloc(2)), 'png');
console.log('im helpers OK');

// ---------------------------------------------------------------------------
// Driver: happy path writes an outbox attachment and calls ctx.im.send
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-archive-im-'));
const outbox = path.join(tmp, 'im-outbox');
const sent = [];
const fakeIm = {
  channels: new Map([['qq', { platform: 'qq' }]]),
  send: async (chat, out) => {
    sent.push({ chat, out });
    return { messageId: `im-${sent.length}` };
  },
};
const channelConfig = { channel: { enabled: false, driver: 'im', imPlatform: 'qq', imChatId: 'group-1' } };
const driver = createImDriver({ getIm: () => fakeIm, getConfig: () => channelConfig, getOutboxDir: () => outbox });
assert.equal(driver.available(), true);
assert.deepEqual(driver.status().channels, ['qq']);
const result = await driver.sendImage('1031430106', png, { caption: '经典语录', filename: 'a.png' });
assert.equal(result.message_id, 'im-1');
assert.equal(result.driver, 'im');
assert.equal(sent.length, 1);
assert.deepEqual(sent[0].chat, { platform: 'qq', chatId: 'group-1' });
assert.equal(sent[0].out.text, '经典语录');
assert.equal(sent[0].out.attachments.length, 1);
assert.equal(sent[0].out.attachments[0].kind, 'image');
assert.ok(existsSync(sent[0].out.attachments[0].path));
assert.ok(sent[0].out.attachments[0].path.startsWith(outbox));
assert.deepEqual(readFileSync(sent[0].out.attachments[0].path), png);
const textResult = await driver.sendText('1031430106', '只发文本');
assert.equal(textResult.message_id, 'im-2');
assert.equal(sent[1].out.text, '只发文本');
assert.equal(sent[1].out.attachments, undefined);
console.log('im driver OK');

// ---------------------------------------------------------------------------
// Driver: unbound / missing service errors are explanatory, not crashes
const unbound = createImDriver({ getIm: () => fakeIm, getConfig: () => ({ channel: {} }), getOutboxDir: () => outbox });
assert.equal(unbound.available(), false);
await assert.rejects(() => unbound.sendImage('1', png), /未绑定会话/);
const missing = createImDriver({ getIm: () => null, getConfig: () => channelConfig, getOutboxDir: () => outbox });
assert.equal(missing.available(), false);
await assert.rejects(() => missing.sendImage('1', png), /未加载 dsh-im/);
console.log('im driver errors OK');

// ---------------------------------------------------------------------------
// Transport: driver selection
const onebotCalls = [];
const fakeOnebot = {
  sendGroupImage: async (groupId, buffer, options) => {
    onebotCalls.push({ groupId, options });
    return { message_id: 'onebot-1' };
  },
  sendGroupText: async (groupId, content) => {
    onebotCalls.push({ groupId, content });
    return { message_id: 'onebot-2' };
  },
};

function makeTransport(config, im = fakeIm) {
  return createTransport({
    getOnebot: () => fakeOnebot,
    getIm: () => im,
    getConfig: () => config,
    getOutboxDir: () => outbox,
  });
}

// auto + reachable onebot -> onebot
{
  const config = { channel: { enabled: true, httpUrl: 'http://127.0.0.1:3000', driver: 'auto', imPlatform: 'qq', imChatId: 'g' } };
  const transport = makeTransport(config);
  assert.equal(transport.activeDriver(), 'onebot');
  const sentOnebot = await transport.sendGroupImage('1031430106', png, { caption: 'c' });
  assert.equal(sentOnebot.driver, 'onebot');
  assert.equal(sentOnebot.message_id, 'onebot-1');
  assert.equal(onebotCalls.length, 1);
}
// auto + onebot disabled -> im
{
  const config = { channel: { enabled: false, httpUrl: 'http://127.0.0.1:3000', driver: 'auto', imPlatform: 'qq', imChatId: 'g' } };
  const transport = makeTransport(config);
  assert.equal(transport.activeDriver(), 'im');
  const sentIm = await transport.sendGroupText('1031430106', 'hi');
  assert.equal(sentIm.driver, 'im');
}
// explicit onebot wins even when im is available
{
  const config = { channel: { enabled: true, httpUrl: 'http://127.0.0.1:3000', driver: 'onebot', imPlatform: 'qq', imChatId: 'g' } };
  assert.equal(makeTransport(config).activeDriver(), 'onebot');
}
// explicit im wins even when onebot is reachable
{
  const config = { channel: { enabled: true, httpUrl: 'http://127.0.0.1:3000', driver: 'im', imPlatform: 'qq', imChatId: 'g' } };
  assert.equal(makeTransport(config).activeDriver(), 'im');
}
// auto with nothing available -> onebot driver, but sending explains the gap
{
  const config = { channel: { enabled: false, httpUrl: '', driver: 'auto' } };
  const transport = createTransport({ getOnebot: () => null, getIm: () => null, getConfig: () => config, getOutboxDir: () => outbox });
  assert.equal(transport.activeDriver(), 'onebot');
  await assert.rejects(() => transport.sendGroupText('1', 'x'), /OneBot 网关未启用或无法连接/);
  const status = transport.status();
  assert.equal(status.configured, 'auto');
  assert.equal(status.onebot.available, false);
  assert.equal(status.im.available, false);
}
console.log('im transport selection OK');

// ---------------------------------------------------------------------------
// Inbound bridge: ctx.im events -> reply comments for remembered images
const imagesDir = path.join(tmp, 'images');
const store = openStore(path.join(tmp, 'quotes.db'), { imagesDir });
mkdirSync(path.join(imagesDir, '1031430106'), { recursive: true });
writeFileSync(path.join(imagesDir, '1031430106', 'a.png'), png);
store.addQuote({
  group: '1031430106',
  speaker: 'alice',
  content: '名场面',
  imagePath: '1031430106/a.png',
  source: 'qq',
  createdAt: 1_700_000_000,
});
store.recordSentQuote({ messageId: 'im-1', groupId: '1031430106', filename: 'a.png' });

const listeners = new Map();
const ctx = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  },
  off(event, handler) {
    listeners.get(event)?.delete(handler);
  },
  emit(event, payload) {
    let handled = 0;
    for (const handler of listeners.get(event) || []) handled += handler(payload) || 0;
    return handled;
  },
  listenerCount(event) {
    return (listeners.get(event) || new Set()).size;
  },
};
const warns = [];
const dispose = attachImInbound({
  ctx,
  getStore: () => store,
  logger: { info() {}, warn: (...args) => warns.push(args.join(' ')) },
});
assert.ok(ctx.listenerCount('im/message') >= 1);
assert.ok(ctx.listenerCount('im/dispatch') >= 1);

const before = store.reactionStats({ group: '1031430106' }).comments;
const recorded = ctx.emit('im/message', { message: { replyTo: 'im-1', text: '这张好看', userId: 'u1' } });
assert.equal(recorded, 1);
assert.equal(store.reactionStats({ group: '1031430106' }).comments, before + 1);
// Duplicate inside the 30s window is deduped by the comment recorder.
assert.equal(ctx.emit('im/message', { replyTo: 'im-1', text: '这张好看', userId: 'u1' }), 0);
// Unknown reply target and empty text are ignored.
assert.equal(ctx.emit('im/message', { replyTo: 'nope', text: 'x', userId: 'u1' }), 0);
assert.equal(ctx.emit('im/message', { replyTo: 'im-1', text: '', userId: 'u1' }), 0);
// dsh-im 1.0.x emits im/dispatch with no reply target: must not throw.
assert.equal(ctx.emit('im/dispatch', { sessionId: 's', platform: 'qq', chatId: 'g', text: 'hello' }), 0);
dispose();
assert.equal(ctx.listenerCount('im/message'), 0);
assert.deepEqual(warns, []);
console.log('im inbound OK');

// ---------------------------------------------------------------------------
// Admin API: dsh/send goes through getSender and records the sent image
const apiChannel = {
  getLoginInfo: async () => ({ user_id: '1', nickname: 'tester' }),
  getGroupList: async () => [{ group: '1031430106', name: 'main' }],
  getGroupMsgHistory: async () => [],
  getImage: async () => Buffer.from(''),
  getMsg: async () => ({}),
  sendGroupImage: async () => ({ message_id: 'bot-1' }),
  sendGroupText: async () => ({ message_id: 'bot-2' }),
};
const imSender = {
  activeDriver: () => 'im',
  status: () => ({ configured: 'im', active: 'im', onebot: { available: false, http_url: '' }, im: { driver: 'im', available: true, platform: 'qq', chat_id: 'g', channels: ['qq'] } }),
  sendGroupImage: async () => ({ message_id: 'im-api-1', driver: 'im' }),
  sendGroupText: async () => ({ message_id: 'im-api-2', driver: 'im' }),
};
const routes = createManageRoutes({
  getStore: () => store,
  getChannel: () => apiChannel,
  getSender: () => imSender,
  getTransportStatus: () => imSender.status(),
  getConfig: () => ({ channel: { enabled: true, httpUrl: 'http://127.0.0.1:3000', groups: ['1031430106'] } }),
  getLastSync: () => null,
  discoverChannel: async () => ({ channel: { enabled: true, auto: true, source: 'snowluma', httpUrl: 'http://127.0.0.1:3000', token_set: true, reachable: true, login: null, groups: 1, error: '' }, candidates: [], searched: { qqBridge: [], snowlumaHomes: [] }, override_path: '/tmp/channel.json' }),
  applyChannel: async () => ({ ok: true, channel: { enabled: true }, override_path: '/tmp/channel.json' }),
  applyCollect: async () => ({ ok: true, collect: {} }),
  getCollect: () => ({}),
});
const apiRoute = routes.find((route) => route.path === ROUTES.api);
assert.ok(apiRoute);

function makeReq(method, url, body) {
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:2759' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      this._handlers = this._handlers || {};
      this._handlers[event] = handler;
      return this;
    },
    _handlers: {},
    setImmediateBody() {
      if (body !== undefined) {
        setImmediate(() => {
          this._handlers.data && this._handlers.data(Buffer.from(JSON.stringify(body)));
          this._handlers.end && this._handlers.end();
        });
      }
      return this;
    },
  };
  return req.setImmediateBody();
}
function callApi(method, rel, payload) {
  const query = method === 'GET' && payload ? '?' + new URLSearchParams(payload).toString() : '';
  const req = makeReq(method, `${ROUTES.api}/${rel}${query}`, method === 'POST' ? payload || {} : undefined);
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(body) {
      this.body = String(body ?? '');
      this._resolve && this._resolve();
    },
  };
  const done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  apiRoute.handler(req, res);
  return done.then(() => ({ status: res.status, body: JSON.parse(res.body || '{}') }));
}

const quotes = store.listImageQuotes({ group: '1031430106', page: 1, pageSize: 10 });
assert.ok(quotes.items.length >= 1);
const quoteId = quotes.items[0].id;
const sendRes = await callApi('POST', 'dsh/send', { quote_id: quoteId, group_id: '1031430106' });
assert.equal(sendRes.status, 200);
assert.equal(sendRes.body.ok, true);
assert.equal(sendRes.body.message_id, 'im-api-1');
assert.equal(store.lookupSentQuote('im-api-1').filename, 'a.png');

const statusRes = await callApi('GET', 'dsh/status', {});
assert.equal(statusRes.status, 200);
assert.equal(statusRes.body.transport.active, 'im');
assert.equal(statusRes.body.channel.driver, 'im');
console.log('im admin API OK');

store.close();
rmSync(tmp, { recursive: true, force: true });
console.log('im tests passed');
