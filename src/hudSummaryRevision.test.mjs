import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const hudSource = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
const updateSummaryMethod = hudSource.match(
  /  async _updateSummary\(animate = false, force = false\) \{([\s\S]*?)\n  \}\n\n  _setSummaryText/m,
);
assert.ok(
  updateSummaryMethod,
  'the HUD summary method is available for the race test',
);
const createUpdateSummary = new Function(
  'isHudSummaryUnconfigured',
  'hudSummaryMatchesProvenance',
  `return async function _updateSummary(animate = false, force = false) {${updateSummaryMethod[1]}\n};`,
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installWindowTimers() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  };
}

test('a rejected old summary context cannot replace a newer language summary', async () => {
  const restoreWindow = installWindowTimers();
  try {
    const oldContext = deferred();
    const writtenSummaries = [];
    const hud = {
      _updateSummary: createUpdateSummary(
        () => false,
        () => true,
      ),
      _markSummaryDirty() {
        this._summaryDirty = true;
        this._summaryRevision++;
      },
      _latestMetrics: { ready: true },
      _summaryDirty: true,
      _summaryRequest: null,
      _lastSummarySignature: '',
      _summaryRevision: 1,
      summaryPolicy: {},
      summaryService: {
        summarize: async () => ({
          ok: true,
          status: 200,
          data: { summary: '新语言摘要' },
        }),
      },
      _composeSummary: () => '确定性摘要回退',
      _setSummaryText: (summary) => writtenSummaries.push(summary),
      _summaryContext: () => oldContext.promise,
    };

    const oldUpdate = hud._updateSummary(false, true);
    hud._markSummaryDirty();
    hud._summaryContext = async () => ({ language: 'zh-CN' });
    await hud._updateSummary(false, true);
    assert.deepEqual(writtenSummaries, ['确定性摘要回退', '新语言摘要']);

    oldContext.reject(new Error('old context failed after language change'));
    await oldUpdate;
    assert.deepEqual(
      writtenSummaries,
      ['确定性摘要回退', '新语言摘要'],
      'the stale failure path must not write its fallback over the newer result',
    );
  } finally {
    restoreWindow();
  }
});
