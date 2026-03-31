# ListLayout Fixes Context Exchange

## Run Metadata
- Timestamp: 30-03-26 17:12:34
- Branch: `cur-section-footer-test`
- Scope: List layout sticky supplementary behavior (header + footer) and debug workflow hardening.

## What Was Fixed
- Header identity continuity was already stabilized (`item-0-header` end-to-end) and legacy remap removal retained.
- Sticky header flicker was fixed earlier by preventing transformed sticky views from being re-framed incorrectly in container apply logic.
- Sticky footer support was implemented in sectioned list flow:
  - Footer is flattened and keyed as `item-<section>-footer`.
  - Footer can be wrapped by `RNScrollCoordinatedView` with `kind=footer` when sticky.
  - Footer transform logic in native sticky view was corrected to allow negative translation (pin-to-bottom behavior).

## Root Cause for Footer Not Sticking
- Pipeline wiring was correct, but footer transform used header-style clamping:
  - `MAX(0, desiredTop - naturalY)`
- For a footer below viewport, `desiredTop - naturalY` is negative at load, so translation stayed `0`.
- Result: footer behaved like a normal end-of-list item.

## Final Footer Math Decision
- Footer pinning must allow upward translation into viewport bottom:
  - Use `MIN(0, desiredTop - naturalY)` (and push-clamped variant).
- Keep z-elevation active when absolute translation is non-zero:
  - `fabs(translateY) > epsilon`.

## Logging and Debug Strategy
- During diagnosis, verbose logs were enabled selectively and then globally to confirm:
  - JS flatten result included `stickyFooterFlatIndices`.
  - JS render branch used `RNScrollCoordinatedView` for footer.
  - ShadowNode resolved footer keys correctly with cache hits.
  - Native footer trace emitted transform inputs/outputs.
- After fix verification, logs/signposts were re-silenced via flags so release and normal debug runs are clean.

## Current Toggle State (Silenced)
- JS:
  - `RNCV_DEBUG_LOGS = false`
  - `RNCV_LAYOUT_DEBUG_LOGS = false`
- Native debug logs:
  - `RNCV_ENABLE_NATIVE_LOGS = 0`
  - `RNCV_ENABLE_STICKY_TRACE = 0`
- Signposts:
  - `kRNCVEnableSignposts = NO`

## Setup and Linking Context
- Local `riff` package linkage is validated via `example/node_modules/riff` symlink to `packages/rn-collection-view`.
- Guardrail scripts and native sanity checklist remain part of workflow to avoid stale codegen/build artifacts.

## Status
- **Single-section list behavior:** header sticky + footer sticky now working as expected for the current scenario.
- Remaining follow-up space (not part of this fix): multi-section footer push semantics and broader layout regression checks.
