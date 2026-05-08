# cosign fixture keypair

**For tests only. Do NOT use these keys to sign production artifacts.**

`scripts/verify-published-artifacts.sh` and the matching test in
`tests/integration/verify-published-artifacts.sh` use this keypair so
the cosign + SLSA verification flow can be exercised end-to-end on
machines with no network access and no GitHub Actions OIDC tokens.

## Files

| File | Purpose |
|------|---------|
| `cosign.pub` | Test-only public key. Override consumed via `AUTOPG_COSIGN_PUB`. |
| `cosign.key` | Encrypted test-only private key. Password: `autopg-fixture`. |

If a leak ever occurs (the password is committed alongside the key),
rotate by regenerating both files with:

```bash
cd tests/fixtures/cosign
rm cosign.key cosign.pub
COSIGN_PASSWORD='autopg-fixture' cosign generate-key-pair
```
