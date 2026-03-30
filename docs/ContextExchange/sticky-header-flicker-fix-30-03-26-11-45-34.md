# Sticky Header Flicker Fix - Context Exchange

## Snapshot
- Date/time: `30-03-26-11-45-34`
- Branch at time of writing: `ag-fix-shadow-node-layouts`
- Scope: stabilize sectioned list header identity and eliminate sticky header flicker in Fabric `CollectionView`.

## Problem Statement
- Section headers initially suffered from key identity drift between JS, C++, and iOS layers.
- That drift caused incorrect position lookups and unstable header behavior.
- After key identity was repaired, header placement became correct, but header flickered while scrolling.
- Flicker root cause was an iOS geometry reconciliation conflict: container frame application vs sticky transform updates.

## High-Level Decisions
- Preserve canonical cache keys end-to-end (`item-{section}-header`, `item-{section}-{index}`).
- Remove legacy supplementary remap behavior (`item-0-header` -> `header-0`) for this sectioned API path.
- Strengthen observability with structured logs at JS, C++, and iOS layers before applying behavioral fixes.
- Harden local monorepo linking and pod/codegen workflow to prevent stale spec/codegen artifacts.
- Keep setup guardrails documented and scriptable to avoid future environment drift.

## Why This Took Multiple Iterations
- Native codegen was sometimes generated from stale installed copies under `example/node_modules/riff`.
- This made runtime behavior appear inconsistent with source edits.
- Without explicit link checks and deterministic install/pod steps, fixes could appear to "not work".
- Detailed logs were required to isolate whether failure was key mismatch, stale build, or iOS transform conflict.

## Linking and Setup Hardening Changes
- In `packages/rn-collection-view/example/package.json`:
  - switched dependency from `file:../` to `link:../`
  - added scripts:
    - `check:riff-link`
    - `sync:riff`
    - `pods`
  - added `postinstall` guard via `check:riff-link`
  - ensured run scripts use `NODE_OPTIONS=--preserve-symlinks`
- Added `packages/rn-collection-view/example/scripts/check-riff-link.js` to verify symlink target.
- Added/setup docs:
  - `docs/native-sanity-checklist.md`
  - local guardrail notes in `packages/rn-collection-view/example/README.md`

## Technical Root Causes and Resolutions

### 1) Key Identity Drift
- Observed canonical key generation in layout engine (`item-0-header`) but key rewrite later in ShadowNode.
- Cause: legacy remap path in `CollectionViewContainerShadowNode.cpp`.
- Resolution: removed remap behavior that rewrote supplementary keys to legacy formats.
- Result: logs now consistently show `finalKey=item-0-header` with cache hits.

### 2) Flicker During Scroll (after key fix)
- Observed:
  - sticky view applied transform based on scroll offset
  - container `applyPositionsFromState` compared against transformed `frame`
  - container reset header position to layout Y (0)
  - sticky logic re-applied transform again
- This produced an oscillation/fight visible as flicker.
- Resolution in `packages/rn-collection-view/ios/RNCollectionViewContainerView.mm`:
  - detect active transform
  - compare target against natural geometry (`center` + `bounds`), not transformed `frame`
  - when transformed, apply updates via `bounds` + `center` (natural geometry), not `frame`
  - use epsilon threshold to avoid micro reapplications
- Result: header no longer flickers in validation run.

## Instrumentation Added During Debug
- JS (`CollectionView.tsx`):
  - flattening, key derivation, branch selection, sticky/range logs
- C++:
  - `ListLayout.cpp` key writes
  - `CollectionViewContainerShadowNode.cpp` key resolution/remap/reread/delta logs
- iOS:
  - `RNCollectionViewContainerView.mm` mount/unmount/state/layout/apply logs
  - `RNScrollCoordinatedViewView.mm` sticky transform logs
  - `RNMeasuredCellView.mm` measurement logs

## Validation Signals to Check
- Key continuity:
  - `RNCV-SN ... finalKey=item-0-header`
  - no conversion to `header-0`
- Sticky behavior:
  - no repeated forced reset of sticky header frame during scroll
  - stable transform progression with no visible flicker
- Build environment:
  - `yarn check:riff-link` reports local package symlink target correctly
  - `yarn pods` shows codegen processing `riff`

## Current Status
- Header placement: fixed.
- Key continuity: fixed and verified in native logs.
- Sticky flicker: fixed by iOS natural-geometry apply logic.
- Setup/linking guardrails: implemented and documented.
- Remaining risk: if linking/pod/codegen guardrails are skipped, stale native artifacts can still mask changes.

## Recommended Independent Review
- Reviewer profile: one Fabric/native iOS reviewer + one React Native integration reviewer.
- Review focus:
  - key continuity contract across JS -> C++ -> iOS
  - removal of legacy remap assumptions
  - transformed geometry handling in container apply logic
  - setup guardrails (`link:` workflow and scripts)
- Suggested reviewer test:
  - run sanity checklist in `docs/native-sanity-checklist.md`
  - reproduce long scroll with sticky headers
  - confirm no flicker and no key drift in logs

## Operational Checklist (Post-Change)
- Run in example app:
  - `yarn check:riff-link`
  - `yarn pods` (when specs/native bridge changed)
- In Xcode:
  - `Product -> Clean Build Folder`
  - build and run
- Capture native logs for one deterministic scroll pass when verifying sticky behavior.
