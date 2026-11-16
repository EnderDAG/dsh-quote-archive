/**
 * Emoji reactions and reply-comments on archived quotes.
 *
 * Ported from the AstrBot plugin (quote_reactions.py v3.1.0) so both editions
 * produce the same tables, the same emotion buckets and the same aggregate
 * shape. The functions here operate on the raw `node:sqlite` DatabaseSync
 * handle owned by lib/store.js; the storage layer creates the tables and
 * re-exports the helpers used by the rest of the plugin.
 *
 * Data model:
 *   sent_quote(message_id PK, group_id, filename, created_at)
 *     One row per quote image the plugin sent through the QQ channel. A
 *     reaction notice only carries the QQ message id, so this table is the
 *     bridge from `message_id` back to `group_id` + `filename`.
 *   quote_reaction(id, group_id, filename, user_id, emoji, emotion, created_at,
 *                  UNIQUE(group_id, filename, user_id, emoji))
 *     One row per (quote, user, emoji): re-adding is idempotent, removing
 *     deletes the row.
 *   quote_comment(id, group_id, filename, user_id, content, source, created_at)
 *     Reply text posted under a quote, deduped with a 30 second window.
 */
export const EMOTION_OTHER = '其他';
export const EMOTION_ORDER = ['喜欢', '欢乐', '赞', '心动', '惊讶', '热烈', '伤感', '生气', EMOTION_OTHER];
export const SENT_QUOTE_TTL = 120 * 86400;
export const CAPTION_LIMIT = 48;
export const TREND_DAYS = 30;

/** Unicode variation selector-16 (emoji presentation selector). */
const FE0F = '\ufe0f';

/**
 * emoji -> emotion buckets, copied from the AstrBot plugin so both editions
 * classify the same emoji the same way.
 */
export const EMOJI_EMOTION_TABLE = {
  // 喜欢
  '❤️': '喜欢',
  '❤': '喜欢',
  '💗': '喜欢',
  '💓': '喜欢',
  '💕': '喜欢',
  '💖': '喜欢',
  '💘': '喜欢',
  '💝': '喜欢',
  '🩷': '喜欢',
  '♥': '喜欢',
  // 欢乐
  '😆': '欢乐',
  '😄': '欢乐',
  '😂': '欢乐',
  '😁': '欢乐',
  '😀': '欢乐',
  '😃': '欢乐',
  '😊': '欢乐',
  '🤣': '欢乐',
  '😸': '欢乐',
  '😹': '欢乐',
  '😅': '欢乐',
  '🥳': '欢乐',
  '🤩': '欢乐',
  '🤗': '欢乐',
  '😋': '欢乐',
  '😛': '欢乐',
  '😜': '欢乐',
  '🤪': '欢乐',
  '🤭': '欢乐',
  '😏': '欢乐',
  '🙃': '欢乐',
  '😉': '欢乐',
  '😝': '欢乐',
  '🤡': '欢乐',
  // 赞
  '👍': '赞',
  '👏': '赞',
  '💯': '赞',
  '🙌': '赞',
  '👌': '赞',
  '🆗': '赞',
  '✅': '赞',
  '🫡': '赞',
  '🤝': '赞',
  '🙏': '赞',
  '🌟': '赞',
  // 心动
  '😍': '心动',
  '🥰': '心动',
  '😘': '心动',
  '😻': '心动',
  '💋': '心动',
  '💞': '心动',
  '💌': '心动',
  '😚': '心动',
  '😙': '心动',
  // 惊讶
  '😮': '惊讶',
  '😯': '惊讶',
  '😲': '惊讶',
  '😱': '惊讶',
  '😳': '惊讶',
  '🤯': '惊讶',
  // 热烈
  '🔥': '热烈',
  '💥': '热烈',
  '⚡': '热烈',
  '✨': '热烈',
  '🎉': '热烈',
  '💫': '热烈',
  // 伤感
  '😭': '伤感',
  '😢': '伤感',
  '😥': '伤感',
  '😓': '伤感',
  '🥲': '伤感',
  '💔': '伤感',
  '☹️': '伤感',
  '😔': '伤感',
  '😞': '伤感',
  '😿': '伤感',
  // 生气
  '😡': '生气',
  '😠': '生气',
  '🤬': '生气',
  '😤': '生气',
  '👿': '生气',
  '💢': '生气',
  '😾': '生气',
  '🖕': '生气',
};

/**
 * QQ/OneBot reports reaction emoji as numeric code points (`emoji_id`) instead
 * of the character itself. This is the same mapping the AstrBot plugin uses.
 */
export const EMOJI_ID_MAP = {
  10084: '❤️',
  10083: '❤️',
  128077: '👍',
  128078: '👎',
  128079: '👏',
  128175: '💯',
  128076: '👌',
  128588: '🙌',
  128591: '🙏',
  128525: '😍',
  129392: '🥰',
  128536: '😘',
  128514: '😂',
  128512: '😀',
  128513: '😁',
  128516: '😄',
  128517: '😆',
  128518: '😅',
  128521: '😉',
  129315: '🤣',
  129322: '🤣',
  128557: '😭',
  128546: '😢',
  128545: '😠',
  128544: '😡',
  128548: '😤',
  128558: '😮',
  128559: '😯',
  128560: '😲',
  128561: '😱',
  128563: '😳',
  128293: '🔥',
  128165: '💥',
  127881: '🎉',
  127775: '✨',
  9989: '✅',
  128064: '👀',
  128169: '💩',
  128148: '💔',
  129300: '🤔',
  128526: '😎',
  129313: '🤡',
};

/** Secondary lookup keyed by the emoji with any FE0F removed. */
const EMOTION_STRIPPED = (() => {
  const map = new Map();
  for (const [emoji, emotion] of Object.entries(EMOJI_EMOTION_TABLE)) {
    const key = emoji.split(FE0F).join('');
    if (!map.has(key)) map.set(key, emotion);
  }
  return map;
})();

function readString(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

/** Epoch seconds from a number (seconds or milliseconds), Date, or ISO string. */
function toUnixSeconds(value) {
  if (value === undefined || value === null || value === '') return Math.floor(Date.now() / 1000);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const number = Number(value);
  if (Number.isFinite(number)) {
    return Math.floor(number > 1e12 ? number / 1000 : number);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

/** Local calendar day (YYYY-MM-DD), matching store.localDateKey. */
export function localDateKey(ts) {
  const date = new Date(Number(ts) * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Turn a reaction payload value into the emoji character.
 * Accepts either the character itself or the numeric `emoji_id` code point.
 */
export function normalizeEmoji(raw) {
  const text = readString(raw);
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    const mapped = EMOJI_ID_MAP[Number(text)];
    if (mapped) return mapped;
  }
  return text;
}

/** Emotion bucket for one emoji (normalizes FE0F before giving up). */
export function emotionFor(emoji) {
  const normalized = normalizeEmoji(emoji);
  if (!normalized) return EMOTION_OTHER;
  if (EMOJI_EMOTION_TABLE[normalized]) return EMOJI_EMOTION_TABLE[normalized];
  const stripped = normalized.split(FE0F).join('');
  if (EMOTION_STRIPPED.has(stripped)) return EMOTION_STRIPPED.get(stripped);
  return EMOTION_OTHER;
}

/**
 * Remember the QQ message id of a quote image we just sent.
 * @returns {boolean} true when the row was new.
 */
export function recordSent(db, { messageId, groupId, filename, createdAt } = {}) {
  const id = readString(messageId);
  if (!id) return false;
  const now = toUnixSeconds(createdAt);
  db.prepare('DELETE FROM sent_quote WHERE created_at < ?').run(now - SENT_QUOTE_TTL);
  const result = db
    .prepare(
      'INSERT INTO sent_quote(message_id, group_id, filename, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING',
    )
    .run(id, readString(groupId), readString(filename), now);
  return Number(result.changes || 0) > 0;
}

/** @returns {{message_id: string, group_id: string, filename: string, created_at: number}|null} */
export function lookupSent(db, messageId) {
  const id = readString(messageId);
  if (!id) return null;
  const row = db
    .prepare('SELECT message_id, group_id, filename, created_at FROM sent_quote WHERE message_id = ?')
    .get(id);
  if (!row) return null;
  return {
    message_id: String(row.message_id),
    group_id: String(row.group_id ?? ''),
    filename: String(row.filename ?? ''),
    created_at: Number(row.created_at) || 0,
  };
}

/**
 * Add or remove one reaction row.
 * @returns {boolean} true when the table actually changed.
 */
export function recordReaction(db, { groupId, filename, userId, emoji, isAdd = true, emotion = '', createdAt } = {}) {
  const group = readString(groupId);
  const file = readString(filename);
  const user = readString(userId);
  const key = normalizeEmoji(emoji);
  if (!group || !file || !key) return false;
  if (isAdd === false) {
    const result = db
      .prepare('DELETE FROM quote_reaction WHERE group_id = ? AND filename = ? AND user_id = ? AND emoji = ?')
      .run(group, file, user, key);
    return Number(result.changes || 0) > 0;
  }
  const emotionName = readString(emotion) || emotionFor(key);
  const created = toUnixSeconds(createdAt);
  const result = db
    .prepare(
      'INSERT INTO quote_reaction(group_id, filename, user_id, emoji, emotion, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(group_id, filename, user_id, emoji) DO NOTHING',
    )
    .run(group, file, user, key, emotionName, created);
  return Number(result.changes || 0) > 0;
}

/**
 * Store one reply-comment under a quote. Repeating the same comment from the
 * same user within 30 seconds is ignored (QQ delivers bursts of the same event).
 * @returns {number} new row id, or 0 when empty / duplicate / invalid.
 */
export function recordComment(db, { groupId, filename, userId, content, source = 'reply', createdAt } = {}) {
  const group = readString(groupId);
  const file = readString(filename);
  const user = readString(userId);
  const text = String(content ?? '').trim().slice(0, 4000);
  if (!group || !file || !text) return 0;
  const created = toUnixSeconds(createdAt);
  const duplicate = db
    .prepare(
      'SELECT id FROM quote_comment WHERE group_id = ? AND filename = ? AND user_id = ? AND content = ? AND created_at >= ? LIMIT 1',
    )
    .get(group, file, user, text, created - 30);
  if (duplicate) return 0;
  const result = db
    .prepare(
      'INSERT INTO quote_comment(group_id, filename, user_id, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(group, file, user, text, readString(source) || 'reply', created);
  return Number(result.lastInsertRowid) || 0;
}

/** Normalize one `likes` entry into a raw emoji value. */
function likeEmojiValue(entry) {
  if (entry === undefined || entry === null) return '';
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (typeof entry === 'object') {
    const id = entry.emoji_id ?? entry.emojiId;
    if (id !== undefined && id !== null && String(id).trim() !== '') return String(id);
    const emoji = entry.emoji ?? entry.emoji_str;
    return emoji === undefined || emoji === null ? '' : String(emoji);
  }
  return '';
}

/** Normalize the reaction list of a notice (list or single dict). */
export function normalizeLikes(rawMessage) {
  const source = rawMessage?.likes ?? rawMessage?.like ?? [];
  const list = Array.isArray(source) ? source : [source];
  const likes = [];
  for (const entry of list) {
    const raw = likeEmojiValue(entry);
    const emoji = normalizeEmoji(raw);
    if (!emoji) continue;
    likes.push({ emoji, emotion: emotionFor(emoji) });
  }
  return likes;
}

/**
 * Parse a `group_msg_emoji_like` notice.
 * @returns {{messageId: string, userId: string, selfId: string, groupId: string, isAdd: boolean, likes: {emoji: string, emotion: string}[]}|null}
 */
export function parseEmojiNotice(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return null;
  if (String(rawMessage.notice_type ?? '') !== 'group_msg_emoji_like') return null;
  const messageId = readString(rawMessage.message_id);
  if (!messageId) return null;
  return {
    messageId,
    userId: readString(rawMessage.user_id),
    selfId: readString(rawMessage.self_id),
    groupId: readString(rawMessage.group_id),
    isAdd: rawMessage.is_add === undefined ? true : Boolean(rawMessage.is_add),
    likes: normalizeLikes(rawMessage),
  };
}

/**
 * Apply one emoji-like notice to the archive.
 * @returns {number} number of reaction rows added/removed.
 */
export function handleEmojiNotice(db, rawMessage) {
  const notice = parseEmojiNotice(rawMessage);
  if (!notice) return 0;
  if (notice.userId && notice.selfId && notice.userId === notice.selfId) return 0;
  if (notice.likes.length === 0) return 0;
  const sent = lookupSent(db, notice.messageId);
  if (!sent) return 0;
  let changed = 0;
  for (const like of notice.likes) {
    if (
      recordReaction(db, {
        groupId: sent.group_id,
        filename: sent.filename,
        userId: notice.userId,
        emoji: like.emoji,
        isAdd: notice.isAdd,
        emotion: like.emotion,
      })
    ) {
      changed += 1;
    }
  }
  return changed;
}

function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, (match) => '\\' + match);
}

/** Quote metadata used to caption reaction rows. */
function quoteInfoFor(db, groupId, filename) {
  const row = db
    .prepare(
      "SELECT speaker, content, subject_user, subject_name FROM quotes WHERE group_id = ? AND image_path LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1",
    )
    .get(String(groupId), `%/${escapeLike(filename)}`);
  if (!row) return { caption: '', author: '', person_id: '' };
  const content = String(row.content ?? '').trim();
  const caption = content && content !== '[图片语录]' ? content.slice(0, CAPTION_LIMIT) : '';
  return {
    caption,
    author: String(row.subject_name || row.speaker || ''),
    person_id: String(row.subject_user || ''),
  };
}

/**
 * Aggregated reaction/comment statistics.
 *
 * Mirrors AstrBot's `_aggregate` result: totals, emotion buckets, top emoji,
 * top reacted quotes, top reactors/commenters and a zero-filled daily trend.
 *
 * @param {object} db
 * @param {{group?: string, top?: number, trendDays?: number, now?: number}} [options]
 */
export function reactionStatistics(db, { group = '', top = 5, trendDays = TREND_DAYS, now } = {}) {
  const groupId = readString(group);
  const limit = Math.max(1, Math.min(50, Number(top) || 5));
  const emojiLimit = Math.max(limit, 8);
  const days = Math.max(1, Math.min(90, Number(trendDays) || TREND_DAYS));
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const where = groupId ? 'WHERE group_id = ?' : '';
  const args = groupId ? [groupId] : [];

  const reactionTotal = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM quote_reaction ${where}`).get(...args) || {}).n || 0,
  );
  const commentTotal = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM quote_comment ${where}`).get(...args) || {}).n || 0,
  );

  const emotionCounts = new Map();
  for (const row of db
    .prepare(`SELECT emotion, COUNT(*) AS n FROM quote_reaction ${where} GROUP BY emotion`)
    .all(...args)) {
    emotionCounts.set(String(row.emotion ?? ''), Number(row.n) || 0);
  }
  const emotions = EMOTION_ORDER.map((emotion) => ({ emotion, count: emotionCounts.get(emotion) || 0 })).filter(
    (row) => row.count > 0,
  );

  const emoji = db
    .prepare(
      `SELECT emoji, emotion, COUNT(*) AS n FROM quote_reaction ${where} GROUP BY emoji, emotion ORDER BY n DESC, emoji ASC LIMIT ?`,
    )
    .all(...args, emojiLimit)
    .map((row) => ({ emoji: String(row.emoji), emotion: String(row.emotion ?? ''), count: Number(row.n) || 0 }));

  const topQuotes = db
    .prepare(
      `SELECT group_id, filename, COUNT(*) AS n FROM quote_reaction ${where} GROUP BY group_id, filename ORDER BY n DESC, filename ASC LIMIT ?`,
    )
    .all(...args, limit)
    .map((row) => {
      const info = quoteInfoFor(db, row.group_id, row.filename);
      return {
        group_id: String(row.group_id),
        filename: String(row.filename),
        caption: info.caption,
        count: Number(row.n) || 0,
        author: info.author,
        person_id: info.person_id,
        avatar_sha: '',
      };
    });

  const topPersons = db
    .prepare(
      `SELECT user_id, COUNT(*) AS n FROM quote_reaction ${where} GROUP BY user_id ORDER BY n DESC, user_id ASC LIMIT ?`,
    )
    .all(...args, limit)
    .map((row) => {
      const uid = String(row.user_id ?? '');
      return { uid, person_id: '', display_name: uid, avatar_sha: '', count: Number(row.n) || 0 };
    });

  const topCommenters = db
    .prepare(
      `SELECT user_id, COUNT(*) AS n FROM quote_comment ${where} GROUP BY user_id ORDER BY n DESC, user_id ASC LIMIT ?`,
    )
    .all(...args, limit)
    .map((row) => {
      const uid = String(row.user_id ?? '');
      return { uid, person_id: '', display_name: uid, avatar_sha: '', count: Number(row.n) || 0 };
    });

  const topCommentedQuotes = db
    .prepare(
      `SELECT group_id, filename, COUNT(*) AS n FROM quote_comment ${where} GROUP BY group_id, filename ORDER BY n DESC, filename ASC LIMIT ?`,
    )
    .all(...args, limit)
    .map((row) => ({
      group_id: String(row.group_id),
      filename: String(row.filename),
      count: Number(row.n) || 0,
    }));

  const topCommentQuotes = topCommentedQuotes.map((row) => {
    const info = quoteInfoFor(db, row.group_id, row.filename);
    return {
      group_id: row.group_id,
      filename: row.filename,
      caption: info.caption,
      count: row.count,
      author: info.author,
      person_id: info.person_id,
      avatar_sha: '',
    };
  });

  // Zero-filled local-day trend for the last `days` days.
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const startMs = today.getTime() - (days - 1) * 86400000;
  const startSec = Math.floor(startMs / 1000);
  const buckets = new Map();
  for (let index = 0; index < days; index += 1) {
    buckets.set(localDateKey(Math.floor((startMs + index * 86400000) / 1000)), { reactions: 0, comments: 0 });
  }
  const bucketRows = (table) =>
    db.prepare(`SELECT created_at FROM ${table} WHERE created_at >= ? ${groupId ? 'AND group_id = ?' : ''}`).all(
      ...[startSec, ...(groupId ? [groupId] : [])],
    );
  for (const row of bucketRows('quote_reaction')) {
    const bucket = buckets.get(localDateKey(Number(row.created_at) || 0));
    if (bucket) bucket.reactions += 1;
  }
  for (const row of bucketRows('quote_comment')) {
    const bucket = buckets.get(localDateKey(Number(row.created_at) || 0));
    if (bucket) bucket.comments += 1;
  }
  const trend = [...buckets.entries()].map(([date, value]) => ({ date, ...value }));

  return {
    reactions: reactionTotal,
    comments: commentTotal,
    emotions,
    emoji,
    top_quotes: topQuotes,
    top_comment_quotes: topCommentQuotes,
    top_commented_quotes: topCommentedQuotes,
    top_persons: topPersons,
    top_commenters: topCommenters,
    trend,
  };
}
