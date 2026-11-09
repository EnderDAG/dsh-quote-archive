/**
 * Offline tests for lib/onebot.js — no real QQ gateway needed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OneBotError,
  createOneBotClient,
  detectImageExtension,
  downloadImageBytes,
  extractImages,
  extractText,
  senderIdOf,
  speakerOf,
} from '../lib/onebot.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function jsonResponse(payload) {
  let text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text),
  };
}

function imageResponse(buffer, contentType) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => '',
    arrayBuffer: async () => buffer,
  };
}

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

const HISTORY = [
  {
    message_id: 11,
    time: 100,
    sender: { user_id: 2, nickname: 'alice', card: 'A姐' },
    message: [
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { file: 'a.jpg', url: 'http://img.example/a.jpg', summary: '[图片]' } },
    ],
  },
];

async function main() {
  // ---- constructor validation -------------------------------------------------
  assert.throws(() => createOneBotClient({ httpUrl: '127.0.0.1:3000' }), /http\(s\) URL/);
  const maskedClient = createOneBotClient({ httpUrl: 'http://user:secret@127.0.0.1:3000', accessToken: 'tok', fetchImpl: async () => jsonResponse({ status: 'ok', retcode: 0, data: {} }) });
  assert.match(maskedClient.httpUrl, /\*\*\*/);
  assert.ok(!maskedClient.httpUrl.includes('secret'));

  // ---- normal actions ---------------------------------------------------------
  const { calls, fetchImpl } = makeFetch(async (url, init) => {
    const action = url.split('/').pop();
    if (action === 'get_login_info') return jsonResponse({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'tester' } });
    if (action === 'get_group_list') {
      return jsonResponse({ status: 'ok', retcode: 0, data: [{ group_id: 1031430106, group_name: '主群' }, { group_id: 478864863, group_name: '分会场' }] });
    }
    if (action === 'get_group_msg_history') return jsonResponse({ status: 'ok', retcode: 0, data: { messages: HISTORY } });
    if (action === 'send_group_msg') {
      const body = JSON.parse(init.body);
      if (body.message[0].type === 'image') return jsonResponse({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
      return jsonResponse({ status: 'ok', retcode: 0, data: { message_id: 9002 } });
    }
    if (action === 'get_image') return jsonResponse({ status: 'ok', retcode: 0, data: { base64: `base64://${PNG.toString('base64')}` } });
    throw new Error(`unexpected action ${action}`);
  });

  const client = createOneBotClient({ httpUrl: 'http://127.0.0.1:3000', accessToken: 'secret-token', fetchImpl });
  const login = await client.getLoginInfo();
  assert.equal(login.user_id, 10001);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/get_login_info');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');

  const groups = await client.getGroupList();
  assert.deepEqual(groups, [
    { group: '1031430106', name: '主群' },
    { group: '478864863', name: '分会场' },
  ]);

  const history = await client.getGroupMsgHistory({ groupId: 1031430106, count: 500 });
  assert.equal(history.length, 1);
  const historyBody = JSON.parse(calls[2].init.body);
  assert.equal(historyBody.group_id, 1031430106);
  assert.equal(historyBody.count, 200, 'count is clamped to 200');

  const sentImage = await client.sendGroupImage(1031430106, PNG, { caption: '今日语录' });
  assert.equal(sentImage.message_id, 9001);
  const imageBody = JSON.parse(calls[3].init.body);
  assert.equal(imageBody.group_id, 1031430106);
  assert.equal(imageBody.message[0].type, 'image');
  assert.ok(imageBody.message[0].data.file.startsWith('base64://'));
  assert.equal(imageBody.message[1].type, 'text');
  assert.equal(imageBody.message[1].data.text, '今日语录');

  const sentText = await client.sendGroupText('478864863', 'hello');
  assert.equal(sentText.message_id, 9002);
  const textBody = JSON.parse(calls[4].init.body);
  assert.equal(textBody.group_id, 478864863);
  assert.deepEqual(textBody.message, [{ type: 'text', data: { text: 'hello' } }]);

  const imageInfo = await client.getImage('a.jpg');
  assert.ok(imageInfo.base64.startsWith('base64://'));

  // ---- retcode / HTTP error handling -----------------------------------------
  const failing = createOneBotClient({
    httpUrl: 'http://127.0.0.1:3000',
    fetchImpl: async () => jsonResponse({ status: 'failed', retcode: 1401, wording: 'access token invalid' }),
  });
  await assert.rejects(
    () => failing.getLoginInfo(),
    (error) => error instanceof OneBotError && error.retcode === 1401 && /access token invalid/.test(error.message),
  );

  const brokenJson = createOneBotClient({
    httpUrl: 'http://127.0.0.1:3000',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not-json', arrayBuffer: async () => Buffer.alloc(0), headers: { get: () => null } }),
  });
  await assert.rejects(() => brokenJson.getLoginInfo(), /invalid JSON/);

  const unreachable = createOneBotClient({
    httpUrl: 'http://127.0.0.1:3000',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(() => unreachable.getLoginInfo(), /cannot reach OneBot HTTP API/);

  // ---- message helpers -------------------------------------------------------
  const message = HISTORY[0];
  assert.equal(extractText(message), '看这个');
  assert.equal(extractImages(message).length, 1);
  assert.equal(speakerOf(message), 'A姐');
  assert.equal(senderIdOf(message), '2');
  assert.equal(speakerOf({ sender: { nickname: 'bob' } }), 'bob');
  assert.equal(speakerOf({ sender: { user_id: 42 } }), '42');
  assert.equal(senderIdOf({ sender: {} }), '');

  assert.equal(detectImageExtension({ buffer: PNG }), 'png');
  assert.equal(detectImageExtension({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }), 'jpg');
  assert.equal(detectImageExtension({ contentType: 'image/webp' }), 'webp');
  assert.equal(detectImageExtension({ url: 'https://x/y/photo.gif?x=1' }), 'gif');
  assert.equal(detectImageExtension({}), 'jpg');

  // ---- image download: URL first, then get_image base64 -----------------------
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'quote-archive-onebot-'));
  try {
    const { calls: imageCalls, fetchImpl: imageFetch } = makeFetch(async (url) => {
      if (url === 'http://img.example/a.jpg') return imageResponse(PNG, 'image/png');
      throw new Error('unexpected');
    });
    const withUrl = await downloadImageBytes(client, { segment: { data: { url: 'http://img.example/a.jpg', file: 'a.jpg' } }, fetchImpl: imageFetch });
    assert.equal(withUrl.extension, 'png');
    assert.deepEqual(Buffer.from(withUrl.buffer), PNG);
    assert.equal(imageCalls.length, 1);

    const viaGetImage = await downloadImageBytes(client, { segment: { data: { file: 'b.jpg' } } });
    assert.equal(viaGetImage.extension, 'png');
    assert.deepEqual(Buffer.from(viaGetImage.buffer), PNG);

    const failingChannel = {
      getImage: async () => {
        throw new Error('gone');
      },
    };
    await assert.rejects(() => downloadImageBytes(failingChannel, { segment: { data: { file: 'c.jpg' } } }), /cannot download the quote image/);
    void tmp;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('onebot OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
