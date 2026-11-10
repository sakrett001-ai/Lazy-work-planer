# Synthetic sudo execution contract

A standalone, synthetic-only Linux test repository. It tests an ordinary account launching individually elevated Python children, shell gate behavior, restrictive file creation, bounded execution, and a small synthetic state machine. All bodies and data are harmless fixtures created for this repository.

## Run

From the repository root:

    cd ci/synthetic_sudo

    python3 -B test_contract.py --local
    python3 -B test_contract.py --sudo

The second command requires an ordinary Linux account with existing passwordless `/usr/bin/sudo`, GNU timeout, Bash, Python 3 and the existing unprivileged `nobody` account. It fails rather than skipping when prerequisites are absent. It never installs software or changes accounts, sudo policy, credentials, permissions, or security settings. The first command does not need sudo and does not establish successful elevation.

The workflow runs on the standard GitHub-hosted `ubuntu-24.04` runner. Pull requests from other repositories do not execute the job. Checkout is pinned, credentials are not persisted, token permissions are read-only, and the job has an eight-minute limit. No secrets, caches, artifact uploads, deployment steps, or application network calls are used. GitHub checkout itself retrieves this repository.

## Assertions

Each modeled child must actually reach UID/EUID 0 through its own `sudo -n` invocation, use a cleared environment and isolated bytecode-disabled Python, receive EOF on stdin, and establish umask 077. Exclusive synthetic writes must be root-owned mode 0600. Tests cover individual and paired launches, both sides of successful shell gates, every modeled gate refusal, every paired writer's partial failure, short test deadlines, missing executable failure, retained partial bytes, and suppression of subsequent writes. Immediate return-code markers must match the actual shell status; stderr must remain suppressed.

An existing `nobody` process exercises real sudo refusal and inability to read protected fixtures. It does not simulate expiry of the ordinary account's sudo cache or change that account's policy. Partial-state retry testing is an explicit adversarial second attempt against a fixture; the example flow itself does not retry.

The synthetic state machine tests MATCH/ABSENT branches, STOP on uncertain input, and a separate observation launch after either exact MATCH/exit 0 or an explicitly qualified PROFILE/exit 1. Its small schema is illustrative, not an application schema. Unexpected, extra, malformed or wrong-status capture output must not trigger observation. PROFILE is not converted into success.

## Limits and evidence

Local construction/parser/refusal tests passed during preparation. Real sudo execution has **not run during local preparation**. Only a successful real-sudo CI job establishes the runtime assertions above. The suite prints a finite summary; fixtures remain in a uniquely named temporary directory until the disposable runner is discarded. There is no cleanup of unrelated data.

The default launcher deadlines are retained; the timeout failure test explicitly substitutes shorter deadlines to avoid a long stall. Long-duration observer timing is checked structurally, not by waiting through the full deadline.

Runtime contract tests use harmless probe bodies. They do not establish that any unmodified application helper, full application source, dependency tree, filesystem layout, receipt, deployment, or production environment passed. This repository contains no operational payloads or deployment instructions. Passing synthetic CI is not a deployment acceptance gate.
