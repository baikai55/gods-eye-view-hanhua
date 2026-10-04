const STORAGE_KEY = 'gev.ui.language';
const ENGLISH = 'en';
const SIMPLIFIED_CHINESE = 'zh-CN';
const listeners = new Set();

let currentLanguage;

function normalizeSupportedLanguage(language) {
  if (typeof language !== 'string') return null;
  const normalized = language.trim().toLowerCase();
  if (normalized === 'zh-cn' || normalized.startsWith('zh-'))
    return SIMPLIFIED_CHINESE;
  if (normalized === 'zh') return SIMPLIFIED_CHINESE;
  if (normalized === 'en' || normalized.startsWith('en-')) return ENGLISH;
  return null;
}

function readStoredLanguage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    return normalizeSupportedLanguage(storage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be disabled or throw in privacy modes and sandboxed frames.
    return null;
  }
}

function readBrowserLanguage() {
  try {
    const navigatorRef = globalThis.navigator;
    return normalizeSupportedLanguage(
      navigatorRef?.languages?.[0] || navigatorRef?.language,
    );
  } catch {
    return null;
  }
}

function initialLanguage() {
  return readStoredLanguage() || readBrowserLanguage() || ENGLISH;
}

/** Return the active UI language, preferring the saved choice on first use. */
export function getUiLanguage() {
  if (!currentLanguage) currentLanguage = initialLanguage();
  return currentLanguage;
}

/** Set the active UI language and persist it when browser storage is available. */
export function setUiLanguage(language) {
  const nextLanguage = normalizeSupportedLanguage(language);
  if (!nextLanguage) return getUiLanguage();

  const previousLanguage = getUiLanguage();
  currentLanguage = nextLanguage;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, nextLanguage);
  } catch {
    // Keep the in-memory choice even when localStorage is unavailable.
  }

  if (previousLanguage !== nextLanguage) {
    for (const listener of [...listeners])
      listener(nextLanguage, previousLanguage);
  }
  return nextLanguage;
}

/** Subscribe to language changes. Returns an idempotent unsubscribe function. */
export function subscribeUiLanguage(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
  };
}
