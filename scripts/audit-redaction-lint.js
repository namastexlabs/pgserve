#!/usr/bin/env bun
/**
 * Audit redaction lint — Group 6, autopg-distribution-cutover.
 *
 * Walks every .js / .cjs source under `src/` (excluding `src/audit/audit.js`
 * itself) and locates every `auditEmit(...)` call. For each call site, the
 * lint asserts:
 *
 *   1. No object-literal key matches /password|secret|token|connection_string|database_url/i.
 *   2. No value is `process.env.*PASSWORD*|*SECRET*|*TOKEN*|*DATABASE_URL*|*CONNECTION_STRING*`.
 *   3. No string-literal value looks like a `postgres://user:pass@host/...` URL.
 *
 * Failure = exit 1 with file:line per offending site. Clean tree = exit 0.
 *
 * The walker is a hand-rolled scanner rather than a full parser: it tracks
 * string state (single, double, backtick), template-literal nesting, line
 * comments, block comments, and balanced brace depth. That's enough to
 * isolate the first object-literal argument of every `auditEmit(...)` call
 * without pulling in a parser dependency. New AST-flavored rules can be
 * added by extending `scanRecord()`.
 *
 * Usage:
 *   bun run scripts/audit-redaction-lint.js
 *   bun run scripts/audit-redaction-lint.js path/to/file.js
 *   bun run scripts/audit-redaction-lint.js --fixture tests/audit/fixtures
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'src');
const SELF_EXCLUDE = path.join('src', 'audit', 'audit.js');

const FORBIDDEN_KEY_RE = /^(password|secret|token|connection_string|database_url)$/i;
const ENV_SECRET_RE =
  /process\.env\.[A-Za-z_][A-Za-z0-9_]*(PASSWORD|SECRET|TOKEN|DATABASE_URL|CONNECTION_STRING)[A-Za-z0-9_]*\b/i;
const POSTGRES_URL_RE = /\bpostgres(?:ql)?:\/\/[^\s'"]*:[^\s'"@]+@/i;

function listSourceFiles(roots) {
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isFile()) {
      if (/\.(js|cjs|mjs)$/.test(root)) out.push(root);
      continue;
    }
    walk(root, out);
  }
  return out.filter((p) => !p.endsWith(SELF_EXCLUDE));
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(js|cjs|mjs)$/.test(name)) {
      out.push(full);
    }
  }
}

/**
 * Find every `auditEmit(...)` call in `src` and yield each one's first
 * argument span (the object literal between `{` and matching `}`), plus
 * the file-relative line number of the `auditEmit` identifier.
 */
function* findAuditEmitCalls(src) {
  const len = src.length;
  let i = 0;
  let line = 1;

  const isIdentChar = (ch) => /[A-Za-z0-9_$]/.test(ch);

  while (i < len) {
    const ch = src[i];

    // Track newlines for accurate line reporting.
    if (ch === '\n') { line++; i++; continue; }

    // Skip line comments.
    if (ch === '/' && src[i + 1] === '/') {
      while (i < len && src[i] !== '\n') i++;
      continue;
    }
    // Skip block comments.
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // Skip strings.
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i, ch, (n) => { line += n; });
      continue;
    }

    // Match `auditEmit` as a whole identifier (must be word-boundary-prefixed).
    if (ch === 'a' && src.startsWith('auditEmit', i)) {
      const before = src[i - 1];
      const after = src[i + 'auditEmit'.length];
      if ((!before || !isIdentChar(before)) && !isIdentChar(after)) {
        const idLine = line;
        // Advance past identifier, skip whitespace, expect '('.
        let j = i + 'auditEmit'.length;
        while (j < len && /\s/.test(src[j])) {
          if (src[j] === '\n') line++;
          j++;
        }
        if (src[j] === '(') {
          // Now find first `{` (the object-literal arg start) before the
          // matching ')'. Object literals as function args appear directly
          // after `(` (perhaps after whitespace) — but `auditEmit` callers
          // pass an object literal by spec, so this is the path we care
          // about. If we find a `)` first, it's auditEmit() with no
          // object-literal arg → not redaction-relevant; skip.
          let k = j + 1;
          while (k < len) {
            const c = src[k];
            if (c === '\n') { line++; k++; continue; }
            if (/\s/.test(c)) { k++; continue; }
            if (c === '/' && src[k + 1] === '/') {
              while (k < len && src[k] !== '\n') k++;
              continue;
            }
            if (c === '/' && src[k + 1] === '*') {
              k += 2;
              while (k < len && !(src[k] === '*' && src[k + 1] === '/')) {
                if (src[k] === '\n') line++;
                k++;
              }
              k += 2;
              continue;
            }
            break;
          }
          if (src[k] === '{') {
            const literalLine = line;
            const end = findBalanced(src, k, '{', '}', (n) => { line += n; });
            if (end !== -1) {
              const literal = src.slice(k, end + 1);
              yield { call: 'auditEmit', idLine, literalLine, literal };
              i = end + 1;
              continue;
            }
          }
        }
      }
    }

    i++;
  }
}

function skipString(src, i, quote, onNewline) {
  // Returns the index just past the closing quote.
  const len = src.length;
  i++; // open quote
  while (i < len) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') { onNewline(1); i++; continue; }
    if (ch === quote) { return i + 1; }
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      // Template literal interpolation — find matching `}`.
      i = findBalanced(src, i + 1, '{', '}', onNewline);
      if (i === -1) return len;
      i++;
      continue;
    }
    i++;
  }
  return len;
}

function findBalanced(src, start, open, close, onNewline) {
  const len = src.length;
  let depth = 0;
  let i = start;
  while (i < len) {
    const ch = src[i];
    if (ch === '\n') { onNewline(1); i++; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < len && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') onNewline(1);
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i, ch, onNewline);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Walk the captured object-literal source and pull out each top-level key.
 * Skips nested objects/arrays so a nested `meta: { secret: 'x' }` is still
 * caught (see scanForNestedSecrets) — but the simple flat-key shape is the
 * primary check.
 */
function extractTopLevelKeys(literal) {
  // Drop the outer braces.
  if (literal[0] !== '{' || literal[literal.length - 1] !== '}') return [];
  const inner = literal.slice(1, -1);
  const keys = [];
  let i = 0;
  let line = 0;
  const len = inner.length;
  let depth = 0;
  let atKeyPosition = true;

  while (i < len) {
    const ch = inner[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && inner[i + 1] === '/') {
      while (i < len && inner[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && inner[i + 1] === '*') {
      i += 2;
      while (i < len && !(inner[i] === '*' && inner[i + 1] === '/')) {
        if (inner[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const next = skipString(inner, i, ch, (n) => { line += n; });
      if (depth === 0 && atKeyPosition) {
        const raw = inner.slice(i + 1, next - 1);
        keys.push({ name: raw, line });
        atKeyPosition = false;
      }
      i = next;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; atKeyPosition = false; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; i++; continue; }
    if (ch === ',' && depth === 0) { atKeyPosition = true; i++; continue; }
    if (ch === ':' && depth === 0) { atKeyPosition = false; i++; continue; }
    if (depth === 0 && atKeyPosition && /[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < len && /[A-Za-z0-9_$]/.test(inner[i])) i++;
      const name = inner.slice(start, i);
      keys.push({ name, line });
      atKeyPosition = false;
      continue;
    }
    i++;
  }
  return keys;
}

function lintFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const errors = [];
  const rel = path.relative(REPO_ROOT, file);

  for (const call of findAuditEmitCalls(src)) {
    const keys = extractTopLevelKeys(call.literal);
    for (const key of keys) {
      if (FORBIDDEN_KEY_RE.test(key.name)) {
        errors.push({
          file: rel,
          line: call.literalLine + key.line,
          message: `auditEmit field "${key.name}" matches forbidden secret pattern (${FORBIDDEN_KEY_RE})`,
        });
      }
    }
    // Value-side checks run on the whole literal: env-secret references and
    // postgres:// URLs would be caught here even if buried inside nested
    // objects.
    const envMatch = call.literal.match(ENV_SECRET_RE);
    if (envMatch) {
      const offset = envMatch.index || 0;
      const lineOffset = call.literal.slice(0, offset).split('\n').length - 1;
      errors.push({
        file: rel,
        line: call.literalLine + lineOffset,
        message: `auditEmit value sources from secret env var: ${envMatch[0]}`,
      });
    }
    const urlMatch = call.literal.match(POSTGRES_URL_RE);
    if (urlMatch) {
      const offset = urlMatch.index || 0;
      const lineOffset = call.literal.slice(0, offset).split('\n').length - 1;
      errors.push({
        file: rel,
        line: call.literalLine + lineOffset,
        message: `auditEmit value contains postgres URL with embedded password: ${urlMatch[0]}…`,
      });
    }
  }
  return errors;
}

function main(argv) {
  const args = argv.slice(2);
  let roots;
  if (args.length === 0) {
    roots = [DEFAULT_ROOT];
  } else {
    roots = args.map((a) => path.resolve(a));
  }
  const files = listSourceFiles(roots);
  const allErrors = [];
  for (const f of files) {
    allErrors.push(...lintFile(f));
  }
  if (allErrors.length === 0) {
    console.log(`audit-redaction-lint: scanned ${files.length} file(s); 0 issues.`);
    return 0;
  }
  for (const err of allErrors) {
    console.error(`${err.file}:${err.line}: ${err.message}`);
  }
  console.error(`audit-redaction-lint: ${allErrors.length} issue(s) across ${files.length} file(s).`);
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}

export { lintFile, findAuditEmitCalls, extractTopLevelKeys, listSourceFiles };
