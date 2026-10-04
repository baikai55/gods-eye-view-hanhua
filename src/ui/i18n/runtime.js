import {
  UI_ATTRIBUTE_SOURCE_ALIASES,
  UI_TRANSLATIONS,
  UI_TRANSLATION_ROOTS,
} from './catalog.js';
import {
  getUiLanguage,
  setUiLanguage,
  subscribeUiLanguage,
} from './language.js';

const LANGUAGE_CHANGE_EVENT = 'gev:language-change';
const TRANSLATABLE_ATTRIBUTES = ['title', 'aria-label', 'placeholder'];
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const SKIPPED_CLASSES = new Set([
  'material-symbols-outlined',
  'material-symbols-rounded',
  'material-symbols-sharp',
]);

function isTextNode(node) {
  return node?.nodeType === 3;
}

function isElementNode(node) {
  return node?.nodeType === 1;
}

function hasSkippedClass(element) {
  if (element.classList?.contains) {
    for (const className of SKIPPED_CLASSES) {
      if (element.classList.contains(className)) return true;
    }
    return false;
  }
  return String(element.className || '')
    .split(/\s+/)
    .some((className) => SKIPPED_CLASSES.has(className));
}

function isSkippedElement(element) {
  return (
    SKIPPED_TAGS.has(element.tagName) ||
    hasSkippedClass(element) ||
    element.getAttribute?.('aria-hidden') === 'true' ||
    element.hasAttribute?.('data-gev-language-control')
  );
}

function isInsideSkippedElement(element) {
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (isSkippedElement(ancestor)) return true;
  }
  return false;
}

function splitSurroundingWhitespace(value) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(value);
  return match ? [match[1], match[2], match[3]] : ['', value, ''];
}

function resolveTranslation(source, language, translations) {
  if (language !== 'zh-CN' || !Object.hasOwn(translations, source))
    return source;
  return translations[source] ?? source;
}

function canonicalAttributeSource(value) {
  return Object.hasOwn(UI_ATTRIBUTE_SOURCE_ALIASES, value)
    ? UI_ATTRIBUTE_SOURCE_ALIASES[value]
    : value;
}

function translationRoots(documentRef, selectors) {
  const found = [];
  for (const selector of selectors) {
    try {
      for (const element of documentRef.querySelectorAll(selector)) {
        if (element && !found.includes(element)) found.push(element);
      }
    } catch {
      // Ignore a malformed selector so an optional translation root cannot
      // prevent the rest of the interface from starting.
    }
  }
  return found.filter(
    (element) =>
      !found.some(
        (candidate) => candidate !== element && candidate.contains?.(element),
      ),
  );
}

function makeLanguageSwitcher(documentRef, onChoose, onDispose) {
  const container = documentRef.createElement('div');
  container.className = 'gev-language-switcher';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Interface language');
  container.setAttribute('data-gev-language-control', '');

  const buttons = new Map();
  const buttonDefinitions = [
    { language: 'en', label: 'EN' },
    { language: 'zh-CN', label: '简中' },
  ];

  for (const definition of buttonDefinitions) {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = 'gev-language-switcher__button';
    button.textContent = definition.label;
    const handleClick = () => onChoose(definition.language);
    button.addEventListener('click', handleClick);
    button.setAttribute('data-language', definition.language);
    buttons.set(definition.language, { button, handleClick });
    container.append(button);
  }

  onDispose(() => {
    for (const { button, handleClick } of buttons.values()) {
      button.removeEventListener('click', handleClick);
    }
  });

  return { container, buttons };
}

/**
 * Install the language control and constrained DOM translation layer.
 * The returned cleanup function also exposes `refresh()` to discover roots
 * that were mounted after installation without observing the whole document.
 */
export function installLanguageSwitcher({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  translations = UI_TRANSLATIONS,
  roots = UI_TRANSLATION_ROOTS,
} = {}) {
  if (!documentRef?.createElement || !documentRef?.documentElement)
    return () => {};

  const language = getUiLanguage;
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  const rootElements = [];
  const observers = new Map();
  const disposers = [];
  const queuedNodes = new Set();
  let disposed = false;
  let flushScheduled = false;
  let frameHandle = null;
  const MutationObserverConstructor =
    windowRef?.MutationObserver || globalThis.MutationObserver;

  function setTextLanguage(node, activeLanguage) {
    const currentValue = node.data;
    let source = textSources.get(node);
    if (!source) {
      source = { original: currentValue, lastApplied: currentValue };
      textSources.set(node, source);
    } else if (currentValue !== source.lastApplied) {
      // A control rewrote this text while translated. Treat the new value as
      // its source so later language changes restore the latest live wording.
      source.original = currentValue;
    }

    const [originalLeading, originalText, originalTrailing] =
      splitSurroundingWhitespace(source.original);
    const translatedContent = resolveTranslation(
      originalText,
      activeLanguage,
      translations,
    );
    const nextValue = `${originalLeading}${translatedContent}${originalTrailing}`;

    if (node.data !== nextValue) node.data = nextValue;
    source.lastApplied = nextValue;
  }

  function setAttributeLanguage(element, attribute, activeLanguage) {
    const currentValue = element.getAttribute(attribute);
    if (currentValue == null) return;

    let sources = attributeSources.get(element);
    if (!sources) {
      sources = new Map();
      attributeSources.set(element, sources);
    }
    let source = sources.get(attribute);
    if (!source) {
      source = {
        original: canonicalAttributeSource(currentValue),
        lastApplied: currentValue,
      };
      sources.set(attribute, source);
    } else if (currentValue !== source.lastApplied) {
      source.original = canonicalAttributeSource(currentValue);
    }

    const nextValue = resolveTranslation(
      source.original,
      activeLanguage,
      translations,
    );
    if (currentValue !== nextValue) element.setAttribute(attribute, nextValue);
    source.lastApplied = nextValue;
  }

  function translateNode(node, activeLanguage) {
    if (isTextNode(node)) {
      const parent = node.parentElement;
      if (parent && !isInsideSkippedElement(parent))
        setTextLanguage(node, activeLanguage);
      return;
    }
    if (!isElementNode(node) || isSkippedElement(node)) return;

    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      setAttributeLanguage(node, attribute, activeLanguage);
    }
    for (const child of [...(node.childNodes || [])]) {
      translateNode(child, activeLanguage);
    }
  }

  function updateSwitcher(activeLanguage) {
    switcher.container.setAttribute('data-active-language', activeLanguage);
    const chinese = activeLanguage === 'zh-CN';
    switcher.container.setAttribute(
      'aria-label',
      chinese ? '界面语言' : 'Interface language',
    );
    const labels = chinese
      ? {
          en: ['切换到英文', '切换到英文界面'],
          'zh-CN': ['当前语言：简体中文', '切换到简体中文界面'],
        }
      : {
          en: [
            'Display interface in English',
            'Display the interface in English',
          ],
          'zh-CN': [
            'Display interface in Simplified Chinese',
            'Display the interface in Simplified Chinese',
          ],
        };

    for (const [code, { button }] of switcher.buttons) {
      const [ariaLabel, title] = labels[code];
      button.setAttribute('aria-pressed', String(activeLanguage === code));
      button.setAttribute('aria-label', ariaLabel);
      button.setAttribute('title', title);
    }
  }

  function dispatchLanguageChange(activeLanguage) {
    const EventConstructor = windowRef?.CustomEvent || globalThis.CustomEvent;
    if (!windowRef?.dispatchEvent || !EventConstructor) return;
    windowRef.dispatchEvent(
      new EventConstructor(LANGUAGE_CHANGE_EVENT, {
        detail: { language: activeLanguage },
      }),
    );
  }

  const switcher = makeLanguageSwitcher(documentRef, setUiLanguage, (dispose) =>
    disposers.push(dispose),
  );
  documentRef.body?.append(switcher.container);

  function observeRoot(root) {
    if (typeof MutationObserverConstructor !== 'function') return;
    const observer = new MutationObserverConstructor((records) => {
      if (disposed) return;
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes || []) queuedNodes.add(node);
        } else if (
          record.type === 'characterData' ||
          record.type === 'attributes'
        ) {
          queuedNodes.add(record.target);
        }
      }
      if (queuedNodes.size) scheduleFlush();
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });
    observers.set(root, observer);
  }

  function refreshTranslationRoots() {
    const discovered = translationRoots(documentRef, roots);

    for (const currentRoot of [...rootElements]) {
      const stillCovered = discovered.some(
        (candidate) =>
          candidate === currentRoot || candidate.contains?.(currentRoot),
      );
      if (stillCovered) continue;
      observers.get(currentRoot)?.disconnect();
      observers.delete(currentRoot);
      rootElements.splice(rootElements.indexOf(currentRoot), 1);
    }

    for (const candidate of discovered) {
      if (
        rootElements.some(
          (currentRoot) =>
            currentRoot === candidate || currentRoot.contains?.(candidate),
        )
      ) {
        continue;
      }

      for (const currentRoot of [...rootElements]) {
        if (!candidate.contains?.(currentRoot)) continue;
        observers.get(currentRoot)?.disconnect();
        observers.delete(currentRoot);
        rootElements.splice(rootElements.indexOf(currentRoot), 1);
      }

      rootElements.push(candidate);
      observeRoot(candidate);
    }
  }

  function applyLanguage(activeLanguage, announce = false) {
    if (disposed) return;
    refreshTranslationRoots();
    documentRef.documentElement.setAttribute('lang', activeLanguage);
    for (const root of rootElements) translateNode(root, activeLanguage);
    updateSwitcher(activeLanguage);
    if (announce) dispatchLanguageChange(activeLanguage);
  }

  function flushQueuedNodes() {
    flushScheduled = false;
    frameHandle = null;
    if (disposed) return;
    const activeLanguage = language();
    const pending = [...queuedNodes];
    queuedNodes.clear();
    for (const node of pending) {
      if (rootElements.some((root) => root === node || root.contains?.(node))) {
        translateNode(node, activeLanguage);
      }
    }
  }

  function scheduleFlush() {
    if (flushScheduled || disposed) return;
    flushScheduled = true;
    if (typeof windowRef?.requestAnimationFrame === 'function') {
      frameHandle = windowRef.requestAnimationFrame(flushQueuedNodes);
    } else {
      queueMicrotask(flushQueuedNodes);
    }
  }

  applyLanguage(language());
  const unsubscribe = subscribeUiLanguage((activeLanguage) => {
    applyLanguage(activeLanguage, true);
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
    rootElements.length = 0;
    for (const dispose of disposers) dispose();
    if (
      frameHandle != null &&
      typeof windowRef?.cancelAnimationFrame === 'function'
    ) {
      windowRef.cancelAnimationFrame(frameHandle);
    }
    queuedNodes.clear();
    switcher.container.remove();
  };

  dispose.refresh = () => applyLanguage(language());
  return dispose;
}
