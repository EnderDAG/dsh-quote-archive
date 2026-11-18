/**
 * dsh-quote-archive — people relationship star map.
 *
 * Builds a per-person graph out of the alias / nickname data the plugin already
 * stores: the centre is one person (person_id + merged QQ users), the spokes are
 * every alias (`person_alias`) and every nickname variant seen in `quotes`
 * (`subject_name`, with `speaker` as weak spokes). Nothing is fetched from the
 * network and no third-party graph library is involved: the admin page renders
 * the returned nodes/edges with a hand-written <canvas> layout.
 *
 * Edge/graph invariants:
 *   - the graph never crosses people: every edge points at the centre;
 *   - aliases in the same group are not linked to each other;
 *   - names are de-duplicated through `normalizeAliasKey` so an alias and the
 *     matching `subject_name` collapse into a single spoke.
 */
import { pickPreferredAlias, normalizeAliasKey } from './alias.js';

const ALIAS_SOURCE_RANK = { manual: 0, learned: 1, merge: 2 };
const DEFAULT_NODE_CAP = 18;
const MAX_NODE_CAP = 40;
const DEFAULT_INDEX_LIMIT = 500;
const MAX_INDEX_LIMIT = 2000;
const LABEL_LIMIT = 32;
const WEAK_WEIGHT = 0.25;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clipLabel(value) {
  const label = text(value);
  if (!label) return '';
  return label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT - 1)}…` : label;
}

function sourceRank(source) {
  const rank = ALIAS_SOURCE_RANK[text(source)];
  return Number.isInteger(rank) ? rank : 3;
}

function readAliasRows(db, group) {
  const params = [];
  let where = '';
  if (group) {
    where = "WHERE group_id = '' OR group_id = ?";
    params.push(group);
  }
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT id, group_id, alias_key, alias_name, target_user_id, person_id,
                display_name, source, confidence, created_at, updated_at
           FROM person_alias ${where}
          ORDER BY updated_at DESC, id DESC`,
      )
      .all(...params);
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: Number(row.id) || 0,
    group_id: text(row.group_id),
    alias_key: text(row.alias_key) || normalizeAliasKey(row.alias_name),
    alias_name: text(row.alias_name),
    target_user_id: text(row.target_user_id),
    person_id: text(row.person_id),
    display_name: text(row.display_name),
    source: text(row.source) || 'manual',
    confidence: Number(row.confidence),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  }));
}

function readMergeMap(db) {
  const map = new Map();
  try {
    for (const row of db.prepare('SELECT user_id, person_key FROM person_merge').all()) {
      const uid = text(row.user_id);
      if (!uid) continue;
      map.set(uid, text(row.person_key) || uid);
    }
  } catch {
    /* table missing on a very old database: treat every user as its own person */
  }
  return map;
}

function personKeyOf(merge, uid) {
  return merge.get(uid) || uid;
}

function uidsOfPerson(merge, key) {
  const uids = new Set([key]);
  for (const [uid, person] of merge) {
    if (person === key) uids.add(uid);
  }
  return uids;
}

function inList(values) {
  return values.map(() => '?').join(',');
}

function readSubjectRows(db, uids, group) {
  const params = [...uids];
  let filter = '';
  if (group) {
    filter = 'AND group_id = ?';
    params.push(group);
  }
  return db
    .prepare(
      `SELECT group_id, subject_user, subject_name, COUNT(*) AS n, MAX(created_at) AS last_ts
         FROM quotes
        WHERE image_path <> '' AND subject_user <> '' AND subject_name <> ''
          AND subject_user IN (${inList(uids)}) ${filter}
        GROUP BY group_id, subject_user, subject_name`,
    )
    .all(...params);
}

function readSpeakerRows(db, uids, group) {
  const params = [...uids];
  let filter = '';
  if (group) {
    filter = 'AND group_id = ?';
    params.push(group);
  }
  return db
    .prepare(
      `SELECT group_id, subject_user, speaker, COUNT(*) AS n, MAX(created_at) AS last_ts
         FROM quotes
        WHERE image_path <> '' AND subject_user <> '' AND speaker <> ''
          AND subject_user IN (${inList(uids)}) ${filter}
        GROUP BY group_id, subject_user, speaker`,
    )
    .all(...params);
}

function collectNameSpokes(rows, usedKeys, idPrefix, weak) {
  const merged = new Map();
  for (const row of rows) {
    const label = clipLabel(row.label);
    if (!label) continue;
    const key = normalizeAliasKey(label);
    if (!key || usedKeys.has(key)) continue;
    const current = merged.get(key);
    if (current) {
      current.count += Number(row.n) || 0;
      current.last_ts = Math.max(current.last_ts, Number(row.last_ts) || 0);
      if (row.group_id && !current.group_id) current.group_id = text(row.group_id);
      if (row.group_id) current.groups.add(text(row.group_id));
      continue;
    }
    merged.set(key, {
      key,
      label,
      count: Number(row.n) || 0,
      group_id: text(row.group_id),
      groups: new Set(row.group_id ? [text(row.group_id)] : []),
      last_ts: Number(row.last_ts) || 0,
      weak: Boolean(weak),
      id: `${idPrefix}${key}`,
    });
  }
  return [...merged.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return left.label.localeCompare(right.label);
  });
}

function existsPerson(db, merge, key, uids) {
  if (merge.has(key)) return true;
  if (uids.size > 1) return true;
  const list = [...uids];
  try {
    const quote = db
      .prepare(
        `SELECT 1 FROM quotes
          WHERE image_path <> '' AND subject_user IN (${inList(list)}) LIMIT 1`,
      )
      .get(...list);
    if (quote) return true;
  } catch {
    /* ignore */
  }
  try {
    const alias = db
      .prepare(`SELECT 1 FROM person_alias WHERE target_user_id IN (${inList(list)}) LIMIT 1`)
      .get(...list);
    if (alias) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Build the star map for one person.
 *
 * @param {object} db node:sqlite DatabaseSync handle.
 * @param {{personId?: string, userId?: string, group?: string, maxNodes?: number}} options
 * @returns {{ok: true, person: object, nodes: object[], edges: object[], stats: object}|{ok: false, error: string}}
 */
export function buildStarMap(db, options = {}) {
  const personId = text(options.personId);
  const userId = text(options.userId);
  const group = text(options.group);
  const maxNodes = clampInt(options.maxNodes, 3, MAX_NODE_CAP, DEFAULT_NODE_CAP);
  if (!personId && !userId) return { ok: false, error: 'person_id or user_id required' };

  const merge = readMergeMap(db);
  const seed = personId || userId;
  const personKey = personKeyOf(merge, seed);
  const uids = uidsOfPerson(merge, personKey);
  if (personId) uids.add(personId);
  if (userId) uids.add(userId);
  if (!existsPerson(db, merge, personKey, uids)) {
    return { ok: false, error: 'person not found' };
  }

  const uidList = [...uids];
  const subjectRows = readSubjectRows(db, uidList, group);
  const speakerRows = readSpeakerRows(db, uidList, group);

  const aliasRows = readAliasRows(db, group)
    .filter((row) => uids.has(row.target_user_id))
    .sort((left, right) => {
      const rank = sourceRank(left.source) - sourceRank(right.source);
      if (rank !== 0) return rank;
      if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at;
      return left.alias_name.localeCompare(right.alias_name);
    });

  // Centre name: confirmed alias first, then the newest subject_name, then QQ id.
  const preferred = pickPreferredAlias(aliasRows, uidList, group ? [group] : []);
  let latestName = '';
  let latestTs = -1;
  for (const row of subjectRows) {
    const ts = Number(row.last_ts) || 0;
    if (ts > latestTs || (ts === latestTs && text(row.subject_name).length > latestName.length)) {
      latestTs = ts;
      latestName = text(row.subject_name);
    }
  }
  const displayName = clipLabel(preferred?.alias_name || latestName || `QQ ${uidList[0] || ''}`);

  const nodes = [];
  const edges = [];
  const usedKeys = new Set();
  const centreId = `person:${personKey}`;
  const centreKey = normalizeAliasKey(displayName);
  if (centreKey) usedKeys.add(centreKey);

  let total = 0;
  const groups = new Set();
  for (const row of subjectRows) {
    total += Number(row.n) || 0;
    if (row.group_id) groups.add(text(row.group_id));
  }

  const personGroups = [...groups].sort();
  nodes.push({
    id: centreId,
    label: displayName,
    kind: 'person',
    group_id: '',
    count: total,
    confidence: 1,
    source: preferred?.source || '',
    weak: false,
  });

  for (const row of aliasRows) {
    if (!row.alias_name) continue;
    const key = normalizeAliasKey(row.alias_name);
    if (!key || usedKeys.has(key)) continue;
    usedKeys.add(key);
    const confidence = Number.isFinite(row.confidence) ? row.confidence : 0.8;
    nodes.push({
      id: `alias:${row.id}`,
      label: clipLabel(row.alias_name),
      kind: 'alias',
      group_id: row.group_id,
      count: 0,
      confidence: round(Math.min(1, Math.max(0.1, confidence))),
      source: row.source,
      weak: false,
    });
    edges.push({
      from: `alias:${row.id}`,
      to: centreId,
      weight: round(Math.min(1, Math.max(0.15, confidence))),
      kind: 'alias',
    });
    if (row.group_id) groups.add(row.group_id);
  }

  const subjectSpokes = collectNameSpokes(
    subjectRows.map((row) => ({ ...row, label: row.subject_name })),
    usedKeys,
    'nickname:',
    false,
  );
  const keptSubjectSpokes = subjectSpokes.slice(0, Math.max(0, maxNodes - nodes.length + 1));
  for (const spoke of keptSubjectSpokes) {
    usedKeys.add(spoke.key);
  }

  const speakerSpokes = collectNameSpokes(
    speakerRows.map((row) => ({ ...row, label: row.speaker })),
    usedKeys,
    'nickname:speaker:',
    true,
  ).slice(0, 8);

  const maxCount = keptSubjectSpokes.reduce((max, spoke) => Math.max(max, spoke.count), 0) || 1;
  for (const spoke of keptSubjectSpokes) {
    nodes.push({
      id: spoke.id,
      label: spoke.label,
      kind: 'nickname',
      group_id: spoke.group_id,
      count: spoke.count,
      confidence: 0,
      source: 'subject_name',
      weak: false,
    });
    edges.push({
      from: spoke.id,
      to: centreId,
      weight: round(0.35 + 0.6 * (Math.log1p(spoke.count) / Math.log1p(maxCount || 1))),
      kind: 'nickname',
    });
    for (const gid of spoke.groups) groups.add(gid);
  }

  for (const spoke of speakerSpokes) {
    nodes.push({
      id: spoke.id,
      label: spoke.label,
      kind: 'nickname',
      group_id: spoke.group_id,
      count: spoke.count,
      confidence: 0,
      source: 'speaker',
      weak: true,
    });
    edges.push({
      from: spoke.id,
      to: centreId,
      weight: WEAK_WEIGHT,
      kind: 'nickname',
    });
    for (const gid of spoke.groups) groups.add(gid);
  }

  let lastUpdated = 0;
  for (const row of aliasRows) lastUpdated = Math.max(lastUpdated, row.updated_at || 0);
  for (const row of subjectRows) lastUpdated = Math.max(lastUpdated, Number(row.last_ts) || 0);
  for (const row of speakerRows) lastUpdated = Math.max(lastUpdated, Number(row.last_ts) || 0);

  return {
    ok: true,
    person: {
      person_id: personKey,
      target_user_id: preferTargetUid(aliasRows, uidList),
      display_name: displayName,
      avatar_sha: '',
      groups: [...groups].sort(),
      total,
    },
    nodes,
    edges,
    stats: {
      aliases: nodes.filter((node) => node.kind === 'alias').length,
      nicknames: nodes.filter((node) => node.kind === 'nickname').length,
      weak: nodes.filter((node) => node.weak).length,
      groups: groups.size,
      quotes: total,
      last_updated: lastUpdated,
    },
  };
}

function preferTargetUid(aliasRows, uidList) {
  for (const row of aliasRows) {
    if (row.target_user_id && uidList.includes(row.target_user_id)) return row.target_user_id;
  }
  return uidList[0] || '';
}

/**
 * Person index used by the page to render the star map picker.
 *
 * @param {object} db
 * @param {{group?: string, limit?: number}} options
 */
export function buildStarIndex(db, options = {}) {
  const group = text(options.group);
  const limit = clampInt(options.limit, 1, MAX_INDEX_LIMIT, DEFAULT_INDEX_LIMIT);
  const merge = readMergeMap(db);

  const people = new Map();
  const ensurePerson = (uid) => {
    const key = personKeyOf(merge, uid);
    let person = people.get(key);
    if (!person) {
      person = {
        person_id: key,
        uids: uidsOfPerson(merge, key),
        names: new Map(),
        latestName: '',
        latestTs: -1,
        quotes: 0,
        groups: new Set(),
        aliasRows: [],
      };
      people.set(key, person);
    }
    person.uids.add(uid);
    return person;
  };

  const params = [];
  let filter = '';
  if (group) {
    filter = 'AND group_id = ?';
    params.push(group);
  }
  const subjectRows = db
    .prepare(
      `SELECT subject_user, group_id, subject_name, COUNT(*) AS n, MAX(created_at) AS last_ts
         FROM quotes
        WHERE image_path <> '' AND subject_user <> '' AND subject_name <> ''
         ${filter}
        GROUP BY subject_user, group_id, subject_name`,
    )
    .all(...params);
  for (const row of subjectRows) {
    const uid = text(row.subject_user);
    if (!uid) continue;
    const person = ensurePerson(uid);
    const name = text(row.subject_name);
    const count = Number(row.n) || 0;
    person.quotes += count;
    if (row.group_id) person.groups.add(text(row.group_id));
    const ts = Number(row.last_ts) || 0;
    if (ts > person.latestTs || (ts === person.latestTs && name.length > person.latestName.length)) {
      person.latestTs = ts;
      person.latestName = name;
    }
    if (name) {
      const key = normalizeAliasKey(name);
      if (key) {
        const current = person.names.get(key);
        if (current) current.count += count;
        else person.names.set(key, { label: name, count });
      }
    }
  }

  const aliasRows = readAliasRows(db, group);
  for (const row of aliasRows) {
    if (!row.target_user_id) continue;
    const person = ensurePerson(row.target_user_id);
    person.aliasRows.push(row);
    if (row.group_id) person.groups.add(row.group_id);
    else person.groups.add('');
  }

  const preferredCache = new Map();
  const items = [];
  for (const person of people.values()) {
    if (preferredCache.has(person.person_id)) continue;
    const aliasRowsForPerson = person.aliasRows;
    const preferred = pickPreferredAlias(
      aliasRowsForPerson,
      [...person.uids],
      group ? [group] : [],
    );
    preferredCache.set(person.person_id, preferred);
    const displayName = clipLabel(
      preferred?.alias_name || person.latestName || `QQ ${[...person.uids][0] || ''}`,
    );
    const aliasKeys = new Set();
    for (const row of aliasRowsForPerson) {
      const key = normalizeAliasKey(row.alias_name);
      if (key) aliasKeys.add(key);
      if (row.group_id) person.groups.add(row.group_id);
    }
    const centreKey = normalizeAliasKey(displayName);
    let nicknameCount = 0;
    for (const key of person.names.keys()) {
      if (!aliasKeys.has(key) && key !== centreKey) nicknameCount += 1;
    }
    items.push({
      person_id: person.person_id,
      target_user_id: preferTargetUid(aliasRowsForPerson, [...person.uids]),
      display_name: displayName,
      aliases: aliasKeys.size,
      nicknames: nicknameCount,
      quotes: person.quotes,
      groups: [...person.groups].filter(Boolean).sort(),
      last_seen: person.latestTs,
    });
  }

  items.sort((left, right) => {
    if (right.quotes !== left.quotes) return right.quotes - left.quotes;
    if (right.aliases !== left.aliases) return right.aliases - left.aliases;
    return left.display_name.localeCompare(right.display_name);
  });

  return { ok: true, total: items.length, items: items.slice(0, limit) };
}
