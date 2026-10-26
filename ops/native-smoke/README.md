# Native synthetic smoke: review templates

These operational helpers accompany the finite synthetic driver documented in
`docs/MARKUS_SMOKE_DRIVER.md`. They are not install-ready and do not enable the
public application. All production AI switches remain off.

## Contents and checks

- `native-lockbox-pull.py`: exclusive owner-private volatile credential custody,
  separate IPC key copies, and exact-version HTTP 403 verification.
- `finite-run.py`: one-shot coordinator with bounded service termination.
- `config/`, `units/`, `network/`: unresolved deployment templates, not live config.
- Python tests use only dummy transports/files and static envelope checks:
  `python3 -m unittest discover -s ops/native-smoke -p 'test_*.py'`.
- Driver checks: `node --test tests/markus-smoke.test.mjs` with the repository's
  pinned runtime/dependencies.

Local dummy tests are not proof of target ownership, Unix IPC, systemd/BPF/nft
isolation, IAM propagation, credential revocation, model quality or actual costs.
No live model run is claimed by this publication.

## Required execution gates

Obtain separate explicit permission for staging, scoped short-lived model
credentials, secret access lifecycle, network changes and one paid synthetic run.
Use an immutable adjacent release pinned to the published commit and verified
file hashes; do not modify the running public application or its database.
Resolve every placeholder and verify numeric identities, runtime, current model
route/tariffs and exact network destinations before installation. Validate rendered
units and rules, then prove isolation with dummy credentials on the target.

Keep model credentials only with the broker. Remove temporary secret access and
verify both control-plane removal and the exact guest HTTP 403 before launch.
The coordinator consumes an exclusive run marker; never automatically retry or
reset a failed/unknown run. Preserve authoritative allocations, prior carry and
unknown reservations. A new allocation book requires separately reconciled private
carry evidence; no historical accounting or create-book values are published here.
The sample 500 RUB/20-call admission policy is not a provider billing cap.

Stop both cgroups on every exit and verify they are empty before removing network
containment. Revoke the model key and verify revocation; remove only the reviewed
volatile credential files, not ledgers or receipts. Review synthetic answers
privately: contract completion is not semantic acceptance. Do not publish secrets,
model payloads, raw logs, deployment identifiers or private accounting evidence.
