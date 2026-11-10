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

export const SCHEMA_VERSION = 7;

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

CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  image_path TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trash_group ON trash(group_id);

CREATE TABLE IF NOT EXISTS person_merge (
  user_id TEXT PRIMARY KEY,
  person_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  collection_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_group ON collections(group_id);

CREATE TABLE IF NOT EXISTS collab_members (
  group_id TEXT NOT NULL,
  qq TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'maintainer',
  added_by TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, qq)
);

CREATE TABLE IF NOT EXISTS collab_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  qq TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'maintainer',
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_collab_tokens_group ON collab_tokens(group_id);

CREATE TABLE IF NOT EXISTS collab_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  actor_qq TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_collab_audit_group ON collab_audit(group_id, id);

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

/** Local calendar date key (YYYY-MM-DD) for an epoch-seconds timestamp. */
function localDateKey(value) {
  const date = new Date(Number(value) * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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


  // ------------------------------------------------------------------ //
  // Trash, statistics and insights (manage-page modules).
  // ------------------------------------------------------------------ //

  function imageQuoteRefs(groupId) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return [];
    return db
      .prepare("SELECT id, image_path FROM quotes WHERE group_id = ? AND image_path <> ''")
      .all(gid)
      .map((row) => ({ id: Number(row.id), imagePath: String(row.image_path ?? '') }));
  }

  function trashQuoteRow(row) {
    const full = db.prepare('SELECT message_id, added_at FROM quotes WHERE id = ?').get(Number(row.id)) || {};
    const tags = tagsFor(Number(row.id));
    const name = String(row.image_path ?? '').split('/').pop() || '';
    const data = JSON.stringify({
      quote: {
        group: String(row.group_id),
        speaker: String(row.speaker ?? ''),
        content: String(row.content ?? ''),
        imagePath: String(row.image_path ?? ''),
        source: String(row.source ?? 'local'),
        restricted: Number(row.restricted ?? 0),
        rating: Number(row.rating ?? 0),
        subjectUser: String(row.subject_user ?? ''),
        subjectName: String(row.subject_name ?? ''),
        messageId: String(full.message_id ?? ''),
        createdAt: Number(row.created_at ?? 0),
        addedAt: Number(full.added_at ?? 0),
      },
      tags,
    });
    db.prepare(
      'INSERT INTO trash(group_id, name, image_path, data, deleted_at) VALUES (?, ?, ?, ?, ?)',
    ).run(String(row.group_id), name, String(row.image_path ?? ''), data, nowSeconds());
    db.prepare('DELETE FROM quotes WHERE id = ?').run(Number(row.id));
    return { id: Number(row.id), name, group: String(row.group_id), imagePath: String(row.image_path ?? '') };
  }

  /** Move one image quote into the trash table (the caller moves the file). */
  function trashQuote(groupId, name) {
    const gid = String(groupId ?? '').trim();
    const file = String(name ?? '').trim();
    if (!gid || !file) return null;
    const found = findImageQuote(gid, file);
    if (!found) return null;
    const row = db.prepare(`SELECT ${IMAGE_COLUMNS} FROM quotes q WHERE q.id = ?`).get(Number(found.id));
    return row ? trashQuoteRow(row) : null;
  }

  /** Move every image quote of one group into the trash table. */
  function trashGroup(groupId) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return [];
    const rows = db
      .prepare(`SELECT ${IMAGE_COLUMNS} FROM quotes q WHERE q.group_id = ? AND q.image_path <> ''`)
      .all(gid);
    const moved = rows.map((row) => trashQuoteRow(row));
    db.prepare('DELETE FROM group_settings WHERE group_id = ?').run(gid);
    return moved;
  }

  function listTrash(groupId) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return { items: [], total: 0 };
    const rows = db
      .prepare('SELECT id, name, image_path, data, deleted_at FROM trash WHERE group_id = ? ORDER BY deleted_at DESC, id DESC')
      .all(gid);
    return {
      items: rows.map((row) => {
        let meta = {};
        try {
          meta = JSON.parse(String(row.data ?? '{}')).quote || {};
        } catch {
          meta = {};
        }
        return {
          name: String(row.name ?? ''),
          image_path: String(row.image_path ?? ''),
          deleted_at: Number(row.deleted_at ?? 0),
          meta: {
            subject_name: String(meta.subjectName ?? ''),
            nickname: String(meta.speaker ?? ''),
            user_id: String(meta.subjectUser ?? ''),
          },
        };
      }),
      total: rows.length,
    };
  }

  function findTrash(groupId, name) {
    const gid = String(groupId ?? '').trim();
    const file = String(name ?? '').trim();
    if (!gid || !file) return null;
    return (
      db
        .prepare('SELECT id, group_id, name, image_path, data, deleted_at FROM trash WHERE group_id = ? AND name = ? ORDER BY id DESC LIMIT 1')
        .get(gid, file) || null
    );
  }

  /** Re-insert a trashed quote after its file was moved back into place. */
  function restoreTrashQuote(groupId, name) {
    const row = findTrash(groupId, name);
    if (!row) return null;
    let parsed;
    try {
      parsed = JSON.parse(String(row.data ?? '{}'));
    } catch {
      return null;
    }
    const quote = parsed.quote || {};
    const imagePath = String(row.image_path ?? '') || `${String(row.group_id)}/${String(row.name)}`;
    const msgId = String(quote.messageId ?? '');
    try {
      const result = db
        .prepare(
          'INSERT INTO quotes(group_id, message_id, speaker, content, image_path, source, restricted, rating, subject_user, subject_name, created_at, added_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          String(quote.group ?? row.group_id),
          msgId || null,
          String(quote.speaker ?? ''),
          String(quote.content ?? '[图片语录]'),
          imagePath,
          String(quote.source ?? 'local'),
          Number(quote.restricted ?? 0) ? 1 : 0,
          Number(quote.rating ?? 0) || 0,
          String(quote.subjectUser ?? ''),
          String(quote.subjectName ?? ''),
          Number(quote.createdAt ?? 0) || nowSeconds(),
          Number(quote.addedAt ?? 0) || nowSeconds(),
        );
      const newId = Number(result.lastInsertRowid);
      for (const tag of parsed.tags || []) {
        insertTag.run(String(tag));
        const tagRow = tagByName.get(String(tag));
        if (tagRow) linkTag.run(newId, Number(tagRow.id));
      }
      db.prepare('DELETE FROM trash WHERE id = ?').run(Number(row.id));
      return { id: newId, name: String(row.name ?? ''), imagePath };
    } catch (error) {
      // A re-sync may already have re-created the same message id.
      if (msgId && String(error?.message ?? '').includes('UNIQUE')) {
        const existing = quoteByMessageId.get(msgId);
        if (existing) {
          db.prepare('UPDATE quotes SET image_path = ? WHERE id = ?').run(imagePath, Number(existing.id));
          db.prepare('DELETE FROM trash WHERE id = ?').run(Number(row.id));
          return { id: Number(existing.id), name: String(row.name ?? ''), imagePath };
        }
      }
      return null;
    }
  }

  function purgeTrash(groupId, names, all = false) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return [];
    let rows = [];
    if (all) {
      rows = db.prepare('SELECT id, name, image_path FROM trash WHERE group_id = ?').all(gid);
    } else {
      for (const name of names || []) {
        const file = String(name ?? '').trim();
        if (!file) continue;
        const row = db
          .prepare('SELECT id, name, image_path FROM trash WHERE group_id = ? AND name = ? ORDER BY id DESC LIMIT 1')
          .get(gid, file);
        if (row) rows.push(row);
      }
    }
    for (const row of rows) db.prepare('DELETE FROM trash WHERE id = ?').run(Number(row.id));
    return rows.map((row) => ({
      name: String(row.name ?? ''),
      imagePath: String(row.image_path ?? ''),
    }));
  }

  function manageStatistics({ group, top = 10, days = 30 } = {}) {
    const gid = String(group ?? '').trim();
    const span = clamp(Number(days) || 30, 1, 3650);
    const limit = clamp(Number(top) || 10, 1, 100);
    const rows = db
      .prepare(
        "SELECT id, group_id, speaker, subject_user, subject_name, created_at FROM quotes WHERE image_path <> ''" +
          (gid ? ' AND group_id = ?' : ''),
      )
      .all(...(gid ? [gid] : []));
    const now = nowSeconds();
    const startOfToday = new Date(now * 1000);
    startOfToday.setHours(0, 0, 0, 0);
    const todayStart = Math.floor(startOfToday.getTime() / 1000);
    const weekAgo = now - 7 * 86400;
    const since = now - span * 86400;
    const groups = new Map();
    const subjects = new Map();
    const speakers = new Map();
    const trendMap = new Map();
    let assigned = 0;
    let today = 0;
    let last7 = 0;
    for (const row of rows) {
      const g = String(row.group_id ?? '');
      const ts = Number(row.created_at ?? 0);
      const subject = String(row.subject_name ?? '').trim();
      const speaker = String(row.speaker ?? '').trim();
      const entry = groups.get(g) || {
        group_id: g,
        quotes: 0,
        assigned: 0,
        semantic: 0,
        submitters: new Set(),
        last_ts: 0,
      };
      entry.quotes += 1;
      entry.last_ts = Math.max(entry.last_ts, ts);
      if (subject) {
        entry.assigned += 1;
        assigned += 1;
        const person = subjects.get(subject) || {
          display_name: subject,
          person_id: String(row.subject_user ?? ''),
          count: 0,
          last_ts: 0,
          groups: new Set(),
        };
        person.count += 1;
        person.last_ts = Math.max(person.last_ts, ts);
        person.groups.add(g);
        subjects.set(subject, person);
      }
      if (speaker) {
        entry.submitters.add(speaker);
        const contributor = speakers.get(speaker) || {
          display_name: speaker,
          person_id: '',
          count: 0,
          last_ts: 0,
          groups: new Set(),
        };
        contributor.count += 1;
        contributor.last_ts = Math.max(contributor.last_ts, ts);
        contributor.groups.add(g);
        speakers.set(speaker, contributor);
      }
      groups.set(g, entry);
      if (ts >= since) {
        const key = localDateKey(ts);
        trendMap.set(key, (trendMap.get(key) || 0) + 1);
      }
      if (ts >= todayStart) today += 1;
      if (ts >= weekAgo) last7 += 1;
    }
    const rank = (rowsMap, withPerson) =>
      [...rowsMap.values()]
        .sort((a, b) => b.count - a.count || String(a.display_name).localeCompare(String(b.display_name)))
        .slice(0, limit)
        .map((row, index) => ({
          rank: index + 1,
          display_name: row.display_name,
          person_id: withPerson ? row.person_id : '',
          user_ids: withPerson && row.person_id ? [row.person_id] : [],
          avatar_sha: '',
          count: row.count,
          groups: [...row.groups],
          last_ts: row.last_ts,
        }));
    const trend = [];
    for (let offset = span - 1; offset >= 0; offset -= 1) {
      const date = localDateKey(now - offset * 86400);
      trend.push({ date, count: trendMap.get(date) || 0 });
    }
    const groupRows = [...groups.values()]
      .map((entry) => ({
        group_id: entry.group_id,
        quotes: entry.quotes,
        assigned: entry.assigned,
        semantic: entry.semantic,
        submitters: entry.submitters.size,
        bytes: 0,
      }))
      .sort((a, b) => b.quotes - a.quotes || String(a.group_id).localeCompare(String(b.group_id)));
    const total = rows.length;
    return {
      totals: {
        quotes: total,
        groups: groupRows.length,
        persons: subjects.size,
        assigned,
        unassigned: total - assigned,
        assigned_rate: total ? assigned / total : 0,
        contributors: speakers.size,
        submissions: total,
        today,
        last7,
        semantic: 0,
        semantic_rate: 0,
        bytes: 0,
      },
      ranking: rank(subjects, true),
      contributors: rank(speakers, false),
      trend,
      groups: groupRows,
    };
  }

  function insightsHeatmap({ group, days = 365 } = {}) {
    const gid = String(group ?? '').trim();
    const span = clamp(Number(days) || 365, 7, 3650);
    const since = nowSeconds() - span * 86400;
    const rows = db
      .prepare("SELECT created_at FROM quotes WHERE image_path <> '' AND created_at >= ?" + (gid ? ' AND group_id = ?' : ''))
      .all(...(gid ? [since, gid] : [since]));
    const hours = Array.from({ length: 24 }, () => Array(7).fill(0));
    const hourSums = Array(24).fill(0);
    const weekdaySums = Array(7).fill(0);
    const calendar = new Map();
    let maxDay = 0;
    for (const row of rows) {
      const date = new Date(Number(row.created_at ?? 0) * 1000);
      const weekday = (date.getDay() + 6) % 7;
      const hour = date.getHours();
      hours[hour][weekday] += 1;
      hourSums[hour] += 1;
      weekdaySums[weekday] += 1;
      const key = localDateKey(Number(row.created_at ?? 0));
      const count = (calendar.get(key) || 0) + 1;
      calendar.set(key, count);
      if (count > maxDay) maxDay = count;
    }
    const peakHour = hourSums.indexOf(Math.max(...hourSums));
    const peakWeekday = weekdaySums.indexOf(Math.max(...weekdaySums));
    const calendarRows = [];
    const end = new Date();
    for (let offset = 181; offset >= 0; offset -= 1) {
      const date = new Date(end);
      date.setDate(end.getDate() - offset);
      const key = localDateKey(date.getTime() / 1000);
      calendarRows.push({ date: key, count: calendar.get(key) || 0 });
    }
    return {
      hours,
      total: rows.length,
      peak_hour: peakHour,
      peak_weekday: peakWeekday,
      max_day: maxDay,
      calendar: calendarRows,
      weekdays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
      weekday_sums: weekdaySums,
      hour_sums: hourSums,
    };
  }

  function insightsTimeline({ pid, group } = {}) {
    const person = String(pid ?? '').trim();
    const gid = String(group ?? '').trim();
    if (!person) return { display_name: '', total: 0, first_ts: 0, months: [], top_tags: [] };
    const rows = db
      .prepare(
        "SELECT id, created_at FROM quotes WHERE image_path <> '' AND speaker = ?" + (gid ? ' AND group_id = ?' : ''),
      )
      .all(...(gid ? [person, gid] : [person]));
    const months = new Map();
    const tags = new Map();
    let first = 0;
    for (const row of rows) {
      const ts = Number(row.created_at ?? 0);
      if (!first || ts < first) first = ts;
      const date = new Date(ts * 1000);
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      months.set(month, (months.get(month) || 0) + 1);
      for (const tag of tagsFor(Number(row.id))) {
        tags.set(tag, (tags.get(tag) || 0) + 1);
      }
    }
    return {
      display_name: person,
      total: rows.length,
      first_ts: first,
      months: [...months.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([month, count]) => ({ month, count })),
      top_tags: [...tags.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .slice(0, 12)
        .map(([tag, count]) => ({ tag, count })),
    };
  }

  // ---------------------------------------------------------------- //
  // People / identity (manage-page "人物" module).
  // ---------------------------------------------------------------- //

  function personMergeMap() {
    const map = new Map();
    for (const row of db.prepare('SELECT user_id, person_key FROM person_merge').all()) {
      map.set(String(row.user_id), String(row.person_key));
    }
    return map;
  }

  function identityUsers() {
    const rows = db
      .prepare(
        "SELECT group_id, speaker, subject_user, subject_name, created_at, image_path, content FROM quotes " +
          "WHERE image_path <> '' AND subject_user <> '' ORDER BY created_at DESC, id DESC",
      )
      .all();
    const users = new Map();
    for (const row of rows) {
      const uid = String(row.subject_user ?? '').trim();
      if (!uid) continue;
      const ts = Number(row.created_at ?? 0);
      const gid = String(row.group_id ?? '');
      const name = String(row.subject_name ?? '').trim();
      const user = users.get(uid) || {
        user_id: uid,
        quote_count: 0,
        last_seen: 0,
        groups: new Set(),
        names: new Map(),
        quotes: [],
      };
      user.quote_count += 1;
      user.last_seen = Math.max(user.last_seen, ts);
      user.groups.add(gid);
      if (name) {
        const entry = user.names.get(name) || { count: 0, first_seen: ts, last_seen: ts };
        entry.count += 1;
        entry.first_seen = Math.min(entry.first_seen, ts);
        entry.last_seen = Math.max(entry.last_seen, ts);
        user.names.set(name, entry);
      }
      user.quotes.push({
        group_id: gid,
        name: String(row.image_path ?? '').split('/').pop() || '',
        ts,
        caption: String(row.content ?? '') === '[图片语录]' ? '' : String(row.content ?? ''),
        subject_name: name,
      });
      users.set(uid, user);
    }
    return users;
  }

  function latestNameOf(user) {
    let best = '';
    let bestTs = -1;
    for (const [name, entry] of user.names) {
      if (entry.last_seen > bestTs) {
        bestTs = entry.last_seen;
        best = name;
      }
    }
    return best;
  }

  function identityPersons() {
    const users = identityUsers();
    const merge = personMergeMap();
    const persons = new Map();
    for (const [uid, user] of users) {
      const key = merge.get(uid) || uid;
      const person = persons.get(key) || {
        person_id: key,
        user_ids: [],
        quote_count: 0,
        groups: new Set(),
        last_seen: 0,
        quotes: [],
        display_name: '',
        name_ts: -1,
      };
      person.user_ids.push(uid);
      person.quote_count += user.quote_count;
      person.last_seen = Math.max(person.last_seen, user.last_seen);
      for (const gid of user.groups) person.groups.add(gid);
      person.quotes.push(...user.quotes);
      const name = latestNameOf(user);
      if (name && user.last_seen > person.name_ts) {
        person.name_ts = user.last_seen;
        person.display_name = name;
      }
      persons.set(key, person);
    }
    for (const person of persons.values()) {
      person.user_ids.sort();
      person.quotes.sort((a, b) => b.ts - a.ts);
      if (!person.display_name) person.display_name = `QQ ${person.user_ids[0] || ''}`.trim();
    }
    return persons;
  }

  function identityOverview() {
    const users = identityUsers();
    const persons = identityPersons();
    let updated = 0;
    let assigned = 0;
    for (const person of persons.values()) {
      updated = Math.max(updated, person.last_seen);
      assigned += person.quote_count;
    }
    return {
      persons: persons.size,
      users: users.size,
      with_avatar: 0,
      assigned_quotes: assigned,
      quote_users: users.size,
      threshold: 0,
      named: persons.size,
      updated_at: updated,
    };
  }

  function identityList({ q, group, page, pageSize } = {}) {
    const keyword = String(q ?? '').trim().toLowerCase();
    const gid = String(group ?? '').trim();
    const size = clamp(Number(pageSize) || 60, 1, 500);
    const current = Math.max(1, Number(page) || 1);
    let rows = [...identityPersons().values()];
    if (gid) rows = rows.filter((person) => person.groups.has(gid));
    if (keyword) {
      rows = rows.filter(
        (person) =>
          person.display_name.toLowerCase().includes(keyword) ||
          person.user_ids.some((uid) => uid.toLowerCase().includes(keyword)),
      );
    }
    rows.sort((a, b) => b.quote_count - a.quote_count || a.display_name.localeCompare(b.display_name));
    const total = rows.length;
    const start = (current - 1) * size;
    return {
      items: rows.slice(start, start + size).map((person) => ({
        pid: person.person_id,
        person_id: person.person_id,
        display_name: person.display_name,
        name: person.display_name,
        user_ids: person.user_ids,
        avatar_sha: '',
        quote_count: person.quote_count,
        groups: [...person.groups].sort(),
        last_seen: person.last_seen,
        is_merged: person.user_ids.length > 1,
      })),
      total,
      pages: Math.max(1, Math.ceil(total / size)),
      page: current,
      page_size: size,
    };
  }

  function identityDetail(personId) {
    const key = String(personId ?? '').trim();
    if (!key) return { ok: false, error: 'person_id required' };
    const users = identityUsers();
    const person = identityPersons().get(key);
    if (!person) return { ok: false, error: 'person not found' };
    return {
      ok: true,
      pid: key,
      person_id: key,
      is_merged: person.user_ids.length > 1,
      quote_count: person.quote_count,
      user_ids: person.user_ids,
      users: person.user_ids.map((uid) => {
        const user = users.get(uid) || { quote_count: 0, last_seen: 0, names: new Map(), groups: new Set() };
        return {
          user_id: uid,
          quote_count: user.quote_count,
          last_seen: user.last_seen,
          names: [...user.names.entries()]
            .map(([name, entry]) => ({
              name,
              count: entry.count,
              first_seen: entry.first_seen,
              last_seen: entry.last_seen,
            }))
            .sort((a, b) => b.count - a.count || b.last_seen - a.last_seen),
          current_avatar: '',
          avatars: [],
          groups: [...user.groups].sort(),
        };
      }),
      quotes: person.quotes.slice(0, 200).map((quote) => ({
        group_id: quote.group_id,
        name: quote.name,
        ts: quote.ts,
        caption: quote.caption,
        subject_name: quote.subject_name,
      })),
    };
  }

  function identityMerge(userIds) {
    const ids = [...new Set((userIds || []).map((value) => String(value ?? '').trim()).filter(Boolean))];
    if (ids.length < 2) return { ok: false, error: 'at least two user ids required' };
    const merge = personMergeMap();
    const keys = new Set(ids.map((uid) => merge.get(uid) || uid));
    const members = new Set(ids);
    for (const [uid, key] of merge) {
      if (keys.has(key)) members.add(uid);
    }
    const canonical = ids[0];
    const upsert = db.prepare(
      'INSERT INTO person_merge(user_id, person_key) VALUES (?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET person_key = excluded.person_key',
    );
    for (const uid of members) upsert.run(uid, canonical);
    return { ok: true, person_id: canonical, merged: members.size };
  }

  function identitySplit({ personId, userId } = {}) {
    const uid = String(userId ?? '').trim();
    const pid = String(personId ?? '').trim();
    let restored = 0;
    if (uid) {
      const result = db.prepare('DELETE FROM person_merge WHERE user_id = ?').run(uid);
      restored = Number(result.changes || 0);
    } else if (pid) {
      db.prepare('DELETE FROM person_merge WHERE person_key = ?').run(pid);
      db.prepare('DELETE FROM person_merge WHERE user_id = ?').run(pid);
      restored = 1;
    }
    return { ok: true, restored };
  }

  function identityReview() {
    const rows = db
      .prepare(
        "SELECT group_id, subject_name, COUNT(*) AS n FROM quotes " +
          "WHERE image_path <> '' AND subject_user = '' AND subject_name <> '' " +
          'GROUP BY group_id, subject_name ORDER BY n DESC',
      )
      .all();
    const byName = new Map();
    for (const row of rows) {
      const name = String(row.subject_name ?? '');
      const entry = byName.get(name) || { subject_name: name, count: 0, groups: [] };
      entry.count += Number(row.n || 0);
      const gid = String(row.group_id ?? '');
      if (gid && !entry.groups.includes(gid)) entry.groups.push(gid);
      byName.set(name, entry);
    }
    const items = [...byName.values()];
    return {
      items,
      total_names: items.length,
      total_quotes: items.reduce((sum, item) => sum + item.count, 0),
    };
  }

  // ---------------------------------------------------------------- //
  // Collections (manage-page "专题合集" module) and meta helpers.
  // ---------------------------------------------------------------- //

  function parseCollectionIds(value) {
    try {
      const parsed = JSON.parse(String(value ?? '[]'));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  function normalizeCollectionIds(ids) {
    const out = [];
    for (const value of Array.isArray(ids) ? ids : []) {
      const name = String(value ?? '').trim();
      if (!name || out.includes(name)) continue;
      out.push(name);
      if (out.length >= 500) break;
    }
    return out;
  }

  function cleanCollectionIds(groupId, names) {
    const out = [];
    for (const name of normalizeCollectionIds(names)) {
      if (findImageQuote(groupId, name)) out.push(name);
    }
    return out;
  }

  function collectionRow(collectionId) {
    return (
      db
        .prepare(
          'SELECT collection_id, group_id, name, description, ids, created_at, updated_at FROM collections WHERE collection_id = ?',
        )
        .get(String(collectionId ?? '').trim()) || null
    );
  }

  function toCollection(row) {
    return {
      collection_id: String(row.collection_id ?? ''),
      name: String(row.name ?? ''),
      desc: String(row.description ?? ''),
      ids: parseCollectionIds(row.ids),
      created_at: Number(row.created_at ?? 0),
      updated_at: Number(row.updated_at ?? 0),
    };
  }

  function listCollections(groupId) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return [];
    return db
      .prepare(
        'SELECT collection_id, group_id, name, description, ids, created_at, updated_at FROM collections ' +
          'WHERE group_id = ? ORDER BY updated_at DESC, collection_id ASC',
      )
      .all(gid)
      .map((row) => ({
        collection_id: String(row.collection_id ?? ''),
        name: String(row.name ?? ''),
        desc: String(row.description ?? ''),
        count: parseCollectionIds(row.ids).length,
      }));
  }

  function getCollection(groupId, collectionId) {
    const gid = String(groupId ?? '').trim();
    const row = collectionRow(collectionId);
    if (!row || String(row.group_id) !== gid) return null;
    return toCollection(row);
  }

  function createCollection(groupId, name, desc, ids) {
    const gid = String(groupId ?? '').trim();
    const title = String(name ?? '').trim().slice(0, 60);
    if (!gid || !title) return null;
    const now = nowSeconds();
    const collectionId = 'c' + now.toString(36) + Math.random().toString(36).slice(2, 8);
    const names = cleanCollectionIds(gid, ids);
    db.prepare(
      'INSERT INTO collections(collection_id, group_id, name, description, ids, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(collectionId, gid, title, String(desc ?? '').trim().slice(0, 200), JSON.stringify(names), now, now);
    return getCollection(gid, collectionId);
  }

  function updateCollection(groupId, collectionId, patch) {
    const gid = String(groupId ?? '').trim();
    const row = collectionRow(collectionId);
    if (!row || String(row.group_id) !== gid) return null;
    const title =
      patch && patch.name !== undefined ? String(patch.name ?? '').trim().slice(0, 60) : String(row.name ?? '');
    const desc =
      patch && patch.desc !== undefined
        ? String(patch.desc ?? '').trim().slice(0, 200)
        : String(row.description ?? '');
    db.prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE collection_id = ?').run(
      title,
      desc,
      nowSeconds(),
      String(row.collection_id),
    );
    return getCollection(gid, row.collection_id);
  }

  function deleteCollection(groupId, collectionId) {
    const gid = String(groupId ?? '').trim();
    const row = collectionRow(collectionId);
    if (!row || String(row.group_id) !== gid) return false;
    db.prepare('DELETE FROM collections WHERE collection_id = ?').run(String(row.collection_id));
    return true;
  }

  function mutateCollection(groupId, collectionId, names, mode) {
    const gid = String(groupId ?? '').trim();
    const row = collectionRow(collectionId);
    if (!row || String(row.group_id) !== gid) return null;
    const current = new Set(parseCollectionIds(row.ids));
    if (mode === 'add') {
      for (const name of cleanCollectionIds(gid, names)) current.add(name);
    } else {
      for (const name of normalizeCollectionIds(names)) current.delete(name);
    }
    const next = [...current].slice(0, 500);
    db.prepare('UPDATE collections SET ids = ?, updated_at = ? WHERE collection_id = ?').run(
      JSON.stringify(next),
      nowSeconds(),
      String(row.collection_id),
    );
    return getCollection(gid, row.collection_id);
  }

  function addToCollection(groupId, collectionId, names) {
    return mutateCollection(groupId, collectionId, names, 'add');
  }

  function removeFromCollection(groupId, collectionId, names) {
    return mutateCollection(groupId, collectionId, names, 'remove');
  }

  // ---- collaboration records (local-only) --------------------------------

  const COLLAB_ROLE_LABELS = { maintainer: '维护员', viewer: '只读成员' };

  function collabMembers(groupId) {
    return db
      .prepare('SELECT qq, role, added_by, added_at FROM collab_members WHERE group_id = ? ORDER BY added_at ASC, qq ASC')
      .all(String(groupId))
      .map((row) => ({
        qq: row.qq,
        role: row.role,
        role_label: COLLAB_ROLE_LABELS[row.role] || row.role,
        added_by: row.added_by || '',
        added_at: Number(row.added_at) || 0,
      }));
  }

  function collabSetMember({ groupId, qq, role = 'maintainer', actor = '' }) {
    db.prepare(
      `INSERT INTO collab_members(group_id, qq, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_id, qq) DO UPDATE SET role = excluded.role, added_by = excluded.added_by, added_at = excluded.added_at`,
    ).run(String(groupId), String(qq), String(role), String(actor), nowSeconds());
    return collabMembers(groupId);
  }

  function collabRemoveMember(groupId, qq) {
    return (
      db.prepare('DELETE FROM collab_members WHERE group_id = ? AND qq = ?').run(String(groupId), String(qq))
        .changes > 0
    );
  }

  function collabTokens(groupId) {
    const now = nowSeconds();
    return db
      .prepare(
        'SELECT id, qq, role, created_at, expires_at, revoked, last_used, use_count FROM collab_tokens WHERE group_id = ? ORDER BY id DESC',
      )
      .all(String(groupId))
      .map((row) => {
        const expiresAt = Number(row.expires_at) || 0;
        const permanent = expiresAt === 0;
        const expired = !permanent && expiresAt <= now;
        return {
          id: Number(row.id),
          qq: row.qq,
          role: row.role,
          role_label: COLLAB_ROLE_LABELS[row.role] || row.role,
          permanent,
          expired,
          expires_in: permanent ? 0 : Math.max(0, expiresAt - now),
          revoked: Number(row.revoked) ? 1 : 0,
          created_at: Number(row.created_at) || 0,
          last_used: Number(row.last_used) || 0,
          use_count: Number(row.use_count) || 0,
        };
      });
  }

  function collabCreateToken({ groupId, qq, role = 'maintainer', hours = 0, token }) {
    const now = nowSeconds();
    const hoursValue = Math.max(0, Math.min(87600, Number(hours) || 0));
    const expiresAt = hoursValue > 0 ? now + Math.round(hoursValue * 3600) : 0;
    const result = db
      .prepare(
        'INSERT INTO collab_tokens(group_id, qq, role, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(String(groupId), String(qq), String(role), String(token), now, expiresAt);
    return collabTokens(groupId).find((item) => item.id === Number(result.lastInsertRowid)) || null;
  }

  function collabRevokeToken(groupId, tokenId) {
    return (
      db.prepare('UPDATE collab_tokens SET revoked = ? WHERE group_id = ? AND id = ?').run(1, String(groupId), Number(tokenId))
        .changes > 0
    );
  }

  function collabAudit(groupId, limit = 40) {
    return db
      .prepare(
        'SELECT id, actor_qq, actor_name, action, target, ts, undone FROM collab_audit WHERE group_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(String(groupId), clamp(Number(limit) || 40, 1, 200))
      .map((row) => ({
        id: Number(row.id),
        actor_qq: row.actor_qq || '',
        actor_name: row.actor_name || '',
        action: row.action,
        target: row.target || '',
        ts: Number(row.ts) || 0,
        undone: Number(row.undone) ? 1 : 0,
      }));
  }

  function collabLog({ groupId = '', actorQq = '', actorName = '', action, target = '', payload = null }) {
    const result = db
      .prepare(
        'INSERT INTO collab_audit(group_id, actor_qq, actor_name, action, target, ts, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        String(groupId),
        String(actorQq),
        String(actorName),
        String(action),
        String(target),
        nowSeconds(),
        JSON.stringify(payload || {}),
      );
    return Number(result.lastInsertRowid);
  }

  function collabUndoAudit(id) {
    const row = db.prepare('SELECT * FROM collab_audit WHERE id = ?').get(Number(id));
    if (!row || Number(row.undone)) return 0;
    let payload = {};
    try {
      payload = JSON.parse(String(row.payload || '{}'));
    } catch {
      payload = {};
    }
    let changed = 0;
    if (row.action === 'member_set') {
      if (payload.previous && payload.previous.role) {
        changed = db
          .prepare('UPDATE collab_members SET role = ? WHERE group_id = ? AND qq = ?')
          .run(String(payload.previous.role), row.group_id, payload.qq).changes;
      } else {
        changed = db
          .prepare('DELETE FROM collab_members WHERE group_id = ? AND qq = ?')
          .run(row.group_id, payload.qq).changes;
      }
    } else if (row.action === 'member_remove') {
      changed = db
        .prepare(
          'INSERT OR REPLACE INTO collab_members(group_id, qq, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          row.group_id,
          payload.qq,
          payload.role || 'maintainer',
          payload.added_by || '',
          Number(payload.added_at) || nowSeconds(),
        ).changes;
    } else if (row.action === 'token_create') {
      changed = db.prepare('UPDATE collab_tokens SET revoked = 1 WHERE id = ?').run(Number(payload.token_id)).changes;
    } else if (row.action === 'token_revoke') {
      changed = db.prepare('UPDATE collab_tokens SET revoked = 0 WHERE id = ?').run(Number(payload.token_id)).changes;
    } else if (row.action === 'base_set') {
      setMeta('collab_public_base', payload.previous || '');
      changed = 1;
    }
    db.prepare('UPDATE collab_audit SET undone = 1 WHERE id = ?').run(Number(id));
    return changed;
  }

  function getMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key ?? ''));
    if (!row) return null;
    try {
      return JSON.parse(String(row.value));
    } catch {
      return null;
    }
  }

  function setMeta(key, value) {
    db.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(String(key ?? ''), JSON.stringify(value ?? null));
    return value;
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
    imageQuoteRefs,
    trashQuote,
    trashGroup,
    listTrash,
    findTrash,
    restoreTrashQuote,
    purgeTrash,
    manageStatistics,
    insightsHeatmap,
    insightsTimeline,
    identityOverview,
    identityList,
    identityDetail,
    identityMerge,
    identitySplit,
    identityReview,
    listCollections,
    getCollection,
    createCollection,
    updateCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
    collabMembers,
    collabSetMember,
    collabRemoveMember,
    collabTokens,
    collabCreateToken,
    collabRevokeToken,
    collabAudit,
    collabLog,
    collabUndoAudit,
    getMeta,
    setMeta,
    deleteAllInGroup,
    listSpeakers,
    getGroupSettings,
    saveGroupSettings,
    close,
  };
}
