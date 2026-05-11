/**
 * Tests for the hardcoded TRUSTED_IDENTITIES list.
 *
 * Wave A (v2.6.x): regression coverage for the trust-regex anchor
 * targets — must match the actual signing workflow file path on each
 * producer (genie/omni use release.yml; pgserve uses sign-attest.yml
 * because release.yml is the unrelated npm-publish pipeline).
 */

import { test, expect, describe } from 'bun:test';
import {
  TRUSTED_IDENTITIES,
  SIGSTORE_GITHUB_ACTIONS_ISSUER,
  getTrustedById,
  getTrustedByPublisher,
  listHardcodedTrust,
} from '../../src/cosign/trust-list.js';

describe('TRUSTED_IDENTITIES shape', () => {
  test('is frozen — Object.freeze on the array and each entry', () => {
    expect(Object.isFrozen(TRUSTED_IDENTITIES)).toBe(true);
    for (const entry of TRUSTED_IDENTITIES) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  test('every entry binds to the GitHub Actions OIDC issuer', () => {
    for (const entry of TRUSTED_IDENTITIES) {
      expect(entry.issuer).toBe(SIGSTORE_GITHUB_ACTIONS_ISSUER);
    }
  });

  test('every entry has a non-empty id, identityRegexp, description', () => {
    for (const entry of TRUSTED_IDENTITIES) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.identityRegexp).toBe('string');
      expect(entry.identityRegexp.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
    }
  });
});

describe('automagik-pgserve-release entry (Wave A regression)', () => {
  test('anchors on sign-attest.yml (NOT release.yml)', () => {
    const entry = getTrustedById('automagik-pgserve-release');
    expect(entry).toBeTruthy();
    // Wave A regression: anchor must match the actual signing workflow
    // file. release.yml is pgserve's npm-publish workflow; the cosign
    // signing pipeline lives in sign-attest.yml.
    expect(entry.identityRegexp).toMatch(/sign-attest\.yml@/);
    expect(entry.identityRegexp).not.toMatch(/release\.yml@/);
    // refs/tags/v* binding is preserved (mirror of genie PR #1725).
    expect(entry.identityRegexp).toMatch(/refs\/tags\/v\.\*\$/);
  });

  test('matches a synthetic post-Wave-A cert subject', () => {
    const entry = getTrustedById('automagik-pgserve-release');
    const re = new RegExp(entry.identityRegexp);
    expect(
      re.test(
        'https://github.com/namastexlabs/pgserve/.github/workflows/sign-attest.yml@refs/tags/v2.6.4',
      ),
    ).toBe(true);
    // Must NOT match release.yml subjects (the unrelated npm workflow).
    expect(
      re.test(
        'https://github.com/namastexlabs/pgserve/.github/workflows/release.yml@refs/tags/v2.6.4',
      ),
    ).toBe(false);
    // Must NOT match a different repo with the same workflow filename.
    expect(
      re.test(
        'https://github.com/someone-else/pgserve/.github/workflows/sign-attest.yml@refs/tags/v2.6.4',
      ),
    ).toBe(false);
    // Must NOT match branch refs — only refs/tags/v.*.
    expect(
      re.test(
        'https://github.com/namastexlabs/pgserve/.github/workflows/sign-attest.yml@refs/heads/main',
      ),
    ).toBe(false);
  });

  test('publisher is the bare "pgserve" name (matches package.json)', () => {
    const entry = getTrustedById('automagik-pgserve-release');
    expect(entry.publisher).toBe('pgserve');
  });
});

describe('genie + omni entries (cohort siblings — regression sanity)', () => {
  test('genie entry anchors on automagik-dev/genie sign-attest.yml@refs/tags/v.*', () => {
    // genie's release.yml is an orchestrator that workflow_call's into
    // sign-attest.yml — the Fulcio SAN URI binds to sign-attest.yml@<ref>.
    // Verified empirically against v4.260511.1 + v4.260511.2 bundle certs
    // on 2026-05-11. Locking the regex shape here so a regression that
    // reverts to `release.yml@` is caught at unit-test time, not at
    // `pgserve verify --slug genie` runtime.
    const entry = getTrustedById('automagik-genie-release');
    expect(entry).toBeTruthy();
    expect(entry.identityRegexp).toMatch(
      /^\^https:\/\/github\.com\/automagik-dev\/genie\/\.github\/workflows\/sign-attest\.yml@refs\/tags\/v\.\*\$$/,
    );
  });

  test('omni entry anchors on automagik-dev/omni release.yml@refs/tags/v.*', () => {
    const entry = getTrustedById('automagik-omni-release');
    expect(entry).toBeTruthy();
    expect(entry.identityRegexp).toMatch(
      /^\^https:\/\/github\.com\/automagik-dev\/omni\/\.github\/workflows\/release\.yml@refs\/tags\/v\.\*\$$/,
    );
  });
});

describe('lookup helpers', () => {
  test('getTrustedById returns null for an unknown id', () => {
    expect(getTrustedById('does-not-exist')).toBe(null);
  });

  test('getTrustedByPublisher returns null for an unknown publisher', () => {
    expect(getTrustedByPublisher('@nope/none')).toBe(null);
  });

  test('listHardcodedTrust marks every entry as source=hardcoded removable=false', () => {
    const list = listHardcodedTrust();
    expect(list.length).toBe(TRUSTED_IDENTITIES.length);
    for (const entry of list) {
      expect(entry.source).toBe('hardcoded');
      expect(entry.removable).toBe(false);
    }
  });
});
