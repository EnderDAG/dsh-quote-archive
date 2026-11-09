// Dependency-free smoke test for the storage layer. Run with any Node >= 22.13:
//   node tests/smoke.mjs
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';

const store = openStore(':memory:');
try {
  const first = store.addQuote({
    group: 'g1',
    speaker: 'alice',
    content: 'hello world',
    messageId: 'm1',
    tag: 'fun, hi',
  });
  assert.equal(first.deduped, false);

  const duplicate = store.addQuote({
    group: 'g1',
    speaker: 'alice',
    content: 'hello world',
    messageId: 'm1',
    tag: 'fun',
  });
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.id, first.id);

  const recalled = store.recallQuote({ group: 'g1' });
  assert.equal(recalled.content, 'hello world');
  assert.deepEqual(recalled.tags, ['fun', 'hi']);

  assert.equal(store.searchQuotes({ query: 'hello' }).length, 1);
  assert.equal(store.searchQuotes({ query: '%' }).length, 0);
  assert.equal(store.listQuotes({ limit: 10 }).length, 1);

  const summary = store.stats();
  assert.equal(summary.totals.quotes, 1);
  assert.equal(summary.totals.groups, 1);
  assert.equal(summary.totals.tags, 2);
  assert.equal(store.listGroups()[0].group, 'g1');

  console.log('smoke OK:', JSON.stringify(summary.totals));
} finally {
  store.close();
}
