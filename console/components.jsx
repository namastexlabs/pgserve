/* pgserve · atoms */
const { useState, useEffect, useRef, useMemo } = React;

const cx = (...c) => c.filter(Boolean).join(' ');

function Btn({ kind = 'default', size, children, onClick, title }) {
  return (
    <button
      className={cx('btn', kind !== 'default' && kind, size === 'sm' && 'sm')}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function Tag({ kind, children }) {
  return <span className={cx('tag', kind)}>{children}</span>;
}

function Dot({ color = 'var(--accent)' }) {
  return <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />;
}

function BracketH({ children, hint }) {
  return (
    <h3 className="bracket-h">
      [ {children} ]{hint && <span className="dim">{hint}</span>}
    </h3>
  );
}

function Stat({ label, value, sub, accent = false, status }) {
  return (
    <div className="stat">
      <div className="lbl">{label}</div>
      <div className="val">
        {accent ? <span className="accent">{value}</span> : value}
      </div>
      {sub && <div className="sub"><span className={status}>{sub}</span></div>}
    </div>
  );
}

/* CLI block-bar meter */
function MiniBar({ value, max = 100, width = 20, kind = 'ok' }) {
  const filled = Math.round((value / max) * width);
  const empty = Math.max(0, width - filled);
  return (
    <span className="mbar">
      <span className={cx('blk', kind !== 'ok' && kind)}>{'█'.repeat(filled)}</span>
      <span className="empty">{'░'.repeat(empty)}</span>
    </span>
  );
}

function Threshold({ label, value, max = 100, suffix = '%', kind = 'ok' }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="threshold">
      <span className="lbl">{label}</span>
      <span className="track">
        <span className={cx('fill', kind !== 'ok' && kind)} style={{ width: `${pct}%` }} />
      </span>
      <span className="v">{value}{suffix}</span>
    </div>
  );
}

/* live-tailing log line */
function LogLine({ ts, lvl = 'info', evt, msg }) {
  return (
    <div className="log-line">
      <span className="ts">{ts}</span>
      <span className={cx('lvl', lvl)}>{evt}</span>
      <span className="msg">{msg}</span>
    </div>
  );
}

/* SVG sparkline */
function Sparkline({ data, w = 120, h = 28, color = 'var(--accent)' }) {
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((d, i) => `${(i * step).toFixed(1)},${(h - ((d - min) / range) * (h - 4) - 2).toFixed(1)}`).join(' ');
  const areaPts = `0,${h} ${pts} ${w},${h}`;
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polygon points={areaPts} fill={color} opacity="0.12" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

/* fingerprint hex emphasis */
function FP({ hex }) {
  return <span style={{ color: 'var(--accent)' }}>{hex}</span>;
}

/* segmented control */
function Seg({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* alert banner */
function Alert({ kind = 'warn', label, children, actions }) {
  return (
    <div className={cx('alert', kind)}>
      <span className="lbl">{label}</span>
      <span className="msg">{children}</span>
      {actions && <span className="actions">{actions}</span>}
    </div>
  );
}

/* score chip 0..100 */
function Score({ value, max = 100 }) {
  const kind = value >= 80 ? 'ok' : value >= 60 ? 'warn' : 'err';
  return (
    <span className={cx('score', kind)}>
      <span className="v">{value}</span>
      <span className="max">/{max}</span>
    </span>
  );
}

/* bracket-eyebrow */
function Eyebrow({ children, info = true }) {
  return <span className={info ? 'bracket-eyebrow' : 'eyebrow'}>{children}</span>;
}

/* placeholder for screens not yet implemented in v1; renders inside the
 * standard <page> shell so navigation chrome stays consistent and the
 * sidebar reads "[ coming soon ]" rather than blowing the React tree up. */
function ComingSoon({ title, crumb }) {
  return (
    <div className="page">
      <div className="page-head">
        <h1>{title}</h1>
        {crumb && <span className="crumb">{crumb}</span>}
      </div>
      <div className="panel" style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 14, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
          [ coming soon ]
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>
          this screen scaffolds the autopg-console-settings wish; a future wish ships its content.
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  cx, Btn, Tag, Dot, BracketH, Stat, MiniBar, Threshold, LogLine,
  Sparkline, FP, Seg, Alert, Score, Eyebrow, ComingSoon,
});
