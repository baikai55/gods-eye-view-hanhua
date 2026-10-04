import test from 'node:test';
import assert from 'node:assert/strict';
import { getUiLanguage, setUiLanguage } from './language.js';
import { installLanguageSwitcher } from './runtime.js';

const observers = [];

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.append(new FakeText(node));
        continue;
      }
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
      emitMutation({
        type: 'childList',
        target: this,
        addedNodes: [node],
        removedNodes: [],
      });
    }
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) return;
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    emitMutation({
      type: 'childList',
      target: this,
      addedNodes: [],
      removedNodes: [node],
    });
  }

  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains?.(node));
  }

  remove() {
    this.parentNode?.removeChild(this);
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this._data = data;
  }

  get data() {
    return this._data;
  }

  set data(value) {
    const oldValue = this._data;
    this._data = String(value);
    if (oldValue !== this._data) {
      emitMutation({ type: 'characterData', target: this, oldValue });
    }
  }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
  }

  get classList() {
    const classes = this.className.split(/\s+/).filter(Boolean);
    return { contains: (className) => classes.includes(className) };
  }

  get textContent() {
    return this.childNodes
      .map((node) => node.data ?? node.textContent)
      .join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(new FakeText(String(value)));
  }

  setAttribute(name, value) {
    const nextValue = String(value);
    const oldValue = this.attributes.get(name) ?? null;
    this.attributes.set(name, nextValue);
    if (oldValue !== nextValue) {
      emitMutation({ type: 'attributes', target: this, attributeName: name });
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  click() {
    for (const listener of this.listeners.get('click') || [])
      listener({ target: this });
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.root = null;
    this.options = null;
    this.disconnected = false;
    observers.push(this);
  }

  observe(root, options) {
    this.root = root;
    this.options = options;
    this.disconnected = false;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

function emitMutation(record) {
  for (const observer of observers) {
    if (observer.disconnected || !observer.root) continue;
    if (observer.root.contains(record.target)) observer.callback([record]);
  }
}

function createFakeDocument() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  documentElement.append(body);
  const root = new FakeElement('section');
  root.className = 'ui-root';
  const translatedText = new FakeElement('span');
  translatedText.append(new FakeText('Settings'));
  const icon = new FakeElement('span');
  icon.className = 'material-symbols-outlined';
  icon.append(new FakeText('Search'));
  const inheritedText = new FakeElement('span');
  inheritedText.append(new FakeText('toString'));
  const inheritedAttribute = new FakeElement('button');
  inheritedAttribute.setAttribute('title', 'constructor');
  inheritedAttribute.append(new FakeText('Unmapped action'));
  root.append(translatedText, icon, inheritedText, inheritedAttribute);
  body.append(root);

  const cesium = new FakeElement('div');
  cesium.className = 'cesium-viewer';
  const unrelatedText = new FakeElement('span');
  unrelatedText.append(new FakeText('Settings'));
  cesium.append(unrelatedText);
  body.append(cesium);

  return {
    body,
    documentElement,
    root,
    translatedText,
    icon,
    cesium,
    unrelatedText,
    createElement: (tagName) => new FakeElement(tagName),
    querySelectorAll: (selector) => {
      if (!selector.startsWith('.')) return [];
      const className = selector.slice(1);
      const matchingElements = [];
      const visit = (node) => {
        if (node.nodeType !== 1) return;
        if (node.classList.contains(className)) matchingElements.push(node);
        for (const child of node.childNodes) visit(child);
      };
      for (const child of body.childNodes) visit(child);
      return matchingElements;
    },
  };
}

async function finishMutationBatch() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('switcher restores known copy, translates dynamic UI additions, and ignores Cesium', async () => {
  observers.length = 0;
  setUiLanguage('en');
  const documentRef = createFakeDocument();
  const dispatchedEvents = [];
  const windowRef = {
    CustomEvent: FakeCustomEvent,
    dispatchEvent: (event) => dispatchedEvents.push(event),
    MutationObserver: FakeMutationObserver,
  };
  const dispose = installLanguageSwitcher({
    documentRef,
    windowRef,
    roots: ['.ui-root'],
    translations: {
      Settings: '设置',
      Search: '搜索',
      Connect: '连接',
      'Search by name': '按名称搜索',
      'Unmapped action': '未映射操作',
    },
  });

  assert.equal(documentRef.documentElement.getAttribute('lang'), 'en');
  assert.equal(documentRef.translatedText.textContent, 'Settings');
  assert.equal(documentRef.unrelatedText.textContent, 'Settings');
  assert.deepEqual(
    observers.map((observer) => observer.root),
    [documentRef.root],
    'only catalog-selected UI roots receive observers',
  );
  assert.equal(observers[0].options.subtree, true);
  assert.equal(
    documentRef.body.childNodes.at(-1).className,
    'gev-language-switcher',
  );

  const switcher = documentRef.body.childNodes.at(-1);
  const chineseButton = switcher.childNodes.find(
    (button) => button.getAttribute('data-language') === 'zh-CN',
  );
  chineseButton.click();
  assert.equal(getUiLanguage(), 'zh-CN');
  assert.equal(documentRef.documentElement.getAttribute('lang'), 'zh-CN');
  assert.equal(documentRef.translatedText.textContent, '设置');
  assert.equal(
    documentRef.icon.textContent,
    'Search',
    'icon ligatures stay untouched',
  );
  assert.equal(documentRef.root.childNodes[2].textContent, 'toString');
  assert.equal(
    documentRef.root.childNodes[3].getAttribute('title'),
    'constructor',
    'inherited object properties are not treated as translations',
  );
  assert.equal(documentRef.unrelatedText.textContent, 'Settings');
  assert.deepEqual(dispatchedEvents.at(-1).detail, { language: 'zh-CN' });

  const dynamicLabel = new FakeElement('button');
  dynamicLabel.setAttribute('aria-label', 'Search by name');
  dynamicLabel.append(new FakeText(' Search '));
  documentRef.root.append(dynamicLabel);
  const unknownLabel = new FakeElement('span');
  unknownLabel.append(new FakeText('Unmapped live label'));
  documentRef.root.append(unknownLabel);
  await finishMutationBatch();
  assert.equal(dynamicLabel.textContent, ' 搜索 ');
  assert.equal(dynamicLabel.getAttribute('aria-label'), '按名称搜索');
  assert.equal(unknownLabel.textContent, 'Unmapped live label');

  documentRef.translatedText.childNodes[0].data = 'Connect';
  await finishMutationBatch();
  assert.equal(documentRef.translatedText.textContent, '连接');
  switcher.childNodes
    .find((button) => button.getAttribute('data-language') === 'en')
    .click();
  assert.equal(documentRef.translatedText.textContent, 'Connect');
  assert.equal(dynamicLabel.textContent, ' Search ');
  assert.equal(dynamicLabel.getAttribute('aria-label'), 'Search by name');
  assert.equal(documentRef.documentElement.getAttribute('lang'), 'en');
  dispose();
});

test('roots mounted after startup are discovered on the next language change', async () => {
  observers.length = 0;
  setUiLanguage('zh-CN');
  const documentRef = createFakeDocument();
  const dispose = installLanguageSwitcher({
    documentRef,
    windowRef: { MutationObserver: FakeMutationObserver },
    roots: ['.ui-root', '.hud-summary-label'],
    translations: {
      'SITUATION SUMMARY': '态势摘要',
      Connect: '连接',
    },
  });

  assert.deepEqual(
    observers.map((observer) => observer.root),
    [documentRef.root],
  );
  assert.equal(typeof dispose.refresh, 'function');
  const hudLabel = new FakeElement('span');
  hudLabel.className = 'hud-summary-label';
  hudLabel.append(new FakeText('SITUATION SUMMARY'));
  documentRef.body.append(hudLabel);
  assert.equal(hudLabel.textContent, 'SITUATION SUMMARY');
  assert.equal(
    observers.some((observer) => observer.root === documentRef.body),
    false,
  );

  dispose.refresh();
  assert.equal(hudLabel.textContent, '态势摘要');
  assert.equal(
    observers.some((observer) => observer.root === hudLabel),
    true,
    'the newly discovered label gets its own scoped observer',
  );

  hudLabel.childNodes[0].data = 'Connect';
  await finishMutationBatch();
  assert.equal(hudLabel.textContent, '连接');
  setUiLanguage('en');
  assert.equal(hudLabel.textContent, 'Connect');
  dispose();
  assert.equal(
    observers.every((observer) => observer.disconnected),
    true,
  );
});

test('mixed translated panel attributes canonicalize and restore to English', async () => {
  observers.length = 0;
  setUiLanguage('en');
  const documentRef = createFakeDocument();
  const panelToggle = new FakeElement('button');
  panelToggle.setAttribute('title', 'Expand DATA LAYERS');
  panelToggle.setAttribute('aria-label', 'Expand DATA LAYERS');
  panelToggle.setAttribute('data-panel-id', 'data-panel');
  documentRef.root.append(panelToggle);
  const dispose = installLanguageSwitcher({
    documentRef,
    windowRef: { MutationObserver: FakeMutationObserver },
    roots: ['.ui-root'],
  });

  setUiLanguage('zh-CN');
  assert.equal(panelToggle.getAttribute('title'), '展开数据图层');
  assert.equal(panelToggle.getAttribute('aria-label'), '展开数据图层');
  panelToggle.setAttribute('title', 'Expand 数据图层');
  panelToggle.setAttribute('aria-label', 'Expand 数据图层');
  await finishMutationBatch();
  assert.equal(panelToggle.getAttribute('title'), '展开数据图层');
  assert.equal(panelToggle.getAttribute('aria-label'), '展开数据图层');
  setUiLanguage('en');
  assert.equal(panelToggle.getAttribute('title'), 'Expand DATA LAYERS');
  assert.equal(panelToggle.getAttribute('aria-label'), 'Expand DATA LAYERS');
  assert.equal(panelToggle.getAttribute('data-panel-id'), 'data-panel');
  dispose();
});

test('dispose disconnects observers and stops translating later changes', async () => {
  observers.length = 0;
  setUiLanguage('en');
  const documentRef = createFakeDocument();
  const dispose = installLanguageSwitcher({
    documentRef,
    windowRef: { MutationObserver: FakeMutationObserver },
    roots: ['.ui-root'],
    translations: { Settings: '设置' },
  });
  const switcher = documentRef.body.childNodes.at(-1);
  dispose();
  dispose();
  assert.equal(switcher.parentNode, null);
  assert.equal(observers[0].disconnected, true);

  setUiLanguage('zh-CN');
  const added = new FakeElement('span');
  added.append(new FakeText('Settings'));
  documentRef.root.append(added);
  await finishMutationBatch();
  assert.equal(added.textContent, 'Settings');
  assert.equal(documentRef.documentElement.getAttribute('lang'), 'en');
});
