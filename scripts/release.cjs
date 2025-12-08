#!/usr/bin/env node

/**
 * Release Script for pgserve
 *
 * Usage:
 *   node scripts/release.cjs --action bump-rc|promote [--dry-run]
 *
 * Actions:
 *   bump-rc  - Bump RC version (1.0.8 -> 1.0.9-rc.1, or 1.0.9-rc.1 -> 1.0.9-rc.2)
 *   promote  - Promote RC to stable (1.0.9-rc.2 -> 1.0.9)
 *
 * Outputs (for GitHub Actions):
 *   version   - New version number
 *   tag       - Git tag (v1.0.9-rc.1)
 *   npm_tag   - npm dist-tag (next or latest)
 *   is_promote - true if this is a promotion (skip build)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

// Parse arguments
function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        opts[key] = nextArg;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const dryRun = opts['dry-run'] || false;

function log(msg) {
  console.log(`[release] ${msg}`);
}

function exec(cmd, options = {}) {
  if (dryRun && !options.readOnly) {
    log(`[dry-run] Would execute: ${cmd}`);
    return '';
  }
  return execSync(cmd, { encoding: 'utf8', cwd: ROOT, ...options }).trim();
}

function getCurrentVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

function updateVersion(newVersion) {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  pkg.version = newVersion;
  if (!dryRun) {
    fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + '\n');
  }
  log(`Updated package.json version: ${newVersion}`);
}

function bumpRcVersion(currentVersion) {
  // Check if already an RC: 1.0.9-rc.1 -> 1.0.9-rc.2
  const rcMatch = currentVersion.match(/^(\d+\.\d+\.\d+)-rc\.(\d+)$/);
  if (rcMatch) {
    const [, base, rcNum] = rcMatch;
    return `${base}-rc.${parseInt(rcNum) + 1}`;
  }

  // Not an RC, bump patch and start at rc.1: 1.0.8 -> 1.0.9-rc.1
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid version format: ${currentVersion}`);

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${parseInt(patch) + 1}-rc.1`;
}

function promoteToStable(currentVersion) {
  // If RC version: 1.0.9-rc.2 -> 1.0.9
  const rcMatch = currentVersion.match(/^(\d+\.\d+\.\d+)-rc\.\d+$/);
  if (rcMatch) {
    return rcMatch[1];
  }

  // If already stable: 1.1.1 -> 1.1.2 (bump patch for new stable release)
  const stableMatch = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (stableMatch) {
    const [, major, minor, patch] = stableMatch;
    return `${major}.${minor}.${parseInt(patch) + 1}`;
  }

  throw new Error(`Invalid version format: ${currentVersion}`);
}

function createTag(version) {
  const tag = `v${version}`;
  const commitMsg = `chore: release ${tag}`;

  if (dryRun) {
    log(`[dry-run] Would commit: "${commitMsg}"`);
    log(`[dry-run] Would create tag: ${tag}`);
    return tag;
  }

  // Stage and commit
  exec('git add package.json');
  try {
    exec(`git commit -m "${commitMsg}"`);
  } catch (e) {
    log('Nothing to commit (version already matches)');
  }

  // Create annotated tag
  exec(`git tag -a ${tag} -m "Release ${tag}"`);
  log(`Created tag: ${tag}`);

  return tag;
}

function outputForGitHubActions(version, tag, isPromote) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const npmTag = version.includes('-rc.') ? 'next' : 'latest';
    fs.appendFileSync(output, `version=${version}\n`);
    fs.appendFileSync(output, `tag=${tag}\n`);
    fs.appendFileSync(output, `npm_tag=${npmTag}\n`);
    fs.appendFileSync(output, `is_promote=${isPromote}\n`);
    log(`GitHub Actions outputs set: version=${version}, tag=${tag}, npm_tag=${npmTag}, is_promote=${isPromote}`);
  }
}

async function main() {
  const action = opts['action'];

  if (!action) {
    console.error('Usage: node scripts/release.cjs --action bump-rc|promote [--dry-run]');
    console.error('');
    console.error('Actions:');
    console.error('  bump-rc  - Create new RC version');
    console.error('  promote  - Promote current RC to stable');
    process.exit(1);
  }

  const currentVersion = getCurrentVersion();
  log(`Current version: ${currentVersion}`);

  let newVersion;
  let isPromote = false;

  switch (action) {
    case 'bump-rc':
      newVersion = bumpRcVersion(currentVersion);
      break;
    case 'promote':
      newVersion = promoteToStable(currentVersion);
      isPromote = true;
      break;
    default:
      console.error(`Unknown action: ${action}`);
      console.error('Valid actions: bump-rc, promote');
      process.exit(1);
  }

  log(`New version: ${newVersion}`);

  // Update package.json
  updateVersion(newVersion);

  // Create git tag
  const tag = createTag(newVersion);

  // Output for GitHub Actions
  // Note: Release notes are auto-generated by GitHub via .github/release.yml
  outputForGitHubActions(newVersion, tag, isPromote);

  log(`Release ${tag} prepared!`);
  if (!dryRun) {
    log('Push with: git push && git push --tags');
  }
}

main().catch(e => {
  console.error(`[release] Error: ${e.message}`);
  process.exit(1);
});
