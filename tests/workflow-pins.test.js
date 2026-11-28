const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const workflowDir = path.resolve(__dirname, '../.github/workflows');
const workflows = fs.readdirSync(workflowDir).filter((file) => file.endsWith('.yml'));
let actionReferences = 0;

for (const file of workflows) {
  const lines = fs.readFileSync(path.join(workflowDir, file), 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/);
    if (!match) continue;
    actionReferences++;
    assert.match(
      match[1],
      /@[0-9a-f]{40}$/,
      `${file}:${index + 1} must pin its Action to an immutable commit SHA`,
    );
    assert.ok(
      match[2],
      `${file}:${index + 1} must retain a readable version comment`,
    );
  }
}

assert.ok(actionReferences > 0, 'workflow Action references were not discovered');

const dependabot = fs.readFileSync(
  path.resolve(__dirname, '../.github/dependabot.yml'),
  'utf8',
);
assert.match(dependabot, /package-ecosystem:\s*github-actions/);
assert.match(dependabot, /interval:\s*weekly/);
console.log(`PASS | ${actionReferences} Action references use immutable SHAs and version comments`);
console.log('PASS | Dependabot audits GitHub Actions updates weekly');
