#!/usr/bin/env bun

/**
 * autopg-cli — the unified entry point for the COMPILED single-binary
 * distribution (BRIEF-v3-build-fix blocker #10).
 *
 * `scripts/build-binary.sh` compiles THIS file with `bun build --compile`.
 * The tarball's `autopg` IS this module.
 *
 * Why this exists: the npm package's bin (`bin/autopg-wrapper.cjs`) is a
 * node launcher that resolves an external `bun` from node_modules and
 * spawns it on `bin/postgres-server.js` for the long-running paths, while
 * routing the pure-node operator verbs (install / verify / doctor / …)
 * in-process through `src/cli-install.cjs`. That spawn-external-bun model
 * cannot exist inside a single compiled binary — there is no node_modules
 * and the binary already IS the runtime. Before this entry, the build
 * compiled bare `postgres-server.js`, so the tarball `autopg` only knew
 * `--version` / `postmaster` / `serve` and every operator verb (and
 * install.sh's own final `autopg install`) exited 1 with a help dump.
 *
 * This entry mirrors the wrapper's dispatch, MINUS the bun-spawn:
 *   - `--version` / `-v`         → print `autopg <version>` (exit 0)
 *   - install/operator verbs     → src/cli-install.cjs `dispatch()` in
 *                                  process. The supervised postmaster
 *                                  command is THIS executable
 *                                  (`process.execPath`) invoked with
 *                                  `postmaster` — pm2 runs it under
 *                                  `--interpreter none`, and the binary
 *                                  handles `postmaster` natively.
 *   - postmaster/serve/help/…    → delegate to bin/postgres-server.js
 *                                  (re-used as a module; it reads argv).
 *
 * Keep the verb set in sync with bin/autopg-wrapper.cjs's
 * __installSubcommands — that file remains the npm-path dispatcher.
 */

import cliInstall from '../src/cli-install.cjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const sub = args[0];

// `autopg --version` / `-v` — MUST exit 0 with `autopg <version>`.
// Same contract + version source as bin/postgres-server.js (the bun
// `--define BUILD_VERSION` literal in the compiled binary, package.json
// fallback otherwise). `typeof` on an undeclared id is the one safe form.
if (sub === '--version' || sub === '-v') {
  process.stdout.write(`autopg ${resolveVersion()}\n`);
  process.exit(0);
}

// Mirror of bin/autopg-wrapper.cjs __installSubcommands (the authoritative
// npm-path routing). These are pure node + child_process — no bun, no
// running PG backend — so they run in-process here.
const INSTALL_SUBCOMMANDS = new Set([
  'install',
  'uninstall',
  'status',
  'url',
  'port',
  'config',
  'update',
  'restart',
  'ui',
  'verify',
  'doctor',
  'trust',
  'gc',
  'provision',
  'create-app',
]);

if (sub && INSTALL_SUBCOMMANDS.has(sub)) {
  // In the compiled binary, the postmaster the supervisor (pm2) must run
  // is THIS executable with `postmaster`. process.execPath is the compiled
  // binary path; buildPm2StartArgs() does
  //   pm2 start <scriptPath> --interpreter none -- postmaster …
  // so pm2 execs `<self> postmaster …`, which the binary handles.
  const self = process.execPath;
  const result = cliInstall.dispatch(sub, process.argv.slice(3), {
    scriptPath: self,
    wrapperPath: self,
  });

  // dispatch() returns either a number (sync verbs) or a Promise (async
  // verbs: uninstall/doctor/verify/trust/gc/provision/create-app/update).
  // Mirror the wrapper's dual handling + the EADDRINUSE double-print guard.
  if (result && typeof result.then === 'function') {
    result.then(
      (code) => process.exit(typeof code === 'number' ? code : 0),
      (err) => {
        if (err && err.code !== 'EADDRINUSE') {
          process.stderr.write(`autopg: ${err?.message ?? err}\n`);
        }
        if (process.exitCode === undefined || process.exitCode === 0) {
          process.exitCode = 1;
        }
      },
    );
  } else {
    process.exit(typeof result === 'number' ? result : 0);
  }
} else {
  // postmaster / serve / --help / help / empty / unknown flags →
  // bin/postgres-server.js owns this surface (it reads process.argv and
  // dispatches, including its own `serve`→`postmaster` alias + the
  // EX_USAGE-style unknown-verb exit). Re-used as a module so there is a
  // single postmaster implementation.
  await import('./postgres-server.js');
}

function resolveVersion() {
  if (typeof BUILD_VERSION !== 'undefined' && BUILD_VERSION) return BUILD_VERSION;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
