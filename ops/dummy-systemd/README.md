# Direct-systemd dummy isolation gate

A local review fixture for the existing Unix peer gate. No model credentials,
provider calls or production-service changes are performed by these scripts.
Systemd directly selects the two service identities; no child changes its UID.
The worker uses only fixed dummy data.

`fixture.py` and `coordinator.py` deliberately pin the published Stage A peer
implementation and its expected adjacent release path. Verify those exact bytes,
trusted source ownership, numeric identities, mounts, unit-name collisions and
absence of competing broker-UID processes before separately authorized staging.
The coordinator takes the fixture absolute path and its reviewed SHA256. It is
not an installer and does not grant permission to run the target test.

## Checks and boundaries

- Exact service UID/groups, empty effective capabilities and NoNewPrivileges.
- Cross-user private-file denial, socket ownership/mode and wrong-peer rejection.
- Positive dummy request, deliberate worker expiry and socket removal.
- Successful retained unit status, empty cgroups before and after explicit stop,
  and narrow known-file cleanup. Ambiguity preserves partial state and fails.
- Independent service runtime limits and a bounded foreground coordinator.

Local tests: `python3 -m unittest discover -s ops/dummy-systemd -p 'test_*.py'`.
These use fake functions and static checks, not target systemd or real sockets.
They do not certify target isolation, timing, successful cleanup, core collector,
swap/backup custody, provider networking or readiness for paid model execution.

Obtain separate explicit target-run approval. Use immutable published source
and verified file hashes over HTTPS, not pasted source or credentials. Never
retry automatically, relax the production service, or interpret a passing dummy
test as permission to retrieve a model key. Preserve failure evidence privately.
