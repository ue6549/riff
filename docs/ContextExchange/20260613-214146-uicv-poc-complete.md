# Session Handoff — 2026-06-13 — UICollectionView POC complete

## What happened

Both phases of the `feat/uicollectionview-poc` plan (`luminous-snuggling-wombat.md`) are implemented and pushed.

### Phase 1 — B1.14 (commit `6a2f787`)

`RNFabricLayoutInterceptor` adapter centralises all "creative Fabric override" call sites:

- 4 `updateLayoutMetrics:` overrides refactored to delegate: `RNMeasuredCellView`, `RNOrthogonalSectionView`, `RNScrollCoordinatedViewView`, `RNCollectionSubContainerView`
- 3 `mountChildComponentView:` overrides refactored: `RNCollectionViewContainerView`, `RNOrthogonalSectionView`, `RNCollectionSubContainerView`
- 4 protocols added to classify dispatch: `RNExternallyPositioned`, `RNFullFrameExternallyPositioned`, `RNCacheBasedOrigin`, `RNContentViewProvider`
- Built and verified: `BUILD SUCCEEDED`

### Phase 2 — UICollectionView POC (commits `f5cf1a2`, `f3ba509`, `ca272b4`, `d1cc980`)

New native components:
- `RNRiffCollectionView` — UIView host with 4-map Fabric bridge bookkeeping + limbo container
- `RNRiffCell` — UICollectionViewCell shell (prepareForReuse is no-op; container coordinates reuse)
- `RNRiffCollectionViewLayout` — static-position UICollectionViewLayout; `shouldInvalidateLayoutForBoundsChange:` returns NO

Integration into `RNCollectionViewContainerView`:
- `experimental_useUICollectionView` prop triggers creation/destruction of `RNRiffCollectionView`
- `contentViewForChildMounting` redirects to limbo when active
- `mountChild/unmountChild` delegate to `adoptFabricChild/releaseFabricChild`
- `updateState:` passes positions + childTags NSArrays to the bridge bookkeeper

JS wiring:
- `experimental_useUICollectionView?: boolean` added to codegen spec + `CollectionView.tsx`
- `FeedComparisonTab.tsx` has `mode: 'cv' | 'cv-ucv' | 'flash'`
- `Comparison.tsx` has a third "Riff×UICV" tab (blue tint)

All builds passed. Branch is fully pushed.

## What's NOT done yet

**The device bench.** `docs/wip/uicv-poc-bench.md` has the protocol + empty results table. The next session should:

1. Run the Metro bundler: `cd packages/rn-collection-view/example && nvm use && npx react-native start --port 8082 --reset-cache`
2. Open `CollectionViewExample.xcworkspace`, run on iPhone 15 Pro.
3. First: smoke-test all existing demos (all LayoutsTab demos, storefront, homepage, search, comparison Riff+FlashList modes) to verify B1.14 didn't regress anything.
4. Then: bench protocol in `uicv-poc-bench.md` — 3 modes × 5 rounds.
5. Fill in the results table. Apply the go/no-go rule.
6. If go → open the PR (`feat/uicollectionview-poc` → `main`).
7. If no-go → keep the B1.14 commit, revert Phase 2 commits, open PR for B1.14 only.

## Known limitations of the POC

- **Scroll velocity in PerfHood shows 0 for cv-ucv mode** — `UICollectionView`'s scroll delegate is `RNRiffCollectionView`, not the container, so the `handleScroll` velocity calculation in `FeedComparisonTab` doesn't fire. FPS/CPU/memory metrics are unaffected.
- **No stickies, no H sub-containers, no decorations** — V-list only per scope.
- **Android not implemented** — iOS only per plan.

## Active branch

`feat/uicollectionview-poc` — 5 commits ahead of `main` after the plan's initial merge.

## File pointers

- Plan: `/Users/rajatgupta/.claude/plans/luminous-snuggling-wombat.md`
- Bench template: `docs/wip/uicv-poc-bench.md`
- New native files: `ios/RNRiffCollectionView.{h,mm}`, `ios/RNRiffCell.{h,mm}`, `ios/RNRiffCollectionViewLayout.{h,mm}`, `ios/RNFabricLayoutInterceptor.{h,mm}`
