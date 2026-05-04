/**
 * Tests for src/cli/autopg.js — listApps verb (Group 5,
 * autopg-distribution-cutover wish).
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import { listApps, __test_internals as cli } from '../../src/cli/autopg.js';

function captureStreams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    get out() { return stdout; },
    get err() { return stderr; },
  };
}

beforeEach(() => { cli.resetSqlExecutor(); });
afterEach(() => { cli.resetSqlExecutor(); });

describe('listApps', () => {
  test('prints a header + one row per app, ordered by app', async () => {
    cli.setSqlExecutor(({ sql, captureStdout }) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      if (captureStdout && /information_schema\.tables.*'autopg_apps'/.test(trimmed)) return 't';
      if (captureStdout && /SELECT app, role, db, manifest_sig_verified FROM autopg_meta\.autopg_apps ORDER BY app/.test(trimmed)) {
        return 'genie|genie|genie|t\nomni|omni|omni|t';
      }
      throw new Error(`unexpected SQL: ${trimmed}`);
    });
    const cap = captureStreams();
    const code = await listApps([], cap);
    expect(code).toBe(0);
    const lines = cap.out.trim().split('\n');
    expect(lines[0]).toBe('app\trole\tdb\tmanifest_sig_verified');
    expect(lines[1]).toBe('genie\tgenie\tgenie\ttrue');
    expect(lines[2]).toBe('omni\tomni\tomni\ttrue');
  });

  test('empty list prints "no apps provisioned"', async () => {
    cli.setSqlExecutor(({ sql, captureStdout }) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      if (captureStdout && /information_schema\.tables.*'autopg_apps'/.test(trimmed)) return 't';
      if (captureStdout && /SELECT app, role, db, manifest_sig_verified FROM autopg_meta\.autopg_apps/.test(trimmed)) {
        return '';
      }
      throw new Error(`unexpected SQL: ${trimmed}`);
    });
    const cap = captureStreams();
    const code = await listApps([], cap);
    expect(code).toBe(0);
    expect(cap.out).toMatch(/no apps provisioned/);
  });
});
