/**
 * dsh-quote-archive storage layer.
 *
 * A tiny quote library on top of the built-in `node:sqlite` module. No native
 * dependencies and no external packages: the plugin can be loaded from a plain
 * directory install.
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 3;

const MAX_CONTENT_LENGTH = 4000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  message_id TEXT UNIQUE,
  speaker TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  image_path TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'local',
  restricted INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  subject_user TEXT NOT NULL DEFAULT '',
  subject_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_settings (
  group_id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS quote_tags (
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (quote_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_quotes_group ON quotes(group_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);

INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;

/** Add columns introduced after schema v1 without touching existing rows. */
const QUOTE_COLUMNS = [
  ['image_path', "ALTER TABLE quotes ADD COLUMN image_path TEXT NOT NULL DEFAULT ''"],
  ['source', "ALTER TABLE quotes ADD COLUMN source TEXT NOT NULL DEFAULT 'local'"],
  ['restricted', 'ALTER TABLE quotes ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0'],
  ['rating', 'ALTER TABLE quotes ADD COLUMN rating REAL NOT NULL DEFAULT 0'],
  ['subject_user', "ALTER TABLE quotes ADD COLUMN subject_user TEXT NOT NULL DEFAULT ''"],
  ['subject_name', "ALTER TABLE quotes ADD COLUMN subject_name TEXT NOT NULL DEFAULT ''"],
];

/**
 * Resolve the archive directory (the folder that holds the database and the
 * downloaded images). An explicit `dbPath` wins; otherwise the folder lives
 * under the DSH home directory so it survives plugin reinstalls.
 * @param {Record<string, unknown>} [config]
 * @returns {string}
 */
export function resolveArchiveDir(config = {}) {
  const custom = typeof config.dbPath === 'string' ? config.dbPath.trim() : '';
  if (custom === ':memory:') return path.join(os.tmpdir(), 'dsh-quote-archive');
  if (custom) return path.dirname(path.resolve(custom));
  const home = (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'quote-archive');
}

/**
 * Resolve the SQLite file to use.
 * @param {Record<string, unknown>} [config]
 * @returns {string}
 */
export function resolveDbPath(config = {}) {
  const custom = typeof config.dbPath === 'string' ? config.dbPath.trim() : '';
  if (custom === ':memory:') return ':memory:';
  if (custom) return path.resolve(custom);
  return path.join(resolveArchiveDir(config), 'quotes.db');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function toSeconds(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return Math.floor(number);
  return nowSeconds();
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENT';
  throw error;
}

function normalizeTags(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；\s]+/);
  const seen = new Set();
  const tags = [];
  for (const item of items) {
    const name = String(item ?? '').trim().replace(/^#+/, '').slice(0, MAX_TAG_LENGTH);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(name);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function toQuote(row, tags) {
  return {
    id: Number(row.id),
    group: String(row.group_id ?? ''),
    speaker: String(row.speaker ?? ''),
    content: String(row.content ?? ''),
    imagePath: String(row.image_path ?? ''),
    source: String(row.source ?? 'local'),
    restricted: Number(row.restricted ?? 0) !== 0,
    rating: Number(row.rating ?? 0),
    subjectUser: String(row.subject_user ?? ''),
    subjectName: String(row.subject_name ?? ''),
    createdAt: Number(row.created_at ?? 0),
    tags,
  };
}

/**
 * Open (and migrate) a quote archive.
 * @param {string} [dbPath]
 * @param {{imagesDir?: string}} [options]
 * @returns {object}
 */
export function openStore(dbPath, options = {}) {
  const file = dbPath || resolveDbPath();
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const imagesDir = path.resolve(
    options.imagesDir || (file === ':memory:' ? path.join(os.tmpdir(), 'dsh-quote-archive-images') : path.join(path.dirname(file), 'images')),
  );
  mkdirSync(imagesDir, { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const existingColumns = new Set(db.prepare('PRAGMA table_info(quotes)').all().map((row) => String(row.name)));
  for (const [column, statement] of QUOTE_COLUMNS) {
    if (!existingColumns.has(column)) db.exec(statement);
  }

  const insertGroup = db.prepare(
    'INSERT INTO groups(group_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO NOTHING',
  );
  const insertQuote = db.prepare(
    'INSERT INTO quotes(group_id, message_id, speaker, content, image_path, source, created_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const quoteByMessageId = db.prepare(
    'SELECT id, group_id, speaker, content, image_path, source, created_at FROM quotes WHERE message_id = ?',
  );
  const renameGroup = db.prepare(
    'INSERT INTO groups(group_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET name = excluded.name WHERE excluded.name <> \'\'',
  );
  const insertTag = db.prepare('INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const tagByName = db.prepare('SELECT id FROM tags WHERE name = ?');
  const linkTag = db.prepare('INSERT OR IGNORE INTO quote_tags(quote_id, tag_id) VALUES (?, ?)');
  const tagsOfQuote = db.prepare(
    'SELECT t.name FROM quote_tags qt JOIN tags t ON t.id = qt.tag_id WHERE qt.quote_id = ? ORDER BY t.name ASC',
  );
  const quotesCount = db.prepare('SELECT COUNT(*) AS n FROM quotes');
  const quotedGroupsCount = db.prepare('SELECT COUNT(DISTINCT group_id) AS n FROM quotes');
  const quoteById = db.prepare(
    'SELECT id, group_id, speaker, content, image_path, source, created_at FROM quotes WHERE id = ?',
  );
  const speakersCount = db.prepare("SELECT COUNT(DISTINCT speaker) AS n FROM quotes WHERE speaker <> ''");
  const tagsCount = db.prepare('SELECT COUNT(*) AS n FROM tags');
  const perGroup = db.prepare(
    'SELECT group_id, COUNT(*) AS n FROM quotes GROUP BY group_id ORDER BY n DESC, group_id ASC LIMIT 50',
  );
  const topSpeakers = db.prepare(
    "SELECT speaker, COUNT(*) AS n FROM quotes WHERE speaker <> '' GROUP BY speaker ORDER BY n DESC, speaker ASC LIMIT 10",
  );
  const groupRows = db.prepare(
    'SELECT g.group_id, g.name, (SELECT COUNT(*) FROM quotes q WHERE q.group_id = g.group_id) AS n FROM groups g ORDER BY n DESC, g.group_id ASC LIMIT 50',
  );

  function tagsFor(quoteId) {
    return tagsOfQuote.all(quoteId).map((row) => String(row.name));
  }

  function attachTags(quoteId, tag) {
    for (const name of normalizeTags(tag)) {
      insertTag.run(name);
      const row = tagByName.get(name);
      if (row) linkTag.run(quoteId, Number(row.id));
    }
  }

  /**
   * Add one quote. `messageId` deduplicates the same IM message.
   * @returns {{id: number, deduped: boolean}}
   */
  function addQuote({ group, speaker, content, messageId, tag, imagePath, source, createdAt } = {}) {
    const groupId = String(group ?? '').trim() || 'default';
    const text = String(content ?? '').trim();
    if (!text) invalid('content is required');
    if (text.length > MAX_CONTENT_LENGTH) invalid(`content is longer than ${MAX_CONTENT_LENGTH} characters`);
    const msgId = String(messageId ?? '').trim();

    insertGroup.run(groupId, '', nowSeconds());

    if (msgId) {
      const existing = quoteByMessageId.get(msgId);
      if (existing) {
        attachTags(Number(existing.id), tag);
        return { id: Number(existing.id), deduped: true };
      }
    }

    const image = String(imagePath ?? '').trim();
    const origin = String(source ?? '').trim() || 'local';
    const created = toSeconds(createdAt);

    let result;
    try {
      result = insertQuote.run(groupId, msgId || null, String(speaker ?? '').trim(), text, image, origin, created, nowSeconds());
    } catch (error) {
      // Lost a race against another writer with the same message_id.
      if (msgId && String(error?.message ?? '').includes('UNIQUE')) {
        const existing = quoteByMessageId.get(msgId);
        if (existing) {
          attachTags(Number(existing.id), tag);
          return { id: Number(existing.id), deduped: true };
        }
      }
      throw error;
    }

    const id = Number(result.lastInsertRowid);
    attachTags(id, tag);
    return { id, deduped: false };
  }

  /** @returns {object|null} the stored quote for one IM message id */
  function findQuoteByMessageId(messageId) {
    const msgId = String(messageId ?? '').trim();
    if (!msgId) return null;
    const row = quoteByMessageId.get(msgId);
    return row ? toQuote(row, tagsFor(Number(row.id))) : null;
  }

  /** @returns {object|null} the stored quote with one numeric id */
  function getQuote(id) {
    const number = Number(id);
    if (!Number.isInteger(number) || number <= 0) return null;
    const row = quoteById.get(number);
    return row ? toQuote(row, tagsFor(Number(row.id))) : null;
  }

  /** Remember the display name of a group. */
  function setGroupName(groupId, name) {
    const id = String(groupId ?? '').trim();
    const label = String(name ?? '').trim();
    if (!id || !label) return;
    renameGroup.run(id, label, nowSeconds());
  }

  /** @returns {object|null} a random quote matching the filters */
  function recallQuote({ group, speaker, tag } = {}) {
    const from = ['FROM quotes q'];
    const where = [];
    const params = [];

    const tags = normalizeTags(tag);
    if (tags.length > 0) {
      from.push('JOIN quote_tags qt ON qt.quote_id = q.id');
      from.push('JOIN tags t ON t.id = qt.tag_id');
      where.push(`t.name IN (${tags.map(() => '?').join(', ')})`);
      params.push(...tags);
    }
    const groupId = String(group ?? '').trim();
    if (groupId) {
      where.push('q.group_id = ?');
      params.push(groupId);
    }
    const name = String(speaker ?? '').trim();
    if (name) {
      where.push('q.speaker = ?');
      params.push(name);
    }

    const sql = [
      'SELECT q.id, q.group_id, q.speaker, q.content, q.image_path, q.source, q.created_at',
      ...from,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY RANDOM() LIMIT 1',
    ]
      .filter(Boolean)
      .join(' ');
    const row = db.prepare(sql).get(...params);
    return row ? toQuote(row, tagsFor(Number(row.id))) : null;
  }

  function searchQuotes({ query, group, speaker, tag, limit } = {}) {
    const where = [];
    const params = [];
    const text = String(query ?? '').trim();
    if (text) {
      where.push("q.content LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(text)}%`);
    }
    const groupId = String(group ?? '').trim();
    if (groupId) {
      where.push('q.group_id = ?');
      params.push(groupId);
    }
    const name = String(speaker ?? '').trim();
    if (name) {
      where.push('q.speaker LIKE ? ESCAPE \'\\\'');
      params.push(`%${escapeLike(name)}%`);
    }
    const tags = normalizeTags(tag);
    const joins = ['FROM quotes q'];
    if (tags.length > 0) {
      joins.push('JOIN quote_tags qt ON qt.quote_id = q.id');
      joins.push('JOIN tags t ON t.id = qt.tag_id');
      where.push(`t.name IN (${tags.map(() => '?').join(', ')})`);
      params.push(...tags);
    }
    const sql = [
      'SELECT q.id, q.group_id, q.speaker, q.content, q.image_path, q.source, q.created_at',
      ...joins,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY q.created_at DESC, q.id DESC',
      'LIMIT ?',
    ]
      .filter(Boolean)
      .join(' ');
    params.push(clamp(limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT));
    return db.prepare(sql).all(...params).map((row) => toQuote(row, tagsFor(Number(row.id))));
  }

  function listQuotes({ group, speaker, tag, limit, offset } = {}) {
    const where = [];
    const params = [];
    const groupId = String(group ?? '').trim();
    if (groupId) {
      where.push('q.group_id = ?');
      params.push(groupId);
    }
    const name = String(speaker ?? '').trim();
    if (name) {
      where.push('q.speaker LIKE ? ESCAPE \'\\\'');
      params.push(`%${escapeLike(name)}%`);
    }
    const tags = normalizeTags(tag);
    const joins = ['FROM quotes q'];
    if (tags.length > 0) {
      joins.push('JOIN quote_tags qt ON qt.quote_id = q.id');
      joins.push('JOIN tags t ON t.id = qt.tag_id');
      where.push(`t.name IN (${tags.map(() => '?').join(', ')})`);
      params.push(...tags);
    }
    const sql = [
      'SELECT q.id, q.group_id, q.speaker, q.content, q.image_path, q.source, q.created_at',
      ...joins,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY q.created_at DESC, q.id DESC',
      'LIMIT ? OFFSET ?',
    ]
      .filter(Boolean)
      .join(' ');
    params.push(clamp(limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT), clamp(offset ?? 0, 0, 100000));
    return db.prepare(sql).all(...params).map((row) => toQuote(row, tagsFor(Number(row.id))));
  }

  function stats() {
    return {
      totals: {
        quotes: Number(quotesCount.get().n),
        groups: Number(quotedGroupsCount.get().n),
        speakers: Number(speakersCount.get().n),
        tags: Number(tagsCount.get().n),
      },
      groups: perGroup.all().map((row) => ({ group: String(row.group_id), count: Number(row.n) })),
      topSpeakers: topSpeakers.all().map((row) => ({ speaker: String(row.speaker), count: Number(row.n) })),
    };
  }

  function listGroups() {
    return groupRows.all().map((row) => ({
      group: String(row.group_id),
      name: String(row.name ?? ''),
      count: Number(row.n),
    }));
  }


  // ------------------------------------------------------------------ //
  // Manage-page helpers (AstrBot-compatible admin API).
  // ------------------------------------------------------------------ //

  function rowToManageQuote(row, tags) {
    return {
      id: Number(row.id),
      group: String(row.group_id),
      speaker: String(row.speaker ?? ''),
      content: String(row.content ?? ''),
      imagePath: String(row.image_path ?? ''),
      source: String(row.source ?? 'local'),
      restricted: Number(row.restricted ?? 0) !== 0,
      rating: Number(row.rating ?? 0),
      subjectUser: String(row.subject_user ?? ''),
      subjectName: String(row.subject_name ?? ''),
      createdAt: Number(row.created_at ?? 0),
      tags,
    };
  }

  const IMAGE_COLUMNS =
    'q.id, q.group_id, q.speaker, q.content, q.image_path, q.source, q.restricted, q.rating, ' +
    'q.subject_user, q.subject_name, q.created_at';

  function imageWhere(options = {}) {
    const where = ["q.image_path <> ''"];
    const params = [];
    const group = String(options.group ?? '').trim();
    if (group) {
      where.push('q.group_id = ?');
      params.push(group);
    }
    const restricted = String(options.restricted ?? '').trim();
    if (restricted === '1') where.push('q.restricted <> 0');
    else if (restricted === '0') where.push('q.restricted = 0');
    const assigned = String(options.assigned ?? '').trim();
    if (assigned === '1') where.push("q.subject_name <> ''");
    else if (assigned === '0') where.push("q.subject_name = ''");
    const speaker = String(options.speaker ?? '').trim();
    if (speaker) {
      where.push('q.speaker = ?');
      params.push(speaker);
    }
    const fromTs = Number(options.fromTs ?? 0);
    if (Number.isFinite(fromTs) && fromTs > 0) {
      where.push('q.created_at >= ?');
      params.push(Math.trunc(fromTs));
    }
    const q = String(options.q ?? '').trim();
    if (q) {
      where.push("(q.content LIKE ? ESCAPE '\\' OR q.speaker LIKE ? ESCAPE '\\' OR q.image_path LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(q)}%`;
      params.push(like, like, like);
    }
    const tags = normalizeTags(options.tag);
    const joins = ['FROM quotes q'];
    if (tags.length > 0) {
      joins.push('JOIN quote_tags qt ON qt.quote_id = q.id');
      joins.push('JOIN tags t ON t.id = qt.tag_id');
      where.push(`t.name IN (${tags.map(() => '?').join(', ')})`);
      params.push(...tags);
    }
    return { joins, where, params };
  }

  /**
   * Paginated image-quote listing for the admin page.
   * @returns {{items: object[], total: number}}
   */
  function listImageQuotes(options = {}) {
    const page = clamp(options.page ?? 1, 1, 1e6);
    const pageSize = clamp(options.pageSize ?? 48, 6, 200);
    const { joins, where, params } = imageWhere(options);
    const totalRow = db
      .prepare(['SELECT COUNT(*) AS n', ...joins, 'WHERE', where.join(' AND ')].join(' '))
      .get(...params);
    const order = String(options.sort ?? 'new') === 'old' ? 'ASC' : 'DESC';
    const rows = db
      .prepare(
        [
          `SELECT ${IMAGE_COLUMNS}`,
          ...joins,
          'WHERE',
          where.join(' AND '),
          `ORDER BY q.created_at ${order}, q.id ${order}`,
          'LIMIT ? OFFSET ?',
        ].join(' '),
      )
      .all(...params, pageSize, (page - 1) * pageSize);
    return {
      items: rows.map((row) => rowToManageQuote(row, tagsFor(Number(row.id)))),
      total: Number(totalRow?.n ?? 0),
    };
  }

  /** Distinct groups that actually contain image quotes, newest activity first. */
  function imageGroups() {
    return db
      .prepare(
        "SELECT q.group_id AS group_id, COUNT(*) AS n, MAX(q.created_at) AS latest_ts, g.name AS name " +
          "FROM quotes q LEFT JOIN groups g ON g.group_id = q.group_id " +
          "WHERE q.image_path <> '' GROUP BY q.group_id ORDER BY n DESC, q.group_id ASC LIMIT 100",
      )
      .all()
      .map((row) => ({
        group: String(row.group_id),
        name: String(row.name ?? ''),
        count: Number(row.n ?? 0),
        latestTs: Number(row.latest_ts ?? 0),
      }));
  }

  function findImageQuote(groupId, name) {
    const gid = String(groupId ?? '').trim();
    const file = String(name ?? '').trim();
    if (!gid || !file) return null;
    const row = db
      .prepare(
        `SELECT ${IMAGE_COLUMNS} FROM quotes q WHERE q.group_id = ? AND q.image_path LIKE ? ESCAPE '\\' LIMIT 1`,
      )
      .get(gid, `%/${escapeLike(file)}`);
    return row ? rowToManageQuote(row, tagsFor(Number(row.id))) : null;
  }

  function deleteQuoteById(id) {
    db.prepare('DELETE FROM quotes WHERE id = ?').run(Number(id));
  }

  function updateImageQuoteRef(id, groupId, imagePath) {
    db.prepare('UPDATE quotes SET group_id = ?, image_path = ? WHERE id = ?').run(
      String(groupId),
      String(imagePath),
      Number(id),
    );
  }

  function setRestricted(groupId, names, restricted) {
    const gid = String(groupId ?? '').trim();
    const value = restricted ? 1 : 0;
    let updated = 0;
    for (const name of names || []) {
      const row = findImageQuote(gid, name);
      if (!row) continue;
      db.prepare('UPDATE quotes SET restricted = ?, rating = ? WHERE id = ?').run(
        value,
        value ? Math.max(Number(row.rating) || 0, 0.5) : 0,
        row.id,
      );
      updated += 1;
    }
    return updated;
  }

  function setSubject(groupId, names, subjectName, subjectUser = '') {
    const gid = String(groupId ?? '').trim();
    const display = String(subjectName ?? '').trim().slice(0, 120);
    const user = String(subjectUser ?? '').trim().slice(0, 120);
    let updated = 0;
    for (const name of names || []) {
      const row = findImageQuote(gid, name);
      if (!row) continue;
      db.prepare('UPDATE quotes SET subject_name = ?, subject_user = ? WHERE id = ?').run(display, user, row.id);
      updated += 1;
    }
    return updated;
  }

  function deleteAllInGroup(groupId) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return [];
    const rows = db
      .prepare("SELECT id, image_path FROM quotes WHERE group_id = ? AND image_path <> ''")
      .all(gid);
    for (const row of rows) deleteQuoteById(Number(row.id));
    db.prepare('DELETE FROM group_settings WHERE group_id = ?').run(gid);
    return rows.map((row) => ({ id: Number(row.id), imagePath: String(row.image_path ?? '') }));
  }

  function listSpeakers({ group, q, limit, offset } = {}) {
    const where = ["speaker <> ''"];
    const params = [];
    const gid = String(group ?? '').trim();
    if (gid) {
      where.push('group_id = ?');
      params.push(gid);
    }
    const keyword = String(q ?? '').trim();
    if (keyword) {
      where.push("speaker LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(keyword)}%`);
    }
    return db
      .prepare(
        [
          'SELECT speaker, COUNT(*) AS n, MAX(created_at) AS latest_ts FROM quotes',
          `WHERE ${where.join(' AND ')}`,
          'GROUP BY speaker ORDER BY n DESC, speaker ASC',
          'LIMIT ? OFFSET ?',
        ].join(' '),
      )
      .all(...params, clamp(limit ?? 100, 1, 500), clamp(offset ?? 0, 0, 1e6))
      .map((row) => ({
        speaker: String(row.speaker ?? ''),
        count: Number(row.n ?? 0),
        latestTs: Number(row.latest_ts ?? 0),
      }));
  }

  function getGroupSettings(groupId) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return null;
    const row = db.prepare('SELECT data FROM group_settings WHERE group_id = ?').get(gid);
    if (!row) return null;
    try {
      return JSON.parse(String(row.data ?? '{}'));
    } catch {
      return {};
    }
  }

  function saveGroupSettings(groupId, patch) {
    const gid = String(groupId ?? '').trim();
    const current = getGroupSettings(gid) || {};
    const next = { ...current, ...(patch || {}) };
    db.prepare(
      'INSERT INTO group_settings(group_id, data) VALUES (?, ?) ' +
        'ON CONFLICT(group_id) DO UPDATE SET data = excluded.data',
    ).run(gid, JSON.stringify(next));
    return next;
  }

  function close() {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }

  return {
    path: file,
    schemaVersion: SCHEMA_VERSION,
    imagesDir,
    addQuote,
    findQuoteByMessageId,
    getQuote,
    setGroupName,
    recallQuote,
    searchQuotes,
    listQuotes,
    stats,
    listGroups,
    listImageQuotes,
    imageGroups,
    findImageQuote,
    deleteQuoteById,
    updateImageQuoteRef,
    setRestricted,
    setSubject,
    deleteAllInGroup,
    listSpeakers,
    getGroupSettings,
    saveGroupSettings,
    close,
  };
}
