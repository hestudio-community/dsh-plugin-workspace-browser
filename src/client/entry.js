import noVNC from '@novnc/novnc/lib/rfb.js';
import { makeClient } from './index.js';
import { PROJECT_ID } from '../shared/identity.js';

window.__ModuleLoader__.load({
  id: PROJECT_ID,
  factory(require) {
    return makeClient({ React: require('react'), RFB: noVNC.default ?? noVNC });
  },
});
