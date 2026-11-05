// shared/format.js is plain globalThis script, so it runs directly under Node.
// Covers endpointForTelemetry: diagnostics need scheme/host and known protocol
// paths, but never userinfo/query/fragment or an unknown custom path (a user can
// paste a key into any part of a custom endpoint URL).
const assert = require('node:assert');

require('../shared/format.js');
const Format = globalThis.Format;

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

test('timestampForFile stays filename-safe', () => {
  const ts = Format.timestampForFile(new Date('2026-10-26T12:34:56.789Z'));
  assert.strictEqual(ts, '2026-10-26T12-34-56');
});

test('endpointForTelemetry keeps an empty endpoint empty', () => {
  assert.strictEqual(Format.endpointForTelemetry(''), '');
  assert.strictEqual(Format.endpointForTelemetry(undefined), '');
  assert.strictEqual(Format.endpointForTelemetry('   '), '');
});

test('endpointForTelemetry keeps scheme/host and known protocol paths', () => {
  assert.strictEqual(
    Format.endpointForTelemetry('wss://ws.example.test/api-ws/v1/inference'),
    'wss://ws.example.test/api-ws/v1/inference',
  );
});

test('endpointForTelemetry drops query, fragment, userinfo and unknown paths', () => {
  assert.strictEqual(
    Format.endpointForTelemetry('wss://user:pw@ws.example.test/v1?api_key=sk-secret#token'),
    'wss://ws.example.test/<redacted-path>',
  );
  assert.ok(
    !Format.endpointForTelemetry('wss://ws.example.test/v1?api_key=sk-secret').includes('sk-secret'),
  );
  assert.ok(
    !Format.endpointForTelemetry('wss://ws.example.test/secret-path').includes('secret-path'),
  );
});

test('endpointForTelemetry masks credential-shaped hostname labels', () => {
  assert.strictEqual(
    Format.endpointForTelemetry('wss://sk-secret.proxy.example/api-ws/v1/inference'),
    'wss://<redacted>.proxy.example/api-ws/v1/inference',
  );
  assert.strictEqual(
    Format.endpointForTelemetry('wss://ordinary.proxy.example/api-ws/v1/inference'),
    'wss://ordinary.proxy.example/api-ws/v1/inference',
  );
});

test('endpointForTelemetry flags unparseable input without echoing it', () => {
  assert.strictEqual(Format.endpointForTelemetry('https://'), '<unparseable>');
  assert.strictEqual(Format.endpointForTelemetry('not a url'), '<unparseable>');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
