// MUST be the first import: bootstraps React/ReactDOM/hooks onto
// globalThis before any screen module evaluates. See globals.js for
// the ESM import-hoisting hazard this fixes.
import './globals.js';

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
