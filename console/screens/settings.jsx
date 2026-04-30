/* screens/settings.jsx — autopg console Settings vertical.
 *
 * Renders the 6-section settings schema (server / runtime / sync / supervision
 * / postgres / ui) read from `GET /api/settings`. Type-aware controls dispatch
 * on the schema descriptor's `type` (int → number input, bool → toggle, enum
 * → segmented control, string → text input). The postgres section also exposes
 * a raw passthrough panel (`postgres._extra`) with add/remove rows.
 *
 * Cross-cutting concerns:
 *   - sources[key] starting with "env:" → yellow OVERRIDDEN BY ENV chip
 *   - server-returned validation errors render inline beneath the offending row
 *   - 409 ETAG_MISMATCH responses surface a banner offering "reload" rather
 *     than overwriting the on-disk state
 *   - "Save & Restart" PUTs then POSTs /api/restart sequentially
 *
 * The schema descriptors are mirrored here from src/settings-schema.cjs. The
 * UI lives at the boundary so it can render labels without an extra round-trip
 * — the server is still the source of truth for validation. If the schema
 * shape changes, this mirror needs updating in lockstep (Group 1's schema
 * file ships as `version: 1`; this is the v1 view).
 */

const SETTINGS_SCHEMA_VIEW = {
  server: {
    label: 'server',
    hint: 'router · postgres backend',
    fields: [
      { key: 'port',         type: 'int',    label: 'router port',        hint: 'TCP port clients connect to' },
      { key: 'host',         type: 'string', label: 'bind host',          hint: 'router listen address' },
      { key: 'pgPort',       type: 'int',    label: 'backend port',       hint: 'internal postgres TCP port' },
      { key: 'pgSocketPath', type: 'string', label: 'backend socket',     hint: 'unix socket path (blank = TCP only)', allowEmpty: true },
      { key: 'pgUser',       type: 'string', label: 'backend user',       hint: 'postgres superuser' },
      { key: 'pgPassword',   type: 'password', label: 'backend password', hint: 'stored at chmod 0600' },
    ],
  },
  runtime: {
    label: 'runtime',
    hint: 'observability · auto-provisioning',
    fields: [
      { key: 'logLevel',       type: 'enum',   label: 'log level',         options: ['debug', 'info', 'warn', 'error'] },
      { key: 'autoProvision',  type: 'bool',   label: 'auto-provision',    hint: 'auto-create missing databases on first connect' },
      { key: 'enablePgvector', type: 'bool',   label: 'enable pgvector',   hint: 'load pgvector on database create' },
      { key: 'dataDir',        type: 'string', label: 'data dir',          hint: 'PG cluster dir (blank = <configDir>/data)', allowEmpty: true },
    ],
  },
  sync: {
    label: 'sync',
    hint: 'logical replication',
    fields: [
      { key: 'enabled', type: 'bool', label: 'enable sync', hint: 'WAL-based logical replication; pairs with WAL GUCs below' },
    ],
  },
  supervision: {
    label: 'supervision',
    hint: 'pm2 lifecycle',
    fields: [
      { key: 'maxMemory',     type: 'string', label: 'max memory',     hint: 'pm2 memory ceiling (e.g. 4G)' },
      { key: 'maxRestarts',   type: 'int',    label: 'max restarts',   hint: 'pm2 rapid-restart cap' },
      { key: 'minUptimeMs',   type: 'int',    label: 'min uptime (ms)', hint: 'window for healthy-start tracking' },
      { key: 'killTimeoutMs', type: 'int',    label: 'kill timeout (ms)', hint: 'graceful shutdown window before SIGKILL' },
    ],
  },
  postgres: {
    label: 'postgres GUCs',
    hint: 'curated 14 + raw passthrough',
    fields: [
      { key: 'max_connections',        type: 'int',    label: 'max_connections' },
      { key: 'shared_buffers',         type: 'string', label: 'shared_buffers' },
      { key: 'work_mem',               type: 'string', label: 'work_mem' },
      { key: 'maintenance_work_mem',   type: 'string', label: 'maintenance_work_mem' },
      { key: 'effective_cache_size',   type: 'string', label: 'effective_cache_size' },
      { key: 'wal_level',              type: 'enum',   label: 'wal_level', options: ['minimal', 'replica', 'logical'] },
      { key: 'max_replication_slots',  type: 'int',    label: 'max_replication_slots' },
      { key: 'max_wal_senders',        type: 'int',    label: 'max_wal_senders' },
      { key: 'wal_keep_size',          type: 'string', label: 'wal_keep_size' },
      { key: 'log_statement',          type: 'enum',   label: 'log_statement', options: ['none', 'ddl', 'mod', 'all'] },
      { key: 'log_min_duration_statement', type: 'int', label: 'log_min_duration_statement' },
      { key: 'statement_timeout',      type: 'int',    label: 'statement_timeout' },
      { key: 'idle_in_transaction_session_timeout', type: 'int', label: 'idle_in_transaction_session_timeout' },
      { key: 'autovacuum',             type: 'bool',   label: 'autovacuum' },
    ],
  },
  ui: {
    label: 'console',
    hint: 'theme · density · phosphor',
    fields: [
      { key: 'theme',    type: 'enum', label: 'theme',     options: ['mdr', 'lumon'] },
      { key: 'phosphor', type: 'enum', label: 'phosphor',  options: ['amber', 'green', 'white'] },
      { key: 'density',  type: 'enum', label: 'density',   options: ['compact', 'comfortable', 'spacious'] },
      { key: 'crt',      type: 'bool', label: 'crt scanlines' },
    ],
  },
};

const GUC_NAME_REGEX_VIEW = /^[a-z][a-z0-9_]*$/;

function deepClone(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
  return out;
}

function ScreenSettings({ theme: parentTheme, setTheme: parentSetTheme }) {
  const [loaded, setLoaded]     = useState(null);
  const [form, setForm]         = useState(null);
  const [errors, setErrors]     = useState({});
  const [banner, setBanner]     = useState(null); // { kind, text }
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [extraRows, setExtraRows] = useState([]);
  const [bootError, setBootError] = useState(null);

  const reload = React.useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setConflict(false);
    setBootError(null);
    try {
      const data = await window.AutopgApi.getSettings();
      setLoaded(data);
      setForm(deepClone(data.settings));
      setErrors({});
      // Materialize _extra map → array of rows for UI editing.
      const extraMap = data?.settings?.postgres?._extra || {};
      const rows = Object.entries(extraMap).map(([k, v]) => ({
        id: `${k}-${Math.random().toString(36).slice(2, 6)}`,
        name: k,
        value: typeof v === 'string' ? v : String(v),
      }));
      setExtraRows(rows);
    } catch (err) {
      setBootError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!window.AutopgApi) return;
    reload();
  }, [reload]);

  const dirty = useMemo(() => {
    if (!loaded || !form) return false;
    if (JSON.stringify(stripExtra(loaded.settings)) !== JSON.stringify(stripExtra(form))) return true;
    return !sameExtraMap(loaded.settings?.postgres?._extra || {}, rowsToMap(extraRows));
  }, [loaded, form, extraRows]);

  const sources = loaded?.sources || {};

  const setField = (section, key, value) => {
    setForm((prev) => {
      const next = deepClone(prev);
      if (!next[section]) next[section] = {};
      next[section][key] = value;
      return next;
    });
    // Clear the field's stale error on edit.
    setErrors((prev) => {
      const dotted = `${section}.${key}`;
      if (!(dotted in prev)) return prev;
      const out = { ...prev };
      delete out[dotted];
      return out;
    });
  };

  const buildPatch = () => {
    if (!form) return {};
    const patch = deepClone(stripExtra(form));
    patch.postgres = patch.postgres || {};
    patch.postgres._extra = rowsToMap(extraRows);
    return patch;
  };

  const validateExtraClient = () => {
    const out = {};
    const seen = new Set();
    for (const row of extraRows) {
      const trimmed = (row.name || '').trim();
      const dotted = `postgres._extra.${trimmed || row.id}`;
      if (!trimmed) {
        out[dotted] = { code: 'INVALID_GUC_NAME', message: 'name is required' };
        continue;
      }
      if (!GUC_NAME_REGEX_VIEW.test(trimmed)) {
        out[dotted] = {
          code: 'INVALID_GUC_NAME',
          message: 'must match /^[a-z][a-z0-9_]*$/',
        };
        continue;
      }
      if (seen.has(trimmed)) {
        out[dotted] = { code: 'INVALID_GUC_NAME', message: 'duplicate key' };
        continue;
      }
      seen.add(trimmed);
      if (typeof row.value === 'string' && /[\n\r\0]/.test(row.value)) {
        out[dotted] = { code: 'INVALID_GUC_VALUE', message: 'value contains forbidden control character' };
      }
      if (typeof row.value === 'string' && row.value.startsWith('-')) {
        out[dotted] = { code: 'INVALID_GUC_VALUE', message: 'value must not start with "-"' };
      }
    }
    return out;
  };

  const handleSave = async ({ thenRestart = false } = {}) => {
    setBusy(true);
    setBanner(null);

    const clientErrors = validateExtraClient();
    if (Object.keys(clientErrors).length) {
      setErrors((prev) => ({ ...prev, ...clientErrors }));
      setBanner({ kind: 'err', text: 'fix highlighted fields before saving' });
      setBusy(false);
      return;
    }

    try {
      const patch = buildPatch();
      const res = await window.AutopgApi.putSettings(patch);
      setBanner({ kind: 'ok', text: thenRestart ? 'saved · restarting…' : 'saved' });
      // Optimistically refresh the loaded baseline + etag so the dirty
      // flag clears without a second full reload.
      const next = { ...loaded, settings: deepClone(form), etag: res.etag };
      next.settings.postgres = next.settings.postgres || {};
      next.settings.postgres._extra = rowsToMap(extraRows);
      setLoaded(next);
      setErrors({});
      setConflict(false);

      if (thenRestart) {
        try {
          await window.AutopgApi.restart();
          setBanner({ kind: 'ok', text: 'saved · restart triggered' });
        } catch (err) {
          setBanner({ kind: 'err', text: `restart failed: ${err.message || err.code}` });
        }
      }
      // Always re-fetch so sources/etag are canonical.
      await reload();
    } catch (err) {
      if (err.code === 'ETAG_MISMATCH') {
        setConflict(true);
        setBanner({ kind: 'warn', text: 'settings changed on disk — reload before saving' });
      } else if (err.field) {
        setErrors((prev) => ({ ...prev, [err.field]: { code: err.code, message: err.message } }));
        setBanner({ kind: 'err', text: `${err.code}: ${err.field}` });
      } else {
        setBanner({ kind: 'err', text: err.message || String(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = () => {
    if (!loaded) return;
    setForm(deepClone(loaded.settings));
    const extraMap = loaded?.settings?.postgres?._extra || {};
    const rows = Object.entries(extraMap).map(([k, v]) => ({
      id: `${k}-${Math.random().toString(36).slice(2, 6)}`,
      name: k,
      value: typeof v === 'string' ? v : String(v),
    }));
    setExtraRows(rows);
    setErrors({});
    setBanner(null);
  };

  if (bootError) {
    return (
      <div className="page">
        <div className="page-head"><h1>settings</h1></div>
        <div className="panel" style={{ padding: 16, color: 'var(--err, #d66)' }}>
          could not load settings · {bootError}
        </div>
      </div>
    );
  }
  if (!loaded || !form) {
    return (
      <div className="page">
        <div className="page-head"><h1>settings</h1></div>
        <div className="panel" style={{ padding: 16 }}>loading…</div>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-head">
        <h1>settings</h1>
        <span className="crumb">/ {loaded.path || '~/.autopg/settings.json'}</span>
        <div className="right">
          <Btn onClick={handleDiscard}>discard</Btn>
          <Btn onClick={() => handleSave({ thenRestart: false })} title="persist to ~/.autopg/settings.json">save</Btn>
          <Btn kind="primary" onClick={() => handleSave({ thenRestart: true })}>save &amp; restart</Btn>
        </div>
      </div>

      {banner && (
        <Alert
          kind={banner.kind === 'ok' ? 'ok' : banner.kind === 'warn' ? 'warn' : 'err'}
          label={banner.kind === 'ok' ? 'ok' : banner.kind === 'warn' ? 'note' : 'error'}
          actions={conflict ? <Btn kind="primary" onClick={reload}>reload</Btn> : null}
        >
          {banner.text}
        </Alert>
      )}

      {Object.entries(SETTINGS_SCHEMA_VIEW).map(([section, view]) => (
        <SettingsSection
          key={section}
          section={section}
          view={view}
          values={form[section] || {}}
          sources={sources}
          errors={errors}
          onChange={setField}
        />
      ))}

      <ExtraPanel
        rows={extraRows}
        setRows={setExtraRows}
        sources={sources}
        errors={errors}
        clearError={(name) => setErrors((p) => {
          const dotted = `postgres._extra.${name}`;
          if (!(dotted in p)) return p;
          const out = { ...p };
          delete out[dotted];
          return out;
        })}
      />

      <div style={{
        marginTop: 32, paddingTop: 18, borderTop: '1px solid var(--line)',
        display: 'flex', justifyContent: 'space-between',
        fontSize: 11, color: 'var(--text-dim)',
      }}>
        <span>autopg · settings v1 · {dirty ? <span style={{ color: 'var(--accent)' }}>dirty</span> : 'clean'}</span>
        <span>etag · <span style={{ color: 'var(--accent)' }}>{(loaded.etag || '').slice(0, 14)}…</span></span>
      </div>
    </div>
  );
}

function SettingsSection({ section, view, values, sources, errors, onChange }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <BracketH hint={view.hint}>{view.label}</BracketH>
      <div className="panel">
        {view.fields.map((field) => (
          <SettingsRow
            key={field.key}
            section={section}
            field={field}
            value={values[field.key]}
            source={sources[`${section}.${field.key}`]}
            error={errors[`${section}.${field.key}`]}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

function SettingsRow({ section, field, value, source, error, onChange }) {
  const dotted = `${section}.${field.key}`;
  const overridden = typeof source === 'string' && source.startsWith('env:');
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px dashed var(--line)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
            {field.label}
            {overridden && (
              <span
                title={`source: ${source}`}
                style={{
                  marginLeft: 8, padding: '1px 6px', fontSize: 9,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  background: 'var(--c-audit, #D6A574)', color: '#1f1a0c',
                  borderRadius: 3,
                }}
              >
                overridden by env
              </span>
            )}
          </div>
          {field.hint && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{field.hint}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <FieldControl
            field={field}
            value={value}
            disabled={overridden}
            onChange={(v) => onChange(section, field.key, v)}
          />
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto' }}>
            {source || 'default'}
          </span>
        </div>
      </div>
      {error && (
        <div style={{
          marginTop: 6, marginLeft: 236, fontSize: 11, color: 'var(--err, #d66)',
        }}>
          {error.code}: {error.message}
        </div>
      )}
    </div>
  );
}

function FieldControl({ field, value, disabled, onChange }) {
  if (field.type === 'bool') {
    return (
      <Seg
        value={value ? 'on' : 'off'}
        onChange={(v) => onChange(v === 'on')}
        options={[{ value: 'off', label: 'OFF' }, { value: 'on', label: 'ON' }]}
      />
    );
  }
  if (field.type === 'enum') {
    return (
      <Seg
        value={value}
        onChange={onChange}
        options={field.options.map((o) => ({ value: o, label: o.toUpperCase() }))}
      />
    );
  }
  if (field.type === 'int') {
    return (
      <input
        className="input"
        type="number"
        value={value ?? ''}
        disabled={disabled}
        style={{ width: 160 }}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(null);
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    );
  }
  if (field.type === 'password') {
    return (
      <input
        className="input"
        type="password"
        value={value ?? ''}
        disabled={disabled}
        style={{ width: 240 }}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="input"
      type="text"
      value={value ?? ''}
      disabled={disabled}
      style={{ width: 240 }}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ExtraPanel({ rows, setRows, sources, errors, clearError }) {
  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { id: `new-${Math.random().toString(36).slice(2, 8)}`, name: '', value: '' },
    ]);
  };
  const removeRow = (id) => setRows((prev) => prev.filter((r) => r.id !== id));
  const updateRow = (id, patch) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div style={{ marginBottom: 24 }}>
      <BracketH hint="raw -c key=value passthrough; validated against /^[a-z][a-z0-9_]*$/">postgres._extra</BracketH>
      <div className="panel">
        {rows.length === 0 && (
          <div style={{ padding: '12px 0', color: 'var(--text-dim)', fontSize: 11 }}>
            no raw GUCs configured. add one to forward an unsupported `-c key=value` to postgres.
          </div>
        )}
        {rows.map((row) => {
          const dotted = `postgres._extra.${row.name}`;
          const error = errors[dotted];
          const source = sources[dotted];
          const overridden = typeof source === 'string' && source.startsWith('env:');
          return (
            <div key={row.id} style={{ padding: '8px 0', borderBottom: '1px dashed var(--line)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  type="text"
                  placeholder="guc_name"
                  value={row.name}
                  style={{ width: 240 }}
                  onChange={(e) => {
                    clearError(row.name);
                    updateRow(row.id, { name: e.target.value });
                  }}
                />
                <span style={{ color: 'var(--text-dim)' }}>=</span>
                <input
                  className="input"
                  type="text"
                  placeholder="value"
                  value={row.value}
                  style={{ flex: 1 }}
                  onChange={(e) => {
                    clearError(row.name);
                    updateRow(row.id, { value: e.target.value });
                  }}
                />
                {overridden && (
                  <span style={{
                    padding: '1px 6px', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: 'var(--c-audit, #D6A574)', color: '#1f1a0c', borderRadius: 3,
                  }}>overridden by env</span>
                )}
                <Btn size="sm" onClick={() => removeRow(row.id)}>remove</Btn>
              </div>
              {error && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--err, #d66)' }}>
                  {error.code}: {error.message}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ paddingTop: 12 }}>
          <Btn size="sm" onClick={addRow}>+ add row</Btn>
        </div>
      </div>
    </div>
  );
}

function stripExtra(settings) {
  if (!settings) return settings;
  const out = deepClone(settings);
  if (out.postgres) delete out.postgres._extra;
  return out;
}

function rowsToMap(rows) {
  const out = {};
  for (const row of rows) {
    const name = (row.name || '').trim();
    if (!name) continue;
    out[name] = row.value;
  }
  return out;
}

function sameExtraMap(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (String(a[ak[i]]) !== String(b[bk[i]])) return false;
  }
  return true;
}

window.ScreenSettings = ScreenSettings;
