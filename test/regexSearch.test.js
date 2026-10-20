const test = require('node:test');
const assert = require('node:assert/strict');
const { searchRegexDocuments } = require('../src/utils/regexSearch');

test('regex search returns matching paths, line numbers, and respects the result limit', async () => {
  const results = await searchRegexDocuments([
    { path: 'one.md', text: 'first\nNeedle here\nlast' },
    { path: 'two.md', text: 'needle again\nnone' },
  ], { query: 'needle', limit: 1 });

  assert.deepEqual(results, [{ path: 'one.md', lineNumber: 2, snippet: 'Needle here' }]);
});

test('regex search reports invalid expressions', async () => {
  await assert.rejects(
    searchRegexDocuments([{ path: 'note.md', text: 'content' }], { query: '(' }),
    /Invalid regular expression/,
  );
});

test('regex search stops pathological matching after the configured timeout', async () => {
  await assert.rejects(
    searchRegexDocuments([{ path: 'large.md', text: `${'a'.repeat(100_000)}!` }], {
      query: '^(a|aa)*b$',
      timeoutMs: 100,
    }),
    /time limit/,
  );
});

test('regex search rejects excessively long lines', async () => {
  await assert.rejects(
    searchRegexDocuments([{ path: 'large.md', text: 'x'.repeat(1024 * 1024 + 1) }], { query: 'x' }),
    /exceeds the regex search line limit/,
  );
});
