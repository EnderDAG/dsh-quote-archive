/**
 * Offline tests for lib/collect.js — a fake OneBot channel plus a temporary
 * SQLite store, no QQ gateway and no network.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncGroup } from '../lib/collect.js';
import { openStore } from '../lib/store.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function imageResponse(buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => buffer,
    text: async () => '',
  };
}

function makeMessages() {
  return [
    {
      message_id: 1,
      time: 10,
      sender: { user_id: 2, nickname: 'alice' },
      message: [{ type: 'text', data: { text: 'no image here' } }],
    },
    {
      message_id: 2,
      time: 20,
      sender: { user_id: 2, nickname: 'alice', card: 'A姐' },
      message: [
        { type: 'text', data: { text: '看看这张' } },
        { type: 'image', data: { file: '2.png', url: 'http://img.example/2.png' } },
      ],
    },
    {
      message_id: 3,
      time: 30,
      sender: { user_id: 10001, nickname: 'tester' },
      message: [{ type: 'image', data: { file: '3.png', url: 'http://img.example/3.png' } }],
    },
    {
      message_id: 4,
      time: 40,
      sender: { user_id: 3, nickname: 'bob' },
      message: [{ type: 'image', data: { file: 'expired.jpg' } }],
    },
  ];
}

function makeChannel() {
  const channel = {
    async getGroupMsgHistory({ groupId, count }) {
      assert.equal(groupId, '1031430106');
      assert.equal(count, 50);
      return makeMessages();
    },
    async getLoginInfo() {
      return { user_id: 10001, nickname: 'tester' };
    },
    async getGroupList() {
      return [{ group: '1031430106', name: '主群' }];
    },
    async getImage() {
      throw new Error('image expired');
    },
  };
  return channel;
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'quote-archive-collect-'));
  const store = openStore(path.join(tmp, 'quotes.db'), { imagesDir: path.join(tmp, 'images') });
  const imageFetch = async (url) => {
    if (url === 'http://img.example/2.png') return imageResponse(PNG);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    // First sync: one image archived, self/text skipped, stale image failed.
    const result = await syncGroup({
      channel: makeChannel(),
      store,
      groupId: '1031430106',
      limit: 50,
      downloadImages: true,
      fetchImpl: imageFetch,
    });
    assert.equal(result.group, '1031430106');
    assert.equal(result.scanned, 4);
    assert.equal(result.added, 1);
    assert.equal(result.downloaded, 1);
    assert.equal(result.deduped, 0);
    assert.equal(result.skipped, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].messageId, '4');
    assert.match(result.errors[0].error, /cannot download the quote image|image expired/);

    const stored = store.findQuoteByMessageId('2');
    assert.ok(stored, 'quote is stored');
    assert.equal(stored.group, '1031430106');
    assert.equal(stored.speaker, 'A姐');
    assert.equal(stored.content, '看看这张');
    assert.equal(stored.source, 'qq');
    assert.equal(stored.imagePath, path.posix.join('1031430106', '2.png'));

    const absolute = path.join(store.imagesDir, ...stored.imagePath.split('/'));
    assert.ok(existsSync(absolute), 'image file is written');
    assert.deepEqual(readFileSync(absolute), PNG);

    const groups = store.listGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].group, '1031430106');
    assert.equal(groups[0].name, '主群');

    // Second sync over the same history: the archived message is deduplicated.
    const again = await syncGroup({
      channel: makeChannel(),
      store,
      groupId: '1031430106',
      limit: 50,
      downloadImages: true,
      fetchImpl: imageFetch,
    });
    assert.equal(again.added, 0);
    assert.equal(again.deduped, 1);
    assert.equal(again.skipped, 2);
    assert.equal(again.failed, 1);
    assert.equal(store.stats().totals.quotes, 1);

    // Text mode: no image is downloaded and no image path is recorded.
    const other = openStore(path.join(tmp, 'other.db'), { imagesDir: path.join(tmp, 'other-images') });
    try {
      const textOnly = await syncGroup({
        channel: makeChannel(),
        store: other,
        groupId: '1031430106',
        downloadImages: false,
      });
      assert.equal(textOnly.added, 2, 'both image messages are stored as text quotes');
      assert.equal(textOnly.downloaded, 0);
      assert.equal(textOnly.failed, 0);
      const quote = other.findQuoteByMessageId('2');
      assert.equal(quote.imagePath, '');
      assert.equal(quote.content, '看看这张');
      const fallback = other.findQuoteByMessageId('4');
      assert.equal(fallback.content, '[图片语录]');
    } finally {
      other.close();
    }

    // Guard clauses.
    await assert.rejects(() => syncGroup({ channel: makeChannel(), store }), /group id is required/);
    await assert.rejects(() => syncGroup({ channel: {}, store, groupId: '1' }), /QQ channel is not configured/);
    await assert.rejects(() => syncGroup({ channel: makeChannel(), store: {}, groupId: '1' }), /quote store is not available/);

    console.log('collect OK');
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
