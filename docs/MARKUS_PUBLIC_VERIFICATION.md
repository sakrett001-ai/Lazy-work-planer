# Public verification scope

This package contains application code and synthetic regression fixtures. Raw model requests/responses, paid-evaluation journals, provider receipts, account identifiers, operational logs, deployment manifests and evidence archives are intentionally excluded. Detailed historical evidence remains private; this publication does not claim reproducibility of those historical live evaluations.

## What tests can establish

Offline tests exercise actor/source/version checks, strict protocol parsing, default-off behavior, safe rejection, durable accounting and no-retry boundaries using synthetic data and injected providers. Unix IPC tests additionally require an environment that permits local Unix sockets. They do not establish general model quality, current provider compatibility, production service-user isolation or deployed health.

## Current candidate checks

Validated on Node.js 24.22.1 with already-installed dependencies:

- 144/144 relevant non-socket runtime regressions passed (including broker allocation/core/worker, keyless route, wire/policy, provider and recovery checks).
- 30/30 offline evaluation-contract tests passed.
- TypeScript `tsc --noEmit` passed; `git diff --check` passed.
- Existing runtime, UI, scripts, test fixtures and dependency lock bytes are unchanged by publication sanitization. A generic test-only IP/DNS denial guard is included separately.

These are focused checks, not a full repository-suite pass. Unix socket/kernel-peer E2E was not rerun for this sanitized candidate because the local environment restriction remains in force. No historical private run is presented as a new result. No live provider calls, credential reads, production changes or deployment are part of this validation.

The existing public Sites binding is inherited unchanged; it does not activate or deploy the new server code.
