# autopg cosign keys

This directory holds the **public** verification key consumers use to
verify autopg release tarballs. The matching private key is held in
GitHub Actions secrets and is **never** committed to this repo.

## Files

| File | Purpose |
|------|---------|
| `cosign.pub` | Public verification key. Distributed at `cdn.automagik.dev/autopg/keys/cosign.pub` and bundled with this repo so consumers can `git clone` and verify offline. |

## How signing works

1. Group 7 of the wish (`build-tarballs.yml`) builds per-platform
   tarballs at `dist/autopg-<version>-<platform>.tar.gz`.
2. Group 8 (`sign-attest.yml`) downloads those artifacts and:
   - Signs each tarball with `cosign sign-blob --key env://COSIGN_PRIVATE_KEY`
     using the password in `COSIGN_PASSWORD`.
   - Generates SLSA L3 build provenance via
     `actions/attest-build-provenance@v1`.
   - Aggregates a top-level `manifest.json` listing every tarball with
     its SHA256, signature URL, and provenance URL.
3. Group 9 (CDN publish) uploads the tarballs, signatures, provenance
   files, this `cosign.pub`, and `manifest.json` to
   `cdn.automagik.dev/autopg/<channel>/<version>/<platform>/`.

## How consumers verify

```bash
# 1) cosign verify-blob (key-based)
cosign verify-blob \
  --key keys/cosign.pub \
  --signature dist/autopg-<version>-<platform>.tar.gz.sig \
  dist/autopg-<version>-<platform>.tar.gz

# 2) slsa-verifier (provenance)
slsa-verifier verify-artifact \
  dist/autopg-<version>-<platform>.tar.gz \
  --provenance-path dist/autopg-<version>-<platform>.tar.gz.intoto.jsonl \
  --source-uri github.com/automagik-dev/autopg

# 3) End-to-end check covering every published tarball:
bash scripts/verify-published-artifacts.sh dist/
```

## Key rotation

1. Generate a new keypair locally:
   ```bash
   COSIGN_PASSWORD='<strong-pass>' cosign generate-key-pair
   ```
2. Replace `keys/cosign.pub` with the new public key (commit + PR).
3. Update GitHub Actions secrets:
   - `COSIGN_PRIVATE_KEY`: full contents of `cosign.key`
   - `COSIGN_PASSWORD`: the password used during generation
4. Cut a new release. Old releases stay verifiable against archived
   copies of the prior `cosign.pub`; consumers should refresh their
   cached key after a rotation.

## Fixture key (do NOT use for production)

`tests/fixtures/cosign/` holds a *separate* dev keypair used by
`scripts/verify-published-artifacts.sh` self-tests. The matching
private key is committed there because it is fixture-only — never
trust signatures verified against the fixture key in production.
