// Lint commits added by a push.
//
// GitHub squash merges combine every PR commit body into one generated body.
// The aggregate can exceed the 280-character limit even when every source
// commit passed commitlint. For GitHub-generated squash commits, validate the
// subject against the full rules but omit the generated body.
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = require('node:path').resolve(__dirname, '..');
const COMMITLINT_CLI = require.resolve('@commitlint/cli/cli.js');
const SQUASH_SUBJECT = /^[a-z]+: \S.* \(#\d+\)$/;
const COMMIT_BULLET = /^\* [a-z]+: \S/;

function normalizeMessage(message) {
  return `${String(message).replace(/\r\n/g, '\n').trimEnd()}\n`;
}

function isGitHubSquash(committerName, message) {
  if (committerName !== 'GitHub') return false;
  const lines = normalizeMessage(message).trimEnd().split('\n');
  if (!SQUASH_SUBJECT.test(lines[0] || '')) return false;
  return lines.slice(1).some((line) => COMMIT_BULLET.test(line));
}

function messageForLint(committerName, message) {
  const normalized = normalizeMessage(message);
  if (!isGitHubSquash(committerName, normalized)) return normalized;
  return `${normalized.split('\n')[0]}\n`;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function lintMessage(message) {
  return spawnSync(process.execPath, [COMMITLINT_CLI, '--verbose'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: message,
  });
}

function main() {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: node scripts/lint-push.js <from-sha> <to-sha>');
    process.exitCode = 2;
    return;
  }

  const commits = git(['rev-list', '--reverse', `${from}..${to}`])
    .split(/\r?\n/)
    .filter(Boolean);
  if (commits.length === 0) {
    console.log('No commits to lint.');
    return;
  }

  let failed = 0;
  for (const sha of commits) {
    const committer = git(['show', '-s', '--format=%cn', sha]).trim();
    const message = git(['show', '-s', '--format=%B', sha]);
    const generatedSquash = isGitHubSquash(committer, message);
    const result = lintMessage(messageForLint(committer, message));

    if (generatedSquash) {
      console.log(`GitHub squash body limits exempt for ${sha.slice(0, 7)}.`);
    }
    if (result.error) console.error(result.error.message);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) failed += 1;
  }

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { isGitHubSquash, messageForLint, normalizeMessage };
