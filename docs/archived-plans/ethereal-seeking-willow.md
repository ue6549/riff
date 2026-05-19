# Riff — Working Plan & Roadmap

## Current State (2026-04-16)

**Branch:** `main` — perf + layout work merged back.

**JS FPS:** ~60fps on Feed tab (parity with FlashList). Achieved by:
- measureAhead=0 (eliminates invisible cell Fabric creation cost)
- Binary search for sorted layouts (replaces spatial queries)
- SlotManager short-circuit, decoration cache, element cache cascade fix
- Reduced window defaults (renderMultiplier=0.5, mountedWindowSize=2.0)
- Velocity leadBoost cap (1.5x instead of 4.0x)
- PerfHUD disabled during comparison, Feed demo uses refs not setState

**Layouts working:** List V, Grid V, Grid H, Masonry V, Flow V (after flatIndex fix), Radial, Circular
**Layouts with known issues:** List H (cross-axis height bounce), Grid H (same), Masonry H (items same size — pre-existing), Flow H (untested)

---

## Roadmap (in order)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | **Remaining perf fixes** | ✅ Done | Change C: `processScroll` now returns flat frame array; `renderCell` reads width/height from it (eliminates ~30 JSI calls/render). `computeCacheKey` for headers/footers derived without JSI. Change F: entering/leaving loops deferred to `setImmediate` with coalescing (removes O(384) `keyExtractor` loop from `onScroll`). |
| 2 | **Flow V fix** | ✅ Done | FlowLayout flatIndex wiring verified; binary search path works for Flow V. |
| 2b | **Grid V insert bugs** | ✅ Done | Bug 1: stale `frameDataRef` had footer at wrong flat index after insert → column items got full-section width. Fix: `frameDataRef` now carries `gen`; `renderCell` skips frame data when `gen !== renderGen`. Bug 2: decoration cache hit on insert render (lcv async) → stale section background height. Fix: invalidate `lastDecoCacheRef.lcv = -1` on `renderGen` bump. JS-only, no C++ changes. |
| 3 | **H-list cross-axis height bounce** | ⬜ | Layout loop: measure → container resize → shouldInvalidate → re-layout → repeat. Affects List H, Grid H. Needs dedicated investigation. See `memory/project_hlist_bounce.md` |
| 4 | **H-list S[0] header half height** | ⬜ | Same root cause as #3 — _maxCrossAxisHeight starts from estimate, grows as items measured |
| 5 | **Perf findings writeup** | ✅ Done | Added `Performance Investigation Results (2026-04-12 → 2026-04-16)` section in `docs/COLLECTIONVIEW_INTERNALS.md`. |
| 6 | **Compositional layout** | ⬜ | UICollectionView CompositionalLayout-like API. Orthogonal scrolling sections. Custom layouts per section. Discuss API design (Compose LazyList-like?) |
| 7 | **Diff engine + Snapshot API** | ⬜ | F1.1 (C++ diff engine), F1.2 (Snapshot API for batch mutations) |
| 8 | **Cell animations** | ⬜ | F1.2b (enter/exit animations), F1.2c (UICollectionView-parity animations) |
| 9 | **H-masonry fix** | ⬜ | All items render same size in H mode. Pre-existing, needs investigation |
| 10 | **Flow justification** | ⬜ | F-Flow.1: leading/center/trailing/spaceBetween/spaceEvenly |
| 11 | **Flow item weight/stretching** | ⬜ | F-Flow.2 |
| 12 | **Grid rowAlignment** | ⬜ | F-Grid.1: top/center/bottom for uneven heightForItem rows |
| 13 | **State persistence & restoration** | ⬜ | F4 |
| 14 | **P6.2 — Device measurement session** | ⬜ | Release build, real device, FlashList comparison benchmarks |
| 15 | **H-2.1 — Cut section-size round-trip (compositional H bounce fix)** | ✅ implemented (2026-05-14) / ⬜ awaiting device verification | Architectural fix — `<RNCollectionSubContainer>` no longer takes `contentWidth`/`contentHeight` props; C++ shadow node reads section size from the cache `h-section-wrapper-{N}` + `h-section-cw-{N}` entries directly (extending the existing `ySectionShift` lookup). Eliminates the JS render storm and Fabric prop commit storm during H bounce. Defenses reverted: cell-level `std::ceil`, `kCellMVCThresholdPt` 1.5→0.5, iOS scroll-view-frame IDLE/animating filter, `kVelocityDeadZonePxMs`. Build: needs `pod install` only if any new .cpp added (none in this change), Xcode clean build, Metro reset cache. Verify on device: storefront H section bounces naturally on both edges, gestures stay responsive, `lcv` stops climbing during a single bounce, `[RNCV-HSUB-CPP] STATE` log shows single section size value per measurement event (no flipping). See `cursor-plan.md` Stage 1 → Tier H-2.1 for full spec. |
| 16 | **Layout intent cleanup (L-1 … L-7)** | ⬜ | Separate workstream — engine-side correctness arc, not H-section specific. Brings every layout in line with the design intent that `itemHeight`/`estimatedItemHeight`/`rowHeight`/`sizeForItem` etc. are *estimates only* and Yoga is the authority on cell size for any axis the engine doesn't structurally own. Per-layout intent matrix and sub-tasks in `cursor-plan.md` Stage 4. Subsumes items #3 (H-list cross-axis bounce) and #4 (H-list S[0] header half height). **Now includes L-7** (push measured cell size back as explicit dimension — the proper fix for Yoga sub-pixel non-determinism that H-2.1.1 currently masks with hysteresis). |
| 17 | **Deliberate: leaf-level supplementary / sectionBackground suppression in compositional** | ⬜ | Today `compositional.ts` forces `headerHeight=0`, `footerHeight=0`, `emitSectionBackground=false`, `sectionSpacing=0` on every leaf section, then re-emits at "Level 1" (compositional-owned). Two-level supplementary system. Question to revisit later: is the two-level model genuinely necessary (sticky headers spanning V coords, sectionBackground wrapping the whole section), or is it a workaround we can solve more directly? Affects what H sections inside compositional can render inside their `RNCollectionSubContainer` (today everything is hoisted to outer V). Tracked as L-6 in `cursor-plan.md` Stage 4. |
| 18 | **H-2.1.1 — Tactical fix for residual gesture-cancel during bounce (post H-2.1)** | ✅ implemented (2026-05-14) / ⬜ awaiting device verification | After H-2.1 cut the JS round-trip, bounce became natural but gestures still wedged mid-bounce. Root cause: Yoga's intrinsic cell measurement is non-deterministic at sub-pixel resolution, so `max(cell heights)` in `finalizeHSection` flips e.g. 343 ↔ 344 across commits → wrapper.bounds flips → `_scrollView.frame` flips via `FlexibleHeight` autoresize → UIKit cancels the active pan recognizer (UIGestureRecognizerStateCancelled) and lands in the `isDragging=1 isDecel=1 isTracking=0` wedge. **Fix (two layers, both defensive)**: (a) C++ `CompositionalLayout::finalizeHSection` — section-level hysteresis: suppress section-height changes < 2pt vs the previously cached `h-section-wrapper-{N}` value (Yoga sub-pixel jitter is bounded by ~1px on either side of the rounding boundary; real layout changes are ≥ 4pt). (b) iOS `RNCollectionSubContainerView.mm` — drop `_scrollView` autoresize entirely; manage `_scrollView.frame` explicitly in `-layoutSubviews` with a busy-guard (defer the frame write into `_pendingScrollViewFrame` if `isTracking || isDragging || isDecelerating`, apply on scroll-end via `scrollViewDidEndDragging:willDecelerate:`/`scrollViewDidEndDecelerating:`/`scrollViewDidEndScrollingAnimation:`). The deferred-frame mismatch is bounded by 1-2pt and hidden by `self.clipsToBounds = YES`. **Acknowledged as a tactical fix**: the proper fix is L-7 (push measured size back as explicit dim, FlashList model) — once L-7 lands the hysteresis becomes a no-op and can be removed; the frame guard stays as defensive engineering. **Verify on device**: after bounce-back at either edge, the next pan gesture is recognized immediately without lifting the finger first; `[RNCV-HSUB-IOS-LAYOUT]` logs no longer show `_scrollView.frame.size.height` flipping during `isDragging=1` or `isDecelerating=1`. See `cursor-plan.md` Stage 1 → Tier H-2.1.1 for full spec. |

---

## Design intent — layout dimension authority (clarified 2026-05-14)

`itemHeight`, `estimatedItemHeight`, `rowHeight`, `sizeForItem`, `estimatedCrossAxisHeight`, etc. are first-pass **estimates only**. Real values come from Yoga. The engine cascades real values once measured. Even names that suggest determinism (e.g. `itemHeight: 130`) are estimates Yoga can override.

| Layout | Width source | Height source | Today | Intent |
|---|---|---|---|---|
| V list | container width | Yoga | ✅ matches | width=container, height=Yoga |
| V grid | `(container - spacing) / cols` | Yoga | ✅ matches | width=column, height=Yoga |
| V flow | Yoga | Yoga | ❌ violates (`sizeForItem.width` locked from JS) | both Yoga |
| V masonry | column-width | Yoga | ✅ matches | width=column, height=Yoga |
| H list | Yoga | Yoga | ❌ violates (`style.width` locked from `estimatedItemHeight`) | both Yoga |
| H grid | Yoga (drives column width) | row-derived from container cross axis | ❌ violates (`style.width` locked from `rowHeight`) | width=Yoga and drives column width (this is what differentiates H grid from H flow); height=row-derived |
| H flow | Yoga | Yoga | n/a (not implemented) | both Yoga |

Tracked as roadmap item #16. Cleanup happens post-arc as Stage 4 in `cursor-plan.md`.

**Related but distinct from the dimension-source intent above**: Yoga's *intrinsic* measurement is non-deterministic at sub-pixel resolution across commits (the same React subtree can produce 335.3 on one commit and 334.7 on the next). The H-2.1.1 hysteresis + frame guard masks this in compositional H sections; the proper fix is **L-7 — layout engine pushes the measured cell size back as an explicit dimension on subsequent commits** (FlashList / RecyclerListView / UICollectionViewCompositionalLayout model). Yoga still measures intrinsically — but exactly once per content version, not on every commit. This is the architecturally correct answer and removes every `std::ceil` + threshold workaround in the codebase that exists to cope with intrinsic-measurement drift. Tracked as L-7 in `cursor-plan.md` Stage 4.

---

## Key Files

| File | Purpose |
|------|---------|
| `example/components/CollectionView.tsx` | Main component (~2500 lines) |
| `example/components/SlotManager.ts` | Cell recycling (Opt 4) |
| `cpp/LayoutCache.h/.cpp` | C++ position cache + binary search |
| `cpp/CollectionViewModule.cpp` | TurboModule + processScroll JSI |
| `cpp/CollectionViewContainerShadowNode.cpp` | Fabric ShadowNode |
| `ios/RNCollectionViewContainerView.mm` | Native UIScrollView wrapper |
| `ios/RNMeasuredCellView.mm` | Cell native view (updateLayoutMetrics override) |
| `src/layouts/*.ts` | Layout engines (list, grid, masonry, flow) |
| `cpp/layouts/*.cpp` | C++ layout engines |
| `PERF-PLAN.md` | Full optimization plan + analysis |
| `docs/COLLECTIONVIEW_INTERNALS.md` | Architecture reference |
