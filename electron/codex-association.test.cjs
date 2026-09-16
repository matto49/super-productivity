const test = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
const {
  getCodexAssociation,
  getCodexThreadLink,
} = require('./shared-with-frontend/codex-thread-link.ts');
const url = 'codex://threads/01a08530-a5b7-7923-97c4-cc8ab25958f7';
const value = {
  threadUrl: url,
  threadCount: 2,
  status: 'needs_scope',
  checkedAt: '2026-09-11T00:00:00Z',
  since: '2026-09-07T00:00:00Z',
  humanStatus: 'skipped_preserved_ledger',
};
const note = (v) => '<!-- sp-codex-v1:' + JSON.stringify(v) + ' -->';
test('canonical primary overrides older ordinary link', () => {
  const notes =
    '[Old](codex://threads/01a06149-abcb-7262-bb1d-0e01902b7d6c)\n' + note(value);
  assert.equal(getCodexThreadLink(notes), url);
  assert.equal(getCodexAssociation(notes).status, 'needs_scope');
});
test('malformed projection degrades safely and cannot inject navigation', () => {
  for (const v of [
    { ...value, threadUrl: 'javascript:alert(1)' },
    { ...value, checkedAt: 'bad' },
    { ...value, status: 'fake' },
  ]) {
    assert.equal(getCodexAssociation(note(v)), undefined);
    assert.equal(getCodexThreadLink('[Open](' + url + ')\n' + note(v)), url);
  }
});
