import en from '../../locale/en.json' with { type: 'json' };
import zh from '../../locale/zh.json' with { type: 'json' };
import { makeOriginSettings } from './origin-settings.js';
import { makeIdleSettings } from './idle-settings.js';
import { makeAgentSettings } from './agent-settings.js';
import { makeBrowserView } from './browser-view.js';
import { makeEnvironmentSettings } from './environment-settings.js';
import { makeNativeMenu } from './native-menu.js';
import { renderSettingsStyles, settings } from './settings-styles.js';
import { panelStyle } from './styles.js';
import { PROJECT_ID } from '../shared/identity.js';

const selectSnapshot = (snapshot) => snapshot;
const dictionary = ({ meta, ...labels }) => ({ ...labels, title: meta.title });

export function makeClient({ React, RFB }) {
  const { createElement: h, useLayoutEffect, useRef } = React;
  const browserMenu = makeNativeMenu(React, `${PROJECT_ID}:browser`);
  // A tab title can mount without its body. Keep it a passive subscriber to
  // that occurrence's existing status polling, never a browser client itself.
  const titles = new WeakMap();
  function titleStore(signal) {
    let store = titles.get(signal);
    if (!store) {
      const listeners = new Set();
      let title;
      store = {
        getSnapshot: () => title,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        set(next) {
          if (next === title) return;
          title = next;
          for (const listener of listeners) listener();
        },
      };
      titles.set(signal, store);
    }
    return store;
  }
  function BrowserTitle({ useTabInfo, t }) {
    const { tab } = useTabInfo();
    const store = titleStore(tab.signal);
    const title = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    return (!tab.signal.aborted && title) || t('title');
  }
  const BrowserView = makeBrowserView(React, RFB, browserMenu);

  function BrowserTab({ sessionId, useTabInfo, useWorkspaces, t, openWebSocket, renderFactorySlot }) {
    const { tab } = useTabInfo();
    const snapshot = useWorkspaces(selectSnapshot);
    const binding = useRef(null);
    const previous = binding.current?.signal === tab.signal && binding.current.sessionId === sessionId
      ? binding.current : null;
    const ready = snapshot.phase === 'ready';
    const matches = ready ? snapshot.items.filter((item) => item.sessionIds.includes(sessionId)) : [];
    const workspaceId = matches.length === 1 ? matches[0].workspaceId : undefined;
    const removed = ready && previous && previous.workspaceId !== workspaceId;
    const closeTab = () => { if (!tab.signal.aborted) tab.actions.close(); };
    // Identity of `set` is stable per occurrence, so the view keeps one connection.
    const setTitle = titleStore(tab.signal).set;

    useLayoutEffect(() => {
      if (tab.signal.aborted) return;
      if (removed) closeTab();
      else if (workspaceId !== undefined && tab.visible) binding.current = { sessionId, workspaceId, signal: tab.signal };
    });

    if (tab.signal.aborted) return null;
    const retainedWorkspace = ready ? workspaceId : previous?.workspaceId;
    const retained = !removed && retainedWorkspace !== undefined;
    return h('section', {
      hidden: !tab.visible, style: tab.visible ? panelStyle : { display: 'none' }, 'aria-label': t('title'),
    }, retained ? h(BrowserView, {
      key: JSON.stringify([sessionId, retainedWorkspace]), sessionId, tabSignal: tab.signal, t, openWebSocket,
      visible: tab.visible && ready, onClosed: closeTab, onTitle: setTitle, renderFactorySlot,
    }) : null,
    !ready || !retained ? h('p', { role: 'status', style: { padding: '0 12px' } },
      t(ready ? 'sessionWorkspaceMissing' : 'loadingWorkspace')) : null);
  }

  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(PROJECT_ID, { en: dictionary(en), zh: dictionary(zh) }), `${PROJECT_ID}: locale`);
    const t = ctx.locale.bind(PROJECT_ID);
    ctx.effect(() => browserMenu.attach(ctx.contextMenus), `${PROJECT_ID}: browser menu`);
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: PROJECT_ID,
      kind: PROJECT_ID,
      keepMounted: true,
      title: () => t('title'),
      guide: [{ id: 'open', order: 31, title: () => t('open') }],
    }), `${PROJECT_ID}: sidebar tab`);
    const openWebSocket = (path) => ctx.connection.openWebSocket(path);
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: PROJECT_ID, locale: PROJECT_ID,
    }, (props) => BrowserTab({ ...props, openWebSocket }))), `${PROJECT_ID}: tab body`);

    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: PROJECT_ID, locale: PROJECT_ID,
    }, BrowserTitle)), `${PROJECT_ID}: tab title`);

    ctx.inject(['configForms', 'slots'], (settingsCtx) => {
      const { configForms, slots } = settingsCtx;
      const form = configForms.get(PROJECT_ID);
      const AgentSettings = makeAgentSettings(React, form);
      const IdleSettings = makeIdleSettings(React, form);
      const OriginSettings = makeOriginSettings(React, form);
      const EnvironmentSettings = makeEnvironmentSettings(React);
      settingsCtx.effect(() => configForms.whileServed([PROJECT_ID], () => slots.inject('plugins.bundle.config', () => slots.register({
        name: 'plugins.bundle.config', key: PROJECT_ID, locale: PROJECT_ID,
      }, ({ t, view }) => view === 'page' ? h('div', { className: settings.page },
        renderSettingsStyles(h), h(AgentSettings, { t }), h(IdleSettings, { t }), h(EnvironmentSettings, { t }),
        h(OriginSettings, { t })) : null))),
      `${PROJECT_ID}: plugin settings`);
    });
  }

  return { inject: ['slots', 'locale', 'uiWorkspace', 'sidebarRightTabs', 'connection', 'contextMenus'], apply };
}
