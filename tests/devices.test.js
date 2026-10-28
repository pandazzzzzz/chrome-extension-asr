// audio/devices.js microphone error mapping tests (pure Node, no browser).
//
// getUserMedia permission failures otherwise surface raw browser text such as
// "Permission dismissed", which does not tell the user how to recover.
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'audio/devices.js'), 'utf8');

let pass = 0;
let fail = 0;

function makeSandbox(getUserMedia) {
  const sandbox = {
    navigator: {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: async () => [],
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'audio/devices.js' });
  return sandbox;
}

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS | ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL | ${name} | ${error.message}`);
  }
}

async function run() {
  await test('microphoneErrorMessage: permission denial points to Chrome microphone settings', () => {
    const sandbox = makeSandbox(async () => {
      throw new Error('not called');
    });
    const message = sandbox.microphoneErrorMessage({
      name: 'NotAllowedError',
      message: 'Permission dismissed',
    });
    assert.match(message, /chrome:\/\/settings\/content\/microphone/);
    assert.doesNotMatch(message, /^Permission dismissed$/);
  });

  await test('openMicrophone: permission denial rejects with actionable guidance', async () => {
    const sandbox = makeSandbox(async () => {
      throw Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' });
    });
    await assert.rejects(
      sandbox.openMicrophone(''),
      (error) => {
        assert.match(error.message, /chrome:\/\/settings\/content\/microphone/);
        return true;
      },
    );
  });

  await test('openMicrophone: unrelated failures keep their original message', async () => {
    const sandbox = makeSandbox(async () => {
      throw Object.assign(new Error('No microphone found'), { name: 'NotFoundError' });
    });
    await assert.rejects(
      sandbox.openMicrophone(''),
      (error) => {
        assert.strictEqual(error.message, 'No microphone found');
        return true;
      },
    );
  });

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} (${pass}/${pass + fail})`);
  if (fail > 0) process.exitCode = 1;
}

run();
