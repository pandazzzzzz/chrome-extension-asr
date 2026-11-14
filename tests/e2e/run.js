'use strict';

const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const { installMockWebSocket } = require('./mock-websocket');

const PORT = Number(process.env.E2E_PORT || 18923);
const MOCK_FINAL = 'mock final transcript';
const MOCK_8K_FINAL = 'mock 8k final transcript';

async function configurePopup(popup, { apiKey, model, endpoint = '' }) {
  await popup.evaluate(({ key, modelName, endpointUrl }) => {
    document.getElementById('apiKey').value = key;
    const region = document.getElementById('region');
    if (endpointUrl) {
      region.value = 'custom';
      region.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('endpoint').value = endpointUrl;
    } else {
      region.value = 'cn-beijing';
      region.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const select = document.getElementById('model');
    const preset = [...select.options].some((option) => option.value === modelName);
    select.value = preset ? modelName : '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    if (!preset) {
      const custom = document.getElementById('modelCustom');
      custom.value = modelName;
      custom.dispatchEvent(new Event('input', { bubbles: true }));
      custom.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { key: apiKey, modelName: model, endpointUrl: endpoint });
  await H.sleep(200);
}

async function enableSubtitles(popup) {
  const enabled = await popup.evaluate(() => {
    const button = document.getElementById('subtitleBtn');
    if (button.textContent.trim() !== 'Subtitles on') button.click();
    return new Promise((resolve) => setTimeout(() => {
      resolve(button.textContent.trim() === 'Subtitles on');
    }, 400));
  });
  H.check('Subtitles toggled on', enabled);
}

async function createOffscreen(popup) {
  const result = await popup.evaluate(async () => {
    const url = chrome.runtime.getURL('offscreen/offscreen.html');
    try {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [url],
      });
      if (existing.length === 0) {
        await chrome.offscreen.createDocument({
          url: 'offscreen/offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: 'Extension E2E test',
        });
      }
      return { ok: true, created: existing.length === 0 };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });
  if (!result.ok) throw new Error(`cannot create offscreen document: ${result.error}`);
}

async function injectMock(browser, options) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.url().includes('/offscreen/offscreen.html'),
    { timeout: 10000 },
  );
  const page = await target.asPage();
  await page.waitForFunction(() => typeof globalThis.WebSocket === 'function'
    && typeof globalThis.PROVIDERS !== 'undefined', { timeout: 10000 });
  await page.evaluate(installMockWebSocket, options);
  return page;
}

async function waitForOffscreenClosed(browser) {
  await H.waitFor(
    () => browser.targets().every((target) => !target.url().includes('/offscreen/offscreen.html')),
    { timeout: 10000, label: 'offscreen document cleanup' },
  );
}

async function runMockStreamSuite({ browser, extension, extensionId, targetPage, model, finalText, sampleRate }) {
  const popup = await H.openPopup(browser, extensionId);
  try {
    await configurePopup(popup, { apiKey: 'sk-e2e-mock', model });
    await enableSubtitles(popup);
    await createOffscreen(popup);
    const offscreen = await injectMock(browser, {
      partialText: 'mock partial',
      finalText,
    });

    await targetPage.bringToFront();
    await popup.evaluate(() => document.getElementById('streamBtn').click());
    await H.pollPage(
      popup,
      () => document.getElementById('streamBtn').textContent === 'Stop Stream'
        || /^(Cannot start streaming|Stream error|Timed out)/.test(document.getElementById('status').textContent),
      15000,
      'stream start',
    );
    const started = await popup.evaluate(() => ({
      button: document.getElementById('streamBtn').textContent,
      status: document.getElementById('status').textContent,
    }));
    H.check(
      `Live Stream starts with ${model}`,
      started.button === 'Stop Stream' && started.status.startsWith('Streaming:'),
      JSON.stringify(started),
    );

    await H.waitFor(
      () => offscreen.evaluate(() => {
        const state = globalThis.__asrE2EMock;
        return state && state.runTasks.length === 1 && state.finalSent && state.audioFrames > 0;
      }),
      { timeout: 12000, label: 'mock WebSocket traffic' },
    );
    const mock = await offscreen.evaluate(() => globalThis.__asrE2EMock);
    H.check('run-task reaches the offscreen WebSocket', mock.runTasks.length === 1);
    H.check(
      `declared sample rate and offscreen AudioContext are both ${sampleRate}`,
      mock.runTasks[0]?.parameters?.sample_rate === sampleRate && mock.contexts[0] === sampleRate,
      JSON.stringify({
        declared: mock.runTasks[0]?.parameters?.sample_rate,
        context: mock.contexts[0],
      }),
    );
    H.check('PCM frames are sent over the stream', mock.audioFrames > 0, `frames=${mock.audioFrames}`);

    await H.waitFor(
      () => popup.evaluate((expected) => (
        document.getElementById('result').value === expected
      ), finalText),
      { timeout: 10000, label: 'final transcript mirror' },
    );
    const result = await popup.evaluate(() => document.getElementById('result').value);
    H.check('final transcript is mirrored into the popup', result === finalText, JSON.stringify({ result }));

    let subtitleText = '';
    const subtitleSeen = await H.waitFor(async () => {
      subtitleText = await H.axText(targetPage);
      return subtitleText.includes(finalText);
    }, { timeout: 10000, label: 'subtitle overlay text' }).then(() => true, () => false);
    H.check('subtitle overlay reaches the active page', subtitleSeen, subtitleSeen ? '' : subtitleText);

    await targetPage.bringToFront();
    await targetPage.evaluate(() => {
      document.querySelector('details').open = true;
      document.getElementById('in1').focus();
    });
    await popup.evaluate(() => document.getElementById('fillBtn').click());
    const fillStatus = await H.pollPage(
      popup,
      () => {
        const status = document.getElementById('status').textContent;
        return status === 'Filled into page input.' || status.startsWith('Fill failed:') ? status : '';
      },
      10000,
      'fill into page',
    );
    const filled = await targetPage.evaluate(() => document.getElementById('in1').value);
    H.check(
      'fill works after the subtitle listener is already present',
      fillStatus === 'Filled into page input.' && filled === finalText,
      JSON.stringify({ fillStatus, filled }),
    );

    await targetPage.bringToFront();
    await popup.evaluate(() => document.getElementById('streamBtn').click());
    await H.pollPage(
      popup,
      () => document.getElementById('streamBtn').textContent === 'Live Stream'
        && document.getElementById('status').textContent === 'Streaming stopped.',
      15000,
      'stream stop',
    );
    await H.sleep(600);
    const ended = await popup.evaluate(async () => ({
      history: await globalThis.HistoryStore.list(),
      result: document.getElementById('result').value,
    }));
    H.check(
      'completed stream is written to history',
      ended.history[0]?.text === finalText && ended.result === finalText,
      JSON.stringify({ result: ended.result, history: ended.history[0] }),
    );
    await waitForOffscreenClosed(browser);
    H.check('offscreen document is reclaimed after stop', true);
    H.check('popup has no page or console errors', popup.__e2eErrors.length === 0, popup.__e2eErrors.join(' | '));
  } finally {
    await popup.close().catch(() => {});
  }
}

async function runRecordTabSuite({ browser, extension, extensionId, targetPage, downloadDir }) {
  let popup;
  let reopened;
  try {
    await targetPage.bringToFront();
    await targetPage.evaluate(async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.15;
      oscillator.frequency.value = 440;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      globalThis.__e2eTabTone = { context, oscillator };
    });

    await targetPage.triggerExtensionAction(extension);
    await H.sleep(400);
    popup = await H.openPopup(browser, extensionId);

    const browserSession = await browser.target().createCDPSession();
    const downloadEvents = [];
    browserSession.on('Browser.downloadWillBegin', (event) => {
      downloadEvents.push({ kind: 'begin', ...event });
    });
    browserSession.on('Browser.downloadProgress', (event) => {
      downloadEvents.push({ kind: 'progress', ...event });
    });
    await browserSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    await targetPage.bringToFront();
    await popup.evaluate(() => document.getElementById('tabRecordBtn').click());
    await H.pollPage(
      popup,
      () => document.getElementById('tabRecordBtn').textContent === 'Stop Tab Rec'
        || document.getElementById('status').textContent.startsWith('Tab record failed:'),
      12000,
      'tab recording start',
    );
    const started = await popup.evaluate(() => ({
      button: document.getElementById('tabRecordBtn').textContent,
      status: document.getElementById('status').textContent,
    }));
    H.check('Record Tab starts', started.button === 'Stop Tab Rec', JSON.stringify(started));
    await H.sleep(1800);

    await popup.close();
    popup = null;
    reopened = await H.openPopup(browser, extensionId);
    const restored = await reopened.evaluate(() => ({
      button: document.getElementById('tabRecordBtn').textContent,
      micDisabled: document.getElementById('recordBtn').disabled,
      streamDisabled: document.getElementById('streamBtn').disabled,
    }));
    H.check(
      'reopened popup restores the active tab recording',
      restored.button === 'Stop Tab Rec' && restored.micDisabled && restored.streamDisabled,
      JSON.stringify(restored),
    );

    await targetPage.bringToFront();
    await reopened.evaluate(() => document.getElementById('tabRecordBtn').click());
    await H.pollPage(
      reopened,
      () => document.getElementById('status').textContent.startsWith('Tab recording complete')
        || document.getElementById('status').textContent.startsWith('Tab record stop failed'),
      20000,
      'tab recording stop',
    );
    const stopped = await reopened.evaluate(() => ({
      button: document.getElementById('tabRecordBtn').textContent,
      saveDisabled: document.getElementById('saveBtn').disabled,
      status: document.getElementById('status').textContent,
    }));
    H.check(
      'Record Tab stops and exposes Save audio',
      stopped.button === 'Record Tab' && !stopped.saveDisabled
        && stopped.status.startsWith('Tab recording complete'),
      JSON.stringify(stopped),
    );

    const beforeFiles = await reopened.evaluate(() => globalThis.RecordingStore.list().then((items) => items.length));
    await reopened.evaluate(() => document.getElementById('saveBtn').click());
    await H.pollPage(
      reopened,
      () => document.getElementById('status').textContent.startsWith('Saved recording'),
      10000,
      'save tab recording',
    );
    const saved = await H.waitFor(() => {
      const names = fs.readdirSync(downloadDir);
      if (names.length > 0 && names.every((name) => !name.endsWith('.crdownload'))) {
        const file = path.join(downloadDir, names[0]);
        return { file: names[0], size: fs.statSync(file).size };
      }
      const begin = downloadEvents.find((event) => event.kind === 'begin');
      const total = downloadEvents
        .filter((event) => event.kind === 'progress')
        .reduce((max, event) => Math.max(max, Number(event.totalBytes) || 0), 0);
      return begin && total > 0 ? { browserAccepted: true, total, filename: begin.suggestedFilename } : null;
    }, {
      timeout: 20000,
      label: `downloaded recording ${JSON.stringify(downloadEvents.slice(-5))}`,
    });
    const afterFiles = await reopened.evaluate(() => globalThis.RecordingStore.list().then((items) => items.length));
    H.check(
      'Save audio hands a non-empty recording to the browser downloader',
      (saved.size || saved.total) > 0,
      JSON.stringify(saved),
    );
    H.check('saved OPFS recording is removed', beforeFiles === 1 && afterFiles === 0,
      JSON.stringify({ beforeFiles, afterFiles }));
    await waitForOffscreenClosed(browser);
    H.check('tab-recording offscreen document is reclaimed', true);
    H.check('record-tab popup has no page or console errors',
      reopened.__e2eErrors.length === 0, reopened.__e2eErrors.join(' | '));
  } finally {
    await popup?.close().catch(() => {});
    await reopened?.close().catch(() => {});
  }
}

async function runRealNetworkSuite({ browser, extensionId, targetPage }) {
  const apiKey = process.env.ASR_TEST_API_KEY;
  if (!apiKey) {
    console.log('  SKIP | real network (ASR_TEST_API_KEY is not set)');
    return;
  }
  const model = process.env.ASR_TEST_MODEL || 'qwen-audio-3.1-asr-flash-streaming';
  const endpoint = process.env.ASR_TEST_ENDPOINT || '';
  const popup = await H.openPopup(browser, extensionId);
  try {
    await configurePopup(popup, { apiKey, model, endpoint });
    await enableSubtitles(popup);
    await targetPage.bringToFront();
    // Pre-create the host document so the real network run does not depend on
    // the offscreen creation path that follows the mock WebSocket suites.
    await createOffscreen(popup);
    await popup.evaluate(() => document.getElementById('streamBtn').click());
    await H.pollPage(
      popup,
      () => document.getElementById('streamBtn').textContent === 'Stop Stream'
        || /^(Cannot start streaming|Stream error|Timed out)/.test(document.getElementById('status').textContent),
      20000,
      'real network start',
    );
    const started = await popup.evaluate(() => ({
      button: document.getElementById('streamBtn').textContent,
      status: document.getElementById('status').textContent,
    }));
    const realStarted = H.check(
      'real provider accepts run-task',
      started.button === 'Stop Stream' && started.status.startsWith('Streaming:'),
      JSON.stringify(started),
    );
    if (!realStarted) return;

    if (process.env.ASR_TEST_SPEECH) {
      await H.waitFor(
        () => popup.evaluate(() => document.getElementById('result').value.trim().length > 0),
        { timeout: 30000, label: 'real transcript' },
      );
      const transcript = await popup.evaluate(() => document.getElementById('result').value);
      H.check('real audio produces transcript text', transcript.trim().length > 0, transcript.slice(0, 120));
      let subtitleText = '';
      const subtitleSeen = await H.waitFor(async () => {
        subtitleText = await H.axText(targetPage);
        return subtitleText.includes(transcript);
      }, { timeout: 10000, label: 'real subtitle overlay' }).then(() => true, () => false);
      H.check('real transcript reaches the subtitle overlay', subtitleSeen, subtitleText.slice(0, 160));

      await targetPage.evaluate(() => {
        document.querySelector('details').open = true;
        document.getElementById('in1').focus();
      });
      await popup.evaluate(() => document.getElementById('fillBtn').click());
      const fillStatus = await H.pollPage(
        popup,
        () => {
          const status = document.getElementById('status').textContent;
          return status === 'Filled into page input.' || status.startsWith('Fill failed:') ? status : '';
        },
        10000,
        'real transcript fill',
      );
      const filled = await targetPage.evaluate(() => document.getElementById('in1').value);
      H.check('real transcript fills the active page input', fillStatus === 'Filled into page input.' && filled === transcript, fillStatus);

      // Reopening the UI must reconcile from the offscreen session, not an
      // empty in-memory mirror, while the real stream is still running.
      const reopened = await H.openPopup(browser, extensionId);
      await H.sleep(400);
      const restored = await reopened.evaluate(() => ({
        button: document.getElementById('streamBtn').textContent,
        text: document.getElementById('result').value,
      }));
      // Real ASR can produce more text while the UI is being reopened. Require
      // the state to be active and non-empty, not a snapshot from seconds ago.
      H.check('reopened popup restores the real stream state', restored.button === 'Stop Stream' && restored.text.length > 0, JSON.stringify(restored));
      await reopened.close();
    }

    await targetPage.bringToFront();
    await popup.evaluate(() => document.getElementById('streamBtn').click());
    await H.pollPage(
      popup,
      () => document.getElementById('streamBtn').textContent === 'Live Stream',
      15000,
      'real network stop',
    );
    const stopped = await popup.evaluate(() => document.getElementById('status').textContent);
    H.check('real provider stops cleanly', stopped === 'Streaming stopped.', stopped);
    await H.sleep(500);
    const saved = await popup.evaluate(async () => ({
      history: await globalThis.HistoryStore.list(),
      result: document.getElementById('result').value,
    }));
    H.check('real stream writes one history entry', saved.history.some((item) => item.text === saved.result), JSON.stringify({ count: saved.history.length }));
    await waitForOffscreenClosed(browser);
    H.check('real stream reclaims the offscreen document', true);
    H.check('real popup has no page or console errors', popup.__e2eErrors.length === 0, popup.__e2eErrors.join(' | '));
  } finally {
    await popup.close().catch(() => {});
  }
}

async function main() {
  const executablePath = await H.findChrome();
  if (!executablePath) {
    throw new Error(
      'no Chrome for Testing binary found; run '
      + '`npx browsers install chrome@stable --path .cache/chrome` or set E2E_CHROME_PATH',
    );
  }
  console.log(`E2E browser: ${executablePath}`);

  const server = await H.startServer(PORT);
  try {
    await withExtensionBrowser(executablePath, { fakeMedia: true }, async ({ browser, extension, extensionId }) => {
      const targetPage = await H.openDiagnosticPage(browser, PORT);
      await targetPage.bringToFront();

      // The telemetry chain (content bridge -> background relay -> panel) is the
      // reason this page exists, and it only works on the manifest-approved
      // origin. Pin both sides: the live path on 18923, and the explicit warning
      // when E2E_PORT moves the page somewhere the bridge cannot inject (#134/#135).
      if (PORT === 18923) {
        // Subscribe first: a popup opened before the panel registers would emit
        // its startup events into the void and the wait below would time out.
        await H.waitFor(
          () => targetPage.evaluate(() => /已订阅/.test(document.getElementById('evtConn').textContent)),
          { label: 'diagnostic bridge subscription', timeout: 10000, interval: 200 },
        );
        await targetPage.triggerExtensionAction(extension);
        await H.waitFor(
          () => targetPage.evaluate(() => [...document.querySelectorAll('#evtLog .logline')]
            .some((line) => line.textContent.includes('{ui}'))),
          { label: 'popup telemetry', timeout: 10000, interval: 200 },
        );
        const conn = await targetPage.evaluate(() => document.getElementById('evtConn').textContent);
        H.check('diagnostic panel subscribes on the approved origin', /已订阅/.test(conn), conn);
        const uiLines = await targetPage.evaluate(() => [...document.querySelectorAll('#evtLog .logline')]
          .map((line) => line.textContent)
          .filter((text) => text.includes('{ui}')));
        H.check('popup telemetry reaches the panel through the bridge', uiLines.length > 0, `${uiLines.length} ui events`);
      } else {
        console.log(`  SKIP | bridge telemetry (E2E_PORT=${PORT}; the bridge only injects on 18923)`);
        // Still needed: the fill/subtitle suites below rely on the activeTab
        // grant that only a real extension action provides.
        await targetPage.triggerExtensionAction(extension);
        await H.waitFor(
          () => targetPage.evaluate(() => /不在扩展注入范围/.test(document.getElementById('evtConn').textContent)),
          { label: 'non-injected origin warning', timeout: 5000, interval: 200 },
        );
        const conn = await targetPage.evaluate(() => document.getElementById('evtConn').textContent);
        H.check('panel flags an origin the bridge is not injected into', /不在扩展注入范围/.test(conn), conn);
      }
      await H.sleep(400);

      await runMockStreamSuite({
        browser,
        extension,
        extensionId,
        targetPage,
        model: 'qwen-audio-3.1-asr-flash-streaming',
        finalText: MOCK_FINAL,
        sampleRate: 16000,
      });
      await runMockStreamSuite({
        browser,
        extension,
        extensionId,
        targetPage,
        model: 'paraformer-realtime-8k-v2',
        finalText: MOCK_8K_FINAL,
        sampleRate: 8000,
      });
      if (PORT === 18923) {
        // Offscreen/provider events are flattened ({ ev, ...fields }), not nested
        // under detail. The panel used to drop those fields, which made the 8 kHz
        // triage step impossible to check (#136 follow-up).
        const lines = await targetPage.evaluate(() => [...document.querySelectorAll('#evtLog .logline')]
          .map((line) => line.textContent));
        const runTask = lines.filter((text) => text.includes('run-task-sent'));
        const pcmStats = lines.filter((text) => text.includes('pcm-stats'));
        H.check(
          'flattened provider fields survive into the panel',
          runTask.some((text) => text.includes('sampleRate')) && pcmStats.some((text) => text.includes('ctxRate')),
          `run-task-sent=${runTask.length} pcm-stats=${pcmStats.length}`,
        );
      }
    });

    // Run the real-network suite in its own browser: after the mock suites have
    // created and closed offscreen documents, Chrome's fake microphone can stop
    // exposing a usable track to createMediaStreamSource().
    if (process.env.ASR_TEST_API_KEY) {
      await withExtensionBrowser(executablePath, { fakeMedia: true }, async ({ browser, extension, extensionId }) => {
        const targetPage = await H.openDiagnosticPage(browser, PORT);
        await targetPage.bringToFront();
        // Give the real suite the same activeTab grant as the mock suites;
        // subtitle injection and Fill into page require it.
        await targetPage.triggerExtensionAction(extension);
        await H.sleep(400);
        await runRealNetworkSuite({ browser, extensionId, targetPage });
      });
    } else {
      console.log('  SKIP | real network (ASR_TEST_API_KEY is not set)');
    }

    // The download folder belongs to this browser: Chrome keeps it open while it
    // runs, so removal is deferred to the afterClose hook. The outer finally also
    // covers a launch that fails before any browser owns the directory (#132).
    const downloadDir = H.tempDir('chrome-asr-e2e-download-');
    try {
      await withExtensionBrowser(executablePath, { fakeMedia: false }, async ({ browser, extension, extensionId }) => {
        const targetPage = await H.openDiagnosticPage(browser, PORT);
        await targetPage.bringToFront();
        await H.sleep(600);
        await runRecordTabSuite({ browser, extension, extensionId, targetPage, downloadDir });
      }, () => H.removeTempDir(downloadDir));
    } finally {
      await H.removeTempDir(downloadDir);
    }
  } finally {
    server.stop();
  }
}

async function withExtensionBrowser(executablePath, options, fn, afterClose) {
  const launched = await H.launchExtension(executablePath, options);
  try {
    const extension = await H.waitForExtension(launched.browser);
    await fn({ browser: launched.browser, ...extension });
  } finally {
    await launched.browser.close().catch(() => {});
    await H.removeTempDir(launched.userDataDir);
    if (afterClose) await afterClose();
  }
}

main()
  .then(() => {
    const failures = H.failureCount();
    console.log(`\n${failures === 0 ? 'ALL E2E CHECKS PASSED' : `${failures} E2E CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('E2E runner failed:', error?.stack || error?.message || error);
    process.exit(2);
  });
