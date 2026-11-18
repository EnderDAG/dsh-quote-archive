/**
 * dsh-quote-archive person-alias layer (schema v9).
 *
 * AstrBot keeps nicknames inside a JSON identity store plus an
 * `alias_candidate` queue. The DSH port stores both on plain SQLite tables
 * (`person_alias`, `alias_candidate`) and resolves display names the same way
 * AstrBot's `preferred_name` does:
 *
 *   confirmed alias for the group (manual > learned > merge)
 *   → latest subject nickname from `quotes`
 *   → raw user id
 *
 * Everything here is pure `node:sqlite` + string handling: no dependencies.
 */

export const ALIAS_SOURCES = ['manual', 'learned', 'merge'];
export const ALIAS_CONFIRM_RATIO = 0.75;
/** A candidate is only offered for manual review after it was seen repeatedly and scores high. */
export const CANDIDATE_MIN_OCCURRENCES = 2;
export const CANDIDATE_MIN_CONFIDENCE = 0.8;
export const ROLE_WORDS = ['群主', '管理员', '群管', '专属头衔', '头衔'];

const SOURCE_RANK = { manual: 0, learned: 1, merge: 2 };
const TITLE_PREFIX_RE = /^lv\s*\d+\s*/i;
const ROLE_PREFIX_RE = /^(?:群主|管理员|群管|专属头衔|头衔)\s*[:：]?\s*/u;
const BRACKET_PREFIX_RE = /^[\s【\[（(]\s*[^】\]）)]{1,12}[】\]）)]\s*/u;
const BRACKET_SUFFIX_RE = /\s*[【\[（(][^】\]）)]{1,16}[】\]）)]\s*$/u;
const SPLIT_RE = /[、,，;；|｜/\\\n\r\t]+/u;
const EDGE_DECORATION_RE =
  /^[\s"'“”‘’「」『』【】\[\]（）()<>《》、，,。.!！?？:：;；·•~～\-—_=+*#@＠]+|[\s"'“”‘’「」『』【】\[\]（）()<>《》、，,。.!！?？:：;；·•~～\-—_=+*#@＠]+$/gu;
const EMOJI_EDGE_RE =
  /^[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F\u200D\s]+|[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F\u200D\s]+$/gu;

const MAX_NAME_LENGTH = 20;
const MAX_KEY_LENGTH = 64;
const MAX_CANDIDATES = 500;

function readString(value) {
  return String(value ?? '').trim();
}

function nowStamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return Math.floor(number);
  return Math.floor(Date.now() / 1000);
}

/**
 * Normalize a nickname into a comparable key: lower-case, no whitespace and
 * no punctuation (AstrBot's `name_key`, plus punctuation stripping).
 */
export function normalizeAliasKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '')
    .slice(0, MAX_KEY_LENGTH);
}

/** True when a nickname is really a group title / role decoration. */
export function looksLikeTitle(value) {
  const text = readString(value);
  if (!text) return false;
  if (TITLE_PREFIX_RE.test(text)) return true;
  if (ROLE_PREFIX_RE.test(text)) return true;
  if (text.length <= 8 && ROLE_WORDS.some((word) => text.includes(word))) return true;
  return false;
}

/** Strip titles, bracketed decorations and edge punctuation from a nickname. */
export function cleanAliasName(value) {
  let text = readString(value);
  if (!text) return '';
  text = text.replace(TITLE_PREFIX_RE, '');
  text = text.replace(ROLE_PREFIX_RE, '');
  text = text.replace(BRACKET_PREFIX_RE, '');
  text = text.replace(/^[\s@＠]+/u, '');
  text = text.replace(BRACKET_SUFFIX_RE, '');
  const parts = text
    .split(SPLIT_RE)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    parts.sort(
      (left, right) =>
        Number(ROLE_WORDS.includes(left)) - Number(ROLE_WORDS.includes(right)) || right.length - left.length,
    );
    text = parts[0];
  }
  text = text.replace(/[\uFE0F\u200D]/gu, '').replace(EDGE_DECORATION_RE, '');
  text = text.replace(EMOJI_EDGE_RE, '').replace(EDGE_DECORATION_RE, '');
  return text.slice(0, MAX_NAME_LENGTH);
}

function editDistance(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/** Similarity ratio in [0, 1] based on normalized keys. */
export function nameRatio(left, right) {
  const a = normalizeAliasKey(left);
  const b = normalizeAliasKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/** AstrBot's `names_alike`: exact key, containment or ≥ 0.75 similarity. */
export function namesAlike(left, right) {
  const a = normalizeAliasKey(left);
  const b = normalizeAliasKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  return nameRatio(a, b) >= ALIAS_CONFIRM_RATIO;
}

/**
 * Confidence assigned by the local learn rule. Repeated, shape-similar variants
 * always clear `CANDIDATE_MIN_CONFIDENCE`; the score grows with the similarity.
 */
function learnConfidence(ratio) {
  const value = 0.8 + 0.2 * Math.max(0, Math.min(1, Number(ratio) || 0));
  return Math.round(Math.min(1, value) * 100) / 100;
}

function mapAliasRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || 0,
    group_id: String(row.group_id ?? ''),
    alias_key: String(row.alias_key ?? ''),
    alias_name: String(row.alias_name ?? ''),
    target_user_id: String(row.target_user_id ?? ''),
    target_pid: String(row.person_id ?? ''),
    person_id: String(row.person_id ?? ''),
    display_name: String(row.display_name ?? ''),
    source: String(row.source ?? 'manual'),
    confidence: Number(row.confidence) || 0,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

function mapCandidateRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || 0,
    group_id: String(row.group_id ?? ''),
    alias_key: String(row.alias_key ?? ''),
    alias_name: String(row.alias_name ?? ''),
    target_user_id: String(row.target_user_id ?? ''),
    target_pid: String(row.person_id ?? ''),
    person_id: String(row.person_id ?? ''),
    display_name: String(row.display_name ?? ''),
    evidence: String(row.evidence ?? ''),
    confidence: Number(row.confidence) || 0,
    occurrences: Number(row.occurrences) || 0,
    status: String(row.status ?? 'pending'),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export function listAliases(db, { group = '', userId = '', limit = 1000 } = {}) {
  const clauses = [];
  const args = [];
  const gid = readString(group);
  const uid = readString(userId);
  if (gid) {
    clauses.push('group_id = ?');
    args.push(gid);
  }
  if (uid) {
    clauses.push('target_user_id = ?');
    args.push(uid);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM person_alias ${where} ` +
        "ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END, " +
        'updated_at DESC, alias_name ASC LIMIT ?',
    )
    .all(...args, Math.max(1, Math.min(5000, Number(limit) || 1000)));
  return rows.map(mapAliasRow);
}

export function getAlias(db, id) {
  const row = db.prepare('SELECT * FROM person_alias WHERE id = ?').get(Number(id) || 0);
  return mapAliasRow(row);
}

export function upsertAlias(
  db,
  { group = '', aliasName, targetUserId, personId = '', displayName = '', source = 'manual', confidence, now } = {},
) {
  const key = normalizeAliasKey(aliasName);
  const uid = readString(targetUserId);
  const name = readString(aliasName).slice(0, MAX_NAME_LENGTH);
  if (!key || !uid || !name) return null;
  const gid = readString(group);
  const stamp = nowStamp(now);
  const sourceValue = ALIAS_SOURCES.includes(readString(source)) ? readString(source) : 'manual';
  const rank = SOURCE_RANK[sourceValue] ?? 0;
  const confidenceValue = Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 0.8;
  const pid = readString(personId);
  const display = readString(displayName).slice(0, MAX_NAME_LENGTH);
  // One nickname can only point at one person per group: drop older targets.
  db.prepare('DELETE FROM person_alias WHERE group_id = ? AND alias_key = ? AND target_user_id <> ?').run(
    gid,
    key,
    uid,
  );
  const existing = db
    .prepare('SELECT * FROM person_alias WHERE group_id = ? AND alias_key = ? AND target_user_id = ?')
    .get(gid, key, uid);
  if (existing) {
    const existingRank = SOURCE_RANK[String(existing.source ?? 'manual')] ?? 0;
    const nextSource = rank <= existingRank ? sourceValue : String(existing.source ?? sourceValue);
    db.prepare(
      'UPDATE person_alias SET alias_name = ?, person_id = ?, display_name = ?, source = ?, ' +
        'confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?',
    ).run(name, pid, display, nextSource, confidenceValue, stamp, Number(existing.id));
    return getAlias(db, Number(existing.id));
  }
  const result = db
    .prepare(
      'INSERT INTO person_alias(group_id, alias_key, alias_name, target_user_id, person_id, display_name, ' +
        'source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(gid, key, name, uid, pid, display, sourceValue, confidenceValue, stamp, stamp);
  return getAlias(db, Number(result.lastInsertRowid));
}

export function deleteAlias(db, { id, group = '', aliasName = '', key = '', userId = '' } = {}) {
  if (Number(id) > 0) {
    return Number(db.prepare('DELETE FROM person_alias WHERE id = ?').run(Number(id)).changes) || 0;
  }
  const aliasKey = readString(key) || normalizeAliasKey(aliasName);
  if (!aliasKey) return 0;
  const clauses = ['alias_key = ?'];
  const args = [aliasKey];
  const gid = readString(group);
  const uid = readString(userId);
  if (gid) {
    clauses.push('group_id = ?');
    args.push(gid);
  }
  if (uid) {
    clauses.push('target_user_id = ?');
    args.push(uid);
  }
  return Number(db.prepare(`DELETE FROM person_alias WHERE ${clauses.join(' AND ')}`).run(...args).changes) || 0;
}

export function aliasesForUser(db, userId) {
  return listAliases(db, { userId: readString(userId) });
}

/** Exact key first, then the closest similar confirmed alias. */
export function lookupAlias(db, name, group = '') {
  const key = normalizeAliasKey(name);
  if (!key) return null;
  const gid = readString(group);
  const rows = listAliases(db, { limit: 5000 });
  const exact = rows.filter((row) => row.alias_key === key);
  if (exact.length) {
    const sameGroup = exact.find((row) => gid && row.group_id === gid);
    return mapAliasRow(sameGroup || exact[0]);
  }
  let best = null;
  for (const row of rows) {
    if (!namesAlike(name, row.alias_name)) continue;
    const distance = 1 - nameRatio(name, row.alias_name);
    const score = [distance, gid && row.group_id === gid ? 0 : 1];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
      best = { score, row };
    }
  }
  return best ? mapAliasRow(best.row) : null;
}

/**
 * Pick the alias that should win for a person: manual > learned > merge, then
 * aliases scoped to one of the person's groups, then shorter/newer names.
 */
export function pickPreferredAlias(rows, userIds, groups) {
  const uids = new Set((userIds || []).map((value) => readString(value)).filter(Boolean));
  if (!uids.size) return null;
  const gids = new Set([...(groups || [])].map((value) => readString(value)).filter(Boolean));
  let best = null;
  for (const row of rows || []) {
    if (!uids.has(row.target_user_id)) continue;
    if (!row.alias_name) continue;
    const score = [
      SOURCE_RANK[row.source] ?? 9,
      row.group_id && gids.has(row.group_id) ? 0 : 1,
      row.alias_name.length,
      -(row.updated_at || row.created_at || 0),
      -(Number(row.id) || 0),
      row.alias_name,
    ];
    if (!best || compareScore(score, best.score) < 0) best = { score, row };
  }
  return best ? best.row : null;
}

function compareScore(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  }
  return 0;
}

export function listCandidates(db, { group = '', status = 'pending', limit = 200 } = {}) {
  const gid = readString(group);
  const statusValue = readString(status) || 'pending';
  const clauses = [
    'status = ?',
    'occurrences >= ?',
    'confidence >= ?',
  ];
  const args = [statusValue, CANDIDATE_MIN_OCCURRENCES, CANDIDATE_MIN_CONFIDENCE];
  if (gid) {
    clauses.push('group_id = ?');
    args.push(gid);
  }
  const rows = db
    .prepare(
      `SELECT * FROM alias_candidate WHERE ${clauses.join(' AND ')} ` +
        'ORDER BY confidence DESC, occurrences DESC, created_at DESC LIMIT ?',
    )
    .all(...args, Math.max(1, Math.min(MAX_CANDIDATES, Number(limit) || 200)));
  return rows.map(mapCandidateRow);
}

export function countCandidates(db, { group = '', status = 'pending' } = {}) {
  const gid = readString(group);
  const statusValue = readString(status) || 'pending';
  const clauses = [
    'status = ?',
    'occurrences >= ?',
    'confidence >= ?',
  ];
  const args = [statusValue, CANDIDATE_MIN_OCCURRENCES, CANDIDATE_MIN_CONFIDENCE];
  if (gid) {
    clauses.push('group_id = ?');
    args.push(gid);
  }
  return Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM alias_candidate WHERE ${clauses.join(' AND ')}`).get(...args) || {}).n || 0,
  );
}

export function addCandidate(
  db,
  {
    group = '',
    aliasName,
    targetUserId,
    personId = '',
    displayName = '',
    evidence = '',
    confidence = 0.5,
    occurrences = 0,
    now,
  } = {},
) {
  const key = normalizeAliasKey(aliasName);
  const uid = readString(targetUserId);
  const name = readString(aliasName).slice(0, MAX_NAME_LENGTH);
  if (!key || !uid || !name) return 0;
  const gid = readString(group);
  // Already confirmed for this person? Nothing to learn.
  const alias = db
    .prepare('SELECT id FROM person_alias WHERE group_id = ? AND alias_key = ? AND target_user_id = ?')
    .get(gid, key, uid);
  if (alias) return 0;
  const stamp = nowStamp(now);
  const score = Math.max(0.1, Math.min(1, Number(confidence) || 0.5));
  const count = Math.max(0, Math.floor(Number(occurrences) || 0));
  // Only repeated, high-confidence candidates reach the manual review queue.
  if (count < CANDIDATE_MIN_OCCURRENCES || score < CANDIDATE_MIN_CONFIDENCE) return 0;
  const pending = db
    .prepare("SELECT * FROM alias_candidate WHERE group_id = ? AND alias_key = ? AND target_user_id = ? AND status = 'pending'")
    .get(gid, key, uid);
  if (pending) {
    db.prepare(
      'UPDATE alias_candidate SET alias_name = ?, person_id = ?, display_name = ?, evidence = ?, ' +
        'confidence = MAX(confidence, ?), occurrences = MAX(occurrences, ?), updated_at = ? WHERE id = ?',
    ).run(
      name,
      readString(personId),
      readString(displayName).slice(0, MAX_NAME_LENGTH),
      readString(evidence).slice(0, 120),
      score,
      count,
      stamp,
      Number(pending.id),
    );
    return Number(pending.id);
  }
  const result = db
    .prepare(
      'INSERT INTO alias_candidate(group_id, alias_key, alias_name, target_user_id, person_id, display_name, ' +
        "evidence, confidence, occurrences, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .run(
      gid,
      key,
      name,
      uid,
      readString(personId),
      readString(displayName).slice(0, MAX_NAME_LENGTH),
      readString(evidence).slice(0, 120),
      score,
      count,
      stamp,
      stamp,
    );
  return Number(result.lastInsertRowid);
}

export function getCandidate(db, id) {
  return mapCandidateRow(db.prepare('SELECT * FROM alias_candidate WHERE id = ?').get(Number(id) || 0));
}

function setCandidateStatus(db, id, status) {
  // The unique key includes `status`, so drop a stale row in the target state.
  const candidate = getCandidate(db, id);
  if (!candidate) return false;
  db.prepare(
    'DELETE FROM alias_candidate WHERE group_id = ? AND alias_key = ? AND target_user_id = ? AND status = ? AND id <> ?',
  ).run(candidate.group_id, candidate.alias_key, candidate.target_user_id, status, candidate.id);
  const changed = Number(db.prepare('UPDATE alias_candidate SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowStamp(),
    candidate.id,
  ).changes);
  return changed > 0;
}

/** Confirm a candidate: persist it as a real (learned) alias. */
export function confirmCandidate(db, id) {
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.status !== 'pending') return null;
  const entry = upsertAlias(db, {
    group: candidate.group_id,
    aliasName: candidate.alias_name,
    targetUserId: candidate.target_user_id,
    personId: candidate.person_id,
    displayName: candidate.display_name,
    source: 'learned',
    confidence: candidate.confidence || 0.8,
  });
  if (!entry) return null;
  setCandidateStatus(db, candidate.id, 'confirmed');
  return entry;
}

export function rejectCandidate(db, id) {
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.status !== 'pending') return false;
  return setCandidateStatus(db, candidate.id, 'rejected');
}

function latestSubjectNames(db) {
  const rows = db
    .prepare(
      'SELECT subject_user, subject_name, MAX(created_at) AS ts, MAX(id) AS id FROM quotes ' +
        "WHERE image_path <> '' AND subject_user <> '' AND subject_name <> '' " +
        'GROUP BY subject_user, subject_name ORDER BY ts ASC, id ASC',
    )
    .all();
  const map = new Map();
  for (const row of rows) {
    const uid = readString(row.subject_user);
    const name = readString(row.subject_name);
    if (uid && name) map.set(uid, name);
  }
  return map;
}

/**
 * Map user id → display name: confirmed aliases first, then the most recent
 * subject nickname stored on quotes.
 */
export function preferredNameMap(db, { group = '' } = {}) {
  const gid = readString(group);
  const aliases = listAliases(db, { limit: 5000 });
  const fallback = latestSubjectNames(db);
  const grouped = new Map();
  for (const row of aliases) {
    if (gid && row.group_id && row.group_id !== gid) continue;
    const uids = grouped.get(row.target_user_id) || [];
    uids.push(row);
    grouped.set(row.target_user_id, uids);
  }
  const map = new Map();
  for (const [uid, rows] of grouped) {
    const best = pickPreferredAlias(rows, [uid], gid ? [gid] : []);
    if (best && best.alias_name) map.set(uid, best.alias_name);
  }
  for (const [uid, name] of fallback) {
    if (!map.has(uid) && name) map.set(uid, name);
  }
  return map;
}

export function preferredName(db, { userId = '', group = '' } = {}) {
  const uid = readString(userId);
  if (!uid) return '';
  const gid = readString(group);
  const rows = listAliases(db, { userId: uid, limit: 200 });
  const best = pickPreferredAlias(rows, [uid], gid ? [gid] : []);
  if (best && best.alias_name) return best.alias_name;
  return latestSubjectNames(db).get(uid) || '';
}

/**
 * Conservative local alias learning (no LLM).
 *
 * Two rules, both explainable:
 *  1. one person bound under several nickname variants (`阿零` vs `阿零同学`);
 *  2. a submitter nickname that looks like a bound person's variant.
 *
 * Variants only become candidates when they occur at least `minOccurrences`
 * times, mirroring AstrBot's "宁缺毋滥" filter.
 */
export function learnAliasCandidates(
  db,
  { group = '', limit = 20, minOccurrences = CANDIDATE_MIN_OCCURRENCES, now } = {},
) {
  const gid = readString(group);
  const stamp = nowStamp(now);
  const minCount = Math.max(CANDIDATE_MIN_OCCURRENCES, Number(minOccurrences) || CANDIDATE_MIN_OCCURRENCES);
  const boundRows = db
    .prepare(
      'SELECT group_id, subject_user, subject_name, COUNT(*) AS n FROM quotes ' +
        "WHERE image_path <> '' AND subject_user <> '' AND subject_name <> '' " +
        (gid ? 'AND group_id = ? ' : '') +
        'GROUP BY group_id, subject_user, subject_name',
    )
    .all(...(gid ? [gid] : []));
  const speakerRows = db
    .prepare(
      'SELECT group_id, speaker, COUNT(*) AS n FROM quotes ' +
        "WHERE image_path <> '' AND speaker <> '' " +
        (gid ? 'AND group_id = ? ' : '') +
        'GROUP BY group_id, speaker',
    )
    .all(...(gid ? [gid] : []));
  const aliasRows = listAliases(db, { limit: 5000 });
  const aliased = new Set(
    aliasRows.map((row) => `${row.group_id}\u0000${row.alias_key}\u0000${row.target_user_id}`),
  );
  const byUser = new Map();
  let scanned = 0;
  for (const row of boundRows) {
    scanned += 1;
    const g = readString(row.group_id);
    const uid = readString(row.subject_user);
    const name = readString(row.subject_name);
    if (!uid || !name) continue;
    const key = `${g}\u0000${uid}`;
    const list = byUser.get(key) || [];
    list.push({ name, count: Number(row.n) || 0, group: g, user: uid });
    byUser.set(key, list);
  }
  const items = [];
  let skipped = 0;
  const seen = new Set();
  const pushCandidate = (candidate) => {
    if (items.length >= Math.max(1, Number(limit) || 20)) return;
    const dedupe = `${candidate.group}\u0000${candidate.user}\u0000${normalizeAliasKey(candidate.name)}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    if (aliased.has(dedupe)) {
      skipped += 1;
      return;
    }
    const person = pickPreferredAlias(aliasRows, [candidate.user], [candidate.group]);
    const display = person && person.alias_name ? person.alias_name : candidate.displayName || '';
    const id = addCandidate(db, {
      group: candidate.group,
      aliasName: candidate.name,
      targetUserId: candidate.user,
      personId: candidate.personId || '',
      displayName: display,
      evidence: candidate.evidence,
      confidence: candidate.confidence,
      occurrences: candidate.count,
      now: stamp,
    });
    if (!id) {
      skipped += 1;
      return;
    }
    items.push({
      id,
      alias_name: candidate.name,
      display_name: display,
      target_user_id: candidate.user,
      confidence: candidate.confidence,
      occurrences: candidate.count,
      evidence: candidate.evidence,
    });
  };
  for (const [key, names] of byUser) {
    const [g, uid] = key.split('\u0000');
    const sorted = names.slice().sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    const canonical = sorted[0];
    if (!canonical) continue;
    for (const variant of sorted.slice(1)) {
      if (looksLikeTitle(variant.name) || looksLikeTitle(canonical.name)) continue;
      if (normalizeAliasKey(variant.name) === normalizeAliasKey(canonical.name)) continue;
      if (variant.count < minCount) {
        skipped += 1;
        continue;
      }
      if (!namesAlike(variant.name, canonical.name)) continue;
      pushCandidate({
        group: g,
        user: uid,
        name: variant.name,
        count: variant.count,
        evidence: `群昵称变体：${variant.name} ≈ ${canonical.name}`,
        confidence: learnConfidence(nameRatio(variant.name, canonical.name)),
      });
    }
  }
  const boundByName = new Map();
  for (const [, names] of byUser) {
    for (const entry of names) {
      const key = normalizeAliasKey(entry.name);
      if (!key) continue;
      const list = boundByName.get(key) || [];
      list.push(entry);
      boundByName.set(key, list);
    }
  }
  for (const row of speakerRows) {
    scanned += 1;
    const g = readString(row.group_id);
    const name = readString(row.speaker);
    const count = Number(row.n) || 0;
    if (!name || count < minCount) continue;
    if (looksLikeTitle(name)) continue;
    const key = normalizeAliasKey(name);
    let target = boundByName.get(key) || null;
    if (!target) {
      for (const [, names] of byUser) {
        const canonical = names.slice().sort((left, right) => right.count - left.count)[0];
        if (canonical && canonical.group === g && namesAlike(canonical.name, name)) {
          target = [canonical];
          break;
        }
      }
    }
    if (!target || !target.length) continue;
    const canonical = target[0];
    if (normalizeAliasKey(canonical.name) === key) continue;
    pushCandidate({
      group: g,
      user: canonical.user,
      name,
      count,
      evidence: `投稿昵称「${name}」≈ 人物「${canonical.name}」`,
      confidence: learnConfidence(nameRatio(name, canonical.name)),
    });
  }
  return {
    ok: true,
    group_id: gid,
    added: items.length,
    scanned,
    skipped,
    items,
    note: 'local-rule',
  };
}

/**
 * Real "tidy old nicknames" pass: normalizes title/decorated nicknames stored
 * on quotes, merges OCR duplicates and migrates the canonical name into the
 * alias table.
 */
export function cleanupSubjects(db, { group = '', apply = false, now } = {}) {
  const gid = readString(group);
  const stamp = nowStamp(now);
  const groups = gid
    ? [gid]
    : db
        .prepare("SELECT DISTINCT group_id FROM quotes WHERE image_path <> ''")
        .all()
        .map((row) => readString(row.group_id))
        .filter(Boolean);
  const rows = [];
  for (const current of groups) {
    const list = db
      .prepare(
        'SELECT id, group_id, subject_user, subject_name FROM quotes ' +
          "WHERE image_path <> '' AND group_id = ? AND (subject_name <> '' OR subject_user <> '')",
      )
      .all(current);
    for (const row of list) {
      rows.push({
        id: Number(row.id) || 0,
        group_id: readString(row.group_id),
        user_id: readString(row.subject_user),
        name: readString(row.subject_name),
      });
    }
  }
  const scanned = rows.length;
  const titleNames = new Set();
  const unbindIds = [];
  const samples = [];
  const items = [];
  const byUser = new Map();
  let boundQuotes = 0;
  const boundNames = new Set();
  const boundUsers = new Set();
  for (const row of rows) {
    if (!row.user_id || !row.name) continue;
    boundQuotes += 1;
    boundNames.add(row.name);
    boundUsers.add(row.user_id);
    if (looksLikeTitle(row.name)) {
      titleNames.add(row.name);
      unbindIds.push(row.id);
      items.push({ group_id: row.group_id, user_id: row.user_id, alias_name: row.name, action: 'unbind' });
      continue;
    }
    const cleaned = cleanAliasName(row.name);
    if (!cleaned) {
      unbindIds.push(row.id);
      items.push({ group_id: row.group_id, user_id: row.user_id, alias_name: row.name, action: 'unbind' });
      continue;
    }
    const key = `${row.group_id}\u0000${row.user_id}`;
    const bucket = byUser.get(key) || { group_id: row.group_id, user_id: row.user_id, names: new Map() };
    const entry = bucket.names.get(cleaned) || { cleaned, raw: new Set(), ids: [] };
    entry.raw.add(row.name);
    entry.ids.push(row.id);
    bucket.names.set(cleaned, entry);
    byUser.set(key, bucket);
  }
  let dropNames = 0;
  let cleaned = 0;
  let mergedClusters = 0;
  const renamePlan = [];
  const aliasPlan = [];
  for (const bucket of byUser.values()) {
    const entries = [...bucket.names.values()].sort(
      (left, right) => right.ids.length - left.ids.length || left.cleaned.localeCompare(right.cleaned),
    );
    const canonical = entries[0];
    if (!canonical) continue;
    if (entries.length > 1) mergedClusters += 1;
    for (const entry of entries) {
      const rawVariants = [...entry.raw];
      for (const raw of rawVariants) {
        if (raw !== entry.cleaned) {
          cleaned += 1;
          if (samples.length < 12) samples.push(`${raw} → ${entry.cleaned}`);
        }
      }
      if (entry !== canonical) {
        dropNames += entry.ids.length;
        if (samples.length < 12) samples.push(`${[...entry.raw].join(' / ')} → ${canonical.cleaned}`);
      }
      renamePlan.push({ ids: entry.ids, name: canonical.cleaned, group_id: bucket.group_id });
    }
    aliasPlan.push({ group_id: bucket.group_id, user_id: bucket.user_id, name: canonical.cleaned });
    items.push({
      group_id: bucket.group_id,
      user_id: bucket.user_id,
      alias_name: canonical.cleaned,
      action: 'alias',
    });
  }
  let quotesUnbound = 0;
  if (apply) {
    for (const id of unbindIds) {
      quotesUnbound += Number(
        db.prepare("UPDATE quotes SET subject_name = '', subject_user = '' WHERE id = ?").run(id).changes,
      );
    }
    for (const plan of renamePlan) {
      const update = db.prepare('UPDATE quotes SET subject_name = ? WHERE id = ?');
      for (const id of plan.ids) update.run(plan.name, id);
    }
    for (const plan of aliasPlan) {
      upsertAlias(db, {
        group: plan.group_id,
        aliasName: plan.name,
        targetUserId: plan.user_id,
        personId: plan.user_id,
        displayName: plan.name,
        source: 'merge',
        confidence: 0.9,
        now: stamp,
      });
    }
  }
  return {
    ok: true,
    group_id: gid,
    dry_run: !apply,
    apply: Boolean(apply),
    scanned,
    bound_quotes: boundQuotes,
    alias_names: boundNames.size,
    alias_users: boundUsers.size,
    drop_names: dropNames,
    drop_users: apply ? new Set(aliasPlan.map((plan) => plan.user_id)).size : new Set(aliasPlan.map((plan) => plan.user_id)).size,
    title_aliases: titleNames.size,
    title_quotes: unbindIds.length,
    titles_cleaned: apply ? titleNames.size : 0,
    quotes_unbound: quotesUnbound,
    merged_clusters: mergedClusters,
    cleaned,
    samples,
    items,
    unsupported: [],
  };
}
