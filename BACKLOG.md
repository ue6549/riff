# Riff — Consolidated Backlog

> Single source of truth for all remaining work. Replaces cursor-plan.md, ethereal-seeking-willow.md, PERF-PLAN.md, and perf-opti-claude.md (archived in `docs/archived-plans/`).
>
> Priority ordering: B0 (bugs) > B1 (architecture) > B2 (features) > B3 (API) > B4 (perf) > B5 (docs) > B6 (state) > B7 (polish) > B8 (testing) > B9 (platform)

---

## B0 — CompositionalLab / Compositional Demo Bugs

Fix before building new features. Some may be subsumed by B1 items — tag during triage.

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

JS layout tabs (Radial, 3D Carousel) had no CollectionView cleanup to race, so they worked.

**Fix:** Removed the unmount `useEffect` cleanup entirely. `prepare()` overwrites stale data from
any previous C++ layout session (every `computeSections()` calls `_cache->clear()` internally),
so the cleanup was both unnecessary for its original purpose and harmful due to the async race.
The `if (!layoutContext)` guard in the prepare `useMemo` remains as a safety net for
`initialWidth={0}` edge cases only.

### B0.3 S4 Masonry V — all items same height (looks like a grid) ✅ FIXED

**Fixed:** Removed `heightForItem: () => 100` from the masonry section in `CompositionalLab.tsx`.
Items already have variable `detail` text (short / medium / long) so Yoga measures each cell
naturally, producing the waterfall height variance.

### B0.4 S3 Grid H — multiple issues

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

### B0.5 S6 "Control" section — clarify purpose ✅ FIXED

**Fixed:** Updated `SECTION_META` label in `CompositionalLab.tsx` from `'S6 Control'` to
`'S6 List V (no chrome — control)'`.

---

## B1 — Architecture (correctness that removes hacks)

### B1.1 L-7: Push measured cell size as explicit Yoga dimension

After Yoga first measures a cell intrinsically, the layout engine writes the measured `(w, h)` back as an explicit Yoga constraint on subsequent commits. Yoga then respects the explicit value instead of re-measuring — eliminates sub-pixel non-determinism (cell heights flipping 343/344 across commits). Drop the explicit dimension on cell-key change / content-version bump so real content changes re-run intrinsic measurement exactly once.

**Subsumes:** H-2.1.1 section-level hysteresis hack, all `std::ceil` workarounds, the iOS scroll-view-frame busy-guard. This is how FlashList/RecyclerListView/UICollectionViewCompositionalLayout all work.

**Effort:** ~2d

### B1.2 L-1/L-2/L-3: Layout intent violations — let Yoga measure what it should

| Layout | Problem | Fix |
|---|---|---|
| H list (L-1) | `style.width` locked from `estimatedItemHeight` | ✅ DONE (`d9164eb`) — `isHListCell` guard removes width for standalone + compositional H-list. |
| H grid (L-2) | `style.width` locked from `rowHeight` | Engine derives column width from `max(measured width)` per column. |
| V flow (L-3) | `style.width` locked from `sizeForItem.width` | Cells render naked. Engine packs into rows from measured widths. |

**Subsumes:** ethereal #3 (H-list cross-axis height bounce), ethereal #4 (H-list S[0] header half height). May also fix B0.1.

**Effort:** ~3d total

### B1.3 MVC semantics for non-list H sections (design TBD)

MVC in H sections is only well-defined for H-list (linearly ordered items — all shift by new-item width on insert). For H-grid, masonry, and flow, inserts cause items to shift across rows/columns, making a single "anchor shift" correction semantically ambiguous.

**Define what MVC should mean for each:**
- **H-grid**: A `+top` insert shifts all items by one slot; existing items may cross row boundaries. Correction = how much the anchor item's X changed (deterministic for full-row-shift inserts, ambiguous for partial). Likely want to correct by one item-width if inserting into the leading row, zero otherwise.
- **H-masonry**: Items are assigned to shortest column; any insert scrambles the column map. Correction is not well-defined. Suggestion: don't correct (accept the jump) or re-anchor to nearest item at old X.
- **H-flow**: Items flow left-to-right; insert at top shifts all items by one item's width along the primary axis (similar to H-list if items are uniform). May be correctable with the same anchor-delta approach as H-list.

**Current state:** H-list MVC fix applied (B1.3 fix). H-grid/masonry/flow MVC deferred.

---

### B1.3 L-4: Rename size config APIs to "estimated"

`itemHeight`, `rowHeight`, `sizeForItem` etc. imply fixed/deterministic — they're all estimates. Rename to `estimatedItemHeight` (where not already), document the "estimates only" contract.

**Effort:** ~0.5d

### B1.6 H-list content size not updated after Width delta cascade

After B1.2a (free-width measurement), `applyMeasurements` correctly cascades all item X positions
in the cache (including unmounted items outside the render window) when a Width delta fires.
But the `contentSize.width` committed to the ScrollView state is not re-derived from the updated
last-item extent — it either comes from the initial `computeSection` estimate (N × estimatedItemHeight)
or from mounted children only (render-window subset).

**Symptom:** Scroll stops before the actual end of the list. If cells are naturally wider than
`estimatedItemHeight`, the cascade pushes items further right but the ScrollView still clamps to
the original estimated width. Does not self-correct after scrolling through the full list because
the content-size write path never picks up the post-cascade last-item extent.

**Why V doesn't have this:** V content height comes from `computeSections` running in full on
every layout cycle, covering all items including unmounted ones. The H equivalent (total content
width after cascade) is not being re-fed into the committed content size after `applyMeasurements`.

**Fix direction:** After `applyMeasurements` runs, re-derive `contentSize.width` from the
updated last-item frame in the cache (`lastItem.frame.x + lastItem.frame.width`) rather than
from the pre-cascade estimate. For standalone H this is in `CollectionViewContainerShadowNode`;
for compositional H sections this is in `CollectionSubContainerShadowNode`.

**Prerequisite for:** B1.7 (first-pass scroll correctness). Also partially addressed by B1.1
(once B1.1 is in, Width deltas only fire once per cell and the content size settles immediately).

**Effort:** ~0.5d

### B1.7 First-pass scroll correctness — primary-axis MVC on Width delta cascade

When a cell enters the viewport for the first time and its Width delta fires, the cascade shifts
all subsequent items' X positions. If the user is already scrolled partway through the list, this
cascade shifts the content under them, causing a visible jump — analogous to the V-scroll MVC
problem on insert.

This is the primary-axis equivalent of V-MVC: after a Width delta cascade, the scroll offset
needs to be corrected by the sum of width changes for all items before the current viewport
leading edge. "Correct scroll even on first time when cells get measured."

**Relationship to B1.6:** B1.6 fixes the content size (you can reach the end). B1.7 fixes the
viewport position (no jump during first-pass measurement). Both are needed for a stable first-
scroll experience. B1.1 reduces severity — once measured sizes are frozen as explicit Yoga
dimensions, deltas only fire once and the cascade is a one-time event rather than recurring.

**Effort:** ~1d (needs primary-axis anchor snapshot + correction, similar to H-MVC but for the
main scroll axis on Width delta, not insert.)

### B1.5 Sub-container owns its own LayoutCache slice

Currently the shared main LayoutCache holds both V section items and H section items (H items at section-local X coords). The sub-container ShadowNode reads the main cache filtered by section index.

**Proposed design:** CompositionalLayout writes H items to a per-section sub-cache instead of the main cache. The sub-container's ShadowNode and native view use that sub-cache for all operations.

**What this unlocks:**
- `snapshotAnchor()`/`computeCorrection()` on the sub-cache work directly — same code path as standalone H. `snapshotHAnchor`/`computeHCorrection` become unnecessary.
- MVC for H-grid, H-masonry, H-flow (B1.3) falls out naturally — no more per-type guards or duck-typing of `sectionTypes`.
- Cleaner isolation: stash, clear, and version operations are fully section-scoped.
- Eliminates the `sectionTypes` duck-type check in JS prepare() MVC logic.

**Cost:** ~1.5–2d refactor. Layout engines currently take a single `LayoutCache*`; they'd need to dispatch writes to the correct cache. Version coordination between main and sub-caches needed.

**Priority:** Do after B1.1 and B1.2. Prerequisite for properly resolving B1.3.

### B1.4 Decouple measureAhead from isVariableHeight

`isVariableHeight` gates whether `measureAhead` is passed to `processScroll`. A list using `itemHeight` (fixed) with `measureAhead > 0` should still pre-measure. Three locations in CollectionView.tsx need `isVariableHeight && measureAhead > 0` → `measureAhead > 0`.

**Source:** PERF-PLAN.md "Correctness Fixes > Fix 1"

**Effort:** trivial

---

## B2 — High-Impact Features

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

### B2.5 F3.6: Interludes

`{ primary, interludes }` API shape — one flat feed + special sections anchored by key/index. Pure JS splitter on top of existing compositional engine. No native changes. See PLAN.md F3.6 for full spec.

**Effort:** ~1.5d

### B2.6 H-6: Snap behaviors

UIKit-style `orthogonalScrollingBehavior` modes: paging, groupPaging, groupPagingCentered on H sections. Snap points via `UIScrollView.decelerationRate` + `scrollViewWillEndDragging:withVelocity:targetContentOffset:`.

**Effort:** ~1d

---

## B3 — API & Quality

### B3.1 API review

Comprehensive review of the public API surface before any external sharing:
- Naming consistency (props, callbacks, layout config)
- Prop shapes and defaults
- ScrollView callback surface (hoist to top-level vs `scrollViewProps` pass-through)
- Type alignment (`RiffProps` in example vs `CollectionViewProps` in src/types)
- Package export: re-export `CollectionView` from `src/index.ts` when React hoisting is solved
- Breaking-change surface assessment
- Demo cleanup: remove `containerH` / `onContentSizeChange` wiring from horizontal demos

**Source:** PERF-PLAN.md "API/packaging audit", user request

**Effort:** ~1-2d

### B3.2 Cross-section sticky headers

Sticky header that stays pinned across multiple sections (e.g. a date header spanning a day's worth of sections). Not currently possible — sticky headers are per-section only.

**Effort:** TBD (design first)

### B3.3 F3.7: Sub-container as public extension point

Document + export the H-2 `RNCollectionSubContainer` framework so consumers can write custom layouts (TS or C++) that get free native frame/transform application. C++ port of one H-2 layout (e.g. `hex`) as reference for native custom layouts.

**Effort:** ~0.5d

---

## B4 — Residual Perf

### B4.1 Main container ShadowNode short-circuit

Same pattern as H-4b for sub-containers. Cache `{childTags hash, cacheVersion}` and skip `correctChildPositionsIfNeeded` when nothing changed. Helps during idle and inertial deceleration.

**Effort:** ~0.5d

### B4.2 Investigate spurious Yoga deltas on repeat scroll

vLCV is 2-15/sec even when scrolling through already-measured content. Batch mode reduced N→1 per commit, but the commits themselves shouldn't have deltas on repeat scroll. Possible causes: sub-pixel Yoga measurement drift, H sub-container recycling. L-7 may eliminate this entirely.

**Effort:** ~0.5d (investigation)

### B4.3 H-cell LCV memo removal

Line ~3008 in CollectionView.tsx: `(!slotIsHCell || prev.lcv === layoutCacheVersion)` invalidates ALL H cells on every LCV bump. Post-H-2, sub-container ShadowNode handles positioning natively. This check may be unnecessary, causing `hCellCount x vLCV_bumps` wasted re-renders/sec.

**Effort:** ~0.25d

### B4.4 Guard unconditional setContentHeight

Line ~1649: `setContentHeight(layoutContentHeight)` always called, even when value is same. React does eager bailout for same-value setState, but should guard like the H-6 path does.

**Effort:** trivial

### B4.5 Opt 3: Transform-based cell positioning

Replace `setFrame:` with `layer.transform = CATransform3DMakeTranslation(x, y, 0)` in `applyPositionsFromState:`. For position-only changes, avoids UIView layout pass. Requires `hitTest:withEvent:` override on `_contentView`. Deferred during earlier perf work — revisit if native positioning shows up in profiles.

**Source:** PERF-PLAN.md Opt 3

**Effort:** ~1d

### B4.6 Opt 5: Flat arrays from spatial queries

For layouts with `needsSpatialQuery: true`, change `getAttributesInRect` to return `Float64Array` instead of JSI objects. Eliminates ~300 JSI property constructions. Only needed if custom spatial-query layouts prove to be a bottleneck.

**Source:** PERF-PLAN.md Opt 5

**Effort:** ~0.5d

### B4.8 LayoutEngine protocol — enforce clear-before-compute structurally

Currently each engine's `computeSections()` must call `_cache->clear()` as its first operation by convention. `ListLayout` had it missing (fixed). The invariant can't be a pure virtual because each engine takes a different params type.

**Fix:** Move `_cache->clear()` into each engine's JSI binding lambda (the call site that bridges JS → C++). `computeSections()` becomes a pure layout function; the JSI layer owns the clear. This is Option B from the discussion; Option A (template method with `doComputeSections` + `_cache` in base class) is the cleaner long-term fix.

**Effort:** ~0.5d

### B4.9 Per-instance LayoutCache — eliminate shared global cache pollution

**Problem:** All CollectionView instances share one C++ `LayoutCache` and one set of layout engine singletons (ListLayout, GridLayout, etc.). When navigating between screens, each new instance's C++ `computeSections()` overwrites the global cache. The ShadowNode's first Fabric layout pass reads whichever data happens to be in the cache at commit time — potentially stale data from the previous instance.

**Current mitigation (B0.2b fix):** Unmount cleanup removed. `prepare()` overwrites stale data from previous instances before the ShadowNode reads. The `if (!layoutContext)` path in the prepare `useMemo` is a residual safety net for `initialWidth={0}` only.

**Real fix:** Each CollectionView instance gets a unique `cacheId` (already in `CollectionViewState.cacheId`). The C++ module maintains `std::map<int32_t, LayoutCache>` keyed by cacheId. All JSI calls (`computeSections`, `getAttributesInRect`, `version`, etc.) take `cacheId` as their first parameter. `_layoutCacheId` in the module becomes an instance lookup key, not a shared singleton.

**Scope:**
- C++: `CollectionViewModule` — change `_layoutCache` from a single `LayoutCache` to a `std::map<int32_t, LayoutCache>`. All JSI binding lambdas route to the per-instance cache.
- TS: `CollectionView.tsx` — pass `layoutCacheId` (from native state) to every `nativeMod.layoutCache.*` call.
- TS: Layout engines (list.ts, compositional.ts, etc.) — accept `cacheId` param or get it from a context/closure.
- Remove all on-mount / on-unmount `layoutCache.clear()` calls (now unnecessary).

**Effort:** ~1–2d
**Priority:** after all current B0/B1 fixes are stable

---

### B4.10 scrollTo API for JS-layout tabs (Radial Arc, 3D Carousel, etc.)

The `scrollTo*` / `scrollToSection` API implemented via `invokeScrollHandler` routes through the LayoutCache to compute target offsets. JS-layout tabs (Radial Arc, 3D Carousel, Spiral, Hex, H2-*) use plain React Native `ScrollView` — they do NOT write to the LayoutCache, so the current `scrollTo` implementation has no effect on them.

**Options:**
1. Expose a `scrollTo` imperative handle on the outer ScrollView and let callers use it directly (simplest; avoids the LayoutCache route entirely for JS layouts).
2. Add a `layoutType === 'js'` fast-path in `invokeScrollHandler` that forwards the call to a JS-supplied `scrollRef`.
3. Block the scrollTo buttons for JS-layout tabs (simplest non-fix; acceptable for demo).

**Decision:** discuss before implementing. Note that the `scrollToSection` / `scrollToIndexPath` API semantics also differ for non-list layouts (radial has no "section" concept in the traditional sense).

**Priority:** low; after core layout fixes

---

### B4.7 Threading model audit — JSI call sites + UIKit dispatch

All `nativeMod.*` JSI calls (scroll, layout query, version polling) execute synchronously on the JS thread. The `invokeScrollHandler` path dispatches a scroll offset to the native scroll container — this ultimately calls `setContentOffset:` which **must** run on the main thread. Verify the current dispatch path is safe and not silently marshalling through the wrong thread.

**Scope:**
- Audit every JSI call site in CollectionView.tsx and native module: which thread does it run on?
- Confirm `invokeScrollHandler` → `setContentOffset:animated:` reaches UIKit on the main thread (not JS thread). If called from JS thread, this is a UIKit thread-safety violation.
- Evaluate whether scroll-to operations could be initiated from the UI thread directly (e.g. via a native gesture recognizer callback) to avoid occupying JS thread at all.
- Document findings; fix any thread-safety violations; note which operations could be moved off JS thread in a future refactor.

**Why:** JSI calls run on JS thread and reduce available JS time even if C++ is fast. Moving to UI-thread initiation (where safe) would give JS thread back entirely for gesture-driven scrolls.

**Effort:** ~0.5d (audit + doc) + ~1d if fixes needed

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

**Next steps if it resurfaces:** Enable `RNCV_MVC_TRACE` logs and capture `snapshotAnchor` / `computeCorrection` output around a `+top` insert. Check whether `MasonryLayout::computeSectionFromCache` needs stash fallback (analogous to the fix applied to `ListLayout::computeSection` in this session).

---

## Completed Work Reference

See `PLAN.md` for the full history of completed milestones (Phases 0-5, P1-P5, F2, F3.1-F3.5, H-1 through H-5, all Opts, all perf work). Archived plans in `docs/archived-plans/` contain detailed context for each completed item.
