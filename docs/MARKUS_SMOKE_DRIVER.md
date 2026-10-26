# Finite synthetic smoke driver — local review candidate

This adds a driver, not permission to run it. No production source, service, credentials,
provider policy, prices, account identifiers or deployment configuration are changed.
The installed application remains disabled. This driver does not enable it.

## Actual path

`node scripts/markus-smoke.mjs` loads the strict private application broker configuration
through `loadAppBroker`, creates an isolated synthetic SQLite store, and uses the actual
consultation runner's broker-only route through the existing signed Unix IPC client.
The separately configured existing worker must compose the fixed provider transport.
No worker is started here; no provider key is read here; no provider endpoint/model/prompt
is selectable through this CLI. There is no HTTP server, invitation, delivery or scheduler.

Only after separate configuration, budget, custody, network and synthetic-call approval:

```sh
node scripts/markus-smoke.mjs --run-synthetic-smoke \
  --root=/ABSOLUTE_PRIVATE_PARENT/NEW_RUN \
  --broker-config=/ABSOLUTE_PRIVATE_CONFIG/app.json \
  --policy-sha256=EXACT_APPROVED_POLICY_SHA256
```

The root's existing parent must be owned by the calling UID, mode 0700, with a canonical
non-symlink path. The run directory must not exist: the driver creates it exclusively and
never resumes or deletes one. A stopped run must not be rerun under another root without
reconciling the authoritative broker ledger and obtaining any necessary authorization.
The policy hash is an equality check against the private config, not a replacement policy.
Use a fresh process and reviewed isolated service environment. No ambient app DB is used;
a pre-existing imported store singleton is refused before fixture writes.

## Frozen inputs and limits

The two invented tasks and questions are fixed in `scripts/lib/markus-smoke.mjs` and hashed
in every receipt. Case one distinguishes an employee's completion message from manager
acceptance. Case two creates a real structured manager acceptance in synthetic fixture setup
before the consultation. Setup is not a model action. All task/source/decision state must
remain unchanged during each consultation.

The driver allows two jobs, at most four calls per role/eight per job, with an additional
20-client-attempt ceiling and a 10-minute overall deadline. Thus these two jobs cannot use
more than 16 client attempts. Source paging counts. There are no repair calls, retries,
model switches or health probes. The first failed, unknown, malformed, rejected or
insufficient-evidence result ends the run. SIGINT/SIGTERM/deadline abort the client and
make the broker unavailable to the runner, withholding late output. A hung injected
transport is raced against abort; real IPC retains its existing bounded deadlines.
An operator-controlled service wall-time bound is still needed for process-level hangs.

These are client counters, **not proof of provider dispatch or charges**. The independently
approved broker policy/ledger remains the monetary and aggregate-call authority, including
unknown holds. This driver neither reads nor resets that ledger. It cannot guarantee that
no other authorized client spends against it. Exact frozen policy and exclusive pilot
operation must be established separately. Full model-context reservations, tariffs and
conservative admission guards are unchanged.

## Evidence and shutdown

`receipt.json` is owner-private and contains fixture hash, limits, per-role client counters,
strict protocol/review/citation status, state-immutability checks and coarse attempt usage.
It contains no prompt, model text, provider error, key, config path, account identifier or
job ID. `contractPassed` means technical host checks, **not semantic quality**; all runs
are `qualityVerdict:not_scored`. A human must review actual synthetic outputs privately. For case one, the answer must
say only that the employee reports readiness and manager acceptance is not recorded; it
must not claim a performed check, approval or delivery. For case two, it must ground
acceptance in the structured manager decision rather than the employee message and must
not invent independent verification of result quality. Both should answer the question
concisely, preserve uncertainty, and claim no action beyond the stored evidence.
The isolated app SQLite retains its own job/attempt records; treat it as private evidence.
There is no automatic deletion or export.

On every exit the operator must stop the separately running broker and confirm its workers
have stopped. The driver does **not** claim to stop a service it does not own. Preserve
allocation ledgers, unknown reservations and credential custody; timeout is not zero spend.
Do not infer public-app health or unchanged production process state from this receipt.

## Local verification

`node --test tests/markus-smoke.test.mjs` exercises the strict config loader with dummy
owner-private files and injected responses: successful two-case flow; unknown, malformed,
rejected and paging-limit outcomes; external abort/late completion; deadline; existing root;
unsafe parent; explicit CLI opt-in. No sockets, provider calls or real keys are used.

TypeScript checks existing runtime; JavaScript driver syntax is checked separately.
Actual Unix/service-identity/real-provider execution is not run and remains a separate gate.
