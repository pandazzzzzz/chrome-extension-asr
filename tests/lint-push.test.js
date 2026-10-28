// Push commitlint selection tests for GitHub-generated squash commits.
const assert = require('node:assert');
const { isGitHubSquash, messageForLint } = require('../scripts/lint-push');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS | ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL | ${name} | ${error.message}`);
  }
}

const squash = [
  'fix: harden diagnostics (#97)',
  '',
  '* fix: harden diagnostic telemetry boundary',
  '',
  'Restrict debug bridge injection.',
  '',
  '* docs: update diagnostics guidance',
  '',
  'Document the boundaries.',
].join('\n');

test('detects a GitHub-generated squash commit', () => {
  assert.equal(isGitHubSquash('GitHub', squash), true);
});

test('does not detect a normal commit from GitHub', () => {
  assert.equal(isGitHubSquash('GitHub', 'fix: harden diagnostics\n\nBody'), false);
});

test('does not detect a squash-shaped message from a local author', () => {
  assert.equal(isGitHubSquash('Local User', squash), false);
});

test('requires the generated commit bullet list', () => {
  assert.equal(isGitHubSquash('GitHub', 'fix: harden diagnostics (#97)\n\nBody'), false);
});

test('exempts only the generated body, not the subject', () => {
  assert.equal(messageForLint('GitHub', squash), 'fix: harden diagnostics (#97)\n');
  assert.equal(messageForLint('Local User', squash), `${squash}\n`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
