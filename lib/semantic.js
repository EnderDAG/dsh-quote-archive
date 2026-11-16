/**
 * Local semantic-ish search for archived quotes (v0.16.0).
 *
 * AstrBot's edition asks a vision model for a caption and an embedding model
 * for vectors, then ranks by cosine similarity. The DSH edition has no model
 * dependency at all, so this module builds a classic lexical index instead:
 * every quote becomes a document (caption text, speaker, subject, group name,
 * tags, collection names), Chinese text is tokenised into characters and
 * bigrams, and retrieval ranks with BM25 + phrase/coverage bonuses.
 *
 * The public functions operate on the raw `node:sqlite` DatabaseSync handle
 * owned by lib/store.js:
 *
 *   semantic_doc(quote_id PK, group_id, length, signature, text, updated_at)
 *     One row per indexed quote. `signature` is a hash of the document text so
 *     incremental builds can skip untouched quotes, `text` powers phrase
 *     bonuses and the "semantic_text" field the management page shows.
 *   semantic_term(term, quote_id, tf, PRIMARY KEY(term, quote_id))
 *     Inverted index. Bigrams and single characters are stored as separate
 *     terms; tf is the term frequency inside one document.
 *   semantic_meta(group_id, key, value, PRIMARY KEY(group_id, key))
 *     Free-form state such as the index version.
 */
import { createHash } from 'node:crypto';

/** Bumped whenever tokenisation or scoring changes, invalidating old docs. */
export const SEMANTIC_VERSION = 'local-bm25-v1';

/** Provider descriptor handed to the management page (`embedding` field). */
export const SEMANTIC_PROVIDER = {
  id: 'local-bm25',
  model: 'char-ngram',
  dimension: 0,
  ready: true,
};

/** Caption provider id: the page requires a non-empty value to stay happy. */
export const SEMANTIC_CAPTION_PROVIDER = 'local-bm25';

/** BM25 parameters (standard defaults). */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Maximum characters kept from one document text (guards degenerate rows). */
export const DOC_TEXT_LIMIT = 2000;

/**
 * Minimal stop-word set: only function words, never content characters, so
 * that «吃饭了吗» still produces the meaningful tokens 吃/饭/吃饭.
 */
export const STOPWORDS = new Set([
  '的', '了', '吗', '呢', '啊', '吧', '呀', '哦', '嗯', '嘛', '啦', '诶', '哎', '唉',
  '是', '在', '有', '和', '与', '就', '都', '也', '还', '又', '很', '太', '这', '那',
  '我', '你', '他', '她', '它', '们', '个', '一', '不', '没', '之', '其', '而', '且',
  '或', '及', '等', '被', '把', '给', '对', '让', '从', '到', '地', '得', '着', '过',
  '去', '来', '说', '上', '下', '里', '再', '才', '更', '最', '挺', '真', '会', '能',
  '要', '想', '看', '么', '啥', '怎', '哪', '谁', '为', '以', '于', '并', '但', '却',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'to', 'in', 'on',
  'for', 'and', 'or', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'so',
]);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9]+/gu;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * NFKC-normalise, lower-case and strip punctuation/symbols to single spaces.
 * Full-width letters and digits collapse to ASCII, which makes the ASCII
 * tokens stable across fonts.
 */
export function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Tokenise text into Chinese character unigrams + bigrams and ASCII words.
 * @returns {string[]} tokens in reading order (duplicates kept; callers fold).
 */
export function tokenize(value) {
  const text = normalizeText(value);
  if (!text) return [];
  const tokens = [];
  for (const run of text.match(CJK_RUN) || []) {
    if (!CJK_CHAR.test(run)) {
      if (run.length >= 2 && !STOPWORDS.has(run)) tokens.push(run);
      continue;
    }
    const chars = Array.from(run);
    for (const char of chars) {
      if (!STOPWORDS.has(char)) tokens.push(char);
    }
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const bigram = chars[i] + chars[i + 1];
      if (!STOPWORDS.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

/** Fold a token list into term -> frequency. */
export function termFrequency(tokens) {
  const freq = new Map();
  for (const token of tokens) freq.set(token, (freq.get(token) || 0) + 1);
  return freq;
}

/**
 * Build the searchable document text for one quote.
 * Empty parts and the placeholder caption `[图片语录]` are ignored.
 */
export function buildSemanticText(fields = {}) {
  const parts = [];
  const push = (value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text === '[图片语录]') return;
    if (!parts.includes(text)) parts.push(text);
  };
  push(fields.content);
  push(fields.speaker);
  push(fields.subjectName);
  push(fields.groupName);
  for (const tag of fields.tags || []) push(`#${String(tag).replace(/^#+/, '')}`);
  for (const name of fields.collections || []) push(name);
  return parts.join(' ').slice(0, DOC_TEXT_LIMIT);
}

/** Stable hash of (version, text); used to skip unchanged documents. */
export function semanticSignature(text) {
  return createHash('sha1')
    .update(SEMANTIC_VERSION)
    .update('\n')
    .update(String(text ?? ''))
    .digest('hex')
    .slice(0, 16);
}

function safeText(value) {
  return String(value ?? '');
}

/**
 * (Re)index one batch of documents.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{quoteId:number, groupId:string, text:string, signature?:string, now?:number}[]} docs
 * @returns {{indexed:number, failed:number, errors:string[]}}
 */
export function indexDocuments(db, docs = []) {
  const now = Math.floor(Date.now() / 1000);
  const deleteTerms = db.prepare('DELETE FROM semantic_term WHERE quote_id = ?');
  const deleteDoc = db.prepare('DELETE FROM semantic_doc WHERE quote_id = ?');
  const insertTerm = db.prepare('INSERT INTO semantic_term(term, quote_id, tf) VALUES (?, ?, ?)');
  const insertDoc = db.prepare(
    'INSERT INTO semantic_doc(quote_id, group_id, length, signature, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  let indexed = 0;
  let failed = 0;
  const errors = [];
  for (const doc of docs) {
    const quoteId = Number(doc?.quoteId ?? 0);
    if (!Number.isFinite(quoteId) || quoteId <= 0) continue;
    const text = safeText(doc.text);
    const signature = safeText(doc.signature) || semanticSignature(text);
    const tokens = tokenize(text);
    const freq = termFrequency(tokens);
    try {
      deleteTerms.run(quoteId);
      deleteDoc.run(quoteId);
      for (const [term, tf] of freq) insertTerm.run(term, quoteId, tf);
      insertDoc.run(quoteId, safeText(doc.groupId), tokens.length, signature, text, now);
      indexed += 1;
    } catch (error) {
      failed += 1;
      if (errors.length < 5) errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { indexed, failed, errors };
}

/**
 * BM25 retrieval.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{group?:string, query?:string, limit?:number, minScore?:number}} options
 * @returns {{hits:{quoteId:number, score:number, matched:number}[], total:number, terms:string[]}}
 */
export function searchDocuments(db, options = {}) {
  const group = String(options.group ?? '').trim();
  const query = safeText(options.query ?? '');
  const limit = Math.max(1, Math.min(500, Number(options.limit ?? 100) || 100));
  const minScore = Number(options.minScore ?? 0);
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return { hits: [], total: 0, terms };

  const scope = group
    ? db.prepare('SELECT COUNT(*) AS n, AVG(length) AS avg FROM semantic_doc WHERE group_id = ?').get(group)
    : db.prepare('SELECT COUNT(*) AS n, AVG(length) AS avg FROM semantic_doc').get();
  const docCount = Number(scope?.n || 0);
  if (!docCount) return { hits: [], total: 0, terms };
  const avgdl = Number(scope?.avg || 0) || 1;

  const placeholders = terms.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT t.term AS term, t.quote_id AS quote_id, t.tf AS tf, d.length AS dl, d.text AS text
         FROM semantic_term t
         JOIN semantic_doc d ON d.quote_id = t.quote_id
        WHERE t.term IN (${placeholders})${group ? ' AND d.group_id = ?' : ''}`,
    )
    .all(...terms, ...(group ? [group] : []));

  const df = new Map();
  for (const row of rows) df.set(String(row.term), (df.get(String(row.term)) || 0) + 1);

  const scores = new Map();
  const matched = new Map();
  const texts = new Map();
  for (const row of rows) {
    const term = String(row.term);
    const quoteId = Number(row.quote_id);
    const tf = Number(row.tf) || 0;
    const dl = Number(row.dl) || 0;
    if (!tf) continue;
    const idf = Math.log(1 + (docCount - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl);
    const gain = idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
    scores.set(quoteId, (scores.get(quoteId) || 0) + gain);
    matched.set(quoteId, (matched.get(quoteId) || 0) + 1);
    if (!texts.has(quoteId)) texts.set(quoteId, safeText(row.text));
  }

  const queryPhrase = normalizeText(query);
  const hits = [];
  for (const [quoteId, base] of scores) {
    const coverage = (matched.get(quoteId) || 0) / terms.length;
    let score = base * (0.6 + 0.4 * Math.min(1, coverage));
    const text = texts.get(quoteId) || '';
    if (queryPhrase && text && normalizeText(text).includes(queryPhrase)) score *= 1.2;
    hits.push({ quoteId, score, matched: matched.get(quoteId) || 0, text });
  }
  if (!hits.length) return { hits: [], total: 0, terms };

  // Normalise so the management page's cosine-style min_score slider (0..1)
  // stays meaningful: the best hit always scores 1.0.
  const top = hits.reduce((max, hit) => Math.max(max, hit.score), 0) || 1;
  const ranked = hits
    .map((hit) => ({
      quoteId: hit.quoteId,
      score: Math.round((hit.score / top) * 10000) / 10000,
      matched: hit.matched,
      text: hit.text,
    }))
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => b.score - a.score || a.quoteId - b.quoteId);
  return { hits: ranked.slice(0, limit), total: ranked.length, terms };
}

/** Public wrapper: rank documents for a free-text query. */
export function semanticSearch(db, options = {}) {
  const result = searchDocuments(db, options);
  const ids = result.hits.map((hit) => hit.quoteId);
  if (!ids.length) return { ok: true, total: 0, terms: result.terms, hits: [] };
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT q.id, q.group_id, q.speaker, q.content, q.image_path, q.source, q.restricted,
              q.rating, q.subject_user, q.subject_name, q.created_at
         FROM quotes q WHERE q.id IN (${placeholders})`,
    )
    .all(...ids);
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const hits = [];
  for (const hit of result.hits) {
    const row = byId.get(hit.quoteId);
    if (!row) continue;
    hits.push({ ...hit, quote: row });
  }
  return { ok: true, total: result.total, terms: result.terms, hits };
}

/** Count indexed / total quotes, optionally per group. */
export function indexStats(db, options = {}) {
  const group = String(options.group ?? '').trim();
  const perGroupTotal = db.prepare(
    "SELECT COUNT(*) AS n FROM quotes WHERE image_path <> '' AND group_id = ?",
  );
  const perGroupDone = db.prepare(
    `SELECT COUNT(*) AS n FROM semantic_doc d JOIN quotes q ON q.id = d.quote_id
      WHERE q.image_path <> '' AND d.length > 0 AND d.group_id = ?`,
  );
  const groupRows = group
    ? [{ group_id: group }]
    : db
        .prepare(
          "SELECT group_id AS group_id, COUNT(*) AS n FROM quotes WHERE image_path <> '' GROUP BY group_id ORDER BY n DESC",
        )
        .all();
  const details = [];
  const totals = { total: 0, done: 0, failed: 0, pending: 0, vectorless: 0, stale: 0 };
  for (const row of groupRows) {
    const gid = String(row.group_id ?? '');
    const total = Number(perGroupTotal.get(gid).n);
    const done = Number(perGroupDone.get(gid).n);
    const pending = Math.max(0, total - done);
    details.push({
      group_id: gid,
      signature: SEMANTIC_VERSION,
      total,
      done,
      failed: 0,
      pending,
      vectorless: pending,
      stale: 0,
    });
    totals.total += total;
    totals.done += done;
    totals.pending += pending;
    totals.vectorless += pending;
  }
  return { totals, groups: details };
}

/** Drop the index (optionally for one group). Returns removed document rows. */
export function resetIndex(db, options = {}) {
  const group = String(options.group ?? '').trim();
  const docs = group
    ? db.prepare('SELECT quote_id FROM semantic_doc WHERE group_id = ?').all(group)
    : db.prepare('SELECT quote_id FROM semantic_doc').all();
  const ids = docs.map((row) => Number(row.quote_id)).filter((id) => Number.isFinite(id) && id > 0);
  const delTerm = db.prepare('DELETE FROM semantic_term WHERE quote_id = ?');
  const delDoc = db.prepare('DELETE FROM semantic_doc WHERE quote_id = ?');
  for (const id of ids) {
    delTerm.run(id);
    delDoc.run(id);
  }
  if (group) db.prepare('DELETE FROM semantic_meta WHERE group_id = ?').run(group);
  else db.prepare('DELETE FROM semantic_meta').run();
  return ids.length;
}
