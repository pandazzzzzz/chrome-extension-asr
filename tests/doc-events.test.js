// Guard for issue #136: the manual triage docs must not name a diagnostic
// event (or a `reason` value) that no code produces. The same class of drift
// was already fixed once in #75 and came back (#136), so pin it here.
//
// Scope is deliberately narrow: only backticked, hyphenated tokens on lines
// that talk about telemetry are candidates. Model ids and module names also
// show up there (`paraformer-realtime-8k-v2`, `asr-crypto`), so they are
// filtered by shape rather than by an ever-growing exact allowlist.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOC_FILES = [
  'docs/manual-verification.md',
  'tests/manual-test-plan.md',
  'tests/stream-debug.html',
];
const PRODUCER_DIRS = [
  'transcription/providers',
  'offscreen',
  'popup',
  'background',
  'shared',
  'store',
  'audio',
  'messaging',
  'content',
];
const TELEMETRY_CONTEXT = /诊断|遥测|事件|evt|track\(/i;
// `asr-crypto` is the shared crypto module, not an event.
const NON_EVENT_TOKENS = new Set(['asr-crypto']);
const MODEL_ID_SHAPE = /^(?:qwen|fun-asr|paraformer|cosyvoice)/i;

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

function producers() {
  const found = new Set();
  for (const dir of PRODUCER_DIRS) {
    for (const file of fs.readdirSync(path.join(ROOT, dir))) {
      if (!file.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
      for (const match of source.matchAll(/(?:debugEvt|track)\(\s*'([a-z0-9-]+)'/g)) {
        found.add(match[1]);
      }
      // Event names also appear through ternaries, e.g.
      // debugEvt(reason === 'remote' ? 'stream-pagehide-like-end' : 'stream-finalized', ...).
      for (const line of source.split('\n')) {
        if (!/(?:debugEvt|track)\(/.test(line)) continue;
        for (const match of line.matchAll(/'([a-z0-9-]+)'/g)) found.add(match[1]);
      }
      // `reason` values are documented next to the event that carries them.
      for (const match of source.matchAll(/reason:\s*'([a-z0-9-]+)'/g)) {
        found.add(match[1]);
      }
    }
  }
  return found;
}

function documentedCandidates() {
  const backtick = String.fromCharCode(96);
  const span = new RegExp(`${backtick}([a-z][a-z0-9]*(?:-[a-z0-9]+)+)${backtick}`, 'g');
  const candidates = new Map();
  for (const file of DOC_FILES) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    // Triage rows carry their context in the header, not on the row itself
    // (`| 连不上 | ws-open -> ws-error | ...`), so remember when we are inside
    // a table whose header is about diagnostic events.
    let inTriageTable = false;
    lines.forEach((line, index) => {
      if (/^\|\s*现象\s*\|\s*关键事件/.test(line)) {
        inTriageTable = true;
        return;
      }
      if (inTriageTable && !line.startsWith('|')) inTriageTable = false;
      if (!TELEMETRY_CONTEXT.test(line) && !inTriageTable) return;
      for (const match of line.matchAll(span)) {
        const name = match[1];
        if (MODEL_ID_SHAPE.test(name) || NON_EVENT_TOKENS.has(name)) continue;
        if (!candidates.has(name)) candidates.set(name, []);
        candidates.get(name).push(`${file}:${index + 1}`);
      }
    });
  }
  return candidates;
}

const produced = producers();

test('producer scan finds the diagnostic events', () => {
  if (!produced.has('ws-open')) throw new Error('ws-open missing from producer scan');
  if (!produced.has('run-task-sent')) throw new Error('run-task-sent missing from producer scan');
  if (!produced.has('no-endpoint')) throw new Error('reason values missing from producer scan');
  if (produced.size < 20) throw new Error(`producer scan only found ${produced.size} names`);
});

test('every event named in the triage docs has a producer', () => {
  const missing = [];
  for (const [name, where] of documentedCandidates()) {
    if (!produced.has(name)) missing.push(`${name} (${where.join(', ')})`);
  }
  if (missing.length) {
    throw new Error(`documented but never produced:\n  ${missing.join('\n  ')}`);
  }
});

test('retired event and field names stay out of the docs', () => {
  const retired = ['ws-connecting', 'targetSampleRate'];
  const hits = [];
  for (const file of DOC_FILES) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const name of retired) {
        if (line.includes(name)) hits.push(`${name} at ${file}:${index + 1}`);
      }
    });
  }
  if (hits.length) throw new Error(hits.join('\n  '));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
