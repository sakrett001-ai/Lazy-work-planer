# Selected task: live internal discussion (local increment)

The existing 15-second memory read now appends new stored conversation sources and separately labelled `no_reply` system events while a task is open. No model, transport, delivery flag, database schema, read receipt or global unread inbox was added. Actor preferences and whole-task `seen` semantics are unchanged.

The editable/action snapshot remains the one the person reviewed. New task/child/draft versions are buffered with an explicit review notice; background reads never replace `expectedVersion`. A 409 keeps the original form and draft. Explicit review fetches the current card and retains selected-card report/message/assistant text and the request-status checkbox. Successful posting clears only the submitted field. Draft recovery is in-memory and actor/task scoped, never automatically submitted or persisted.

Reads are single-flight, paused when hidden, with one catch-up on return. Session epoch, actor identity/role, task ID and open generation guard responses. A successful memory response contains only the authenticated current actor's ID/role; a role mismatch ends the old UI session. Selected-task 401/403/404 responses invalidate pending detail responses and remove private detail/control nodes. Revocation is observed at the next response, not instantly; a task 404 does not imply global role revocation or erase the already-seen board.

Conversation sources and history events are keyed and escaped. A bounded 50-source window is explicitly labelled; a no-overlap update preserves existing DOM without claiming a complete history. Earlier events can be loaded in history, but that does not promise recovery of every older conversation source. Polls preserve existing form nodes, focus/selection, conversation scroll position and history anchor; tail following is limited to the conversation's own tail when not typing. Editor-dialog drafts and full cross-device draft recovery are outside this slice.

## Verification

- `npm test`: real SQLite/HTTP-handler + DOM fixtures, including two actors, unchanged-version source append, no_reply dedup, draft node/selection and 409 preservation, explicit review, hidden/resume, 50-source window, single-flight polling, same-ID close/reopen, loading-close draft recovery, role changes, reassignment and late private response invalidation. Existing preference/API authorization tests remain in the full suite.
- Final implementation pin `72babd946d7530aca613f946479bd8306b6cc734`: **162/162 tests passed**, `npm run typecheck` passed; independently reviewed.
- Native Chromium QA at that exact implementation pin passed all four synthetic layout checks and manual typed-draft/selection checks. The tested `dist/prototype-ui.js` SHA-256 was `518871e68337caee1df6d61a987ce3be76542c6700af9018a35588930374f307`. See the [QA evidence record](SELECTED_THREAD_UPDATES_QA.md).
- This browser evidence uses a synthetic fixture calling the actual renderer; it does **not** verify a live 15-second HTTP polling session or assistive-technology behavior. The local headless CLI was blocked by its sandbox; native browser QA was performed separately and is not counted among the default automated tests.

No deployment or publication is part of this increment.
