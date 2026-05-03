/* pgserve · mocked daemon snapshot */

const DBS = [
  { name: 'app_genie_a1b2c3d4e5f6', fp: 'a1b2c3d4e5f6', pkg: '@automagik/genie',  size: '142 MB',  tables: 14, conns: 3,  last: '14:18:02', persist: true,  state: 'running', pgvector: true,  uptime: '3d 4h' },
  { name: 'app_brain_4f3e2d1c0b9a', fp: '4f3e2d1c0b9a', pkg: '@automagik/brain',  size: '2.1 GB',  tables: 41, conns: 7,  last: '14:18:11', persist: true,  state: 'running', pgvector: true,  uptime: '12d 2h' },
  { name: 'app_omni_9876543210ab',  fp: '9876543210ab', pkg: '@automagik/omni',   size: '12 MB',   tables: 6,  conns: 0,  last: '10:02:44', persist: false, state: 'idle',    pgvector: false, uptime: '4h 16m' },
  { name: 'app_loom_5b4a3c2d1e0f',  fp: '5b4a3c2d1e0f', pkg: '@studio/loom',      size: '844 MB',  tables: 22, conns: 12, last: '14:18:14', persist: true,  state: 'running', pgvector: false, uptime: '6d 8h' },
  { name: 'app_drift_0123456789ab', fp: '0123456789ab', pkg: '@studio/drift',     size: '38 MB',   tables: 9,  conns: 1,  last: '14:17:50', persist: false, state: 'running', pgvector: true,  uptime: '52m' },
  { name: 'app_relay_fedcba987654', fp: 'fedcba987654', pkg: '@hive/relay',       size: '6.4 MB',  tables: 3,  conns: 0,  last: '13:01:20', persist: false, state: 'reaped',  pgvector: false, uptime: '—' },
];

const SCHEMAS = ['public', 'auth', 'pgvector', 'audit'];

const TABLE_COLS = [
  { n: 'id',          t: 'uuid',        pk: true,  nn: true  },
  { n: 'created_at',  t: 'timestamptz', nn: true             },
  { n: 'title',       t: 'text',        nn: true             },
  { n: 'body',        t: 'text'                              },
  { n: 'author_id',   t: 'uuid',        fk: 'users.id'       },
  { n: 'tags',        t: 'text[]'                            },
  { n: 'embedding',   t: 'vector(1536)', vec: true           },
  { n: 'is_archived', t: 'bool',        nn: true,  d: 'false'},
];

const TABLE_ROWS = [
  { id:'a14b…f021', created_at:'2026-04-02 14:02:11', title:'Onboarding flow audit',         body:'Maps friction points across the first 90s of the genie surface.', author_id:'u_021', tags:['research','onboarding'], embedding:'[0.012, -0.044, …]', is_archived:false },
  { id:'b25c…0a19', created_at:'2026-04-04 09:31:48', title:'pgvector HNSW vs IVFFLAT',      body:'Benchmarks at 1M rows. HNSW wins on recall, IVFFLAT on build time.', author_id:'u_021', tags:['db','vector','bench'], embedding:'[-0.114, 0.220, …]', is_archived:false },
  { id:'c36d…11b2', created_at:'2026-04-08 23:14:02', title:'Daemon socket hardening',       body:'Move from 0700 dir to peercred + uid match. Audit event added.', author_id:'u_004', tags:['security'],            embedding:'[0.067, -0.012, …]', is_archived:true  },
  { id:'d47e…2233', created_at:'2026-04-12 11:48:00', title:'Restore-from-source UX',         body:'Confirm dialog, dry-run preview, lock target during apply.', author_id:'u_018', tags:['sync','ux'],           embedding:'[-0.031, 0.408, …]', is_archived:false },
  { id:'e58f…3344', created_at:'2026-04-14 06:02:39', title:'TTL reaper edge case',           body:'Fingerprint last_connection_at can be NULL after fresh restore.', author_id:'u_004', tags:['bug','reaper'],        embedding:'[0.244, 0.001, …]', is_archived:false },
  { id:'f69a…4455', created_at:'2026-04-18 19:22:14', title:'libpq client retry policy',      body:'Exponential backoff capped at 4s; immediate for restarts.', author_id:'u_021', tags:['client'],              embedding:'[-0.402, -0.019, …]', is_archived:false },
  { id:'071b…5566', created_at:'2026-04-20 13:00:00', title:'Token rotation cadence',         body:'Default 24h. Apps can opt-in to 1h with --short-token.', author_id:'u_004', tags:['security','tokens'],   embedding:'[0.118, 0.097, …]', is_archived:false },
  { id:'182c…6677', created_at:'2026-04-22 08:14:21', title:'Console settings draft',         body:'Persist policy, GC TTL, control-socket path, telemetry, theme.', author_id:'u_018', tags:['console'],             embedding:'[NULL]', is_archived:false },
  { id:'293d…7788', created_at:'2026-04-25 17:00:00', title:'pgserve.persist guidance',       body:'Long-lived apps; not just for convenience. Doc copy locked.', author_id:'u_021', tags:['docs'],                embedding:'[0.005, -0.211, …]', is_archived:false },
  { id:'3a4e…8899', created_at:'2026-04-27 02:31:09', title:'Async logical replication slots', body:'Slot per target; lag visible in stats panel; auto-drop on remove.', author_id:'u_004', tags:['sync','replication'],  embedding:'[-0.066, 0.181, …]', is_archived:false },
  { id:'4b5f…99aa', created_at:'2026-04-28 12:48:30', title:'EXPLAIN cost-threshold',         body:'Anything over 10k cost shows in optimizer board with index hint.', author_id:'u_018', tags:['perf'],                embedding:'[0.401, -0.107, …]', is_archived:false },
  { id:'5c60…aabb', created_at:'2026-04-29 22:11:55', title:'Backup retention',                body:'Keep 7 daily, 4 weekly, 3 monthly. Restore from any.', author_id:'u_021', tags:['backups'],             embedding:'[NULL]', is_archived:true  },
];

const SQL_TABS = [
  { id:'t1', label:'slow_queries.sql', dirty:false },
  { id:'t2', label:'documents_search.sql', dirty:true },
  { id:'t3', label:'tool_calls_agg.sql', dirty:false },
];

const SQL_HISTORY = [
  { id:'h1', t:'14:18:02', ms:'2.4 ms',  ok:true,  q:'SELECT pg_database_size(current_database())' },
  { id:'h2', t:'14:17:11', ms:'184 ms',  ok:true,  q:"SELECT id, title FROM documents WHERE embedding <=> '[0.1, 0.2, ...]'::vector LIMIT 10" },
  { id:'h3', t:'14:14:00', ms:'38 ms',   ok:true,  q:"SELECT tool, count(*) FROM tool_calls GROUP BY tool" },
  { id:'h4', t:'14:11:08', ms:'6 ms',    ok:false, q:"SELECT * FROM audit_events WHERE event = 'connection_denied' LIMIT 50" },
  { id:'h5', t:'14:08:14', ms:'12 ms',   ok:true,  q:'EXPLAIN ANALYZE SELECT * FROM messages WHERE session_id = $1' },
  { id:'h6', t:'14:02:11', ms:'78 ms',   ok:true,  q:'VACUUM ANALYZE messages' },
];

const SLOW_QUERIES = [
  { id:'q01', total:'4823 ms', calls:128,  mean:'37.7 ms', rows:'1.2e5', hit:97.2, q:"SELECT * FROM articles WHERE author_id = $1 ORDER BY created_at DESC LIMIT 50", issue:'seq_scan',  fix:'CREATE INDEX articles_author_created_idx ON articles (author_id, created_at DESC);', cost:18421 },
  { id:'q02', total:'2901 ms', calls:42,   mean:'69.1 ms', rows:'8.4e3', hit:88.4, q:"UPDATE sessions SET last_seen = now() WHERE user_id = $1", issue:'no_index',   fix:'CREATE INDEX sessions_user_idx ON sessions (user_id);', cost:9210 },
  { id:'q03', total:'1844 ms', calls:9,    mean:'205 ms',  rows:'3',     hit:62.0, q:"SELECT embedding <=> $1 FROM docs ORDER BY 1 LIMIT 10", issue:'vector_scan', fix:'CREATE INDEX docs_embedding_hnsw ON docs USING hnsw (embedding vector_cosine_ops);', cost:14002 },
  { id:'q04', total:'1610 ms', calls:240,  mean:'6.7 ms',  rows:'9.6e3', hit:99.1, q:"SELECT count(*) FROM events WHERE created_at > now() - '1 day'::interval", issue:'partial_idx', fix:"CREATE INDEX events_recent_idx ON events (created_at) WHERE created_at > now() - '2 days'::interval;", cost:7880 },
  { id:'q05', total:'982 ms',  calls:18,   mean:'54.5 ms', rows:'512',   hit:91.0, q:"SELECT u.*, p.* FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.email ILIKE $1", issue:'ilike_no_trgm', fix:"CREATE EXTENSION pg_trgm; CREATE INDEX users_email_trgm ON users USING gin (email gin_trgm_ops);", cost:6044 },
  { id:'q06', total:'770 ms',  calls:1240, mean:'0.6 ms',  rows:'1240',  hit:99.8, q:"INSERT INTO audit_log (...) VALUES (...)", issue:'fine', fix:'no action', cost:120 },
];

const BLOAT = [
  { table:'public.messages',     dead:'12.4 MB', pct:8.2,  age:'4d 12h', verdict:'low' },
  { table:'public.tool_calls',   dead:'47.0 MB', pct:18.4, age:'1d 3h',  verdict:'medium' },
  { table:'public.audit_events', dead:'118 MB',  pct:31.6, age:'8d 1h',  verdict:'high' },
  { table:'public.embeddings',   dead:'4 MB',    pct:0.4,  age:'2h',     verdict:'low' },
];

const AUDIT = [
  { ts:'14:18:14', lvl:'audit', evt:'tcp_token_issued',     msg:"fingerprint=4f3e2d1c0b9a · ttl=24h" },
  { ts:'14:18:11', lvl:'info',  evt:'connection_opened',    msg:"app_brain_4f3e2d1c0b9a · pid=4821 · uid=1000" },
  { ts:'14:18:02', lvl:'info',  evt:'connection_opened',    msg:"app_genie_a1b2c3d4e5f6 · pid=4811 · uid=1000" },
  { ts:'14:17:58', lvl:'err',   evt:'connection_denied',    msg:"28P01 — peer fingerprint mismatch (a1b2c3d4 → app_genie req production)" },
  { ts:'14:17:42', lvl:'audit', evt:'rls_policy_violation', msg:"messages · session_id != current_setting('jwt.claim.sid')" },
  { ts:'14:17:01', lvl:'info',  evt:'pgvector_index_built', msg:"public.docs.embedding · HNSW · 412ms" },
  { ts:'14:16:33', lvl:'warn',  evt:'sql_lint',             msg:"DELETE FROM users — no WHERE clause; rejected" },
  { ts:'14:14:00', lvl:'audit', evt:'replication_slot_active', msg:"slot=sync_prod_pg target=prod-pg.internal:5432" },
  { ts:'14:11:08', lvl:'err',   evt:'connection_denied',    msg:"28P01 fingerprint mismatch — peer 9876 → app_brain" },
  { ts:'14:08:33', lvl:'audit', evt:'tcp_token_issued',     msg:"fingerprint=a1b2c3d4e5f6 · ttl=1h" },
  { ts:'14:02:11', lvl:'info',  evt:'db_created',           msg:"app_omni_9876543210ab · ephemeral · ttl=24h" },
  { ts:'13:48:09', lvl:'audit', evt:'role_created',         msg:"genie_rw — owner=app_genie · grants=SELECT,INSERT,UPDATE" },
];

const ROLES = [
  { name: 'pgserve_super',  super: true,  conns: 1, last: '14:18:14', kind: 'daemon' },
  { name: 'genie_rw',       super: false, conns: 3, last: '14:18:02', kind: 'app'    },
  { name: 'brain_rw',       super: false, conns: 7, last: '14:18:11', kind: 'app'    },
  { name: 'loom_rw',        super: false, conns: 12,last: '14:18:14', kind: 'app'    },
  { name: 'audit_ro',       super: false, conns: 1, last: '14:17:42', kind: 'system' },
  { name: 'replication_tx', super: false, conns: 1, last: '14:14:00', kind: 'system' },
];

const LINTS = [
  { sev:'high', msg:'public.users — no RLS policy and contains email column',  fix:'ALTER TABLE users ENABLE ROW LEVEL SECURITY; …' },
  { sev:'high', msg:'public.messages.embedding — index is IVFFLAT, recall < 0.7', fix:'DROP INDEX messages_embedding_idx; CREATE INDEX … USING hnsw (…);' },
  { sev:'med',  msg:'function exec_sql(text) — SECURITY DEFINER without search_path', fix:'ALTER FUNCTION exec_sql(text) SET search_path = pg_catalog, public;' },
  { sev:'low',  msg:'public.audit_events — table not partitioned (902k rows, growing)', fix:'consider monthly partitioning by ts' },
];

const HEALTH = {
  server: { mem: 847, mem_pct: 41, cpu: 28, cpu_pct: 28, uptime: '12d 4h 28m', version: 'PostgreSQL 16.2', host: 'pgserve.sock' },
  conn:   { active: 23, idle: 8, total: 1000, wait: 0, longest: '4.2s' },
  back:   [
    { pid: 4811, db: 'app_genie',  user: 'genie_rw', state: 'active', wait: '—',         q: 'SELECT * FROM messages WHERE …' },
    { pid: 4821, db: 'app_brain',  user: 'brain_rw', state: 'active', wait: 'IO/DataFileRead', q: 'INSERT INTO embeddings …' },
    { pid: 4824, db: 'app_loom',   user: 'loom_rw',  state: 'idle',   wait: '—',         q: '<IDLE in transaction>' },
    { pid: 4828, db: 'app_drift',  user: 'drift_rw', state: 'active', wait: 'Lock/transactionid', q: 'UPDATE sessions SET …' },
    { pid: 4830, db: 'app_brain',  user: 'brain_rw', state: 'active', wait: '—',         q: 'COPY embeddings FROM …' },
  ],
  res: { tx_per_s: 412, tps_history: [380,402,388,410,422,395,401,418,412,420,408,412], cache_hit: 98.4, wal: '32 MB/s', commits: 11042, rollbacks: 18 },
  pgi: { autovac: 'idle', last_vac: '03:14:00', last_an: '03:14:01', locks: 4, deadlocks: 0, longest_lock: '12ms' },
  vec: { indexes: 6, queries_per_s: 14, recall: 0.94, hnsw_build: '412 ms', dim: 1536 },
  cpu_history:   [22,28,31,26,24,29,34,28,25,28,31,28,26,30,28,32,28,28,29,28,27,28,30,28],
  mem_history:   [38,39,40,40,41,40,41,42,41,40,41,41,41,40,41,42,41,41,41,40,41,41,41,41],
  io_read_hist:  [12,18,14,22,28,18,14,16,22,18,14,16,18,22,16,14,18,16,14,18,16,14,18,16],
  io_write_hist: [4,8,6,10,14,8,6,8,10,8,6,8,10,12,8,6,10,8,6,10,8,6,10,8],
  /* lock waterfall — concurrent locks held over the last 12s, longest first */
  locks: [
    { pid:4828, mode:'RowExclusive',     rel:'sessions',   db:'app_drift', dur:12.4, blocking:0,   wait:'Lock/transactionid' },
    { pid:4811, mode:'AccessShare',      rel:'messages',   db:'app_genie', dur:8.1,  blocking:0,   wait:null },
    { pid:4821, mode:'RowExclusive',     rel:'embeddings', db:'app_brain', dur:5.6,  blocking:1,   wait:'IO/DataFileRead' },
    { pid:4830, mode:'AccessExclusive',  rel:'embeddings', db:'app_brain', dur:2.2,  blocking:0,   wait:null, blocked_by:4821 },
    { pid:4824, mode:'AccessShare',      rel:'sessions',   db:'app_loom',  dur:0.4,  blocking:0,   wait:null },
  ],
  /* autovacuum lane — past 60min of activity */
  vacuum_lane: [
    { rel:'app_brain.embeddings', start:-58, dur:6,   kind:'auto',   tuples:'2.4M', state:'done' },
    { rel:'app_brain.documents',  start:-44, dur:2,   kind:'auto',   tuples:'48K',  state:'done' },
    { rel:'app_genie.messages',   start:-30, dur:14,  kind:'auto',   tuples:'1.8M', state:'done' },
    { rel:'app_drift.sessions',   start:-18, dur:1,   kind:'analyze',tuples:'412K', state:'done' },
    { rel:'app_brain.embeddings', start:-3,  dur:8,   kind:'auto',   tuples:'124K', state:'running' },
  ],
  /* pgvector recall histogram — buckets and counts over last hour */
  recall_hist: [
    { bucket:'1.00',     count:12 },
    { bucket:'0.95-99',  count:28 },
    { bucket:'0.90-94',  count:34 },
    { bucket:'0.85-89',  count:18 },
    { bucket:'0.80-84',  count:8  },
    { bucket:'<0.80',    count:2  },
  ],
};

const SYNC_TARGETS = [
  { name:'prod-pg',       host:'prod-pg.internal:5432', state:'streaming', lag:'0.04s', slot:'sync_prod_pg', wal:'2.4 MB/s' },
  { name:'analytics-bq',  host:'bq-bridge:7000',         state:'streaming', lag:'0.18s', slot:'sync_bq',      wal:'412 KB/s' },
  { name:'cold-archive',  host:'archive.s3:443',         state:'paused',    lag:'—',     slot:'sync_archive', wal:'—' },
];

const BACKUPS = [
  { id:'b41', when:'2026-04-30 03:00', kind:'daily',   size:'4.1 GB', src:'app_brain', state:'ok' },
  { id:'b40', when:'2026-04-29 03:00', kind:'daily',   size:'4.0 GB', src:'app_brain', state:'ok' },
  { id:'b39', when:'2026-04-28 03:00', kind:'daily',   size:'3.9 GB', src:'app_brain', state:'ok' },
  { id:'b38', when:'2026-04-27 03:00', kind:'daily',   size:'3.8 GB', src:'app_brain', state:'ok' },
  { id:'b37', when:'2026-04-26 03:00', kind:'weekly',  size:'3.6 GB', src:'app_brain', state:'ok' },
  { id:'b36', when:'2026-04-19 03:00', kind:'weekly',  size:'3.1 GB', src:'app_brain', state:'ok' },
  { id:'b35', when:'2026-04-01 03:00', kind:'monthly', size:'2.4 GB', src:'app_brain', state:'ok' },
];

/* ============================================================
 * Swarm — agents that compose a SQL answer for a natural-language prompt
 * ============================================================ */

const SWARM_PROMPT = "show me everyone who hit a tool error in the last hour, ranked by how many times";

const SWARM_AGENTS = [
  {
    id: 'router', glyph: '◉', name: 'router',
    role: 'classify intent · pick swarm',
    state: 'done', t: 38,
    out: 'intent: read · target: app_brain · domain: tool_calls + sessions',
  },
  {
    id: 'scout', glyph: '◌', name: 'schema-scout',
    role: 'crawl information_schema · score relevance',
    state: 'done', t: 184,
    out: 'matched 3 tables · tool_calls (0.92) · sessions (0.71) · users (0.44)',
    branches: [
      { label: 'tool_calls.tool, status, session_id, ts', score: 0.92, picked: true },
      { label: 'sessions.id, user_id, started_at',        score: 0.71, picked: true },
      { label: 'users.id, email, display_name',           score: 0.44, picked: true },
    ],
  },
  {
    id: 'sniffer', glyph: '◐', name: 'sample-sniffer',
    role: "SELECT 5 from each candidate to confirm shape",
    state: 'done', t: 92,
    out: "tool_calls.status enum: ['ok','error','timeout','denied']  ·  matched 'error'",
  },
  {
    id: 'author', glyph: '◑', name: 'query-author',
    role: 'draft SQL · join through sessions to users',
    state: 'done', t: 211,
    out: 'draft v3 · 18 lines · 2 joins · time-bucket window',
  },
  {
    id: 'critic', glyph: '◒', name: 'critic',
    role: 'EXPLAIN · flag seq_scan · suggest rewrites',
    state: 'done', t: 64,
    out: 'plan ok · index hit on tool_calls(ts, status) · cost 184.2',
  },
  {
    id: 'exec', glyph: '●', name: 'executor',
    role: 'run · stream rows · format markdown',
    state: 'running', t: 12,
    out: 'streaming row 7/12…',
  },
];

// timeline of agent emissions (ms offset → which agent emitted what kind of event)
const SWARM_TIMELINE = [
  { ms: 0,    a: 'router',  kind: 'spawn'  },
  { ms: 38,   a: 'router',  kind: 'done'   },
  { ms: 38,   a: 'scout',   kind: 'spawn'  },
  { ms: 110,  a: 'scout',   kind: 'branch', label: 'tool_calls' },
  { ms: 138,  a: 'scout',   kind: 'branch', label: 'sessions' },
  { ms: 162,  a: 'scout',   kind: 'branch', label: 'users' },
  { ms: 184,  a: 'scout',   kind: 'done'   },
  { ms: 184,  a: 'sniffer', kind: 'spawn'  },
  { ms: 220,  a: 'sniffer', kind: 'sample' },
  { ms: 276,  a: 'sniffer', kind: 'done'   },
  { ms: 276,  a: 'author',  kind: 'spawn'  },
  { ms: 320,  a: 'author',  kind: 'draft', v: 1 },
  { ms: 410,  a: 'author',  kind: 'draft', v: 2 },
  { ms: 487,  a: 'author',  kind: 'draft', v: 3 },
  { ms: 487,  a: 'author',  kind: 'done'   },
  { ms: 487,  a: 'critic',  kind: 'spawn'  },
  { ms: 551,  a: 'critic',  kind: 'done'   },
  { ms: 551,  a: 'exec',    kind: 'spawn'  },
  { ms: 563,  a: 'exec',    kind: 'row',   row: 1 },
];

const SWARM_DRAFT_SQL = `-- query-author · v3 · accepted by critic
WITH window_errors AS (
  SELECT
    tc.session_id,
    tc.tool,
    tc.error_code
  FROM tool_calls tc
  WHERE tc.status = 'error'
    AND tc.ts > now() - INTERVAL '1 hour'
)
SELECT
  u.display_name,
  u.email,
  count(*)            AS error_count,
  array_agg(DISTINCT we.tool)  AS tools,
  max(we.error_code)  AS last_error
FROM window_errors we
JOIN sessions s ON s.id = we.session_id
JOIN users u    ON u.id = s.user_id
GROUP BY u.id, u.display_name, u.email
ORDER BY error_count DESC
LIMIT 25;`;

const SWARM_RESULT_ROWS = [
  { name:'eli rosen',     email:'eli@studio.dev',    n:14, tools:['code_run','grep'],          last:'TIMEOUT_4XX' },
  { name:'priya mehta',   email:'priya@studio.dev',  n:9,  tools:['code_run'],                  last:'TOOL_SCHEMA_MISMATCH' },
  { name:'jonas vetra',   email:'jonas@studio.dev',  n:7,  tools:['fetch_url','grep','tabulate'], last:'NETWORK_REFUSED' },
  { name:'mira asante',   email:'mira@studio.dev',   n:5,  tools:['fetch_url'],                 last:'NETWORK_REFUSED' },
  { name:'adam bryce',    email:'adam@studio.dev',   n:4,  tools:['code_run'],                  last:'TOOL_TIMEOUT' },
  { name:'lin yamamoto',  email:'lin@studio.dev',    n:3,  tools:['grep'],                      last:'PERMISSION_DENIED' },
  { name:'ofelia carrasco', email:'ofelia@studio.dev', n:2, tools:['fetch_url'],                last:'NETWORK_REFUSED' },
];

const SWARM_RECENT = [
  { id:'sw_91', t:'14:14:02', prompt:'top 10 slowest queries this morning',     ms:412,  status:'ok',    cost:0.0014 },
  { id:'sw_90', t:'14:08:41', prompt:'sessions that exceeded 50 tool calls',     ms:288,  status:'ok',    cost:0.0009 },
  { id:'sw_89', t:'13:55:11', prompt:'how many users haven\'t logged in for 7d', ms:140,  status:'cached',cost:0 },
  { id:'sw_88', t:'13:48:04', prompt:'find duplicate embeddings in docs',         ms:611,  status:'asked', cost:0.0021 },
  { id:'sw_87', t:'13:31:40', prompt:'audit events with no fingerprint match',    ms:204,  status:'ok',    cost:0.0011 },
];

/* ============================================================
 * Ingress — Unix-socket peercred + TCP bearer-token authentication
 *   mirrors src/fingerprint.js + src/daemon-tcp.js + src/tokens.js + src/control-db.js
 * ============================================================ */

const INGRESS_LISTENERS = [
  { id:'unix',  proto:'unix',  path:'/run/pgserve/control.sock',           since:'2026-04-26 09:14', conns:14, accepted:412881, denied:0,
    auth:'peercred · SO_PEERCRED → uid+pid', detail:'kernel-attested · cwd-walk → fingerprint' },
  { id:'tcp',   proto:'tcp',   path:'127.0.0.1:5433',                      since:'2026-04-26 09:14', conns:6,  accepted:1844,   denied:23,
    auth:'application_name=?fingerprint=…&token=…', detail:'sha256 hash · timing-safe compare' },
];

const INGRESS_FUNNEL = {
  windowLabel:'last 5 minutes',
  total: 1280,
  steps: [
    { id:'accept',     label:'socket accept',           kept:1280, dropped:0,   note:'after listen()' },
    { id:'startup',    label:'startup msg parsed',      kept:1278, dropped:2,   note:'truncated · 2' },
    { id:'auth',       label:'auth resolved',           kept:1265, dropped:13,  note:'token_unknown · 11 · malformed · 2' },
    { id:'fp_match',   label:'fingerprint match',       kept:1262, dropped:3,   note:'cross-fp attempt · 3' },
    { id:'db_route',   label:'db route',                kept:1261, dropped:1,   note:'db not provisioned · 1' },
    { id:'pg_proxy',   label:'pg proxy attached',       kept:1261, dropped:0,   note:'' },
  ],
};

const INGRESS_LIVE = [
  { ts:'14:18:14.221', proto:'unix', evt:'connection_routed', fp:'a1b2c3d4e5f6', mode:'package', pkg:'@automagik/genie',     uid:1000, pid:48211, db:'app_genie_a1b2c3d4e5f6',     ms:0.4,  status:'ok',     reason:null },
  { ts:'14:18:14.118', proto:'tcp',  evt:'tcp_token_used',    fp:'a1b2c3d4e5f6', mode:null,      tokenId:'4f12a9e0', uid:null,   pid:null,   db:'app_genie_a1b2c3d4e5f6', ms:0.9,  status:'ok',     reason:null, remote:'127.0.0.1:54812' },
  { ts:'14:18:13.880', proto:'tcp',  evt:'tcp_token_denied',  fp:'b9d4e7f1a3c2', mode:null,      tokenId:null,        uid:null,   pid:null,   db:null,                      ms:0.2,  status:'denied', reason:'token_unknown', remote:'127.0.0.1:54810' },
  { ts:'14:18:12.444', proto:'unix', evt:'connection_routed', fp:'b9d4e7f1a3c2', mode:'package', pkg:'@studio/brain',         uid:1000, pid:48199, db:'app_brain_b9d4e7f1a3c2',     ms:0.5,  status:'ok',     reason:null },
  { ts:'14:18:11.992', proto:'unix', evt:'connection_routed', fp:'c4d8e2b6f0a9', mode:'script',  pkg:null,                    uid:1001, pid:48190, db:'svc_omx_c4d8e2b6f0a9',       ms:0.6,  status:'ok',     reason:null },
  { ts:'14:18:11.041', proto:'tcp',  evt:'tcp_token_used',    fp:'a1b2c3d4e5f6', mode:null,      tokenId:'4f12a9e0', uid:null,   pid:null,   db:'app_genie_a1b2c3d4e5f6', ms:1.1,  status:'ok',     reason:null, remote:'10.42.0.7:51220' },
  { ts:'14:18:09.661', proto:'tcp',  evt:'tcp_token_denied',  fp:null,           mode:null,      tokenId:null,        uid:null,   pid:null,   db:null,                      ms:0.1,  status:'denied', reason:'missing_or_malformed_application_name', remote:'10.42.0.13:51188' },
  { ts:'14:18:08.220', proto:'unix', evt:'connection_routed', fp:'a1b2c3d4e5f6', mode:'package', pkg:'@automagik/genie',     uid:1000, pid:48184, db:'app_genie_a1b2c3d4e5f6',     ms:0.4,  status:'ok',     reason:null },
  { ts:'14:18:07.103', proto:'unix', evt:'connection_routed', fp:'e8f1a2b3c4d5', mode:'package', pkg:'@studio/jobs',          uid:1001, pid:48171, db:'svc_jobs_e8f1a2b3c4d5',      ms:0.7,  status:'ok',     reason:null },
  { ts:'14:18:06.554', proto:'tcp',  evt:'tcp_token_used',    fp:'b9d4e7f1a3c2', mode:null,      tokenId:'9c3e801b', uid:null,   pid:null,   db:'app_brain_b9d4e7f1a3c2', ms:1.0,  status:'ok',     reason:null, remote:'10.42.0.7:51160' },
  { ts:'14:18:05.099', proto:'tcp',  evt:'tcp_token_denied',  fp:'a1b2c3d4e5f6', mode:null,      tokenId:null,        uid:null,   pid:null,   db:null,                      ms:0.3,  status:'denied', reason:'cross_fingerprint_attempt', remote:'10.42.0.21:50998' },
  { ts:'14:18:04.011', proto:'unix', evt:'connection_routed', fp:'f7c1b2d3e4a5', mode:'script',  pkg:null,                    uid:1000, pid:48150, db:'svc_repl_f7c1b2d3e4a5',      ms:0.5,  status:'ok',     reason:null },
];

const INGRESS_TOKENS = [
  { id:'4f12a9e0', fp:'a1b2c3d4e5f6', pkg:'@automagik/genie', issued:'2026-04-26 09:14', lastUsed:'14:18:14', uses:18244,  status:'active',  note:'CI · ci-runner@gha' },
  { id:'9c3e801b', fp:'b9d4e7f1a3c2', pkg:'@studio/brain',    issued:'2026-04-22 11:02', lastUsed:'14:18:06', uses:9211,   status:'active',  note:'analytics · prod read' },
  { id:'2a8d3f7c', fp:'c4d8e2b6f0a9', pkg:'svc_omx (script)', issued:'2026-04-18 16:40', lastUsed:'13:50:11', uses:412,    status:'active',  note:'omx ingest worker' },
  { id:'7e0b1c4d', fp:'e8f1a2b3c4d5', pkg:'@studio/jobs',     issued:'2026-04-12 08:29', lastUsed:'12:14:02', uses:5022,   status:'expiring',note:'rotates in 47m' },
  { id:'88a4f1e2', fp:'a1b2c3d4e5f6', pkg:'@automagik/genie', issued:'2026-03-30 14:11', lastUsed:'2026-04-22 09:00', uses:1208, status:'idle',    note:'unused 8d · candidate to revoke' },
  { id:'5d2b9011', fp:'(deleted)',    pkg:'(deleted)',         issued:'2026-03-12 10:00', lastUsed:'2026-03-15 04:22', uses:88,   status:'revoked', note:'manual · key rotation' },
];

const INGRESS_DENY_REASONS = [
  { code:'token_unknown',                         count:11, share:0.478, hint:'hash not in pgserve_meta.allowed_tokens' },
  { code:'missing_or_malformed_application_name', count:8,  share:0.348, hint:'app_name did not parse to {fp,token}' },
  { code:'cross_fingerprint_attempt',             count:3,  share:0.130, hint:'token valid for fp X · presented for fp Y' },
  { code:'unknown_fingerprint',                   count:1,  share:0.044, hint:'fp present but no pgserve_meta row' },
];

const INGRESS_FP_DETAIL = {
  fp: 'a1b2c3d4e5f6',
  mode: 'package',
  packageRealpath: '/Users/dev/code/genie',
  packageName: '@automagik/genie',
  uid: 1000,
  derivation: 'sha256(realpath \\0 name \\0 uid)[:12]',
  db: 'app_genie_a1b2c3d4e5f6',
  liveness_pid: 48211,
  persisted: true,
  tokens: 2,
  sample: 'sha256("0/Users/dev/code/genie\\0@automagik/genie\\01000")',
};

window.PGS = {
  DBS, SCHEMAS, TABLE_COLS, TABLE_ROWS, SQL_TABS, SQL_HISTORY, SLOW_QUERIES, BLOAT, AUDIT, ROLES, LINTS, HEALTH, SYNC_TARGETS, BACKUPS,
  SWARM_PROMPT, SWARM_AGENTS, SWARM_TIMELINE, SWARM_DRAFT_SQL, SWARM_RESULT_ROWS, SWARM_RECENT,
  INGRESS_LISTENERS, INGRESS_FUNNEL, INGRESS_LIVE, INGRESS_TOKENS, INGRESS_DENY_REASONS, INGRESS_FP_DETAIL,
};
