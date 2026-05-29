# Riff — Consolidated Backlog

> Single source of truth for all remaining work. Replaces cursor-plan.md, ethereal-seeking-willow.md, PERF-PLAN.md, and perf-opti-claude.md (archived in `docs/archived-plans/`).

---

# 🔲 Active / Remaining

## Execution Order

| # | Item | Est | Notes |
|---|------|-----|-------|
| 7 | **JS layouts audit** | 1d | Review Radial/Carousel/Spiral/Hex implementations: layout math stays in JS, but verify they wire through the core C++ engine (LayoutCache, ShadowNode positioning) correctly rather than going around it. Fix any bypasses found. B4.10 (scrollTo for these tabs) folds in here. |
| 8 | **B2.6** Snap behaviors (H-6) | 1d | UIKit paging/groupPaging on H sections; FlashList has no equivalent |
| 9 | **B5.2** Shareable artifacts — round 1 | 1d | README, benchmarks doc, FlashList comparison matrix (needs P6.2 numbers — now done) |
| 10 | **B2.2 + B2.1** Snapshot API + C++ diff engine | 2d | NSDiffableDataSource-style mutation API + off-thread key diff |
| 11 | Post-POC items | — | See section below |

---

## B1 — Architecture (Remaining)

### B1.3 L-4: Rename size config APIs to "estimated"

`itemHeight`, `rowHeight`, `sizeForItem` etc. imply fixed/deterministic — they're all estimates. Rename to `estimatedItemHeight` (where not already), document the "estimates only" contract.

**Effort:** ~0.5d

### B1.5 Sub-container owns its own LayoutCache slice ⚠️ ATTEMPTED — PARKED

**Status:** Implemented and partially working on branch `fix/b0-h-section-wrapper-stale`, then reverted (2026-05-23). Root issues not fully resolved; complexity growing faster than confidence.

**What was done:**
- Per-section sub-caches allocated by `CompositionalLayout` JS engine; H items written there instead of main cache.
- New `mainCacheId` / `sectionLayoutType` props wired through `RNCollectionSubContainer`.
- `CollectionSubContainerShadowNode` updated to read from sub-cache and call leaf engine's `applyMeasurements`.
- `injectMeasuredDimensionsIfNeeded` updated to read H-cell widths from sub-cache.
- Stash/clear sequencing for sub-cache added in `computeOneSection`.

**Why parked:** Two persistent bugs could not be stabilised in acceptable complexity:
1. **Full-screen-wide cells** — Placeholder H cells injected at initial `p.itemHeight` estimate constrained Yoga, blocking natural width discovery. Fix (inject only for Measured in free-width sections) added a masonry/flow carve-out, and the `std::optional` vs pointer issue in the injection check was a compile error. Fixable but multiplying carve-outs.
2. **Oscillation / shifting sizes** — sub-cache cleared without stashing measured widths on every `computeSections` call. Fix (`stashMeasuredSizes` before `clear`) is correct in isolation but revealed that the stash/injection interaction had deeper timing issues.

**Original motivation:** H scroll `applyMeasurements` writes to the main cache → bumps `cache->version()` → `shouldSkipCorrection()` sees a bump for ALL sub-containers → all re-run their O(N) hash check → potentially triggers redundant layout cascade.

**Re-attempt when:** B1.3 (H-grid/masonry/flow MVC semantics) is prioritised AND there is dedicated time to handle sub-cache stash lifecycle end-to-end.

### B1.9 Precise Activity=hidden detection via forwarded prop

**Problem — current state:** Both `CollectionSubContainerShadowNode` and `CollectionViewContainerShadowNode` detect Activity=hidden via dimension proxies (`yogaHeight == 0`). This works because:
- For H cells: cross-axis height is always > 0 when rendered; only Activity=hidden collapses it to 0.
- For V cells: `display:none` collapses all Yoga dims to 0.

The proxy is reliable today but not semantically precise. `displayType == DisplayType::None` does NOT work — Activity=hidden sets `display:none` on the Activity ancestor ShadowNode, not on the cell's own ShadowNode. The cell's own `displayType` stays `Inline`.

**Proper fix:** Add `isHidden: Bool` to the `RNMeasuredCell` codegen spec. In `CollectionView.tsx`, pass `isHidden={mode === 'hidden'}` from the `CellWrapper` to the `RNMeasuredCell` prop. In C++, read `cellProps.isHidden` directly instead of any dimension proxy. This is the cleanest, intent-explicit approach.

**Scope:** Codegen spec change → pod install; C++ changes in both container ShadowNodes; JS wiring in `renderCell`.

**Estimated cost:** ~0.5d. **Priority:** low — current proxies are reliable, this is a correctness and future-proofing improvement.

### B1.10 In-place cell resize via local setState (Fabric limitation)

**Problem:** A cell whose content changes via an internal `useState` call (e.g. an expand/collapse toggle inside `renderItem` without updating the item data) does not resize in-place. The cell only picks up the new height after scrolling out of the render window and back in.

**Root cause investigated (2026-05-28):**
Fabric's reconciliation for a local `setState` inside a cell processes the update within that cell's fiber subtree. `CollectionViewContainerShadowNode` is NOT re-cloned for this change — the container's structural output (its children array) is unchanged from Fabric's perspective. This means:
- `layout()` on the container never fires
- `correctChildPositionsIfNeeded()` never runs
- The stale measured height in LayoutCache is never evicted

**Approaches tried:**
1. `completeClone()` override on `CollectionViewContainerShadowNode` — the container is not re-cloned for in-place cell state changes, so the override is never reached.
2. `completeClone()` override on a custom `RNMeasuredCellShadowNode` — the cell ShadowNode is also not re-cloned for in-place `setState`. `[CELL-CLONE]` logs never appeared on tap.

**Why UICollectionView sends an explicit `invalidateLayout` signal:** UIKit's `UICollectionViewLayout` is similarly decoupled — cell content changes don't automatically propagate to layout geometry. The app must call `invalidateLayout()` (or `performBatchUpdates`) to signal that layout should re-run. Riff's equivalent is `ref.current.invalidateKeys(keys)`.

**Current recommendation:** Use `ref.current.invalidateKeys([key])` in the resize handler alongside the local state update. React 19 batches both state calls into one commit; the `layoutCacheVersion` bump triggers a container `layout()` call on the next Fabric pass.

**Future investigation:** Deeper Fabric internals may expose a hook (e.g. via `YGNode::markDirty` propagation to ancestor) that could automate this. Not pursued — complexity high, explicit signal is clean and reliable.

**Effort for future attempt:** 2d+ (Fabric internals), low probability of clean solution.

---

## B2 — High-Impact Features (Remaining)

### B2.1 F1.1: C++ diff engine

Key-based diff, runs off main thread. `diff(oldKeys, newKeys) → { inserted, removed, moved }`. O(n) for pure insertions/deletions; O(n log n) for moves.

**Effort:** ~1d

### B2.2 F1.2: Snapshot API (complete)

NSDiffableDataSourceSnapshot-style identity-based mutation API. Partially implemented in `CollectionSnapshot.ts`. Complete: `appendItems`, `deleteItems`, `moveItem`, `reloadItems`, `apply()` with diff + animation.

**Effort:** ~1d

### B2.3 F1.2b: Enter/exit cell animations

Deleted cells: keep mounted briefly, animate opacity→0 + collapse, then unmount. Inserted cells: mount at opacity 0, animate to 1 + expand. "Pending removal" queue in the cell renderer.

**Effort:** ~1.5d

### B2.4 F1.2c: UICollectionView-parity coordinated batch animations

Per-item animation types (fade, slide, custom). Interruptible spring physics. Coordinated batch: inserts, deletes, and moves animate simultaneously. Visual parity with `UICollectionViewDiffableDataSource.apply(snapshot, animatingDifferences: true)`.

**Effort:** ~2d

### B2.6 H-6: Snap behaviors

UIKit-style `orthogonalScrollingBehavior` modes: paging, groupPaging, groupPagingCentered on H sections. Snap points via `UIScrollView.decelerationRate` + `scrollViewWillEndDragging:withVelocity:targetContentOffset:`.

**Effort:** ~1d

---

## B3 — API & Quality (Remaining)

### B3.2 Cross-section sticky headers

Sticky header that stays pinned across multiple sections (e.g. a date header spanning a day's worth of sections). Not currently possible — sticky headers are per-section only.

**Effort:** TBD (design first)

### B3.3 F3.7: Sub-container as public extension point

Document + export the H-2 `RNCollectionSubContainer` framework so consumers can write custom layouts (TS or C++) that get free native frame/transform application. C++ port of one H-2 layout (e.g. `hex`) as reference for native custom layouts.

**Effort:** ~0.5d

---

## B4 — Residual Perf (Remaining)

### B4.5 Opt 3: Transform-based cell positioning

Replace `setFrame:` with `layer.transform = CATransform3DMakeTranslation(x, y, 0)` in `applyPositionsFromState:`. For position-only changes, avoids UIView layout pass. Requires `hitTest:withEvent:` override on `_contentView`. Deferred during earlier perf work — revisit if native positioning shows up in profiles.

**Source:** PERF-PLAN.md Opt 3

**Effort:** ~1d

### B4.6 Opt 5: Flat arrays from spatial queries

For layouts with `needsSpatialQuery: true`, change `getAttributesInRect` to return `Float64Array` instead of JSI objects. Eliminates ~300 JSI property constructions. Only needed if custom spatial-query layouts prove to be a bottleneck.

**Source:** PERF-PLAN.md Opt 5

**Effort:** ~0.5d

### B4.7 Threading model audit — JSI call sites + UIKit dispatch

All `nativeMod.*` JSI calls (scroll, layout query, version polling) execute synchronously on the JS thread. The `invokeScrollHandler` path dispatches a scroll offset to the native scroll container — this ultimately calls `setContentOffset:` which **must** run on the main thread. Verify the current dispatch path is safe and not silently marshalling through the wrong thread.

**Scope:**
- Audit every JSI call site in CollectionView.tsx and native module: which thread does it run on?
- Confirm `invokeScrollHandler` → `setContentOffset:animated:` reaches UIKit on the main thread (not JS thread). If called from JS thread, this is a UIKit thread-safety violation.
- Evaluate whether scroll-to operations could be initiated from the UI thread directly (e.g. via a native gesture recognizer callback) to avoid occupying JS thread at all.
- Document findings; fix any thread-safety violations; note which operations could be moved off JS thread in a future refactor.

**Effort:** ~0.5d (audit + doc) + ~1d if fixes needed

### B4.10 scrollTo API for JS-layout tabs (Radial Arc, 3D Carousel, etc.)

The `scrollTo*` / `scrollToSection` API implemented via `invokeScrollHandler` routes through the LayoutCache to compute target offsets. JS-layout tabs (Radial Arc, 3D Carousel, Spiral, Hex, H2-*) use plain React Native `ScrollView` — they do NOT write to the LayoutCache, so the current `scrollTo` implementation has no effect on them.

**Options:**
1. Expose a `scrollTo` imperative handle on the outer ScrollView and let callers use it directly (simplest; avoids the LayoutCache route entirely for JS layouts).
2. Add a `layoutType === 'js'` fast-path in `invokeScrollHandler` that forwards the call to a JS-supplied `scrollRef`.
3. Block the scrollTo buttons for JS-layout tabs (simplest non-fix; acceptable for demo).

**Decision:** discuss before implementing. Note that the `scrollToSection` / `scrollToIndexPath` API semantics also differ for non-list layouts (radial has no "section" concept in the traditional sense).

**Priority:** low; after core layout fixes

---

## B5 — Documentation

### B5.1 HLD + LLDs

| Doc | Covers |
|---|---|
| `docs/HLD.md` | 5 pillars expanded, trade-offs, design rules |
| `docs/lld/LayoutCache.md` | Single source of truth, version tracking, spatial index |
| `docs/lld/ShadowNode.md` | Fabric reordering bug, tag map, single source of truth, container state |
| `docs/lld/ScrollPath.md` | 5-layer pipeline, C++/JS split, renderGen discipline |
| `docs/lld/Recycling.md` | Three identities (cacheKey/slotKey/dataKey), element cache |
| `docs/lld/Compositional.md` | Key generation, two-level supplementary, interludes |
| `docs/lld/MVC.md` | Anchor lifecycle, programmaticScroll, stash |
| `docs/lld/HSections.md` | Section-local frames, sub-container framework, ChildVisualState |

**Effort:** ~2.5d

### B5.2 Shareable artifacts

- `README.md` refresh (elevator + install + hello world)
- `docs/ARCHITECTURE.md` refresh (5-pillar overview with diagrams)
- `docs/BENCHMARKS.md` (P6.2 + post-H5 numbers, methodology)
- `docs/FlashList-Comparison.md` (feature matrix + perf matrix)
- `docs/GLOSSARY.md` (cacheKey, slotKey, dataKey, flatIndex, fingerprint, MVC, etc.)

**Effort:** ~1d

### B5.3 Contributor + optimization docs

- `docs/Contributing-Layouts.md` (walkthrough to add a new layout)
- `docs/OPTIMIZATIONS.md` (one section per Opt 1-7 + H-1 through H-5)

**Effort:** ~0.5d

---

## B6 — State Persistence & Restoration

### B6.1 F4.1: Layout cache serialization (JSON)

Serialize LayoutCache to disk. JSON format (temporary). MMKV via JSI. Cache key: SHA1(listId + dataHash + viewportWidth + layoutConfig).

### B6.2 F4.2: Scroll position persistence (native iOS)

`setContentOffset:animated:NO` synchronously on viewWillAppear from NSUserDefaults.

### B6.3 F4.3: Full restoration sequence

Wire F4.1 + F4.2 with data validation + cache diff.

### B6.4 F4.4: FlatBuffers serialization

Replace JSON with FlatBuffers. Zero-copy mmap hydration. 10k items: serialize < 3ms, deserialize < 0.1ms.

**Total effort:** ~3.5d

---

## B7 — Layout Polish

### B7.0a Suppress range recalculation and cell eviction during overscroll bounce

**Problem:** During overscroll/rubber-band bounce, the scroll offset changes beyond the content bounds. This triggers H/V render-range recalculation, which can evict cells currently in the window (because the range contracts at the bounce edge). Any loading indicator or content in the overscroll region can mount, but cells already in the render window should not be evicted — they're still visible.

**Desired behavior:** During a bounce, only EXPAND the render range (allow new cells to enter if the range grows), never shrink it. On snap-back, normal range logic resumes.

**Scope:** H render range in compositional layouts confirmed affected. V layouts and standalone H layouts likely same behavior — needs verification.

**Signal:** Detect bounce via `scrollViewDidEndDecelerating` or by checking if content offset is outside `[0, contentSize - viewportSize]`.

**Estimated cost:** ~0.5d. **Priority:** TBD.

### B7.0b H free-width cell measurement ceiling at vpWidth

**Problem:** H free-width cells (H-list, H-grid) are measured by Yoga within the H sub-container, whose Yoga width = vpWidth. Even with the `alignSelf/alignItems: flex-start` chain on the inner wrapper, Yoga passes `YGMeasureModeAtMost(vpWidth)` to Text nodes. Cells whose content naturally needs more than vpWidth will wrap at vpWidth.

**Options:**
1. Document as known limitation: consumers should set explicit `width` on cells that need > vpWidth.
2. Framework provides a `maxMeasureWidth` hint prop on the H sub-container that overrides the Yoga available width for cell measurement.
3. Make H cells `position: absolute` at the React level (unconstrained Yoga measurement). Complex, likely breaks other things.

**Estimated cost:** Option 1 = 0 (just docs). Option 2 = ~0.5d. **Priority:** low.

### B7.1 Flow justification

Leading / center / trailing / spaceBetween / spaceEvenly.

### B7.2 Flow item weight/stretching

### B7.3 Grid rowAlignment

Top / center / bottom for uneven `heightForItem` rows.

### B7.4 H-masonry fix

All items render same size in H mode. Pre-existing, needs investigation.

### B7.5 L-5/L-6: Demo updates + supplementary deliberation

Add H list/H grid resize test to RiffDemo. Deliberate on whether the two-level supplementary model in compositional is the right design.

### B7.6 MVC should anchor on resize

Container resize (orientation change, split view) should trigger MVC correction to keep the visible item anchored. Currently MVC only activates on data mutations.

**Source:** PERF-PLAN.md "Known Issues #3"

### B7.7 Separator toggle scroll position shifts

Toggling separators on/off while scrolled causes scroll position jumps. MVC anchor correction doesn't fully compensate for separator height deltas.

**Source:** PERF-PLAN.md "Known Issues #1"

### B7.8 apply() removeAttributes key format mismatch

`apply()` calls `removeAttributes(key)` using raw keyExtractor IDs (e.g. `"s0-5"`), but LayoutCache stores entries under prefixed keys (e.g. `"sticky-identity:s0-5"`). Removal is always a no-op. Currently harmless because fingerprint-based `cache.clear()` wipes everything.

**Source:** PERF-PLAN.md "Known Issues #5"

### B7.9 Duplicate item at s[0][0] after insert/delete

Two instances of the same item stacked at the same position. Seen once, not fully diagnosed. Possible SlotManager edge case or LayoutAnimation overlap.

**Source:** PERF-PLAN.md "Known Issues #4"

---

## B8 — Testing

### B8.1 T1.1: C++ unit tests

GoogleTest for all layout engines + LayoutCache. Empty section, single item, fixed/dynamic height, multi-section, insets, sticky, separators, backgrounds, spatial queries, invalidation.

### B8.2 T1.2: TS layout wrapper tests

Jest tests for list.ts, grid.ts, masonry.ts, flow.ts. Stable key rule compliance, prepare() params, attributesForItem fallbacks.

**Total effort:** ~3d

---

## B9 — Cross-Platform

### B9.1 F5.1: Android port

CMakeLists wired to existing `cpp/`. TurboModule registration in Kotlin. All M1-M3 test screens pass on Android emulator.

**Effort:** ~5d+

### B9.2 F5.2: Web port (React Native Web)

JS-only fallbacks for C++ JSI calls. ScrollView → DOM scroll container. Fabric components → DOM equivalents.

**Effort:** ~3d+

---

## Unconfirmed / Intermittent Bugs

Bugs reported but not reproducible on re-test. Keep for reference in case they resurface.

### U1 Masonry +top — main list scroll shift

**Reported:** After `+top` insert in masonry section, the main V list shifts a bit and shows the previous section. Only stops when the masonry section becomes much larger than the viewport.

**Hypothesis:** MVC anchor correction was under-correcting because `MasonryLayout::computeSectionFromCache` (called from `applyMeasurements`) reads item heights from the cache post-`computeSections()` fresh path (estimated), not from stash. Since all masonry items have `heightForItem: () => 100`, actual heights may equal estimates, making the error zero — which may explain why it's not reproducible once B0.3 (hardcoded heights) is fixed.

**Next steps if it resurfaces:** Enable `RNCV_MVC_TRACE` logs and capture `snapshotAnchor` / `computeCorrection` output around a `+top` insert.

---

## Post-POC Items

Items that don't block the POC or FlashList comparison but are worth doing afterward.

| Item | Est | Notes |
|------|-----|-------|
| **B2.3** Enter/exit cell animations | 1.5d | Fade/collapse on delete, expand on insert |
| **B2.4** Coordinated batch animations | 2d | UIKit-parity simultaneous insert/delete/move spring animation |
| **B3.2** Cross-section sticky headers | TBD | Design needed; single sticky spanning multiple sections |
| **B3.3** Sub-container as public extension point | 0.5d | Document + export H-2 framework; C++ reference layout |
| **B4.5** Transform-based cell positioning | 1d | `layer.transform` instead of `setFrame:` for position-only changes |
| **B4.6** Flat arrays from spatial queries | 0.5d | `Float64Array` from `getAttributesInRect` — only if custom spatial layouts bottleneck |
| **B4.7** Threading model audit | 0.5–1.5d | Verify `setContentOffset:` reaches UIKit on main thread; fix if not |
| **B5.1** HLD + LLDs | 2.5d | Full architecture docs (LayoutCache, ShadowNode, ScrollPath, MVC, H sections) |
| **B5.3** Contributor + optimization docs | 0.5d | Adding layouts walkthrough, Opt 1-7 reference |
| **B6.1–B6.4** State persistence | 3.5d | JSON → FlatBuffers cache serialization + scroll position restore |
| **B7.4** H-masonry H mode | 0.5d | All items same size in H mode; likely cross-axis sizing not reaching computeSection |
| **B7.5** L-5/L-6 demo updates | — | H list/grid resize test in RiffDemo; supplementary model deliberation |
| **B7.6** MVC on container resize | TBD | Keep anchor on orientation change / split view |
| **B7.8** `apply()` removeAttributes key mismatch | trivial | Raw keyExtractor IDs vs prefixed cache keys; harmless until fingerprint-clear is removed |
| **B7.9** Duplicate item at s[0][0] on insert/delete | TBD | Intermittent; SlotManager or LayoutAnimation edge case |
| **B8.1** C++ unit tests | 2d | GoogleTest for all layout engines + LayoutCache |
| **B8.2** TS layout wrapper tests | 1d | Jest for list/grid/masonry/flow |
| **B9.1** Android port | 5d+ | CMakeLists + TurboModule Kotlin registration |
| **B9.2** Web port | 3d+ | JS fallbacks for JSI; DOM scroll container |
| **B7.7** Separator toggle scroll position shift | 0.5d | MVC anchor correction doesn't fully compensate for separator height delta |
| **B1.3-masonry** MVC semantics for H-masonry | TBD | Correction not well-defined; items assigned to shortest column scramble on insert. Options: no correction or re-anchor to nearest item at old X. **Also:** revisit `setLayoutCacheVersion` guard in `CollectionView.tsx` scroll handler — current guard fires only when `effectiveLayout.contentSize()` changes. H-masonry uses per-cell explicit column-assigned widths; a width change without total contentSize change skips the JS re-render, leaving `containerStyle.width` stale. Add a per-cell width-change trigger when implementing. |
| **B1.3-flow** MVC semantics for H-flow | 0.5d | Items flow left-to-right; same anchor-delta approach as H-list may work for uniform items. **Also:** same `setLayoutCacheVersion` guard caveat as B1.3-masonry — H-flow cells have flow-assigned explicit widths, so a reflow that changes widths without changing total contentSize would not trigger the current guard. Add a per-cell width-change trigger when implementing. |
| **B1.5** Sub-cache isolation (reattempt) | 2.5d | Parked; re-attempt when B1.3 is done and full stash lifecycle can be handled end-to-end |
| **B1.5a** Stable section identity for sub-cache | 0.5d | Prerequisite: B1.5 |

---

---

---

# ✅ Completed

---

## Execution Order — Completed

| # | Item | Est | Notes |
|---|------|-----|-------|
| 1 | **B1.5b** Re-render burst — H-MVC version isolation | 0.5d | ✅ DONE |
| 2 | **B1.3** MVC semantics for H sections | 1d | ✅ DONE — snapshotHAnchor now layout-agnostic (list/grid/masonry/flow) |
| 3 | **B2.5** Interludes — `splitInterludes` API | 1.5d | ✅ DONE — `src/layouts/interludes.ts`; `splitInterludes(primary, interludes)` → `{ sections, layout }` |
| 3b | **B0.4.4** H scroll vertical bounce | 0.5d | ✅ DONE — `updateState:` syncs `frame.size.height = contentSize.height` for H sections; `_applyOrDeferScrollViewFrame` clamps height to max(bounds, contentSize) |
| 4 | **P6.2** Device measurement session | — | ✅ DONE — `docs/BENCHMARKS.md`; Search fast-scroll: Riff 59 FPS vs Flash 37–38; HP: tied FPS, Riff 2× lower CPU + ~27 MB lower memory; Storefront: broadly even |
| 5 | **B3.1** API review | 1–2d | ✅ DONE (rename pass) — all public types Riff-prefixed (RiffLayout, RiffSection, RiffListConfig, etc.); handle→ref via forwardRef; renderItem → RiffRenderItemInfo<T>. Remaining: ScrollView callback surface, deprecated prop cleanup, renderSectionHeader missing prop |

---

## B0 — CompositionalLab / Compositional Demo Bugs ✅ All Fixed

### B0.1 S1 List H — section height much larger than max item height ✅ FIXED

**Fixed:** `finalizeHSection` + `refreshHSectionWrapperHeight` now cap Placeholder item heights
at `maxMeasuredH` (tallest Measured cell in section). Placeholder items at `estimatedCrossAxisHeight`
no longer inflate the wrapper past actual content height. Committed in `2729016`.
Also subsumed by **L-1** (B1.2a): without a locked style.width, H-list cells measure
their natural height, so Placeholders converge to actual height sooner.

### B0.2 Resize and Update mutation buttons not working ✅ FIXED

**Fixed:** Two-part fix in `2729016`:
1. `SlotManager.sync()` now accepts `renderGen` and includes it in the short-circuit check.
   In-place mutations (Resize, Update) bump `renderGen` via `extraData` change, forcing a
   Phase 3 run that refreshes `slot.item` references so Yoga re-measures new content.
2. `CollectionSubContainerShadowNode::shouldSkipCorrection` now hashes per-child Yoga frame
   (all 4 fields, 2-decimal precision) in addition to child tags. Resize changes Yoga
   dimensions without changing tags/count/cacheVersion — old hash skipped correction.

### B0.2b Compose/Lab broken when navigating from any C++ layout tab ✅ FIXED

**Root cause:** `useEffect` unmount cleanup (`layoutCache.clear()`) fired asynchronously after
paint — after `prepare()` had correctly filled the cache, but *before* the re-render triggered
by `ShadowNode.updateState()` arrived. The re-render's `useMemo` deps were unchanged so
`prepare()` was skipped; `ShadowNode.layout()` read an empty cache → wrong contentSize.

**Fix:** Removed the unmount `useEffect` cleanup entirely. `prepare()` overwrites stale data from
any previous C++ layout session (every `computeSections()` calls `_cache->clear()` internally),
so the cleanup was both unnecessary for its original purpose and harmful due to the async race.
The `if (!layoutContext)` guard in the prepare `useMemo` remains as a safety net for
`initialWidth={0}` edge cases only.

### B0.3 S4 Masonry V — all items same height (looks like a grid) ✅ FIXED

**Fixed:** Removed `heightForItem: () => 100` from the masonry section in `CompositionalLab.tsx`.
Items already have variable `detail` text (short / medium / long) so Yoga measures each cell
naturally, producing the waterfall height variance.

### B0.4 S3 Grid H — multiple issues ✅ All Fixed

1. **Item heights much smaller than row heights.** ✅ FIXED — `GridLayout::computeSectionFromCache`
   H-path now tracks `hasMeasuredCross[]` and only uses actually-measured cross heights to derive
   `itemCrossSize`. Placeholder items no longer keep the estimate when measured data is available.
   Committed in `2729016`.
2. **Vertical scroll indicator / vertical scrolling.** ✅ FIXED — `refreshHSectionWrapperHeight`
   (added in `36669f7`) re-derives wrapper height from actual item frames after every
   `applyMeasurements`, bypassing the 2pt hysteresis that was leaving the sub-container
   `contentSize.height` inflated after deletes.
3. **Delayed resize.** Fixed by B0.2 Yoga-hash fix — shouldSkipCorrection no longer skips on
   content-only changes. ✅ FIXED.
4. **H scroll vertical bounce during measurement convergence.** ✅ FIXED — `alwaysBounceVertical=NO`
   suppresses bounce only when `contentSize.height <= frame.height`.

### B0.5 S6 "Control" section — clarify purpose ✅ FIXED

**Fixed:** Updated `SECTION_META` label in `CompositionalLab.tsx` from `'S6 Control'` to
`'S6 List V (no chrome — control)'`.

---

## B1 — Architecture (Completed)

### B1.1 L-7: Push measured cell size as explicit Yoga dimension ✅ FIXED

**Fixed in `ba9869b`:** Override `layoutTree` in `CollectionViewContainerShadowNode` to call
`YGNodeStyleSetHeight`/`Width` on `Measured` cells before `YGNodeCalculateLayout` runs.
Covers V-section cells (Height axis) and H-section grandchildren (Both axes).
`Placeholder` cells receive `YGNodeStyleSetHeightAuto` so intrinsic measurement runs normally
on first render. With drift eliminated, also removed:
- `std::ceil` + 2pt hysteresis in `CompositionalLayout::finalizeHSection` and `refreshHSectionWrapperHeight`
- `_applyOrDeferScrollViewFrame` busy-guard in `RNCollectionSubContainerView`

### B1.2 L-1/L-2/L-3: Layout intent violations — let Yoga measure what it should ✅ FIXED

| Layout | Problem | Fix |
|---|---|---|
| H list (L-1) | `style.width` locked from `estimatedItemHeight` | ✅ DONE (`d9164eb`) — `isHListCell` guard removes width for standalone + compositional H-list. |
| H grid (L-2) | `style.width` locked from `rowHeight` | ✅ DONE — `isHFreeWidthCell` extended to cover compositional H-grid cells. GridLayout's `applyMeasurements` already cascades via `computeSectionFromCache` using per-column max measured width. No C++ changes needed. |
| V flow (L-3) | `style.width` locked from `sizeForItem.width` | ✅ DONE — `isVFlowCell` added to `isHFreeWidthCell` condition. Standalone V-flow cells get `alignSelf:flex-start` + `maxWidth:viewportWidth`. `FlowLayout::applyMeasurements` already handles `ContentDimension::Both` (Width + Height deltas) and does a full `computeSectionFromCache` reflow. |

### B1.3 MVC semantics for H sections ✅ FIXED

**Fixed:** `snapshotHAnchor` in the `prepare` useMemo was gated on `hSectionTypes?.[sIdx] === 'list'`, excluding grid/masonry/flow. The correction mechanism is layout-agnostic — it records the first-visible item key + X before `prepare()`, then reads the item's new X from the cache after `applyMeasurements` and applies the delta to the H scroll view. Removed the type guard; correction now fires for all H layouts.

### B1.4 Decouple measureAhead from isVariableHeight ✅ FIXED

**Already resolved.** `measureAhead` is passed directly to `processScroll` without any
`isVariableHeight` gate. No remaining instances of `isVariableHeight && measureAhead` in CollectionView.tsx.

### B1.5b H-MVC version isolation ✅ DONE

Add `uint64_t _hMvcVersion` to `LayoutCache`. H sub-containers check `_hMvcVersion`; V sub-containers check `_version` only. Prevents V sub-containers from re-running O(N) hash check on every H scroll `applyMeasurements`.

### B1.6 H-list content size not updated after Width delta cascade ✅ FIXED

**Already resolved.** `LayoutCache::getTotalContentSize()` iterates all entries in `_map`
(not just mounted children), so after `applyMeasurements` cascades X positions for all H-list
items the max extent is always correct.

### B1.7 First-pass scroll correctness — primary-axis MVC on Width delta cascade ✅ FIXED

**Fixed:** Removed `!_mvcEnabled` guard from `LayoutCache::snapshotAnchorIfNeeded()`. Size-change MVC is now always active — Yoga measurement settling should never cause visible scroll jumps. Mutation MVC (`snapshotAnchor()` from JS `prepare()`) remains gated on `maintainVisibleContentPosition`.

### B1.8 computeSection preserves Measured heights — break vLCV feedback loop ✅ FIXED

**Fixed in `fix/compute-section-preserve-measured`:** Before writing an item, both `MasonryLayout::computeSection` and `FlowLayout::computeSection` now look up the cache for an existing `Measured` entry and reuse the Yoga-measured size as `itemPrimary`. Writing back the same frame is a no-op for `_version` → no LCV notification → feedback loop broken. `vLCV` drops from ~70 per scroll to ~initial measurement count only.

---

## B2 — Completed

### B2.5 F3.6: Interludes ✅ DONE

**Fixed:** `src/layouts/interludes.ts` exports `splitInterludes(primary, interludes)` → `{ sections, layout }`.
Pure JS splitter on top of the existing compositional engine — no native changes.
Anchors: `{ afterKey }` (tracks item identity across mutations), `{ afterIndex }`, `{ atKey: 'top'|'bottom' }`.
Multiple interludes at the same anchor are stacked in declaration order.

---

## B3 — API (Completed)

### B3.1 API review ✅ DONE (rename pass)

All public types Riff-prefixed (`RiffLayout`, `RiffSection`, `RiffListConfig`, etc.); handle→ref via `forwardRef`; `renderItem` → `RiffRenderItemInfo<T>`. Remaining items (ScrollView callback surface, deprecated prop cleanup, `renderSectionHeader` missing prop) deferred.

---

## B4 — Residual Perf (Completed)

### B4.1 Main container ShadowNode short-circuit ✅ FIXED

**Fixed:** `shouldSkipCorrection()` added to `CollectionViewContainerShadowNode`. Caches `{cacheVersion, childCount, childTagsHash, yogaFrameHash}`. Returns early if all four match, skipping `correctChildPositionsIfNeeded` + `updateStateIfNeeded` entirely.

### B4.2 Investigate spurious Yoga deltas on repeat scroll ✅ RESOLVED

**Resolved by B1.8.** `vLCV=0` during steady-state scroll through already-measured content. Root cause was `computeSection` resetting Measured cells to estimated heights on every layout effect run.

### B4.3 H-cell LCV memo removal ✅ FIXED (2026-05-22)

Removed `(!slotIsHCell || prev.lcv === layoutCacheVersion)` from the Opt-7 element cache check. H-cell positions are owned by the sub-container ShadowNode, not CSS style, so the extra LCV guard was causing every H cell to miss the memo on every V scroll tick.

### B4.4 Guard unconditional setContentHeight ✅ FIXED

`setContentHeight(layoutContentHeight)` now guarded by `chChanged`. Avoids React reconciler overhead on layout effect runs where content height is stable.

### B4.8 LayoutEngine protocol — enforce clear-before-compute structurally ✅ FIXED (2026-05-22)

Moved `_cache->clear()` from each engine's `computeSections()` body into the JSI binding lambda. `computeSections()` is now a pure layout function; the clear is structurally enforced at the JSI call site for all 5 engines.

### B4.9 Per-instance LayoutCache — eliminate shared global cache pollution ✅ FIXED (2026-05-22)

`PerInstanceData` struct + `_instances` map in `CollectionViewModule`. `createLayoutCache()` / `destroyLayoutCache(id)` lifecycle JSI handlers. Per-instance JSI accessors (`layoutCacheById`, `getListLayoutById`, etc.). All 9 layout classes wire `_cache`/`_engine` to per-instance objects via `context.cacheId` in `prepare()`.

**Branch:** `feat/b4-9-per-instance-cache` → merged to `main`

---

*For full milestone history (Phases 0–5, P1–P5, F2, F3.1–F3.5, H-1 through H-5, all Opts, all perf work) see `PLAN.md`. Archived plans in `docs/archived-plans/`.*
