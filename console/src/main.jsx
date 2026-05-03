import React from 'react';
import * as ReactDOM from 'react-dom/client';

globalThis.React = React;
globalThis.ReactDOM = ReactDOM;

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
