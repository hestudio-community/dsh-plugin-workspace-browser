import en from '../../locale/en.json' with { type: 'json' };
import zh from '../../locale/zh.json' with { type: 'json' };
import { makeAgentSettings } from './agent-settings.js';
import { makeBrowserView } from './browser-view.js';
import { makeNativeMenu } from './native-menu.js';
import { panelStyle } from './styles.js';

const NS = '@local/dsh-workspace-browser';
const selectSnapshot = (snapshot) => snapshot;
const dictionary = ({ meta, ...labels }) => ({ ...labels, title: meta.title });

export function makeClient({ React, RFB }) {
  const { createElement: h, useLayoutEffect, useRef } = React;
  const browserMenu = makeNativeMenu(React, `${NS}:browser`);
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
      visible: tab.visible && ready, onClosed: closeTab, renderFactorySlot,
    }) : null,
    !ready || !retained ? h('p', { role: 'status', style: { padding: '0 12px' } },
      t(ready ? 'sessionWorkspaceMissing' : 'loadingWorkspace')) : null);
  }

  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { en: dictionary(en), zh: dictionary(zh) }), 'Workspace Browser: locale');
    const t = ctx.locale.bind(NS);
    ctx.effect(() => browserMenu.attach(ctx.contextMenus), 'Workspace Browser: browser menu');
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: NS,
      kind: 'workspace-browser',
      keepMounted: true,
      title: () => t('title'),
      guide: [{ id: 'open', order: 31, title: () => t('open') }],
    }), 'Workspace Browser: sidebar tab');
    const openWebSocket = (path) => ctx.connection.openWebSocket(path);
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: NS, locale: NS,
    }, (props) => BrowserTab({ ...props, openWebSocket }))), 'Workspace Browser: tab body');

    ctx.inject(['configForms', 'slots'], (settingsCtx) => {
      const { configForms, slots } = settingsCtx;
      const entry = 'workspace-browser';
      const AgentSettings = makeAgentSettings(React, configForms.get(entry));
      settingsCtx.effect(() => configForms.whileServed([entry], () => slots.inject('plugins.bundle.config', () => slots.register({
        name: 'plugins.bundle.config', key: NS, locale: NS,
      }, ({ t, view }) => view === 'page' ? h(AgentSettings, { t }) : null))),
      'Workspace Browser: plugin settings');
    });
  }

  return { inject: ['slots', 'locale', 'uiWorkspace', 'sidebarRightTabs', 'connection', 'contextMenus'], apply };
}
