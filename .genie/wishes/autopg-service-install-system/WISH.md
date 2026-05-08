# Wish: `autopg service install --system` — privileged system-wide systemd unit

| Field | Value |
|-------|-------|
| **Status** | DRAFT (parked for post-v2.4 `/dream` queue) |
| **Slug** | `autopg-service-install-system` |
| **Date** | 2026-05-08 |
| **Author** | Felipe Rosa (split out from `autopg-distribution-cutover` G11.6) |
| **Appetite** | medium (~1 week, integration-test heavy) |
| **Branch** | `wish/autopg-service-install-system` (separate branch + PR per Felipe directive 2026-05-08) |
| **Repos touched** | `automagik/autopg` (post-rename) |
| **Predecessor** | `autopg-distribution-cutover` G11.6 ships Tier B `--user` only in v2.4. This wish adds the `--system` mode in the next minor (v2.5 or v3.0 — TBD by Felipe). |
| **Dream queue** | next-version |

## Summary

Extend `autopg service install` with a `--system` mode that writes a system-wide systemd unit at `/etc/systemd/system/autopg.service`, runs as a dedicated `autopg` UNIX user, and ships the hardening profile expected of a production service. Deferred from v2.4 because the privileged-install surface (sudo, dedicated user, mandatory access control) is materially larger than `--user` and would have blocked the v2.4 train.

This wish exists ONLY to unblock the v2.4 ship. It is not a placeholder — when it lands, it ships the full privileged path that ops teams expect.

## Scope

### IN

**Group 1 — Dedicated UNIX user provisioning**
- `autopg service install --system` creates an `autopg` system user (no shell, no home in `/home`, primary group `autopg`) if absent. Idempotent.
- Data dir, runtime dir, log dir all get `chown autopg:autopg` with mode `0700`.
- Refuse to run if not invoked under sudo / as root.

**Group 2 — System unit file**
- Write `/etc/systemd/system/autopg.service`:
  - `User=autopg`, `Group=autopg`
  - `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`
  - `ReadWritePaths=` for data + runtime + log dirs only
  - `Restart=on-failure`, `RestartSec=5`
  - `ExecStart=<install-dir>/autopg serve --data /var/lib/autopg --runtime /run/autopg`
  - `RuntimeDirectory=autopg`, `RuntimeDirectoryMode=0700`
- `systemctl daemon-reload && systemctl enable --now autopg.service`.

**Group 3 — Migration from `--user` or pm2**
- Same hard-MIGRATE contract as the v2.4 G11.6 `--user` path: must detect existing supervisor (pm2 / systemd-user / launchd), capture state, stop + delete cleanly, write new system unit, verify boot, update `admin.json`. No duplicates ever.
- Specific edge case: migrating from `--user` to `--system` requires moving the data dir from `~/.autopg/data` to `/var/lib/autopg` with `chown autopg:autopg`. Provide `--keep-data-in-home` escape hatch for operators who want to leave the data where it is (only the unit changes scope).

**Group 4 — SELinux / AppArmor profile**
- Write a minimal AppArmor profile for the `autopg` binary (Ubuntu / Debian).
- Write a minimal SELinux policy module (Fedora / RHEL).
- `autopg service install --system` detects which MAC system is active and installs the matching profile.
- `--no-mac-profile` flag for operators who manage profiles externally.

**Group 5 — `autopg doctor --system` checks**
- Verify dedicated user exists and owns expected paths.
- Verify unit is enabled + active + running under correct user.
- Verify MAC profile is loaded (when not `--no-mac-profile`).
- Still passive reporting only — no auto-fix suggestions per Felipe's 2026-05-08 directive.

**Group 6 — Documentation + migration guide**
- New section in install guide: "Production install with system-wide systemd".
- Migration runbook: `--user` → `--system` upgrade, with the data-dir-move step.
- Rollback runbook: `autopg service uninstall --system`.

**Group 7 — Tests + CI fixtures**
- Linux fixture: fresh root container → `autopg service install --system` → assert dedicated user, unit active, MAC profile loaded, postgres responsive on UDS + TCP.
- Migration fixtures: pm2 → `--system`, `--user` → `--system`, `--system` rollback.
- All in CI on Linux Blacksmith runners with sudo enabled.

### OUT

- macOS `--system` (launchd `LaunchDaemons` requiring root) — separate future wish if demand emerges.
- Multi-host / cluster systemd orchestration.
- Custom MAC profile composition (operators bring their own profile generator).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Separate wish, separate branch, separate PR | Felipe directive 2026-05-08: "separate branches wishes and prs" + "that comes for next version". |
| 2 | Dedicated `autopg` UNIX user, not `nobody` or postgres | Service hardening 101: principle of least privilege. `nobody` is overloaded; reusing system `postgres` user couples autopg to a specific PG package. |
| 3 | MAC profile on by default | Production hosts running as root need defense in depth; profile is opt-out via `--no-mac-profile`. |
| 4 | Migration is a one-way upgrade by default | `--system` is the production endpoint; downgrade to `--user` exists (`autopg service uninstall --system && autopg service install`) but is not a smooth flow. Operators rarely downgrade. |

## Success Criteria

- Fresh Linux host: `sudo autopg service install --system` produces a fully functional, MAC-profiled, dedicated-user-owned autopg in <60s.
- Re-running `sudo autopg service install --system` is idempotent.
- `autopg doctor` reports `supervisor: systemd-system, user: autopg, mac: apparmor (or selinux)` and all checks pass.
- No duplicate-supervision states ever observable from the migration paths.
- All seven groups land behind a single PR per Felipe's "separate PRs" directive.

## Dependencies

- v2.4 must ship first (Tier A pm2 + Tier B systemd-user) — this wish only adds `--system` on top.
- `autopg-distribution-cutover` G11.6 contract for "no duplicate supervisors" must be already proven and tested.

## QA Criteria

- [ ] CI fixture: pm2 → `--system` migrates cleanly, no pm2 residue.
- [ ] CI fixture: `--user` → `--system` migrates cleanly, data dir moved to `/var/lib/autopg`.
- [ ] CI fixture: rollback path (`autopg service uninstall --system`) restores `--user` mode.
- [ ] AppArmor / SELinux profile loads on Ubuntu 24.04 + Fedora 41 fixtures.
- [ ] `autopg service install --system` invoked without sudo exits non-zero with clear remediation.

## Notes

This wish is parked. Do NOT execute via `/dream` until v2.4 has shipped and `autopg service install` (Tier B `--user`) is proven in production. Felipe's directive (2026-05-08): "separate dedicated wish, and dream queue too" — this lives on the next-version queue.
