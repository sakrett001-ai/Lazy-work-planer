# Frozen critic-only comparison

Twelve newly authored synthetic cases, not the untouched task-flow holdout: four valid reasonable inferences, four factual errors, four unsupported conclusions from missing/conflicting evidence. Gold and rationales stay local in `cases.json`, never sent in prompts. All quotations are exact source substrings, including wrong drafts: citation matching alone must not pass a factual error.

The protocol compares four candidates with the same frozen system/prompt and JSON-object transport, a common output-token bound, and no per-model tuning, repair or automatic retry. Any live execution requires separate approval, durable admission accounting and validated model aliases. This package contains no credentials or network code.

## Offline preparation

From repo root, using locally installed Node 24:

```
node --test evals/markus/critic-comparison/contract.test.mjs
node evals/markus/critic-comparison/compile.mjs /absolute/new/critic-requests-v1.json
node evals/markus/critic-comparison/score.mjs /absolute/blind-results.json /absolute/new/blind-score.json /absolute/frozen-binding.json
```

Compile after commit. The manifest binds commit, fixture bytes, system and request bundle. Prompt hash is SHA256 of JSON `[system,prompt]`; the caller retains its canonical request hash over `[system,prompt,configuredModel]`. Maximum source+system text is below 20KB; the caller independently bounds full serialized request bytes. Never regenerate prompts after observing comparison outputs.

## Blinded scoring

Sole caller randomly assigns opaque candidate labels and keeps identity mapping separate. Scorer/evaluator must not read that mapping before final scoring. Input is an array of `{candidateId,fixtureId,promptHash,outcome,text,latencyMs,costRub}`. `outcome=received` is eligible for strict JSON/schema/citation assessment; known `length`, `refusal`, transport unknown and missing outcomes remain distinct, unusable outcomes, not evidence of semantic rejection. No stripping markdown fences. Preserve raw evidence separately; no cherry-picking repeated attempts.

Report denominators explicitly: false-positive rejections /4 valid cases; false-negative approvals /8 invalid cases; usable verdicts /12; correct usable verdicts /12. An unusable/missing result is not silently a safe correct rejection and is not included as a semantic false negative. Report coverage alongside both error rates. This small hand-authored set supports diagnosis, not statistical claims of general model superiority.

Human review, still blinded, scores each reason: 0 = materially wrong/unjustified; 1 = correct decision but vague or partly flawed explanation; 2 = correctly identifies the specific fact/inference/uncertainty with relevant evidence and no invented authority. Check whether model's rejection reason matches the actual error rather than an unrelated stylistic complaint. Record unsupported new assertions and unjustified caution separately. Freeze human scores before revealing identities. Prioritize factual false negatives and overstrict false positives; then reasoning quality, JSON usability, HTTP latency p50/p95 and calculated token cost. No automatic winner based only on verdict matching.

This directly tests a single critic decision with all sources supplied. It does not test analyst composition, retrieval tools, multi-turn memory, task mutations or overall Markus personality. It is not the actual complete consultation runner, and cannot certify production readiness.

Frozen scoring binding is `{casesSha256: manifest.casesCanonicalSha256,candidateIds: [all four opaque labels]}`. Create it before results are read, retain beside the frozen manifest. CLI requires it and validates every model-independent prompt hash. Missing entire candidates remain visible as 12 missing outcomes.
