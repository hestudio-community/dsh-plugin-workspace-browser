import en from '../../locale/en.json' with { type: 'json' };
import zh from '../../locale/zh.json' with { type: 'json' };
import { makeAgentAccess } from './agent-access.js';
import { makeBrowserView } from './browser-view.js';
import { panelStyle } from './styles.js';

const NS = '@local/dsh-workspace-browser';
const selectSnapshot = (snapshot) => snapshot;
const dictionary = ({ meta, ...labels }) => ({ ...labels, title: meta.title, description: meta.description });

export function makeClient({ React, RFB }) {
  const { createElement: h } = React;
  const AgentAccess = makeAgentAccess(React);
  const BrowserView = makeBrowserView(React, RFB);

  function BrowserTab({ sessionId, useTabInfo, useWorkspaces, t, openWebSocket }) {
    const { tab } = useTabInfo();
    const snapshot = useWorkspaces(selectSnapshot);
    if (!tab.visible || tab.signal.aborted) return null;

    const ready = snapshot.phase === 'ready';
    const matches = ready ? snapshot.items.filter((item) => item.sessionIds.includes(sessionId)) : [];
    if (matches.length !== 1) {
      return h('section', { style: panelStyle, 'aria-label': t('title') },
        h('p', { role: 'status', style: { padding: '0 12px' } },
          t(ready ? 'sessionWorkspaceMissing' : 'loadingWorkspace')));
    }

    const [workspace] = matches;
    const key = `${sessionId}:${workspace.workspaceId}`;
    return h('section', { style: panelStyle, 'aria-label': t('title') },
      h(BrowserView, { key: `view:${key}`, sessionId, tabSignal: tab.signal, t, openWebSocket }),
      h(AgentAccess, { key: `access:${key}`, workspace, t }));
  }

  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { en: dictionary(en), zh: dictionary(zh) }), 'Workspace Browser: locale');
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: NS,
      kind: 'workspace-browser',
      title: () => t('title'),
      guide: [{ id: 'open', order: 31, title: () => t('open'), description: () => t('description') }],
    }), 'Workspace Browser: sidebar tab');
    const openWebSocket = (path) => ctx.connection.openWebSocket(path);
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: NS, locale: NS,
    }, (props) => BrowserTab({ ...props, openWebSocket }))), 'Workspace Browser: tab body');
  }

  return { inject: ['slots', 'locale', 'uiWorkspace', 'sidebarRightTabs', 'connection'], apply };
}
