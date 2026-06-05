# Riff — Consolidated Backlog

> Single source of truth for all remaining work. Replaces cursor-plan.md, ethereal-seeking-willow.md, PERF-PLAN.md, and perf-opti-claude.md (archived in `docs/archived-plans/`).

---

# 🔲 Active / Remaining

## Execution Order

| # | Item | Est | Notes |
|---|------|-----|-------|
| 1 | **B1.3** Rename size APIs to `estimated` prefix | 0.5d | Breaking rename: `itemHeight` → `estimatedItemHeight` etc. across all 5 layout engines + public types. Coordinate with B5.2 docs. |
| 2 | **B5.2** Shareable artifacts — round 1 | 1d | README, benchmarks doc, FlashList comparison matrix (P6.2 numbers done). |
| 3 | **B4.11** `scrollTo` with unmeasured items | 1d | Scroll to exact offset even when intervening items are still Placeholder. See B4.11 below. |
| 4 | **B3.2** Cross-section sticky headers | TBD | Design first; single sticky spanning multiple sections. |
| 5 | **B2.3 + B2.4** Enter/exit + coordinated animations | 3.5d | Fade/collapse on delete; expand on insert; UIKit-parity spring batch animations. |
| 6 | **B6.1–B6.4** State persistence | 3.5d | JSON cache serialization → FlatBuffers + scroll position restore. |
| 7 | **B2.7 + B3.4** JS layouts fix + native layout plugin API | 2d | Fix `correctChildPositionsIfNeeded` for JS layouts; expose public C++ plugin registration. |
| 8 | **B2.6** Snap behaviors (H-6) | 1d | UIKit paging/groupPaging on H sections; FlashList has no equivalent. |
| 9 | **B2.2 + B2.1** Snapshot API + C++ diff engine | 2d | NSDiffableDataSource-style mutation API + off-thread key diff. |
| 10 | **B4** Perf / threading | 1–2.5d | B4.7 threading audit + B4.5 transform positioning + B4.6 flat spatial arrays + B4.12 native invalidation callback. Profile-driven; skip if not bottlenecked. |
| 10 | **B8** Unit tests | 3d | C++ GoogleTest + TS Jest. |
| 11 | **B7.0a + B7 polish** | — | Overscroll range contraction, flow justification, grid rowAlignment, H-masonry, MVC on resize, separator toggle shift. |
| 12 | **B9** Android / Web | 8d+ | Android CMakeLists + Kotlin; RN Web JS fallbacks. |

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

### B1.10 In-place cell resize via local setState ✅ RESOLVED (2026-06-02)

**Resolution:** `ref.current.invalidateItem(sectionIndex, itemIndex)` is the correct pattern. Call it in the same event handler as the state update that changes the cell's height — React 19 batches both into one commit. The `invalidateItem` API bumps `invalidateTrigger` (internal counter, not consumer-facing), which:
1. Increments `renderGen` → all window cells miss the element cache → re-render → Fabric re-measures the changed cell.
2. Fires the double-RAF version-poll → once `applyMeasurements` records the new Yoga height, `processScroll` calls C++ `invalidateFrom(i)` → positions reflow from the changed item onward. O(n − i), not O(n).

**Root cause documented for posterity:** Fabric does not re-clone `CollectionViewContainerShadowNode` for in-cell `setState` (the container's child array is structurally unchanged). `layout()` never fires, so `correctChildPositionsIfNeeded` never runs and the stale cached height is never evicted. An explicit signal is necessary — this is by design, matching UIKit's `invalidateLayout()` pattern.

### B1.11 RN < 0.83 Activity fallback — clamp `measureAhead` only (B-pre83-measureahead)

**Surfaced during:** session-prep validation (2026-06-03); refined by storefront diagnosis (2026-06-04).

**Problem:** `Activity` resolves to `undefined` on RN < 0.83 (CollectionView.tsx:51–56). The `CellWrapper` fallback at line 1016 returns `<>{children}</>` — `measureOnly` no longer suppresses render. Two features behave differently in this fallback path:

1. **Slot pool retention** — STILL useful on older RN. Pool re-renders cost subtree reconciliation only (no useEffect re-fire because deps are stable, no Yoga re-measure, no native UIView allocation). Cold-mount cost on re-entry is strictly higher than pool re-render cost for any cell that re-enters. Pool clamp would *hurt* bouncy workloads. **Do NOT clamp pool size based on Activity availability** — keep the consumer-tunable `recyclePoolSize` knob working on all RN versions. The consumer knows whether their workload re-enters cells (set high) or scrolls linearly (set low).

2. **`measureAhead > 0`** — NOT useful without Activity. Its sole purpose is "mount cell, let Yoga measure, but suppress paint + useEffect." Activity is the mechanism that suppresses; without it the cells render fully, paint at their below-viewport position (clipped by UIScrollView but the React + Yoga compute already ran), useEffect fires. Zero observable benefit, full compute cost.

**Fix:** when `Activity === undefined`, clamp the effective `measureAhead` to 0 regardless of the consumer prop value. Log a `__DEV__`-only warning the first time a non-zero `measureAhead` is observed on a pre-Activity build so consumers notice they're configuring a no-op.

**Where:** `src/components/CollectionView.tsx` measureAhead read path (where the effective value is computed from props + memory pressure).

**Document** in README §"Why Riff" §4 / §"Windowing and the slot pool":
- `recyclePoolSize` works on all RN versions; trade is memory ↑ (cell stays mounted) for CPU ↓ (no cold mount on re-entry). On RN 0.83+ pool members are frozen by Activity (cheap memory); on older RN they re-render on parent reconcile (still cheaper than cold mount but not free).
- `measureAhead` only takes effect on RN 0.83+. Older RN silently clamps to 0 — consumer needs to ship with first-paint correction visible if they expect content above first-paint to be variable-height.

**Effort:** ~0.5d (clamp + dev warning + README paragraph + test).

**Priority:** Pick up before any concerted RN < 0.83 support work. Not urgent for the current target (RN 0.83.4).

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

### B2.7 JS layouts — re-attempt guide (reverted 2026-06-01)

Reverted commits: 43e541d, f77040f, e70429a, a328588, 461168a

**Root causes of regressions:**
1. `correctChildPositionsIfNeeded` used Yoga-sequential positions for JS layout cells instead of the JS layout's LayoutCache positions → all cells stacked at top
2. B1.1 in `layoutTree()` — dead code (Fabric only calls `layoutTree()` on RootShadowNode, never on component ShadowNodes)
3. JS layouts writing `sizingState: 'measured'` → violated Yoga-authority principle, blocked height measurement

**What was kept (already in main after revert):**
- Visual attrs pipeline generalized for all layouts: alpha, transform3D, zIndex applied from LayoutCache in `applyPositionsFromState` without `_isJsLayout` guard
- `cacheKey` property on `RNMeasuredCellView` always stored (not DEBUG-only)
- `sizingState: 'placeholder'` in all 4 JS layout .ts files (radial, carousel3D, spiral, hex)

**What needs to be done for re-attempt:**
1. Add `'js'` layoutType back to codegen spec + C++ enum (from a328588)
2. Add `isJsLayout` paths back to `CollectionView.tsx` (from 43e541d): `JsLayoutScrollOptions`, `JsLayoutScrollResult` types, updated `processScroll` signature, JS layout scroll handling
3. **Critical fix**: Add JS-layout correction path in `correctChildPositionsIfNeeded` — for `layoutType == Js`, read x/y positions from LayoutCache instead of Yoga-sequential layout output. This is the core regression that needs new code.
4. Visual attrs pipeline already generalized — will work for JS layouts automatically
5. Test: H-2 tabs (radial/carousel3D/spiral/hex) show expected shapes with cell content visible

**Effort:** ~1d (mostly the `correctChildPositionsIfNeeded` fix + wiring)

---

## B3 — API & Quality (Remaining)

### B3.2 Cross-section sticky headers

Sticky header that stays pinned across multiple sections (e.g. a date header spanning a day's worth of sections). Not currently possible — sticky headers are per-section only.

**Effort:** TBD (design first)

### B3.3 F3.7: Sub-container as public extension point

Document + export the H-2 `RNCollectionSubContainer` framework so consumers can write custom layouts (TS or C++) that get free native frame/transform application. C++ port of one H-2 layout (e.g. `hex`) as reference for native custom layouts.

**Effort:** ~0.5d

### B3.4 Public packaging API for user-defined native C++ layout engines

`registerLayoutEngine(cacheId, name, enginePtr)` already exists internally and is how all 5 built-in layouts are registered at startup. What is missing is a clean public API for app or library code to register a custom `LayoutEngine` subclass from outside the Riff module — e.g. a separate npm package that ships a native C++ layout and registers it at app init.

**Work needed:**
- Define a public C++ interface (`RiffLayoutEnginePlugin`) that consumers inherit from
- Expose a `RiffLayoutRegistry` singleton accessible from ObjC app-layer (iOS) and CMake (Android)
- Add JS-side codegen enum entry (or string prop) to declare the custom layout type name to CollectionView
- Write a reference example: `hex` layout extracted from Riff internals, published as a standalone plugin

**Why it matters:** Enables community-contributed native layouts (circular carousels, physics-driven, etc.) without modifying Riff core. Same model as UICollectionViewLayout subclassing.

**Effort:** ~1.5d

**Priority:** After B2.7 (JS layout fix) to establish both extension paths simultaneously.

### B3.5 `invalidateItem` API truthfulness (B-invalidate-api-truth)

**Surfaced during:** session-prep validation (2026-06-03).

**Problem:** The `invalidateItem(sectionIndex, itemIndex)` ref method (CollectionView.tsx:2148–2157) ignores both arguments. It bumps `invalidateTrigger` and `layoutCacheVersion`, which forces a full re-render of all window cells via the `renderGen` increment path. The README §9 framing — "Riff runs `invalidateFrom(i)` in C++ — only items from index i onward reflow" — is partially aspirational: the C++ tail-only path does run, but it's triggered after the full-window React re-render, not as a direct targeted invalidation from `(section, index)`.

**Two options:**

1. **Rename the API to match behaviour** — `invalidateWindow()` (or keep `invalidateItem` as an alias for callers that pass coordinates for documentation value, but make the arguments truly optional and clearly noted as unused). Updates README §9 accordingly. Cheap, honest.
2. **Implement actual targeted invalidation** — route the call to evict only the named cell from the LayoutCache, force Fabric to re-measure only that cell (challenging — Fabric doesn't re-clone the container ShadowNode without a structural child-array change; see B1.10 root-cause note). Likely needs a synthetic dirty-flag prop on the child or a direct JSI bypass.

**Recommendation:** Option 1 in the near term. Option 2 only if the full-window React re-render becomes a measurable cost on cell-resize-heavy pages.

**Effort:** Option 1 ~0.5d (rename + README update). Option 2 ~2d+.

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

### B4.12 Replace double-RAF version poll with direct native callback

**Problem:** When `invalidateItem` is called without an active scroll, Riff detects the Yoga measurement completing by polling the C++ LayoutCache version counter in two consecutive `requestAnimationFrame` callbacks (~33ms at 60fps). This is the only remaining polling loop in the scroll path.

**Why it exists:** The LayoutCache version is a C++ integer; JS has no listener API for it today. The double-RAF is the simplest bridge.

**Better approach:** Emit a native event (or use a JSI callback) from `updateState:` in `RNCollectionViewContainerView` when `layoutRevision` changes. JS subscribes once; the callback fires synchronously on the same frame as the Fabric commit. This is what FlashList achieves via `onLayout` callbacks — Fabric fires them synchronously during the commit, no polling needed.

**Impact:** Removes the last polling loop. Reduces invalidateItem-to-reflow latency from ~33ms to <1 frame. Low priority — only affects static-viewport invalidation; active scroll already uses the synthetic onScroll signal from `updateState:`.

**Effort:** ~0.5d

---

### B4.11 `scrollTo` exact offset with unmeasured items

**Problem:** `scrollToIndex` / `scrollToIndexPath` compute the target scroll offset by reading cumulative positions from the LayoutCache. Items that haven't entered the render window yet are still `Placeholder` — their heights are the `estimatedItemHeight` estimate, not the Yoga-measured value. If actual heights differ from estimates, the scroll lands at the wrong offset (sometimes by a lot for large lists with variable-height items).

**Current behaviour:** Scrolling to a far-off item lands near but not exactly at the item. The first scroll brings the render window close; subsequent `applyMeasurements` passes correct individual heights; but there is no second-pass correction to adjust the scroll offset.

**Desired behaviour:** After scrolling to an estimated position, once the target item becomes Measured, correct the scroll offset to the exact position. The user should not see a jump — either hold the final position still (suppress bounce) or apply the correction instantly.

**Approaches:**
1. **Two-pass correction**: after `scrollToIndex`, register the target key. When `applyMeasurements` marks that key as `Measured`, check if the current offset drifted from the correct position and call `setContentOffset:` to correct. Low cost; small visible jump possible on very slow devices.
2. **Pre-render and scroll**: before scrolling, synchronously expand the render window to include the target item and wait one Fabric pass for measurement. Expensive for large jumps (O(distance) cells mounted).
3. **Accept estimated offset + document limitation**: document that `scrollTo` is best-effort for unmeasured items. Correct for already-measured ranges. This is what FlashList does.

**Recommended approach:** Option 1 (post-scroll correction). Register the target in a `pendingScrollCorrection` ref; clear it once applied or after a timeout.

**Effort:** ~1d

### B4.17 V-container cache-version bump source investigation (B-cache-version-bumps) — TOP PRIORITY

**Surfaced during:** post-clone-ctor-fix bench (2026-06-05).

**Context:** With the clone-constructor bug fixed, `shouldSkipCorrection` works correctly. Skip rate jumped from 0% to ~30% across all three bench pages. **The remaining 70% of correction runs are driven by `cache->version()` changes** — specifically, `fail.ver=66%` on storefront (1054/1600), `fail.ver=64%` on homepage, `fail.ver=67%` on search. Cache version is bumping by ~1 per Fabric commit during V scroll.

The likely source: V container's `correctChildPositionsIfNeeded` writes measured heights via `applyMeasurements` as new cells enter render range during V scroll. New cells have estimated heights; Yoga measures them differently; the layout engine cascades; `endBatch()` bumps `_version`. Each such bump invalidates every sub-container's skip check on the next commit.

This isn't necessarily a bug — measuring incoming cells during scroll is legitimate work. But it's putting a ~30% ceiling on skip rate. Investigation needed to determine:

1. Are all of those writes truly necessary, or is some Yoga sub-pixel drift triggering needless `applyMeasurements`?
2. Can the V container's `correctChildPositionsIfNeeded` batch multiple measurements into one `_version` bump per commit instead of one bump per measurement?
3. Could the V container's writes use a separate counter (e.g. `_vMvcVersion` analogous to `_hMvcVersion`) that sub-containers don't observe, so V correction doesn't fan out to sub-containers?

Approach: instrument the V container's `correctChildPositionsIfNeeded` to count `applyMeasurements` calls per commit and how many deltas were in each batch. If average batch size > 1, batching might already coalesce. If avg = 1 per commit, one write per scrolled-in cell is happening.

**Effort:** ~1d for instrumentation + analysis. Fix effort depends on findings:
- If sub-pixel drift: tighten threshold in the V engine's delta detection (~0.5d)
- If genuine batching coalescing opportunity: refactor commit/batch boundaries (~1-2d)
- If `_vMvcVersion` split: similar to `_hMvcVersion` precedent (~1d)

**Priority:** TOP — this is the next bottleneck after the clone-ctor fix. Bench numbers show ~30% skip rate; pushing to 80-90% requires understanding what's driving the version bumps.

### B4.18 Tighter applyMeasurements thresholds — V container (B-tighter-thresholds)

**Surfaced during:** post-clone-ctor-fix bench (2026-06-05).

**Problem:** Sub-container's `correctChildPositionsIfNeeded` filters Yoga deltas with a 0.5pt threshold to suppress sub-pixel jitter. The V container may not be as aggressive. If Yoga drift below 0.5pt triggers `applyMeasurements` in V correction, every commit during V scroll could be writing trivial corrections that bump `_version` and invalidate sub-container skip checks.

**Investigation:** check V container's delta threshold and Yoga-vs-cache comparison logic. Compare to sub-container's pattern at `CollectionSubContainerShadowNode.cpp:381` (`kCellMVCThresholdPt = 0.5f`).

**Effort:** ~0.5d to investigate + tighten if applicable.

### B4.19 Coalesce cache writes within a Fabric commit (B-coalesce-writes)

**Surfaced during:** post-clone-ctor-fix bench (2026-06-05).

**Goal:** ensure a single Fabric commit produces a single `_version` bump regardless of how many cache writes happen during that commit. The V container, sub-containers, and any engine-driven recomputation should all write under one `beginBatch()` / `endBatch()` pair scoped to the commit.

Currently `beginBatch`/`endBatch` is used inside specific engines (e.g. `applyMeasurements`), but cross-cutting writes (V correction → cache write, then sub-container correction → cache write) may each produce their own bump. Coalescing across the entire commit cycle would mean sub-containers only see one `_version` delta per Fabric commit, capping cascade fan-out.

**Approach:** wrap `ShadowNode::layout()` of the V container in `beginBatch()`/`endBatch()`. Sub-containers nested inside this scope would have their writes coalesced into the outer batch.

**Effort:** ~1-1.5d. Needs care: batch reentry semantics must support nesting; existing batch users (engine `applyMeasurements`) must continue to work.

### B4.21 Defer V correction during high-velocity scroll (B-defer-v-correction)

**Surfaced during:** post-B4.17-fix bench review (2026-06-05).

**Context:** After all skip-correction fixes (clone ctor, LCV-removal, vVersion split), storefront's p75/p90 CPU still trails FlashList by 3-8 points (Riff 32/37% vs Flash 29/29%). The remaining cost is the V container's own `correctChildPositionsIfNeeded` running on ~95% of Fabric commits during fast scroll, with each call doing real layout work (Yoga delta detection, `applyMeasurements`, position cascade, state delivery).

The work itself is legitimate — cells genuinely stream into render range and need their measured heights applied. But during fast V scroll, the user can't perceive sub-pixel position corrections happening every frame. There may be room to defer the corrections until scroll velocity drops or scroll ends.

**Proposed approach:**
- Read scroll velocity from the LayoutCache (already tracked via `setScrollOffset`)
- During high-velocity scroll (e.g. > 50pt/frame), skip `applyMeasurements` writes in `correctChildPositionsIfNeeded` — keep the cached estimates as the current frame's positions, defer real corrections
- Maintain a "pending corrections" set; flush on `didEndDecelerating` / `didEndDragging` / sustained low-velocity frame
- Sub-containers continue to function normally (they read positions from cache; cache stays at estimates during the deferred window)
- Once the user stops scrolling, flush the queue: one large `applyMeasurements` batch with all accumulated deltas → one cache version bump → one re-correction pass through sub-containers

**Risks:**
1. **Visible-cell staleness during fast scroll** — if a cell's measured height differs significantly from its estimate, the visible position would shift on scroll-end as the deferred correction lands. Acceptable for sub-pixel deltas; bad for large deltas (e.g. image-load resize during fling).
2. **MVC interaction** — `maintainVisibleContentPosition` relies on position changes propagating to scroll-offset adjustments. Deferral could produce visible jumps when corrections flush.
3. **Heuristic tuning** — what counts as "high velocity"? Per-platform? Per-device?

**Effort:** ~2-3 days for prototype + tuning + bench verification. The most aggressive remaining optimization on storefront.

**Priority:** Pursue only if storefront's p75/p90 gap vs FlashList becomes a real product issue. Current Riff wins on min FPS, p5 FPS, memory, and active component count even on storefront; the percentile-CPU gap is an analytical loss but not a perceived loss.

### B4.20 Defer non-critical measurements (B-defer-measurements)

**Surfaced during:** post-clone-ctor-fix bench (2026-06-05).

**Goal:** cells entering the *measure* range but not the *render* range don't strictly need their measured heights applied immediately — the user can't see them. Defer those corrections until they actually enter the render range (or until idle time after scroll-end). Reduces cache writes during fast scroll.

**Risk:** estimates may be inaccurate at first paint when a cell scrolls into render range. May produce a one-frame correction flicker on fast scroll. Trade between scroll smoothness and first-paint accuracy.

**Effort:** ~1-1.5d to implement + test for paint flicker.

### B5.6 Document crossSectionRecycling + per-section pool model (B-doc-cross-section-recycling)

**Surfaced during:** post-clone-ctor-fix bench (2026-06-05).

**Pending docs work** — to be done AFTER bench numbers validate the `crossSectionRecycling` prop's impact across the three workloads:

1. **README** §"Windowing and the slot pool" — add `crossSectionRecycling` prop to the "four knobs" tuning section. Explain trade-off (global pool vs per-section pool); when to set to false (single-widget-type-across-many-sections workloads like product feeds); note migration is non-destructive (slot keys preserved). Add to "Tuning the four knobs" table.

2. **`session_riff_sneak_peek.md` (slide deck)** — extend the R4 (slot lifecycle) block: add a note that pool keying can be global vs per-section, controlled by `crossSectionRecycling` prop. Show the trade-off in one sentence each.

3. **`session_riff_handout.md` (engineer handout)** — substantive section after the "Tuning the four knobs" content. Cover: SlotManager's pool-keying mechanism (single map keyed by `itemType` or `${section}|${itemType}`), the non-destructive migration semantics of `setCrossSectionRecycling()`, the storefront-style workload pattern (one widget type → high cross-section churn), and benchmark guidance ("toggle via PerfHood, measure both states").

Hold off until at least one full bench cycle with both states confirms the model and produces consistent numbers — the docs need real numbers, not speculation.

### B4.16 Per-H-section private slot pools (B-hsection-private-pools)

**Surfaced during:** storefront regression diagnosis (2026-06-05).

**Problem:** Riff's current slot pool is keyed by `getItemType` and SHARED globally across V and H sections. On pages where multiple sections use the same widget type (storefront: all 8 sections use one product card type), the single shared pool absorbs evictions from every section. Consequences:

1. **Pool churn dominates the bench** — V scroll moving past a section evicts its H cells; the pool capacity is consumed faster than its `recyclePoolSize` (default ~16, storefront tested up to 64). Cells from sections currently in V scope get evicted by sections that just left scope.
2. **`shouldSkipCorrection` cnt-check fails 100%** — when a section re-enters V scope, its sub-container wrapper is still mounted (the wrapper is one slot, easy to retain) but the cells inside are gone; they cold-mount. Wrapper's child count goes `N → 0 → N` constantly. Every commit on every sub-container sees a cnt change.
3. **Pre-RN-0.83 path is even worse** — without `Activity=hidden` suppression, pool-retained cells render full-cost on every parent reconcile.

**Proposed alternative:** each H sub-container owns its own private pool, sized for its own H render range (~hWindow × 2). H cells of section A only compete with section A's own evictions, not with section B's. With 4 sections × ~10-20 retained cells each, total mounted ≈ ~40-80 cells per type but isolated — and section A's cells survive V-scroll-past-and-back because nothing else's evictions are competing for A's pool.

The V container's slot pool can stay global (V cells aren't subject to the same cross-section pool churn pattern).

**Design questions to resolve:**
- Where does the pool live? On the H sub-container instance (SlotManager subordinate)? Or via a separate pool manager keyed by (sectionIndex, itemType)?
- How to compute size? Static (set via prop)? Auto (derived from hWindow)?
- How to handle compositional pages where some H sections are empty (e.g. a section in V scope but with zero items currently visible)?
- Backwards compat: should the existing global pool stay as a fallback for V cells while H sections opt into private pools?

**Effort:** ~3-5d for the implementation + benchmarking. This is a significant architectural change to the slot manager.

**Priority:** Pursue after the immediate `shouldSkipCorrection` work has been investigated (B4.14, B-cascade-investigation). If the diag's per-section sampling reveals that cross-section pool churn is the dominant cause of storefront's CPU regression, this becomes the primary fix.

### B4.14 H sub-container commit-fanout metric (B-subcontainer-commit-fanout-metric)

**Surfaced during:** storefront regression diagnosis (2026-06-04).

**Hypothesis:** every V container commit may cascade into a commit on each H sub-container, even when the sub-container's own state is unchanged. `CollectionSubContainerShadowNode` has a `shouldSkipCorrection` hash check, but its hit rate is unknown. If hit rate is low on storefront (10 mixed sections all sharing one widget type), every V scroll tick fans out into 5–10 sub-container commits → that's the N× multiplier on percentile CPU even after the visual-attrs gate and the pool-size bump.

**Investigation plan:**
- Add HUD counters: `hsub_commit_per_sec`, `hsub_skip_per_sec`, ratio.
- Run storefront bench. Expected outcomes:
  - Skip-rate ≥80%: fan-out is not the bottleneck; close as not-a-problem.
  - Skip-rate <50%: investigate what's bumping each sub-container's hash on V-only scrolls. Likely candidates: `lastCacheVersion_`, `lastHMvcVersion_`, `lastChildCount_` tracking is too aggressive and triggers when sub-container's own state is genuinely unchanged.

**Effort:** ~0.5d to add counters + measure. Follow-up effort depends on findings.

### B4.15 Deferred Phase-2 pool unmount (B-deferred-pool-unmount)

**Surfaced during:** storefront regression diagnosis (2026-06-04).

**Problem:** `SlotManager.sync()` Phase 2 (lines 207–211) and Phase 4 (lines 294–304) delete overflowed pool entries synchronously inside the React render pass. On pages with bursty section transitions (V scroll passing through many sections that share one widget type), this concentrates N React Fiber unmounts into a single frame — visible as min-FPS dips (storefront 2026-06-04 bench: 35–36 fps min vs Flash 42–43).

**Approach:** batch the actual `activeSlots.delete()` calls into a `requestIdleCallback` (or RAF-deferred) microtask, so:
- The sync() return value (the active slot set) reflects the post-eviction state immediately for correctness.
- The actual React tree shrinkage happens between bursts, smoothing the per-frame work.

Trades a small amount of transient memory (deferred-unmount cells still in tree) for smoother min-FPS.

**Risk:** Fiber unmount has side effects (useEffect cleanup, ref clearing). Need to verify that deferring them does not produce visible / observable problems. Cells getting their data ripped out of `activeSlots` while still in the React tree could see prop access into a stale state.

**Effort:** ~1d to implement + verify no regressions.

### B4.13 Memory-aware dynamic pool sizing (B-pool-memory-aware)

**Surfaced during:** session-prep validation (2026-06-03).

**Problem:** Auto-pool formula is `max(renderRangeSize, maxHWindow × 2, 8)` at CollectionView.tsx:3188–3196, recomputed every `sync()`. The formula is *viewport-aware* (scales with render-range width and H window) but *memory-unaware* (doesn't react to system memory pressure or available headroom). `memoryMultiplier` at line 1445 already exists for the mounted-cap path; the pool path has no equivalent.

**Proposal:**
- Plumb the same `memoryMultiplier` (or a related memory-pressure signal) through to the pool-size auto formula.
- Under pressure: shrink pool to the visible band only, accepting more cold mounts in exchange for lower mounted-cell count.
- Under headroom: optionally raise the floor (e.g. 1.5× the current ceiling) so brief-scroll-off state preservation is more generous.

**Why not urgent:** Current perf numbers (RN 0.83.4) show the existing floor working in practice — Riff already runs at 2–3× lower memory than FlashList across all three bench pages. The optimisation would help edge cases (constrained devices, very long sessions) but isn't load-bearing for the default story.

**Effort:** ~1d (signal plumbing + test under simulated memory pressure).

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

### B5.4 Remove stale `top:-9999` comments (B-stale-9999-comments)

**Surfaced during:** session-prep validation (2026-06-03).

**Problem:** Three comments in `src/components/CollectionView.tsx` describe a `top:-9999` offscreen-parking strategy that was never actually implemented — the design was superseded by the `Activity` API. The comments are at lines 14, 506, and 2742. They mislead anyone reading the code expecting to find offscreen-parking styling that doesn't exist.

**Fix:** Delete or rewrite the three comments to reflect what the code actually does — `Activity=hidden` for measure-only cells (RN 0.83+) with a `<>{children}</>` fragment fallback for older RN.

**Coordinate with:** README §"Why Riff" §4 — which still claims "graceful degradation via top:-9999" for pre-0.83 RN. Same edit pass.

**Effort:** ~15 min.

### B5.5 Record perf-bench environment versions (B-perf-bench-versions)

**Surfaced during:** session-prep validation (2026-06-03).

**Problem:** The README "Performance → Test setup" section has `> FlashList version: _[fill in]_` as a placeholder. The RN, Hermes, and iOS versions used in the bench are implicit (assumed RN 0.83.4 per `CLAUDE.md`). Numbers stay interpretable across time only if the environment is pinned.

**Fix:** in the README perf section, record:
- React Native version (likely 0.83.4)
- Hermes version
- iOS version (likely 17.x)
- Xcode version
- FlashList version (the placeholder)
- Device model (already noted: iPhone 15 Pro)

**Effort:** ~15 min once the numbers are confirmed with whoever ran the bench.

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
| **B7.0b** H free-width measurement ceiling at vpWidth | 0.5d | H free-width cells wrap at vpWidth even with `alignSelf:flex-start`. Option 1: document limitation (cells needing > vpWidth must set explicit `width`). Option 2: `maxMeasureWidth` prop on sub-container. |
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

### B1.10 In-place cell resize via local setState ✅ RESOLVED (2026-06-02)

**Resolution:** `ref.current.invalidateItem(sectionIndex, itemIndex)` is the recommended pattern. Call it in the same event handler as the state update that changes the cell's height — React 19 batches both. Internally, `invalidateItem` bumps `invalidateTrigger` (fully internal counter, not consumer-facing):
1. `invalidateTrigger` is part of `_curCacheDeps` → increments `renderGen` → all window cells miss the element cache → re-render → Fabric re-measures the changed cell.
2. Also in the double-RAF deps → polls native LayoutCache version → once `applyMeasurements` records the new Yoga height, `processScroll` calls `invalidateFrom(i)` → positions reflow from changed item onward (O(n − i)).

**Root cause archived:** Fabric does not re-clone `CollectionViewContainerShadowNode` for in-cell `setState` (container child array is structurally unchanged). `layout()` never fires; stale cached height is never evicted. An explicit signal is required — this matches UIKit's `invalidateLayout()` pattern.

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

---

## Architectural Decisions (Non-negotiable)

### Yoga-Authority Principle

**Yoga is the only authority for actual dimensions. All layout-provided sizes are estimates.**

This was established during B1.1 planning (2026-06-01) when it was clarified that even a JS layout writing explicit `frame.width/height` in `prepare()` is providing an estimate, not a measurement. The JS layout's pre-computed sizes seed the LayoutCache for first-frame positioning; Yoga measures actual rendered content and may produce a different value.

**API naming enforcement:** All size/dimension APIs exposed to consumers must carry the `estimated` prefix:
- `estimatedItemHeight` (not `itemHeight`)
- `estimatedHeightForItem` (not `heightForItem`)
- `estimatedSizeForItem` (not `sizeForItem`)
- `estimatedItemSize` (not `itemSize`)
- `estimatedItemLayoutAttributes` (not `itemLayoutAttributes` or `layoutAttributes`)

**Backlog item:** Rename all currently unqualified APIs in the existing layout engines (`heightForItem` in list/grid/masonry, `sizeForItem` in flow, `itemSize` in radial/carousel3D/spiral/hex, `itemHeight` in list params) to their `estimated` counterparts. This is a breaking API change — coordinate with any consumer-facing documentation update.
