/**
 * Sanity harness for the dashboard's search engine.
 * Extracts section 2 of dashboard.js (pure functions, no DOM/chrome usage)
 * and exercises every lookup mode.
 *
 * Run:  node tools/search.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const source = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');

const start = source.indexOf('/** Which strings of an entry a query is tested against. */');
const end = source.indexOf('/* -------------------------------------------------- highlight rendering');
assert.ok(start > 0 && end > start, 'could not locate the search-engine section');

const engine = source.slice(start, end);
const compileQuery = new Function(`${engine}; return compileQuery;`)();

const entries = [
  { id: '1', title: 'GitHub Pull Requests', url: 'https://github.com/kiro/vault/pulls', domain: 'github.com' },
  { id: '2', title: 'Stack Overflow - regex lookahead', url: 'https://stackoverflow.com/questions/1234', domain: 'stackoverflow.com' },
  { id: '3', title: 'Gmail Inbox', url: 'https://mail.google.com/mail/u/0/#inbox', domain: 'mail.google.com' },
  { id: '4', title: 'Google Drive', url: 'https://drive.google.com/drive/my-drive', domain: 'drive.google.com' },
  { id: '5', title: 'Quarterly report.pdf', url: 'https://files.example.org/docs/Quarterly%20report.pdf', domain: 'files.example.org' },
  { id: '6', title: 'Login | Example', url: 'https://app.example.org/login?next=/home', domain: 'app.example.org' }
];

const run = (query, mode, opts = {}) => {
  const compiled = compileQuery(query, mode, { field: 'all', ...opts });
  assert.ok(compiled.ok, `compile failed for ${mode} "${query}": ${compiled.error}`);
  return entries.filter((e) => compiled.score(e) > 0).map((e) => e.id);
};

let passed = 0;
const check = (label, actual, expected) => {
  assert.deepEqual(actual, expected, `${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  passed += 1;
  console.log(`  ok  ${label}`);
};

console.log('\nNORMAL (literal substring)');
check('finds a literal path fragment', run('github.com/kiro', 'normal'), ['1']);
check('is case-insensitive by default', run('GITHUB', 'normal'), ['1']);
check('honours case sensitivity', run('GITHUB', 'normal', { caseSensitive: true }), []);
check('does not interpret regex metacharacters', run('.*', 'normal'), []);
check('empty query matches everything', run('', 'normal'), ['1', '2', '3', '4', '5', '6']);

console.log('\nFUZZY (typo tolerant)');
check('subsequence: gthb -> github', run('gthb', 'fuzzy'), ['1']);
check('typo: stckoverflow -> stackoverflow', run('stckoverflow', 'fuzzy'), ['2']);
check('typo: quartrly -> quarterly', run('quartrly', 'fuzzy'), ['5']);
check('multi-word requires every word', run('google drive', 'fuzzy'), ['4']);
check('nonsense matches nothing', run('zzzqqqxxwv', 'fuzzy'), []);
{
  const compiled = compileQuery('github', 'fuzzy', { field: 'all' });
  const exact = compiled.score(entries[0]);
  const typo = compileQuery('githbu', 'fuzzy', { field: 'all' }).score(entries[0]);
  assert.ok(exact > typo && typo > 0, 'exact hits should outrank typo hits');
  passed += 1;
  console.log('  ok  exact hits score higher than typo hits');
}

console.log('\nREGEX');
check('anchored alternation', run('^https://(mail|drive)\\.google\\.com', 'regex'), ['3', '4']);
check('escaped extension match', run('\\.(pdf|zip)($|\\?)', 'regex'), ['5']);
check('negative lookahead', run('^https://(?!.*google)', 'regex'), ['1', '2', '5', '6']);
check('case-sensitive flag is respected', run('GitHub', 'regex', { caseSensitive: true }), ['1']);
{
  const bad = compileQuery('([unclosed', 'regex', { field: 'all' });
  assert.equal(bad.ok, false, 'invalid regex must not compile');
  assert.match(bad.error, /Invalid regex/);
  assert.doesNotThrow(() => bad.score(entries[0]), 'a failed compile must still be safe to call');
  passed += 1;
  console.log('  ok  invalid pattern is reported, not thrown');
}
{
  const tooLong = compileQuery('a'.repeat(501), 'regex', { field: 'all' });
  assert.equal(tooLong.ok, false);
  passed += 1;
  console.log('  ok  over-long pattern is rejected');
}

console.log('\nMIXED (domain + text)');
check('domain: prefix', run('domain:google.com', 'mixed'), ['3', '4']);
check('site: alias plus free text', run('site:google.com drive', 'mixed'), ['4']);
check('bare host token', run('stackoverflow.com', 'mixed'), ['2']);
check('quoted phrase', run('"Pull Requests"', 'mixed'), ['1']);
check('negation excludes', run('domain:google.com -drive', 'mixed'), ['3']);
check('inline regex clause', run('/log(in)?\\?/', 'mixed'), ['6']);
check('clauses are AND-ed', run('domain:example.org login', 'mixed'), ['6']);
check('unmatched combination yields nothing', run('domain:github.com gmail', 'mixed'), []);
{
  const bad = compileQuery('/([bad/', 'mixed', { field: 'all' });
  assert.equal(bad.ok, false, 'invalid inline regex must be reported');
  passed += 1;
  console.log('  ok  invalid inline regex is reported');
}

console.log('\nFIELD SCOPING');
check('title only', run('google', 'normal', { field: 'title' }), ['4']);
check('domain only', run('google', 'normal', { field: 'domain' }), ['3', '4']);
check('url only ignores titles', run('inbox', 'normal', { field: 'url' }), ['3']);

console.log(`\n${passed} assertions passed\n`);
