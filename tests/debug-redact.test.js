// Diagnostic redaction tests - pure Node, no browser dependencies.
//
// The diagnostic page displays and exports telemetry. Credentials must not
// survive either path, including when a user pastes a URL with a query token
// into the endpoint field.
const path = require('node:path');
const assert = require('node:assert');

require(path.join(__dirname, 'debug-redact.js'));
const redact = globalThis.redactDebugText;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + e.message); }
};

t('redact: api_key query parameter', () => {
  const out = redact('wss://host/path?api_key=sk-secret&model=x');
  assert.strictEqual(out, 'wss://host/path?api_key=<redacted>&model=x');
});

t('redact: access_token and generic token query parameters', () => {
  const out = redact('https://host/?access_token=abc&token=def&key=ghi');
  assert.strictEqual(out, 'https://host/?access_token=<redacted>&token=<redacted>&key=<redacted>');
});

t('redact: JSON credential fields (camelCase included)', () => {
  const out = redact('{"apiKey":"sk-a","accessToken":"b","authorization":"Bearer c"}');
  assert.strictEqual(out, '{"apiKey":"<redacted>","accessToken":"<redacted>","authorization":"<redacted>"}');
});

t('redact: bearer token in headers', () => {
  assert.strictEqual(
    redact('Authorization: Bearer abc.def-123'),
    'Authorization: Bearer <redacted>',
  );
});

t('redact: ordinary diagnostic text remains readable', () => {
  assert.strictEqual(redact('model=qwen task-started len=12'), 'model=qwen task-started len=12');
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
