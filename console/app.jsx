/* autopg · app shell · routing · theme.
 *
 * Adapted from the design system's pgserve-console kit. Differences vs the
 * pristine design:
 *   - identity flips from `pgserve` to `autopg` in the topbar / sidebar.
 *   - SECTIONS gains two RLM screens (rlm-trace, rlm-sim) so all 11 routes
 *     register; the wish ships them as `[ coming soon ]` placeholders.
 *   - theme toggle persists into `settings.ui.theme` via the autopg helper
 *     API, surviving reloads. Other tweaks remain ephemeral for v1.
 */

const SECTIONS = [
  { id: 'databases', label: 'Databases',     glyph: '◫', count: '6',   group: 'data' },
  { id: 'tables',    label: 'Tables',        glyph: '▦', count: '47',  group: 'data' },
  { id: 'sql',       label: 'SQL Editor',    glyph: '›_', count: null, group: 'data' },
  { id: 'optimizer', label: 'Optimizer',     glyph: '◇', count: '4',   group: 'ops' },
  { id: 'security',  label: 'Security',      glyph: '✦', count: '2',   group: 'ops' },
  { id: 'ingress',   label: 'Ingress',       glyph: '⇨', count: '23',  group: 'ops' },
  { id: 'health',    label: 'Health',        glyph: '◍', count: null,  group: 'ops' },
  { id: 'sync',      label: 'Sync & Backups',glyph: '⇆', count: null,  group: 'ops' },
  { id: 'rlm-trace', label: 'RLM Trace',     glyph: '⌬', count: null,  group: 'rlm' },
  { id: 'rlm-sim',   label: 'RLM Sim',       glyph: '⊙', count: null,  group: 'rlm' },
  { id: 'settings',  label: 'Settings',      glyph: '⚙', count: null,  group: 'system' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "phosphor": "green",
  "density": "standard",
  "crt": "subtle"
}/*EDITMODE-END*/;

const PHOSPHOR_PRESETS = {
  green:   { accent: '#7DD3A4', accentHover: '#97DFB6', accentPress: '#5FB988', vector: '#B69BE0', audit: '#D6A574', label: 'P1 · GREEN' },
  amber:   { accent: '#E8B860', accentHover: '#F2C97A', accentPress: '#C99A45', vector: '#E89E60', audit: '#D6C474', label: 'P3 · AMBER' },
  cyan:    { accent: '#6EE0E0', accentHover: '#8FEAEA', accentPress: '#4FBFBF', vector: '#9BB6E0', audit: '#D6B574', label: 'IBM · CYAN' },
  magenta: { accent: '#E07BB8', accentHover: '#EA97C9', accentPress: '#B8628F', vector: '#B69BE0', audit: '#E0997B', label: 'SYN · MAGENTA' },
  paper:   { accent: '#C8C2B0', accentHover: '#D8D2C0', accentPress: '#A8A290', vector: '#B6B0A0', audit: '#D6CCA0', label: 'PAPER · MUTED' },
};

const DENSITY_PRESETS = {
  compact:  { space: 0.78, row: 24, base: 12, h1: 20, gap: 14, label: 'compact'  },
  standard: { space: 1.00, row: 28, base: 13, h1: 22, gap: 18, label: 'standard' },
  roomy:    { space: 1.28, row: 36, base: 14, h1: 26, gap: 26, label: 'roomy'    },
};

const CRT_PRESETS = {
  off:    { scanline: 0,    glow: 0, vignette: 0,   chroma: 0,   curve: 0, label: 'flat'   },
  subtle: { scanline: 0.04, glow: 4, vignette: 0.18, chroma: 0,   curve: 0, label: 'subtle' },
  heavy:  { scanline: 0.10, glow: 10, vignette: 0.42, chroma: 0.6, curve: 1, label: 'heavy'  },
};

/* Format helpers — small, dependency-free, scoped to the footer. */
function fmtUptime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}
function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString();
}

/* LiveFooter — the only place where pgserve health is reported.
 * Polls /api/stats (SQL-backed: connections, databases, pg version, uptime,
 * cache hit %, total xact, total db size) and /api/status (pm2-backed:
 * daemon pid, restarts, memory) on a 3 s cadence (6 s when down).
 *
 * Compact line shows the headline numbers; the `title` attribute holds a
 * multi-line health report rendered as the native browser tooltip on hover.
 * No custom popover layer is needed — keeps the footer single-purpose.
 */
function LiveFooter() {
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const popRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!window.AutopgApi) return;
    let alive = true;
    let timer;
    const tick = async () => {
      const [s, st] = await Promise.all([
        window.AutopgApi.getStats().catch(() => null),
        window.AutopgApi.getStatus().catch(() => null),
      ]);
      if (!alive) return;
      setStats(s);
      setStatus(st);
      // Slow the cadence when down to avoid hammering a failed daemon.
      timer = setTimeout(tick, s?.ok ? 3000 : 6000);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  // Click-outside + Escape to close the popover.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const live = !!stats?.ok;
  const pid = status?.pid;
  const restarts = status?.restarts;
  const daemonMem = status?.memory ?? status?.mem;
  const ts = stats?.ts ? new Date(stats.ts).toTimeString().slice(0, 8) : '—';

  // Multiline health report — same shape used inside the popover <pre>.
  const healthReport = (() => {
    const lines = [];
    lines.push(`autopg ${stats?.autopg?.version ?? '—'}`);
    lines.push(`port  ${stats?.port ?? '—'}`);
    lines.push('');
    if (live) {
      lines.push('postgres');
      lines.push(`  version       ${stats.pg.version}`);
      lines.push(`  uptime        ${fmtUptime(stats.pg.uptimeSec)}`);
      lines.push(`  connections   ${stats.connections}`);
      lines.push(`  databases     ${stats.databases}`);
      lines.push(`  size          ${fmtBytes(stats.pg.sizeBytes)}`);
      lines.push(`  cache hit     ${stats.pg.cacheHitPct == null ? '—' : `${stats.pg.cacheHitPct}%`}`);
      lines.push(`  total xact    ${fmtNum(stats.pg.txTotal)}`);
    } else {
      lines.push('postgres');
      lines.push(`  status        ${stats?.reason || 'unreachable'}`);
      if (stats?.message) lines.push(`  error         ${stats.message}`);
    }
    lines.push('');
    if (status && !status.error) {
      lines.push('daemon (pm2)');
      lines.push(`  pid           ${pid ?? '—'}`);
      lines.push(`  restarts      ${restarts ?? '—'}`);
      if (daemonMem) lines.push(`  memory        ${typeof daemonMem === 'number' ? fmtBytes(daemonMem) : daemonMem}`);
    } else {
      lines.push('daemon (pm2)');
      lines.push('  not supervised — running in foreground or unreachable');
    }
    lines.push('');
    lines.push(`last sample ${ts}`);
    return lines.join('\n');
  })();

  const liveLabel = live ? 'live' : 'daemon down';
  const btnTitle = live ? 'click to open health report' : 'daemon unreachable — click for details';

  return (
    <div className="footer">
      {/* meta strip — left-aligned facts in left-to-right reading order */}
      <span>autopg <span style={{ color: 'var(--accent)' }}>{stats?.autopg?.version ?? '—'}</span></span>
      {pid != null && (
        <>
          <span className="sep">/</span>
          <span>pid <span style={{ color: 'var(--accent)' }}>{pid}</span></span>
        </>
      )}
      {live && (
        <>
          <span className="sep">/</span>
          <span>pg {stats.pg.version}</span>
          <span className="sep">/</span>
          <span>{stats.connections} conns · {stats.databases} dbs</span>
          {stats.pg.cacheHitPct != null && (
            <>
              <span className="sep">/</span>
              <span>cache · <span className="ok">{stats.pg.cacheHitPct}%</span></span>
            </>
          )}
        </>
      )}
      {!live && stats?.reason && (
        <>
          <span className="sep">/</span>
          <span>{stats.reason}</span>
        </>
      )}

      {/* live-status button — clickable, right-aligned, opens health popover */}
      <button
        ref={btnRef}
        className={`live-btn ${live ? 'on' : 'down'}`}
        onClick={() => setOpen((v) => !v)}
        title={btnTitle}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{ marginLeft: 'auto' }}
      >
        <span className="dot" /> {liveLabel}
      </button>

      {open && (
        <div ref={popRef} className="live-popover" role="dialog" aria-label="pgserve health report">
          <div className="head">
            <span>health · last sample {ts}</span>
            <button className="close" onClick={() => setOpen(false)} aria-label="close">×</button>
          </div>
          <pre>{healthReport}</pre>
        </div>
      )}
    </div>
  );
}

function App() {
  const [route, setRoute] = useState('settings');
  const [theme, setThemeLocal] = useState('mdr');
  const [now, setNow] = useState('00:00:00');
  const [tw, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [bootError, setBootError] = useState(null);

  /* On boot: pull current settings to seed theme + tell the Settings screen
   * the path the daemon is actually reading from. The error is non-fatal —
   * the rest of the console still renders so operators can navigate. */
  useEffect(() => {
    let cancelled = false;
    if (!window.AutopgApi) return undefined;
    window.AutopgApi.getSettings()
      .then((data) => {
        if (cancelled) return;
        const t = data?.settings?.ui?.theme;
        if (t === 'mdr' || t === 'lumon') setThemeLocal(t);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('autopg console: initial settings load failed', err);
        setBootError(err.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useMemo(() => async (next) => {
    setThemeLocal(next);
    if (!window.AutopgApi) return;
    try {
      await window.AutopgApi.putSettings({ ui: { theme: next } });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('autopg console: theme persist failed', err);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const r = document.documentElement;
    const phos = PHOSPHOR_PRESETS[tw.phosphor] || PHOSPHOR_PRESETS.green;
    const den  = DENSITY_PRESETS[tw.density]   || DENSITY_PRESETS.standard;
    const crt  = CRT_PRESETS[tw.crt]           || CRT_PRESETS.subtle;

    if (theme === 'mdr') {
      r.style.setProperty('--c-accent',       phos.accent);
      r.style.setProperty('--c-accent-hover', phos.accentHover);
      r.style.setProperty('--c-accent-press', phos.accentPress);
      r.style.setProperty('--c-vector',       phos.vector);
      r.style.setProperty('--c-audit',        phos.audit);
    } else {
      ['--c-accent', '--c-accent-hover', '--c-accent-press', '--c-vector', '--c-audit']
        .forEach(p => r.style.removeProperty(p));
    }

    r.style.setProperty('--space-1', `${4 * den.space}px`);
    r.style.setProperty('--space-2', `${8 * den.space}px`);
    r.style.setProperty('--space-3', `${12 * den.space}px`);
    r.style.setProperty('--space-4', `${16 * den.space}px`);
    r.style.setProperty('--space-5', `${24 * den.space}px`);
    r.style.setProperty('--space-6', `${32 * den.space}px`);
    r.style.setProperty('--row-control', `${den.row}px`);
    r.style.setProperty('--row-table',   `${den.row + 4}px`);
    r.style.setProperty('--t-md', `${den.base}px`);
    r.style.setProperty('--t-lg', `${den.base + 2}px`);
    r.style.setProperty('--t-2xl', `${den.h1}px`);

    r.style.setProperty('--scanline-opacity', String(crt.scanline));
    r.style.setProperty('--phosphor-glow',   `${crt.glow}px`);
    r.style.setProperty('--crt-vignette',    String(crt.vignette));
    r.style.setProperty('--crt-chroma',      `${crt.chroma}px`);
    r.dataset.crt = tw.crt;
    r.dataset.density = tw.density;
    r.dataset.phosphor = tw.phosphor;
  }, [tw.phosphor, tw.density, tw.crt, theme]);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(d.toTimeString().slice(0, 8));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => ([
    { id: 'data',   label: 'data',   items: SECTIONS.filter(s => s.group === 'data') },
    { id: 'ops',    label: 'ops',    items: SECTIONS.filter(s => s.group === 'ops') },
    { id: 'rlm',    label: 'rlm',    items: SECTIONS.filter(s => s.group === 'rlm') },
    { id: 'system', label: 'system', items: SECTIONS.filter(s => s.group === 'system') },
  ]), []);

  // Every entry MUST be a stable component reference. The previous
  // `settings: () => window.ScreenSettings({ theme, setTheme })` wrapper was
  // recreated on every App re-render (the 1Hz clock alone re-renders the
  // whole tree), making React treat each tick as a new component type and
  // unmount/remount ScreenSettings — losing scroll, focus, and the
  // /api/settings fetch state. Direct refs only; pass props in JSX below.
  const Screen = {
    databases: window.ScreenDatabases,
    tables:    window.ScreenTables,
    sql:       window.ScreenSQL,
    optimizer: window.ScreenOptimizer,
    security:  window.ScreenSecurity,
    ingress:   window.ScreenIngress,
    health:    window.ScreenHealth,
    sync:      window.ScreenSync,
    'rlm-trace': window.ScreenRlmTrace,
    'rlm-sim':   window.ScreenRlmSim,
    settings:  window.ScreenSettings,
  }[route];

  return (
    <div className="app">
      {/* topbar */}
      <div className="topbar">
        <div className="wm">
          <span className="cur">▌</span><span>autopg</span>
        </div>
        <div className="meta">
          <span className="sep">/</span>
          <span>console · v1</span>
          <span className="sep">·</span>
          <span style={{ color: 'var(--accent)' }}>{route}</span>
          <span className="sep">·</span>
          <span>{now}</span>
        </div>
        <div className="right">
          {bootError && <span className="pill" style={{ color: 'var(--err, #d66)' }}>api · {bootError}</span>}
          <span className="pill"><span className="dot"></span> ~/.autopg</span>
          <div className="theme-switch">
            <button
              onClick={() => setTheme(theme === 'mdr' ? 'lumon' : 'mdr')}
              title={theme === 'mdr' ? 'switch to light' : 'switch to dark'}
              aria-label={theme === 'mdr' ? 'switch to light theme' : 'switch to dark theme'}
            >
              {theme === 'mdr' ? (
                /* moon — currently dark */
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 9.5A6 6 0 1 1 6.5 2a5 5 0 0 0 7.5 7.5z" />
                </svg>
              ) : (
                /* sun — currently light */
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="8" cy="8" r="3" />
                  <path d="M8 1.5v2 M8 12.5v2 M14.5 8h-2 M3.5 8h-2 M12.6 3.4l-1.4 1.4 M4.8 11.2l-1.4 1.4 M12.6 12.6l-1.4-1.4 M4.8 4.8l-1.4-1.4" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* sidebar */}
      <div className="sidebar">
        <div style={{ padding: '0 18px 12px', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
          ~/.autopg
        </div>
        {groups.map(g => (
          <div className="group" key={g.id}>
            <div className="group-label">[ {g.label} ]</div>
            {g.items.map(s => (
              <div
                key={s.id}
                className={cx('nav-item', route === s.id && 'on')}
                onClick={() => setRoute(s.id)}
                data-screen-label={s.label}
              >
                <span className="glyph">{s.glyph}</span>
                <span>{s.label}</span>
                {s.count && <span className="count">{s.count}</span>}
              </div>
            ))}
          </div>
        ))}
        <div style={{ padding: '14px 18px', fontSize: 10, color: 'var(--text-dim)', borderTop: '1px solid var(--line)', marginTop: 14 }}>
          <div style={{ marginBottom: 4 }}>autopg · settings vertical</div>
          <div>health vertical · next wish</div>
        </div>
      </div>

      {/* main */}
      <div className="main">
        {Screen
          ? <Screen theme={theme} setTheme={setTheme} />
          : <div className="page">loading…</div>}
      </div>

      {/* footer — live pgserve health line; full report on hover */}
      <LiveFooter />

      {/* CRT overlay */}
      <div className="crt-overlay" aria-hidden="true">
        <div className="crt-scan"></div>
        <div className="crt-vig"></div>
        <div className="crt-chroma"></div>
      </div>

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection label="Phosphor" />
        <window.TweakSelect
          label="Tube color"
          value={tw.phosphor}
          options={[
            { value: 'green',   label: 'P1 · green (default)' },
            { value: 'amber',   label: 'P3 · amber' },
            { value: 'cyan',    label: 'IBM · cyan' },
            { value: 'magenta', label: 'Synthwave · magenta' },
            { value: 'paper',   label: 'Paper · muted' },
          ]}
          onChange={(v) => setTweak('phosphor', v)}
        />
        <div style={{ fontSize: 10, color: 'rgba(41,38,27,.55)', marginTop: -4, lineHeight: 1.4 }}>
          Recolors accent, vector, and audit families across every screen. Lumon (light) keeps its institutional blue.
        </div>

        <window.TweakSection label="Density" />
        <window.TweakRadio
          label="Layout"
          value={tw.density}
          options={[
            { value: 'compact',  label: 'Compact'  },
            { value: 'standard', label: 'Standard' },
            { value: 'roomy',    label: 'Roomy'    },
          ]}
          onChange={(v) => setTweak('density', v)}
        />

        <window.TweakSection label="CRT intensity" />
        <window.TweakRadio
          label="Tube"
          value={tw.crt}
          options={[
            { value: 'off',    label: 'Flat'   },
            { value: 'subtle', label: 'Subtle' },
            { value: 'heavy',  label: 'Heavy'  },
          ]}
          onChange={(v) => setTweak('crt', v)}
        />
      </window.TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
