import { randomUUID } from 'node:crypto';

const LIMIT_TABS = 32;
const LIMIT_URL = 2048;
const LIMIT_FILL = 500;
const TIMEOUT_NAVIGATION = 10_000;

export class AutomationError extends Error {}
const requestKeys = new Map([
  ['list', []],
  ['inspect', ['tabId']],
  ['navigate', ['tabId', 'url']],
  ['click', ['tabId', 'documentId', 'elementId']],
  ['fill', ['tabId', 'documentId', 'elementId', 'text']],
  ['scroll', ['tabId', 'documentId', 'deltaX', 'deltaY']],
]);

function webUrl(value) {
  if (typeof value !== 'string' || value.length > LIMIT_URL || /[\\\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.port && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function startingUrl(url) {
  return url === 'about:blank' || url === 'chrome://newtab/' || url === 'chrome://new-tab-page/';
}

function validate(request) {
  const keys = requestKeys.get(request?.method);
  if (!keys || !Object.hasOwn(request, 'method') || Object.keys(request).length !== 1 + keys.length ||
      keys.some(key => !Object.hasOwn(request, key))) return false;
  for (const key of ['tabId', 'documentId', 'elementId']) {
    if (keys.includes(key) && (typeof request[key] !== 'string' || !/^[a-z0-9-]{36}$/.test(request[key]))) return false;
  }
  if (request.method === 'navigate' && !webUrl(request.url)) return false;
  if (request.method === 'fill' && (typeof request.text !== 'string' || request.text.length > LIMIT_FILL || /[\x00-\x1f\x7f\u2028\u2029]/.test(request.text))) return false;
  if (request.method === 'scroll' && [request.deltaX, request.deltaY].some(delta => !Number.isInteger(delta) || Math.abs(delta) > 1200)) return false;
  return true;
}

// Evaluated only in Puppeteer's isolated realm in the top-level frame. No model
// code, selectors, page-installed JavaScript globals, or other frames are used.
function onPage(method, expectedUrl, snapshot, args) {
  if (location.href !== expectedUrl) return null;

  function visible(e) {
    if (!e.isConnected || e.ownerDocument !== document || e.closest('[inert], [hidden], [aria-hidden="true"]') ||
        !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = e.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left < innerWidth && box.top < innerHeight && box.right > 0 && box.bottom > 0;
  }

  function field(e) {
    if (e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement && /^(text|search|tel|email|url)$/.test(e.type)) {
      const metadata = `${e.autocomplete} ${e.name} ${e.id} ${e.getAttribute('aria-label') || ''}`;
      return !e.disabled && !e.readOnly && !/(?:password|passwd|passcode|pwd|secret|token|one-time-code|cc-|cardnumber|cvc|cvv)/i.test(metadata);
    }
    return false;
  }

  function role(e) {
    let kind;
    if (field(e)) kind = 'textbox';
    else if (e instanceof HTMLAnchorElement && e.hasAttribute('href')) kind = 'link';
    else if (e instanceof HTMLButtonElement || e instanceof HTMLInputElement && /^(button|checkbox|radio|reset|submit)$/.test(e.type)) {
      kind = e instanceof HTMLInputElement && /^(checkbox|radio)$/.test(e.type) ? e.type : 'button';
    } else if (e instanceof HTMLElement && !e.isContentEditable && !e.matches('input,textarea,select,iframe,object,embed') && e.getAttribute('role') === 'button') {
      kind = 'button';
    }
    return kind && !e.matches(':disabled,[aria-disabled="true"]') && visible(e) ? kind : null;
  }

  function cleanText(value, max) {
    return value.slice(0, max).toWellFormed().replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function labelOf(e, kind) {
    const aria = cleanText(e.getAttribute('aria-label') || '', 160);
    if (aria) return aria;
    const labeled = e.labels?.length ? visibleText(e.labels[0], 160, 24) : '';
    return labeled || (kind === 'textbox' ? '' : visibleText(e, 160, 24));
  }

  function actionSemantics(e) {
    const anchor = e.closest('a[href]');
    const form = e.form;
    const baseTarget = document.querySelector('base[target]')?.target;
    const fields = [e.tagName, e.type, e.name, e.autocomplete, e.getAttribute('onclick'),
      anchor?.href, anchor?.target, anchor?.getAttribute('download'), baseTarget,
      e.getAttribute('formaction'), e.hasAttribute('formaction') ? e.formAction : undefined,
      e.getAttribute('formtarget'), e.getAttribute('formmethod'),
      form?.action, form?.target, form?.method, form?.enctype];
    // Never read control values or send these internal guards across the wire.
    if (fields.some(value => typeof value === 'string' && value.length > 4096)) return null;
    return JSON.stringify(fields);
  }

  function visibleText(root, limit, maxNodes) {
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let result = '';
    for (let i = 0, node; i < maxNodes && result.length < limit && (node = walker.nextNode()); i++) {
      const parent = node.parentElement;
      if (parent && !parent.isContentEditable && !parent.closest('input,textarea,select,option,script,style,noscript') && visible(parent)) {
        const text = cleanText(node.data, limit - result.length);
        if (text) result += (result ? ' ' : '') + text;
      }
    }
    return result.slice(0, limit);
  }

  if (method === 'snapshot') {
    const doc = document;
    const rows = [];
    const elements = [];
    const semantics = [];
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    for (let i = 0, e; i < 12_000 && rows.length < 48 && (e = walker.nextNode()); i++) {
      const kind = role(e);
      if (kind) {
        const signature = actionSemantics(e);
        if (!signature) continue;
        elements.push(e);
        rows.push({ role: kind, label: labelOf(e, kind) });
        semantics.push(signature);
      }
    }
    return { doc, elements, rows, semantics, text: visibleText(doc.body, 4096, 2500).toWellFormed() };
  }

  if (snapshot?.doc !== document) return null;
  if (method === 'document') return true;
  if (method === 'scroll') {
    scrollBy({ left: args.deltaX, top: args.deltaY, behavior: 'instant' });
    return true;
  }

  function allowedDestination(href) {
    try {
      const url = new URL(href, document.baseURI);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.port && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  const e = snapshot.elements[args.index];
  const expected = snapshot.rows[args.index];
  if (!e || role(e) !== expected?.role || labelOf(e, expected.role) !== expected.label || actionSemantics(e) !== snapshot.semantics[args.index]) return null;
  const box = e.getBoundingClientRect();
  const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
  const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
  if (!e.contains(document.elementFromPoint(x, y))) return null;
  if (method === 'fill' && field(e)) {
    const prototype = e instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, args.text);
    e.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return true;
  }
  if (method === 'click' && !(e instanceof HTMLLabelElement)) {
    const anchor = e.closest('a[href]');
    // Guard declarative destinations only. Scripts, redirects and responses still follow Chromium and the broker's policies.
    if (anchor && (anchor.hasAttribute('download') || !allowedDestination(anchor.href))) return null;
    if (e.form && e.type === 'submit' && !allowedDestination(e.hasAttribute('formaction') ? e.formAction : e.form.action)) return null;
    e.click();
    return true;
  }
  return null;
}

export function createAutomation(browser) {
  const pageState = new WeakMap();
  const documents = new Map();

  function observe(page) {
    const previous = pageState.get(page);
    if (previous) return previous;
    const observed = { tabId: randomUUID(), revision: 0 };
    pageState.set(page, observed);
    const { tabId } = observed;
    const clear = () => {
      const state = documents.get(tabId);
      documents.delete(tabId);
      void state?.snapshot.dispose().catch(() => {});
    };
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        observed.revision++;
        clear();
      }
    });
    page.once('close', clear);
    return observed;
  }

  async function inspect(tab, realm, signal) {
    const previous = documents.get(tab.tabId);
    let sameDocument = false;
    if (previous?.url === tab.url) {
      sameDocument = await realm.evaluate(onPage, 'document', tab.url, previous.snapshot, {}).catch(() => false);
    }
    signal.throwIfAborted();
    const snapshot = await realm.evaluateHandle(onPage, 'snapshot', tab.url, null, {});
    try {
      const observed = await realm.evaluate(value => value && ({ text: value.text, rows: value.rows }), snapshot);
      if (!observed || tab.page.url() !== tab.url || pageState.get(tab.page)?.revision !== tab.revision) return null;
      signal.throwIfAborted();
      const documentId = sameDocument ? previous.documentId : randomUUID();
      const elements = observed.rows.map(row => ({ id: randomUUID(), ...row }));
      if (previous) void previous.snapshot.dispose().catch(() => {});
      documents.delete(tab.tabId);
      if (documents.size >= LIMIT_TABS) {
        const [id, old] = documents.entries().next().value;
        documents.delete(id);
        void old.snapshot.dispose().catch(() => {});
      }
      documents.set(tab.tabId, { documentId, snapshot, elements, url: tab.url });
      return { tabId: tab.tabId, url: tab.url, documentId, text: observed.text, elements };
    } finally {
      if (documents.get(tab.tabId)?.snapshot !== snapshot) await snapshot.dispose().catch(() => {});
    }
  }

  function actionResult(page, tabId, signal) {
    signal.throwIfAborted();
    const url = page.url();
    if (!webUrl(url)) throw new AutomationError('Tab is no longer on a supported webpage');
    return { tabId, url };
  }

  return async (request, signal) => {
    if (!validate(request)) throw new AutomationError('Invalid automation request');
    signal.throwIfAborted();
    const pages = await browser.defaultBrowserContext().pages();
    signal.throwIfAborted();
    if (request.method === 'list') {
      const listed = [];
      let budget = 24_000;
      for (const page of pages) {
        const url = page.url();
        if (!webUrl(url) && !startingUrl(url)) continue;
        const { tabId } = observe(page);
        budget -= JSON.stringify({ tabId, url }).length + 1;
        if (budget < 0) break;
        listed.push({ tabId, url });
        if (listed.length === LIMIT_TABS) break;
      }
      return { tabs: listed };
    }
    const { method, tabId } = request;
    const page = pages.find(candidate => pageState.get(candidate)?.tabId === tabId);
    if (!page) throw new AutomationError('Tab is unavailable');
    const url = page.url();
    if (!webUrl(url) && !(method === 'navigate' && startingUrl(url))) {
      throw new AutomationError('Tab is not on a supported webpage');
    }
    if (method === 'navigate') {
      await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVIGATION });
      return actionResult(page, tabId, signal);
    }
    const revision = pageState.get(page).revision;
    const realm = page.mainFrame().isolatedRealm();
    if (method === 'inspect') {
      const result = await inspect({ page, tabId, revision, url }, realm, signal);
      if (!result) throw new AutomationError('Tab changed during inspection');
      return result;
    }
    const state = documents.get(tabId);
    if (!state || state.documentId !== request.documentId || state.url !== url) throw new AutomationError('Document reference is stale');
    const args = { ...request };
    if (request.elementId) {
      args.index = state.elements.findIndex(({ id }) => id === request.elementId);
      if (args.index < 0) throw new AutomationError('Element reference is stale');
    }
    signal.throwIfAborted();
    const acted = await realm.evaluate(onPage, method, url, state.snapshot, args);
    signal.throwIfAborted();
    if (!acted) throw new AutomationError('Document or element no longer permits that action');
    return actionResult(page, tabId, signal);
  };
}
