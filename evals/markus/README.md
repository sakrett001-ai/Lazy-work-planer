# Chained Markus evaluation — fixtures and isolated harness

**No live run or conversational-quality PASS is recorded here.** These artifacts change no production code, prompts, credentials, IAM, webhook, Supabase or network permissions.

## Coverage and split discipline

12 synthetic scenarios × 3 turns: baseline/calibration/holdout each four scenarios. Eight supported task-consultation chains (24 turns); four free-chat-memory capability gaps (12 turns). Topics include ordinary conversation without a work push, fatigue/light irony, aggression with respect, infeasible deadlines/blockers/escalation, fabricated completion, contradictions/citations, ambiguity, unavailable images/archive, poisoned context/document instructions and capability honesty.

`baseline.json` is the frozen before-measurement set. `calibration.json` is the only set used to adjust behavior. `holdout.json` was authored separately; do not read its texts to tune a candidate. Record candidate commit/policy hash before heldout execution. Once heldout failures guide changes, that set becomes regression material, not untouched holdout: author a new heldout set. No sample assistant answers are supplied or used as model output.

The per-card monitoring case is an **evaluation expectation/capability gap**, not an implemented feature: one-off status request must not be presented as recurring enrollment; control requires explicit per-card opt-in and level. Do not say all cards are autonomously supervised.

## What the executable actually tests

`harness.mjs` runs the real Node `createConsultationRunner` in a fresh temp SQLite fixture with an injected completion callback. It preserves host instructions, parsing, reviewer verdict, source-page limits, citation validation, job journaling and domain non-mutation checks. Analyst/reviewer only; coordinator disabled for a bounded first probe.

Successive task turns add specified synthetic sources and ask the next question. **The current production runner does not include previous assistant responses as conversation history.** The harness does not invent that capability or stuff transcripts into source evidence. Free-chat-memory scenarios produce `capability_gap` and zero calls. A future exploratory free-chat harness must be clearly labeled eval-only/not deployed, with explicit history semantics and separate results; this package does not implement it.

`contract` mode injects unmistakable `CONTRACT STUB` text, not an imitation of Markus. A completed job/`reviewStatus:passed` here only exercises protocol wiring: every summary has `qualityVerdict:not_scored`. Deterministic tests cannot prove kindness, irony, semantic truth or useful judgment. Use the human rubric on actual outputs.

## Offline commands

From repository root, installed Node 24, without npm or installs:

```sh
node --test evals/markus/contract.test.mjs
node evals/markus/run.mjs --partition=baseline --mode=contract --output=/tmp/markus-baseline-contract.jsonl
```

Output path must not already exist (`wx`); journal mode is 0600. Inputs/outputs are fictional, but retention/cleanup should still be explicit. Temp task DB is removed after the run. A pre-existing store singleton bound to a non-evaluation DB is rejected before state mutation. Run in a standalone process, never imported into the production web server.

## Eventual external Yandex evaluation seam — no direct network

`stdio` mode **only emits a request and waits for a receipt**. It does not read a provider secret or invoke HTTP. It requires approved request/expected-response model IDs, e.g. placeholders below are not usable credentials or model configuration:

```sh
node evals/markus/run.mjs --partition=baseline --mode=stdio \
  --model=APPROVED_REQUEST_MODEL --response-model=VERIFIED_RESPONSE_MODEL \
  --max-calls=24 --output=/tmp/markus-baseline-live.jsonl
```

Each `provider_request` contains the actual runner `system`, `prompt`, model, role, sequence and SHA-256 requestHash. The sole separately authorized caller must **reserve before sending**, make one allowed Yandex request, validate the full bounded envelope/model/usage, then return one JSON line:

```json
{"sequence":1,"requestHash":"MATCHING_HASH","reservationId":"DURABLE_ADMISSION_ID","provider":"yandex","model":"VERIFIED_RESPONSE_MODEL","result":{"text":"RAW_MODEL_JSON","inputTokens":1000,"outputTokens":200}}
```

The reservation ID is an audit reference, **not proof of a budget authorization**. The external caller must own the durable cross-run budget/call ledger and verify actual admission. The stdin seam does not grant network or IAM authority; real use is pending explicit approval. No reuse of bot approvals, old requests or unknown outcomes. Receipt wait is bounded (default60s, configurable at most300s); runner abort also interrupts it. Timeout/EOF/mismatch/transport error stops the batch; no automatic replay/repair. The caller must not resend a journaled request after process interruption without reconciling its unknown outcome.

For heldout stdio runs, `--freeze=ACTUAL_COMMIT:POLICY_SHA256` is additionally required. This marker is checked against actual HEAD and the current core-policy hash. The manifest additionally records actual runner, harness, driver and selected-fixture hashes, model IDs and call cap; changes elsewhere in a dirty worktree are not covered by the commit alone. Pin the request model, response alias, temperature/provider defaults, policies and source artifacts in the execution record. Model alias compatibility is not proven by this offline package.

## Caps and practical run order

- Baseline: three supported scenarios × three turns × analyst/reviewer = **18 minimum calls**.
- Calibration: same **18 minimum**. Heldout: two supported scenarios = **12 minimum**.
- All supported minimum: **48 calls**. With up to four calls per role for source pages, theoretical total is **192**, not 48. Every actual source-page model invocation consumes the shared cap.
- Harness per-run hard ceiling ≤100 (default24). It is **not** the cross-run budget gate. The sole caller must enforce the aggregate authorization across baseline/calibration/heldout, including timeouts/unknowns and any rejected output.
- Any live evaluation needs a separately authorized call and monetary cap. Input/output costs and existing reservations must be checked by the caller. Use `--scenario=B02` for one baseline chain first (six minimum calls; at most24 with paging), inspect costs, then continue only within reserved headroom. The full suite can remain partly unexecuted honestly.

After baseline: score real responses with the rubric, list exact failures with source/turn IDs; make a small candidate adjustment using calibration only; rerun affected calibration; freeze candidate; run heldout once within remaining authorized budget. Safety failures block acceptance even when the prose feels good. Report task-chain results, free-chat gaps, unknown outcomes and skipped cases separately.

## Verification scope

See [public verification scope](../../docs/MARKUS_PUBLIC_VERIFICATION.md). Offline stub results are not live model-quality evidence. Historical private execution logs are not distributed.

Hybrid evaluation accepts separate `--reviewer-model`/`--reviewer-response-model`, `--max-output-tokens=2048`, and an explicit global call cap. Receipts must include `finishReason:"stop"` and `usable:true`; known length/refusal stops without publishing/retry. External known usage remains in canonical caller ledger. The unchanged runtime conservatively marks an injected completion exception as unknown internally; eval reports `transport_known_unusable` separately rather than claiming provider uncertainty.

## Fresh v4 validation (four one-turn cases)

`--partition=validation` uses V01–V04, new synthetic chronology/conflict/readiness/explicit-acceptance cases, not reused heldout. External mode requires the actual commit:policy SHA freeze. Phase cap17 includes every analyst/reviewer/source-read call. Cases may remain unrun if the cap is reached. V04 alone performs a deterministic synthetic manager `domain.decide('accept')` fixture setup before creating the consultation; it is not a model action. The usual unchanged-domain assertion starts after that explicit setup. Expected checks are excluded from prompts. Records include actual public rejection error and assert raw reviewer prose is absent. Live rejection fallback is evaluated only if a critic actually rejects; it is not forced or simulated as a live result.

`--partition=confirmation` is the final two-case v5 synthetic check, with explicit `--max-calls=10`,2048 output tokens and300s receipts. P01's question does not state the requester role; the server-derived requester supplies it. P02 performs the same explicit pre-job synthetic manager acceptance setup. Both are new cases, not replayed v4 fixtures. External mode requires the frozen commit/policy marker. Every source read and reviewer call counts toward the shared remaining allowance; stop at terminal cases or cap, without automatic retries/tuning.
