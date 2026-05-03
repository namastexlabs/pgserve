// Bundle entry. Imports the SPA files in their original <script>-tag order.
// Each .jsx file imports React/ReactDOM directly via the standard ESM
// pattern — bundler resolves them per-module. No globalThis hack needed.

import './api.js';
import './data.jsx';
import './components.jsx';
import './tweaks-panel.jsx';
import './screens/databases.jsx';
import './screens/tables.jsx';
import './screens/sql.jsx';
import './screens/optimizer.jsx';
import './screens/security.jsx';
import './screens/ingress.jsx';
import './screens/health.jsx';
import './screens/sync.jsx';
import './screens/rlm-trace.jsx';
import './screens/rlm-sim.jsx';
import './screens/settings.jsx';
import './app.jsx';
