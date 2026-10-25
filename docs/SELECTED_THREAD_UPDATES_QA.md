# Selected-thread native browser QA

Verified implementation: `72babd946d7530aca613f946479bd8306b6cc734`  
Implementation tree: `be4b9e7c51e7bbd43f0776df1fd9d120a0bf720a`  
Module: [`dist/prototype-ui.js`](../dist/prototype-ui.js)  
Module SHA-256: `518871e68337caee1df6d61a987ce3be76542c6700af9018a35588930374f307`

## Native Chromium results

The synthetic [browser fixture](../scripts/check-thread-scroll.test.mjs), using the exact implementation module, returned:

```json
{"tail":true,"reading":true,"draft":true,"history":true}
```

A separate native GUI interaction typed `QA draft`, selected characters and waited for a delayed three-second synthetic append. Checks passed for unchanged textarea node, text, selection, focus and reading scroll position.

The first browser run exposed a genuine history-anchor defect: Chromium had already adjusted scrolling for inserted content, and restoring the old scroll offset undid that adjustment. The reviewed fix preserves the browser-adjusted offset. The [deterministic regression](../tests/thread-scroll-anchor.test.mjs) covers this interaction. The exact fixed pin passed the native browser rerun.

## Scope and limits

- Actual browser layout and manual draft interaction were exercised with synthetic data and the actual renderer.
- This is not a live 15-second HTTP polling test, external delivery test, screen-reader test or accessibility conformance claim.
- Local headless Chromium launch was blocked by its sandbox; the native GUI browser route supplied the layout evidence. The optional CLI command itself is not claimed to have passed.
- The independent code review passed with no blocking findings; the default suite passed **162/162 tests**, and typecheck passed.
- No publication or deployment was performed as part of this QA.
