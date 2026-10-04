import test from 'node:test';
import assert from 'node:assert/strict';

const STORAGE_KEY = 'gev.ui.language';

function replaceGlobal(name, descriptor) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    ...descriptor,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  };
}

test('saved language takes priority and subscribers can unsubscribe', async () => {
  const savedValues = new Map([[STORAGE_KEY, 'zh-CN']]);
  const restoreStorage = replaceGlobal('localStorage', {
    value: {
      getItem: (key) => savedValues.get(key),
      setItem: (key, value) => savedValues.set(key, value),
    },
  });
  const restoreNavigator = replaceGlobal('navigator', {
    value: { language: 'en-US', languages: ['en-US'] },
  });

  try {
    const language = await import('./language.js?stored-language-test');
    assert.equal(language.getUiLanguage(), 'zh-CN');

    const changes = [];
    const unsubscribe = language.subscribeUiLanguage((next, previous) => {
      changes.push([next, previous]);
    });
    assert.equal(language.setUiLanguage('en'), 'en');
    assert.equal(savedValues.get(STORAGE_KEY), 'en');
    assert.equal(language.setUiLanguage('en'), 'en');
    assert.deepEqual(changes, [['en', 'zh-CN']]);
    unsubscribe();
    language.setUiLanguage('zh-CN');
    assert.deepEqual(changes, [['en', 'zh-CN']]);
    assert.equal(
      language.setUiLanguage('fr'),
      'zh-CN',
      'unsupported choices are ignored',
    );
  } finally {
    restoreNavigator();
    restoreStorage();
  }
});

test('browser language is normalized and storage failures keep an in-memory choice', async () => {
  const restoreStorage = replaceGlobal('localStorage', {
    get() {
      throw new Error('storage is blocked');
    },
  });
  const restoreNavigator = replaceGlobal('navigator', {
    value: { language: 'zh-HK', languages: ['zh-HK'] },
  });

  try {
    const language = await import('./language.js?blocked-storage-test');
    assert.equal(language.getUiLanguage(), 'zh-CN');
    assert.equal(language.setUiLanguage('en'), 'en');
    assert.equal(language.getUiLanguage(), 'en');
    assert.equal(language.setUiLanguage('zh-CN'), 'zh-CN');
  } finally {
    restoreNavigator();
    restoreStorage();
  }
});

test('unsupported stored and browser languages fall back to English', async () => {
  const restoreStorage = replaceGlobal('localStorage', {
    value: { getItem: () => 'fr-FR', setItem() {} },
  });
  const restoreNavigator = replaceGlobal('navigator', {
    value: { language: 'fr-FR', languages: ['fr-FR'] },
  });

  try {
    const language = await import('./language.js?unsupported-language-test');
    assert.equal(language.getUiLanguage(), 'en');
  } finally {
    restoreNavigator();
    restoreStorage();
  }
});
