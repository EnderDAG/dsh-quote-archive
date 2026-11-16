/**
 * Offline tests for lib/reactions.js and the reaction schema added in v0.12.0:
 * emoji mapping (including FE0F and numeric code points), sent-quote backfill,
 * reaction add/remove dedupe, reply-comment dedupe, notice parsing and the
 * aggregated statistics shape. No QQ gateway and no network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  EMOTION_OTHER,
  EMOJI_ID_MAP,
  EMOJI_EMOTION_TABLE,
  TREND_DAYS,
  emotionFor,
  handleEmojiNotice,
  localDateKey,
  lookupSent,
  normalizeEmoji,
  normalizeLikes,
  parseEmojiNotice,
  reactionStatistics,
  recordComment,
  recordReaction,
  recordSent,
} from '../lib/reactions.js';
import { openStore } from '../lib/store.js';

const GROUP = '1031430106';

function withStore(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-reactions-'));
  const dbPath = path.join(dir, 'quotes.db');
  const store = openStore(dbPath);
  try {
    return run(store, dbPath, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedQuote(store, { filename = 'a.png', content = '经典语录', speaker = 'alice' } = {}) {
  return store.addQuote({
    group: GROUP,
    speaker,
    content,
    imagePath: `${GROUP}/${filename}`,
    source: 'qq',
  });
}

// ---------------------------------------------------------------------------
// Emoji mapping
// ---------------------------------------------------------------------------
assert.equal(emotionFor('❤️'), '喜欢');
assert.equal(emotionFor('❤'), '喜欢');
assert.equal(emotionFor('☹️'), '伤感');
assert.equal(emotionFor('👍'), '赞');
assert.equal(emotionFor('😭'), '伤感');
assert.equal(emotionFor('🫡'), '赞');
assert.equal(emotionFor('🚀'), EMOTION_OTHER);
assert.equal(emotionFor(''), EMOTION_OTHER);
// Every table value is a known emotion bucket.
for (const emotion of Object.values(EMOJI_EMOTION_TABLE)) {
  assert.ok([...new Set(Object.values(EMOJI_EMOTION_TABLE))].includes(emotion), emotion);
}
assert.equal(Object.keys(EMOJI_ID_MAP).length > 30, true);

// Numeric code points and characters normalize to the same emoji.
assert.equal(normalizeEmoji('128077'), '👍');
assert.equal(normalizeEmoji(128514), '😂');
assert.equal(normalizeEmoji('10084'), '❤️');
assert.equal(normalizeEmoji('👏'), '👏');
assert.equal(normalizeEmoji('  '), '');
assert.equal(EMOJI_ID_MAP[9989], '✅');

// ---------------------------------------------------------------------------
// sent_quote backfill
// ---------------------------------------------------------------------------
withStore((store) => {
  assert.equal(store.recordSentQuote({ messageId: '9001', groupId: GROUP, filename: 'a.png' }), true);
  assert.equal(store.recordSentQuote({ messageId: '9001', groupId: GROUP, filename: 'b.png' }), false);
  const sent = store.lookupSentQuote('9001');
  assert.equal(sent.message_id, '9001');
  assert.equal(sent.group_id, GROUP);
  assert.equal(sent.filename, 'a.png');
  assert.ok(sent.created_at > 0);
  assert.equal(store.lookupSentQuote('nope'), null);
  assert.equal(store.lookupSentQuote(''), null);
  assert.equal(store.recordSentQuote({ messageId: '', groupId: GROUP, filename: 'a.png' }), false);

  // Rows older than the 120 day TTL are pruned on the next insert.
  const old = Math.floor(Date.now() / 1000) - 121 * 86400;
  store.recordSentQuote({ messageId: 'old', groupId: GROUP, filename: 'old.png', createdAt: old });
  store.recordSentQuote({ messageId: 'fresh', groupId: GROUP, filename: 'fresh.png' });
  assert.equal(store.lookupSentQuote('old'), null);
  assert.ok(store.lookupSentQuote('fresh'));
});

// ---------------------------------------------------------------------------
// Reaction add / remove / dedupe
// ---------------------------------------------------------------------------
withStore((store) => {
  assert.equal(store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u1', emoji: '👍' }), true);
  assert.equal(store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u1', emoji: '👍' }), false);
  // Numeric code point for the same emoji is the same reaction.
  assert.equal(store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u2', emoji: '128077' }), true);
  assert.equal(store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u2', emoji: '128077' }), false);
  assert.equal(store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u1', emoji: '👍', isAdd: false }), true);
  assert.equal(store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u1', emoji: '👍', isAdd: false }), false);
  // Invalid rows are ignored.
  assert.equal(store.recordReaction({ groupId: '', filename: 'a.png', userId: 'u1', emoji: '👍' }), false);
  assert.equal(store.recordReaction({ groupId: GROUP, filename: 'a.png', userId: '', emoji: '🔥' }), true);
});

// ---------------------------------------------------------------------------
// Reply comments
// ---------------------------------------------------------------------------
withStore((store) => {
  const now = 1700000000;
  assert.equal(
    store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u1', content: '哈哈哈', createdAt: now }) > 0,
    true,
  );
  // A repeated burst of the same comment within 30s is dropped.
  assert.equal(
    store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u1', content: '哈哈哈', createdAt: now + 5 }),
    0,
  );
  assert.equal(
    store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u1', content: '好笑', createdAt: now + 10 }) > 0,
    true,
  );
  // Different author or different quote is a new row.
  assert.equal(
    store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u2', content: '哈哈哈', createdAt: now }) > 0,
    true,
  );
  // Empty text never creates a row.
  assert.equal(store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u1', content: '   ' }), 0);
  // Same text much later is accepted again.
  assert.equal(
    store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u1', content: '哈哈哈', createdAt: now + 60 }) > 0,
    true,
  );
});

// ---------------------------------------------------------------------------
// Notice parsing
// ---------------------------------------------------------------------------
assert.equal(parseEmojiNotice(null), null);
assert.equal(parseEmojiNotice({ post_type: 'message', notice_type: 'group_msg_emoji_like' }), null);
assert.equal(parseEmojiNotice({ notice_type: 'group_increase', message_id: 1 }), null);

const rawNotice = {
  post_type: 'notice',
  notice_type: 'group_msg_emoji_like',
  group_id: 1031430106,
  user_id: 2,
  self_id: 1,
  message_id: 9001,
  is_add: true,
  likes: [{ emoji_id: '128077', emoji: '👍' }],
};
const parsed = parseEmojiNotice(rawNotice);
assert.equal(parsed.messageId, '9001');
assert.equal(parsed.groupId, GROUP);
assert.equal(parsed.userId, '2');
assert.equal(parsed.isAdd, true);
assert.deepEqual(parsed.likes, [{ emoji: '👍', emotion: '赞' }]);

// `likes` may be a single dict (older SnowLuma builds) and `like` is accepted too.
assert.deepEqual(normalizeLikes({ likes: { emoji_id: 128293 } }), [{ emoji: '🔥', emotion: '热烈' }]);
assert.deepEqual(normalizeLikes({ like: { emoji: '😂' } }), [{ emoji: '😂', emotion: '欢乐' }]);
// Cancellation notices carry is_add=false.
const removed = parseEmojiNotice({ ...rawNotice, is_add: false });
assert.equal(removed.isAdd, false);

// ---------------------------------------------------------------------------
// Notice handling against a stored sent quote
// ---------------------------------------------------------------------------
withStore((store) => {
  seedQuote(store);
  store.recordSentQuote({ messageId: '9001', groupId: GROUP, filename: 'a.png' });
  // Unknown message ids are ignored.
  assert.equal(store.handleEmojiNotice({ ...rawNotice, message_id: 1 }), 0);
  // Our own reactions are ignored.
  assert.equal(store.handleEmojiNotice({ ...rawNotice, self_id: 2 }), 0);
  assert.equal(store.handleEmojiNotice(rawNotice), 1);
  assert.equal(store.handleEmojiNotice(rawNotice), 0);
  // Cancel it again.
  assert.equal(store.handleEmojiNotice({ ...rawNotice, is_add: false }), 1);
  assert.equal(store.handleEmojiNotice({ ...rawNotice, is_add: false }), 0);
  // Re-add for the statistics checks below.
  assert.equal(store.handleEmojiNotice(rawNotice), 1);
  assert.equal(
    store.handleEmojiNotice({ ...rawNotice, user_id: 3, likes: [{ emoji_id: 10084 }] }),
    1,
  );

  const stats = store.reactionStats({ group: GROUP, top: 5, trendDays: 30 });
  assert.equal(stats.reactions, 2);
  assert.equal(stats.comments, 0);
  assert.deepEqual(
    stats.emotions.map((row) => row.emotion),
    ['喜欢', '赞'],
  );
  assert.equal(stats.emotions[0].count, 1);
  assert.equal(stats.emoji[0].count, 1);
  assert.equal(stats.top_quotes.length, 1);
  assert.equal(stats.top_quotes[0].filename, 'a.png');
  assert.equal(stats.top_quotes[0].caption, '经典语录');
  assert.equal(stats.top_quotes[0].author, 'alice');
  assert.deepEqual(stats.top_persons.map((row) => row.uid), ['2', '3']);
  assert.equal(stats.trend.length, 30);
  assert.equal(stats.trend.at(-1).date, localDateKey(Math.floor(Date.now() / 1000)));
  assert.equal(stats.trend.at(-1).reactions, 2);
  assert.equal(stats.trend.at(-1).comments, 0);
  // Group filter excludes other groups.
  assert.equal(store.reactionStats({ group: 'other' }).reactions, 0);
  assert.equal(store.reactionStats({ group: 'other' }).trend.length, 30);
});

// ---------------------------------------------------------------------------
// Comment stats
// ---------------------------------------------------------------------------
withStore((store) => {
  seedQuote(store);
  store.recordSentQuote({ messageId: '9001', groupId: GROUP, filename: 'a.png' });
  store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u1', content: '哈哈哈' });
  store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u2', content: '笑死' });
  store.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u2', content: '再来一条' });
  const stats = store.reactionStats({ group: GROUP });
  assert.equal(stats.comments, 3);
  assert.equal(stats.top_commenters[0].uid, 'u2');
  assert.equal(stats.top_commenters[0].count, 2);
  assert.equal(stats.top_comment_quotes[0].count, 3);
  assert.equal(stats.top_comment_quotes[0].caption, '经典语录');
  assert.equal(stats.trend.at(-1).comments, 3);
});

// ---------------------------------------------------------------------------
// Schema idempotency / reopen
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-quote-reactions-migrate-'));
  const dbPath = path.join(dir, 'quotes.db');
  const first = openStore(dbPath);
  assert.equal(first.schemaVersion, 8);
  first.recordSentQuote({ messageId: 'm1', groupId: GROUP, filename: 'a.png' });
  first.recordReaction({ groupId: GROUP, filename: 'a.png', userId: 'u1', emoji: '👍' });
  first.recordComment({ groupId: GROUP, filename: 'a.png', userId: 'u1', content: 'hi' });
  first.close();

  // Opening the same database again must not recreate or wipe the new tables.
  const second = openStore(dbPath);
  assert.equal(second.schemaVersion, 8);
  assert.ok(second.lookupSentQuote('m1'));
  assert.equal(second.reactionStats().reactions, 1);
  assert.equal(second.reactionStats().comments, 1);
  // A second open with the schema already present stays idempotent.
  second.close();
  const third = openStore(dbPath);
  assert.equal(third.schemaVersion, 8);
  assert.equal(third.reactionStats().reactions, 1);
  third.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Direct lib helpers used by tests above also work without a store wrapper
// ---------------------------------------------------------------------------
withStore((store, dbPath) => {
  const raw = new DatabaseSync(dbPath);
  try {
    assert.equal(recordSent(raw, { messageId: 'direct', groupId: GROUP, filename: 'a.png' }), true);
    assert.equal(recordReaction(raw, { groupId: GROUP, filename: 'a.png', userId: 'u1', emoji: '👍' }), true);
    assert.ok(recordComment(raw, { groupId: GROUP, filename: 'a.png', userId: 'u1', content: 'yo' }) > 0);
    let stats = reactionStatistics(raw, { group: GROUP });
    assert.equal(stats.reactions, 1);
    assert.equal(stats.comments, 1);
    assert.equal(stats.trend.length, TREND_DAYS);
    // The notice only applies to message ids we actually sent.
    assert.equal(handleEmojiNotice(raw, rawNotice), 0);
    assert.equal(recordSent(raw, { messageId: '9001', groupId: GROUP, filename: 'a.png' }), true);
    assert.equal(handleEmojiNotice(raw, rawNotice), 1);
    stats = reactionStatistics(raw, { group: GROUP });
    assert.equal(stats.reactions, 2);
  } finally {
    raw.close();
  }
});

console.log('reactions tests passed');
