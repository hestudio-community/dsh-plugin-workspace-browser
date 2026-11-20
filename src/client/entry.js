import noVNC from '@novnc/novnc/lib/rfb.js';
import { makeClient } from './index.js';

window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-browser',
  factory(require) {
    return makeClient({ React: require('react'), RFB: noVNC.default ?? noVNC });
  },
});
