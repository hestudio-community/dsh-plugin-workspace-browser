import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';
import { AutomationError, createAutomation } from '../runner/automation.mjs';

// Execute the actual isolated-realm function against a small DOM fixture. The
// Page stand-in intentionally has no interception, CDP, or tab-activation API.
function fixture(url) {
  const page = new EventEmitter();
  const elements = [];
  const scrolls = [];
  const navigations = [];
  const location = { href: url };
  const rect = { left: 5, top: 5, right: 25, bottom: 25, width: 20, height: 20 };
  let hit = null;
  let realmAccesses = 0;
  let disposals = 0;
  const document = {
    get visibilityState() { return 'hidden'; },
    get baseURI() { return location.href; },
    body: {},
    createTreeWalker(_root, filter) {
      let index = 0;
      return { nextNode: () => filter === 1 ? elements[index++] : null };
    },
    querySelector: () => null,
    elementFromPoint: () => hit,
  };
  class HTMLElement {
    constructor(tagName, attrs = {}) {
      this.tagName = tagName;
      this.attrs = attrs;
      this.ownerDocument = document;
      this.isConnected = true;
      this.box = rect;
      this.clicks = 0;
      elements.push(this);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    closest(selector) { return selector === 'a[href]' && this instanceof HTMLAnchorElement ? this : null; }
    matches() { return false; }
    checkVisibility() { return true; }
    getBoundingClientRect() { return this.box; }
    contains(element) { return element === this; }
    click() { this.clicks++; }
  }
  class HTMLAnchorElement extends HTMLElement {
    constructor(attrs) { super('A', attrs); }
    get href() { return new URL(this.attrs.href, document.baseURI).href; }
    get target() { return this.attrs.target ?? ''; }
  }
  class HTMLButtonElement extends HTMLElement {
    constructor(attrs, form) {
      super('BUTTON', attrs);
      this.type = 'submit';
      this.form = form;
    }
    get formAction() { return new URL(this.attrs.formaction, document.baseURI).href; }
  }
  class HTMLInputElement extends HTMLElement {
    constructor(attrs) {
      super('INPUT', attrs);
      this.type = 'text';
      this.events = [];
    }
    set value(text) { this.filled = text; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const context = vm.createContext({
    URL, Event, document, location, innerWidth: 100, innerHeight: 100, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    HTMLElement, HTMLAnchorElement, HTMLButtonElement, HTMLInputElement,
    HTMLTextAreaElement: class extends HTMLElement {}, HTMLLabelElement: class extends HTMLElement {},
    scrollBy: ({ left, top, behavior }) => scrolls.push([left, top, behavior]),
  });
  const evaluate = (fn, ...args) => vm.runInContext(`(${fn})`, context)(...args.map(arg => arg?.unwrap ? arg.unwrap() : arg));
  const realm = {
    async evaluate(fn, ...args) { return evaluate(fn, ...args); },
    async evaluateHandle(fn, ...args) {
      const value = evaluate(fn, ...args);
      return { unwrap: () => value, async dispose() { disposals++; } };
    },
  };
  const frame = { isolatedRealm() { realmAccesses++; return realm; } };
  function navigateTo(next) {
    location.href = next;
    page.emit('framenavigated', frame);
  }
  Object.assign(page, {
    url: () => location.href,
    mainFrame: () => frame,
    async goto(destination, options) {
      navigations.push({ destination, options });
      navigateTo(page.redirect ?? new URL(destination).href);
    },
  });
  return {
    page, navigations, scrolls, navigateTo,
    anchor: attrs => new HTMLAnchorElement(attrs),
    button: (attrs, form) => new HTMLButtonElement(attrs, form),
    input: attrs => new HTMLInputElement(attrs),
    pointAt(element) { hit = element; },
    replaceDocument() { context.document = { ...document }; },
    get realmAccesses() { return realmAccesses; },
    get disposals() { return disposals; },
  };
}

function automation(fixtures) {
  const run = createAutomation({ defaultBrowserContext: () => ({ pages: async () => fixtures.map(({ page }) => page) }) });
  const signal = new AbortController().signal;
  return (method, fields) => run({ method, ...fields }, signal);
}

const staleDocument = /Document reference is stale/;
const noAction = /Document or element no longer permits that action/;

test('Runner lists different origins and operates on a background webpage without activating it', async () => {
  const foreground = fixture('https://example.com/');
  const background = fixture('http://example.org/');
  const input = background.input({ 'aria-label': 'Search' });
  background.pointAt(input);
  const run = automation([foreground, background]);
  const { tabs } = await run('list');
  assert.deepEqual(tabs.map(({ url }) => url), [foreground.page.url(), background.page.url()]);
  const { tabId, url } = tabs[1];
  const { documentId, elements } = await run('inspect', { tabId });
  assert.equal(elements.length, 1);
  assert.equal(elements[0].role, 'textbox');
  assert.equal(elements[0].label, 'Search');
  assert.deepEqual(await run('fill', { tabId, documentId, elementId: elements[0].id, text: 'example' }), { tabId, url });
  assert.equal(input.filled, 'example');
  assert.deepEqual(input.events, ['input']);
  assert.deepEqual(await run('scroll', { tabId, documentId, deltaX: 0, deltaY: 1200 }), { tabId, url });
  assert.deepEqual(background.scrolls, [[0, 1200, 'instant']]);
  assert.equal(foreground.realmAccesses, 0);
});

test('Runner permits cross-origin links and form destinations on custom ports with new-window targets', async () => {
  const tab = fixture('https://example.com/');
  const anchor = tab.anchor({ href: 'https://[::1]:8443/path', target: '_blank', 'aria-label': 'Link' });
  const submit = tab.button({ formaction: 'http://192.168.31.1:8080/search', formtarget: 'results', 'aria-label': 'Submit' },
    { action: 'https://example.com/', target: '_self' });
  const run = automation([tab]);
  const { tabs: [{ tabId, url }] } = await run('list');
  const { documentId, elements } = await run('inspect', { tabId });
  for (const [index, element] of [anchor, submit].entries()) {
    tab.pointAt(element);
    assert.deepEqual(await run('click', { tabId, documentId, elementId: elements[index].id }), { tabId, url });
    assert.equal(element.clicks, 1);
  }
});

test('Runner rejects declarative download links and unsafe navigation destinations on click', async () => {
  const tab = fixture('https://example.com/');
  const anchors = [
    { href: 'https://example.org/report', download: '' },
    { href: 'javascript:void(0)' },
    { href: 'file:///local' },
    { href: 'https://user@example.org/' },
  ].map(attrs => tab.anchor(attrs));
  const run = automation([tab]);
  const { tabs: [{ tabId }] } = await run('list');
  const { documentId, elements } = await run('inspect', { tabId });
  assert.equal(elements.length, anchors.length);
  for (const [index, anchor] of anchors.entries()) {
    tab.pointAt(anchor);
    await assert.rejects(run('click', { tabId, documentId, elementId: elements[index].id }), noAction);
    assert.equal(anchor.clicks, 0);
  }
});

test('Runner retains stale document, stale element, hit-test and viewport checks', async () => {
  const tab = fixture('https://example.com/');
  const anchor = tab.anchor({ href: 'https://example.org/', 'aria-label': 'Link' });
  const run = automation([tab]);
  const { tabs: [{ tabId, url }] } = await run('list');
  const first = await run('inspect', { tabId });
  const second = await run('inspect', { tabId });
  assert.equal(second.documentId, first.documentId);
  const fields = { tabId, documentId: second.documentId, elementId: second.elements[0].id };
  await assert.rejects(run('click', { ...fields, elementId: first.elements[0].id }), /Element reference is stale/);
  await assert.rejects(run('click', fields), noAction); // Center is occluded.
  tab.pointAt(anchor);
  const box = anchor.box;
  anchor.box = { ...box, left: 101, right: 121 };
  await assert.rejects(run('click', fields), noAction);
  anchor.box = box;
  anchor.attrs.href = 'https://example.net/';
  await assert.rejects(run('click', fields), noAction);
  anchor.attrs.href = 'https://example.org/';
  tab.replaceDocument();
  await assert.rejects(run('click', fields), noAction); // Replaced DOM even if the URL and events haven't changed.
  tab.navigateTo(url); // Same-URL navigation also invalidates the document ID.
  await assert.rejects(run('click', fields), staleDocument);
  assert.equal(anchor.clicks, 0);
  assert.equal(tab.disposals, 2);
});

test('Runner lists start pages but never opens their isolated realms; navigate uses bounded goto and follows redirects', async () => {
  const starts = ['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/'];
  const fixtures = [...starts, 'chrome://settings/', 'chrome-untrusted://new-tab-page/', 'file:///local',
    'https://example.org:65536/', 'https://secret@example.org/'].map(fixture);
  const run = automation(fixtures);
  const { tabs } = await run('list');
  assert.deepEqual(tabs.map(({ url }) => url), starts);
  for (const [index, { tabId }] of tabs.entries()) {
    const tab = fixtures[index];
    await assert.rejects(run('inspect', { tabId }), AutomationError);
    const destination = 'http://example.com:80/from-start';
    tab.page.redirect = 'https://example.org/final';
    assert.deepEqual(await run('navigate', { tabId, url: destination }), { tabId, url: tab.page.redirect });
    assert.deepEqual(tab.navigations, [{ destination, options: { waitUntil: 'domcontentloaded', timeout: 10_000 } }]);
    assert.equal(tab.realmAccesses, 0);
    assert.equal((await run('inspect', { tabId })).url, tab.page.redirect);
  }
  const { tabId } = tabs[0];
  const old = await run('inspect', { tabId });
  assert.deepEqual(await run('navigate', { tabId, url: 'https://example.net/next' }), { tabId, url: old.url });
  await assert.rejects(run('scroll', { tabId, documentId: old.documentId, deltaX: 0, deltaY: 1 }), staleDocument);
  const { realmAccesses } = fixtures[0];
  fixtures[0].page.redirect = 'chrome://settings/';
  await assert.rejects(run('navigate', { tabId, url: 'https://example.net/next' }), /^Error: Tab is no longer on a supported webpage$/);
  await assert.rejects(run('navigate', { tabId, url: 'https://example.net/next' }), AutomationError);
  assert.equal(fixtures[0].realmAccesses, realmAccesses);
});

test('Runner wire validation requires flat requests and HTTP(S) destinations without credentials', async () => {
  const tab = fixture('https://example.com/');
  const run = automation([tab]);
  const { tabs: [{ tabId }] } = await run('list');
  const url = 'https://example.org:443/';
  await assert.rejects(run('list', { origin: tab.page.url() }), /Invalid automation request/);
  await assert.rejects(run('navigate', { tabId, url, documentId: tabId }), /Invalid automation request/);
  for (const bad of ['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/', 'file:///local', 'data:text/plain,test',
    'https://example.org:65536/', 'https://user:pass@example.org/', 'https://example.org/a b']) {
    await assert.rejects(run('navigate', { tabId, url: bad }), /Invalid automation request/);
  }
  assert.equal(tab.navigations.length, 0);
  assert.deepEqual(await run('navigate', { tabId, url }), { tabId, url: 'https://example.org/' });
});

test('Runner navigates to, lists, and inspects local HTTP(S) pages on custom ports', async () => {
  const tab = fixture('about:blank');
  const run = automation([tab]);
  const { tabs: [{ tabId }] } = await run('list');
  for (const url of ['http://192.168.31.1:8080/', 'http://localhost:3000/', 'https://[::1]:8443/']) {
    assert.deepEqual(await run('navigate', { tabId, url }), { tabId, url });
    assert.deepEqual(await run('list'), { tabs: [{ tabId, url }] });
    const snapshot = await run('inspect', { tabId });
    assert.equal(snapshot.url, url);
    assert.equal(snapshot.tabId, tabId);
    assert.ok(snapshot.documentId);
  }
});

test('Runner can target an observed tab after it falls outside either list output cap', async () => {
  for (const prefix of ['https://example.com/', `https://example.com/${'x'.repeat(2000)}`]) {
    const target = fixture('https://example.org/');
    const fixtures = [target];
    const run = automation(fixtures);
    const { tabs: [{ tabId }] } = await run('list');
    fixtures.unshift(...Array.from({ length: 32 }, (_, i) => fixture(`${prefix}${i}`)));
    const { tabs } = await run('list');
    assert.equal(tabs.length, prefix.length > 1000 ? 11 : 32);
    assert.ok(!tabs.some(tab => tab.tabId === tabId));
    assert.ok(JSON.stringify(tabs).length <= 24_001);
    assert.equal((await run('inspect', { tabId })).url, target.page.url());
    assert.equal((await run('navigate', { tabId, url: 'https://example.net/' })).url, 'https://example.net/');
  }
});
