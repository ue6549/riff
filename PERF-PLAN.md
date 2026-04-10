# Riff Performance Optimization Plan

## Context

After implementing and reverting JS-level cell pooling, we did a thorough analysis comparing Riff's per-frame architecture with FlashList v2. The key finding: **Riff's biggest per-frame cost is not cell mount/unmount — it's the JSI spatial query marshalling on every scroll tick.** FlashList v2 (pure JS, zero native code) achieves good performance through cheap O(log n) binary search + JS key pooling. Riff's C++ ShadowNode gives superior measurement (1-frame convergence vs FlashList's 2+ frames), but the JSI boundary crossings on the scroll hot path negate that advantage.

---

## Per-Frame Cost Analysis: Riff vs FlashList v2

### What impacts UI FPS

| Work | Riff | FlashList v2 |
|------|------|-------------|
| Scroll offset tracking | `setScrollOffset` to C++ LayoutCache — O(1), mutex | Handled by RN ScrollView natively — zero cost |
| Position application | `applyPositionsFromState` — `child.frame = CGRect(...)` per cell, O(mounted) | JS `left`/`top` styles → Yoga → Fabric → UIKit — same pipeline |
| Sticky headers | KVO + `CATransform3D` — O(sticky_count), zero-lag | `Animated.Value` — 1 frame lag |
| Fabric commit processing | Custom ShadowNode `layout()` with Yoga + LayoutCache diffing — O(mounted) | Standard Fabric — no custom ShadowNode |

**Primary UI FPS bottleneck**: The custom ShadowNode's `correctChildPositionsIfNeeded()` runs on the Fabric BG thread. It iterates all mounted children twice (read cache positions, diff Yoga measurements) and may call `applyMeasurements()` to cascade. This delays the Fabric commit, which delays `applyPositionsFromState` on the UI thread.

### What impacts JS FPS

| Work | Riff | FlashList v2 |
|------|------|-------------|
| Visibility detection | 2 spatial queries via JSI → C++ (O(buckets+k), marshals ~30 attribute objects) | Binary search on JS array — O(log n), returns 2 integers |
| Range/budget computation | `applyBudget` + `computeMeasureRange` — 2 more JSI calls | Pure JS arithmetic |
| Per-scroll JSI calls | **4-6 total** (version check, 2x spatial, budget, measure range, blank area) | **Zero** |
| setState frequency | `setRenderRange` when window boundary moves | `setRenderId` when engaged indices change |
| Render loop | O(window_size) element creation for full window | O(window_size) but with recycled keys — Fiber UPDATE not CREATE |
| Measurement feedback | `useLayoutEffect` re-runs spatial query when LayoutCache version bumps | `useLayoutEffect` calls `measureLayout()` per cell |

**Primary JS FPS bottleneck**: The spatial query marshalling. `getAttributesInRect` returns an array of ~30 JSI objects, each with ~10 properties (frame, zIndex, alpha, sizingState, isSticky, etc.). That's ~300 JSI property constructions per scroll event. FlashList returns 2 integers.

---

## Why FlashList Can't Do Custom Layouts (and Riff Can)

FlashList's `getVisibleLayouts` assumes items are **sorted by primary axis position** and visible items form a **contiguous index range**. Binary search finds `startIndex` and `endIndex`. This is O(log n) but restricts layouts to:
- Linear (vertical/horizontal)
- Grid (row-major, sorted by Y)
- Masonry (column-major, approximately sorted by Y)

A circular layout, radial arc, or any layout where index order ≠ position order breaks the binary search assumption. Riff's spatial index (bucket-based, position-keyed) handles arbitrary item placement — the cost is O(buckets + k) regardless of index ordering.

---

## Positioning: Frames vs Transforms

**Current state**: Both Riff and FlashList v2 use frame-based positioning (`setFrame:` / `left`+`top`).

**Why transforms would be faster for repositioning**:
- `setFrame:` triggers UIView layout pass (bounds + center + subview adjustment)
- `layer.transform = CATransform3DMakeTranslation(x, y, 0)` is GPU-side compositing only — no layout pass
- For cells that just need repositioning (not resizing), transforms skip unnecessary work
- Riff already uses this for sticky headers — proven pattern

**Caveat**: Transforms work when the view's natural frame is fixed at origin. Cell content sizing (Yoga) must still use bounds. The transform only replaces the position offset, not the size.

---

## Optimizations (ordered by impact)

### Opt 1: Eliminate per-scroll spatial query for sorted layouts ✅
**Impact: HIGH** — removes the #1 JS thread cost

For layouts where items are sorted by primary axis: replace `getAttributesInRect` with O(log n) binary search returning `{first, last}` integers, like FlashList. Fall back to spatial query only when the layout opts in.

**Implementation**:
- Add `computeSortedRanges(scrollOffset, vpSize, renderMult, velocity)` to C++ WindowController
- It reads item positions from LayoutCache (already stored) and does binary search
- Returns `{renderFirst, renderLast, visibleFirst, visibleLast}` — 4 integers, single JSI call
- CollectionView.tsx uses this by default, falls back to `attributesForElements` only when `layout.needsSpatialQuery === true`
- **Per-scroll cost drops from**: 2 spatial queries + marshalling ~60 objects → 1 JSI call returning 4 integers

**Layout routing — `needsSpatialQuery` flag**:

Add an optional `needsSpatialQuery?: boolean` to the `CollectionViewLayout` protocol. Default: `false`. When `true`, the scroll handler falls back to `attributesForElements()` spatial query instead of binary search.

- Built-in layouts (`list`, `grid`, `masonry`, `flow`): always `false` — items are sorted, binary search works
- Custom layouts: default `true` (safe default — custom layouts may have non-contiguous visibility). Custom layout authors can explicitly set `false` if their layout produces sorted, contiguous visible ranges (e.g., a custom horizontal carousel that's still linear)

This gives custom layout authors control: `needsSpatialQuery: false` opts into the fast binary search path when they know their layout is sorted. The default protects against silent breakage for truly non-linear layouts.

**Files**: `cpp/WindowController.h`, `cpp/CollectionViewModule.cpp`, `src/types/protocol.ts`, `example/components/CollectionView.tsx`

### Opt 2: Batch JSI calls into single per-scroll call ✅
**Impact: MEDIUM** — reduces 4-6 JSI boundary crossings to 1

Combine version check + range computation + budget + measure range into one C++ function:
```cpp
struct ScrollState {
  int32_t renderFirst, renderLast, visibleFirst, visibleLast;
  int32_t measureFirst, measureLast;
  int32_t cacheVersion;
  float blankBefore, blankAfter;
};
ScrollState processScroll(scrollY, vpW, vpH, renderMult, velocity, ...);
```

Single JSI call, single mutex acquisition, zero intermediate JS work.

**Files**: `cpp/WindowController.h`, `cpp/CollectionViewModule.cpp`, `example/components/CollectionView.tsx`

### Opt 3: Transform-based cell positioning ⬜ (deferred)
**Impact: MEDIUM** — faster UI thread repositioning

Change `applyPositionsFromState` to use `layer.transform = CATransform3DMakeTranslation(x, y, 0)` instead of `setFrame:`. Cell's natural frame stays at `(0, 0, w, h)`.

**Consideration**: When cell SIZE changes (first measurement, or data change), need to update `bounds` too. Can check if w/h differ from current bounds and only set bounds when needed.

**Implementation note (2026-04-06)**: `layer.transform` (CATransform3D) does NOT affect UIKit's `view.frame` or `view.center`. Hit testing would break for cells whose natural frame is at `(0, 0)` while their visual position is at `(x, y)`. To use this approach, `_contentView` needs a `hitTest:withEvent:` override that accounts for layer transforms. Additionally: for position-only changes (same w/h), `setFrame:` already just calls `setCenter:` without triggering `layoutSubviews` — so the benefit is smaller than estimated. Deferred until other optimizations are validated and profiling confirms native positioning is still a bottleneck.

**Files**: `ios/RNCollectionViewContainerView.mm`

### Opt 4: JS-level cell recycling (revisit) ✅
**Impact: MEDIUM** — reduces Fiber CREATE/DELETE overhead

The previous pooling attempt failed because native position application (via ShadowNode state) was desynced from React content updates. Two possible fixes:
- **Option A**: Apply positions from JS via transform styles (like FlashList does with `left`/`top`), bypassing the ShadowNode position pipeline for recycled cells
- **Option B**: Make the ShadowNode position application synchronous with the React commit by using the `cacheKey` prop (already works — the issue was the slot's `cacheKey` changing causing cache miss on the first frame)

SlotManager.ts is already written and correct. The integration needs the position sync fix.

**Files**: `example/components/CollectionView.tsx`, `example/components/SlotManager.ts`

### Opt 5: Return flat arrays from spatial queries ⬜
**Impact: LOW-MEDIUM** — for layouts that use per-scroll spatial queries

When a layout has `needsSpatialQuery: true` and the spatial query path is used, change `getAttributesInRect` to return `Float64Array` `[key_hash, x, y, w, h, section, index, ...]` instead of JSI objects. Eliminates ~300 JSI property constructions.

Applies to any layout that opts into spatial queries (custom layouts by default, or any layout that explicitly sets `needsSpatialQuery: true`).

**Files**: `cpp/LayoutCache.cpp`, JS consumer code

### Opt 6: C++ early return in processScroll (stable-band skip) ⬜
**Impact: LOW-MEDIUM** — eliminates spatial query work when ranges haven't changed

The previous approach (JS-side range-stability check) was reverted as too aggressive. The correct location for this optimization is **inside C++ `processScroll`**, not in JS.

**Mechanism**: After computing ranges, `processScroll` records a "stable band" — the range of scroll offsets where the integer indices don't change (approximately ±¼ viewport). On the next call, if `cacheVersion` is unchanged AND `scrollPrimary` is within the band, the cached result is returned immediately — no spatial queries, no budget computation. Cost: ~200ns vs 50-200μs for full computation.

```cpp
struct LastScrollResult {
    int32_t renderFirst, renderLast, visibleFirst, visibleLast;
    int32_t measureFirst, measureLast;
    int32_t cacheVersion;
    double bandLow, bandHigh;
};
// At top of processScroll:
if (curVersion == _last.cacheVersion &&
    scrollPrimary >= _last.bandLow &&
    scrollPrimary <= _last.bandHigh) {
    return _last; // skip all spatial queries
}
```

**Why C++, not JS**: The JSI hop is ~100ns — negligible. The cost is inside `getAttributesInRect` (spatial bucket walk + candidate filtering). Skipping at the C++ level avoids this work while keeping the architecture simple. JS doesn't need to know about scroll bands.

**Files**: `cpp/CollectionViewModule.cpp`

### Opt 7: Incremental render loop (O(delta) instead of O(window_size)) ✅
**Impact: MEDIUM** — reduces per-render JS work

Currently the `scrollContent` render loop rebuilds React elements for the FULL window (~30 cells) even when only 1-2 cells enter/leave. React's reconciler efficiently diffs the output, but element creation itself (JSX → `React.createElement` for 30 cells with nested view trees) is O(window_size) JS work per render.

**Two approaches:**

**A. Stable element map (recommended with SlotManager):** Maintain a `Map<slotKey, ReactElement>` across renders. SlotManager already knows which slots changed — only create/update elements for changed slots. Render loop becomes O(delta).

**B. React-only (no SlotManager):** Keep current approach — rebuild full array, let React diff. Simpler, but O(window_size) element creation remains. This is what we have today.

Approach A naturally pairs with Opt 4 (cell recycling). SlotManager tracks entering/leaving/unchanged slots. For unchanged slots, reuse the cached element reference — React sees referential equality and skips reconciliation entirely (not just skips DOM work, skips the diffing too).

**Files**: `example/components/CollectionView.tsx`, `example/components/SlotManager.ts`

---

## Scroll Path Ownership (architecture cleanup — pre-Opt 3)

During Opt 3 preparation, we identified three architectural misalignments in the scroll hot path:

### 1. Velocity round-trips through JS unnecessarily

**Before**: Native `scrollViewDidScroll:` writes offset to `LayoutCache.setScrollOffset()` on every UI-thread tick → emits throttled `onScroll` to JS → JS computes `velocity = Δoffset / Δt` using `Date.now()` → JS passes both `scrollOffset` and `velocity` back to C++ `processScroll`.

**After**: `setScrollOffset(x, y, timestamp)` derives velocity internally using `CACurrentMediaTime()` (strictly more accurate than JS `Date.now()`). `processScroll` reads both scroll offset and velocity directly from `LayoutCache`. JS passes **neither** — fewer JSI args, zero physics estimation in JS.

### 2. Dimension-estimate invariant

**Principle**: All consumer-provided dimensions (`itemHeight`, `estimatedItemHeight`, `heightForItem`, `sizeForItem`, etc.) are **estimates**. Actual dimensions always come from Yoga via the LayoutCache (`measuredHeightForItem`). No code path should treat consumer inputs as final.

**Audit result (2026-04-09)**: All 4 layout engines (list, grid, masonry, flow) correctly use the priority chain: `measured (Yoga) → delegate callback → prop fallback`. The only violation was `isVariableHeight` being used as a gate for `measureAhead` — decoupled (see COLLECTIONVIEW_INTERNALS.md).

### 3. Push vs pull for range updates

**Question**: If native owns offset, velocity, and windowing, should native push range updates instead of JS pulling via `processScroll`?

**Answer: Pull wins.** Three reasons:

1. **Threading**: Running spatial queries in `scrollViewDidScroll:` (UI thread) would contend with `ShadowNode::layout()` (Fabric BG thread) on `LayoutCache._mutex` — the ShadowNode holds it for 50-500μs during `correctChildPositionsIfNeeded` + `applyMeasurements`. Main-thread blocking = scroll jank.

2. **Cost**: With the C++ early return (Opt 6), the total JS cost when ranges don't change is ~1-2μs (JSI hop + band check + return). That's 0.01% of a 16ms frame budget. Not worth architectural complexity to eliminate.

3. **Custom layouts**: Push from native would bypass JS custom layout engines that compute their own positions. The pull model keeps JS as the orchestrator — it decides when to call `processScroll` and how to apply the result.

**Escape hatch**: If profiling shows event delivery itself is a bottleneck, suppress `onScroll` from native when scroll offset is within the stable band — incremental, single `if` in `scrollViewDidScroll:`, no architectural change.

---

## Recommended Execution Order

1. **Opt 1 + Opt 2 together** — combine sorted-range computation and batching into a single `processScroll` JSI call. This is the biggest bang-for-buck: removes 4-6 JSI calls and replaces them with 1 returning ~8 integers. ✅
2. **Scroll ownership cleanup** — move velocity/offset to native-owned, simplify `processScroll` interface, fix `measureAhead` gating.
3. **Opt 6** — C++ early return in `processScroll` (stable-band skip). Natural follow-on from scroll ownership cleanup.
4. **Opt 3** — transform positioning. Independent, can be done in parallel.
5. **Opt 4 + Opt 7 together** — revisit recycling (SlotManager) + incremental render loop.
6. **Opt 5** — only needed if spatial query layouts prove to be a bottleneck.

---

## Key Files

| File | Changes |
|------|---------|
| `cpp/WindowController.h` | Add `processScroll()` / `computeSortedRanges()` |
| `cpp/CollectionViewModule.cpp` | Expose new JSI bindings |
| `ios/RNCollectionViewContainerView.mm` | Transform-based positioning |
| `src/types/protocol.ts` | Add `needsSpatialQuery` to layout protocol |
| `example/components/CollectionView.tsx` | Use batched JSI call, range-stability check, layout routing |
| `example/components/SlotManager.ts` | Already exists — revisit for Opt 4 |

---

## Verification

1. **Benchmark before/after** each optimization using the existing benchmark suite (feed + search tabs)
2. **JS FPS** should improve most from Opt 1+2 (spatial query elimination)
3. **UI FPS** should improve from Opt 3 (transform positioning)
4. **Mount counts** should drop with Opt 4 (recycling revisit)
5. **Custom layouts** with `needsSpatialQuery: true` must still work — verify spatial query fallback path
6. **Custom layouts** with `needsSpatialQuery: false` must use binary search path — verify no visual breakage
7. **Sticky headers** — must still work with transform positioning (already use transforms)
8. **Variable-height cells** — measurement feedback loop must still converge in 1 frame
9. **MVC (maintain visible content position)** — offset correction must still work with transforms

---

## Commit status: Opt 1 + Opt 2

**Recorded on branch:** `cur-cell-pooling` — message `perf(rncv): Opt 1+2 batched processScroll; document API audit` (includes `PERF-PLAN.md` appendix + C++/iOS/JS hot path; `example/yarn.lock` left unstaged). Use `git log -1 --oneline` for the current hash.

**Scope:** Opt 1 (C++ spatial queries in `processScroll` + JS `windowController.processScroll`) and Opt 2 (single batched JSI call returning render/visible/measure ranges + `cacheVersion`) across `cpp/CollectionViewModule.cpp`, `cpp/WindowController.h`, related native/iOS glue, and `example/components/CollectionView.tsx`.

---

## API / packaging audit (post Opt 1+2)

### Where `CollectionView` lives today

The **consumer React component** (`Riff` / `CollectionView`) is implemented under **`packages/rn-collection-view/example/components/CollectionView.tsx`**, not under `packages/rn-collection-view/src/`.

**Why (POC constraint):** The library package can resolve a **different React instance** than the host app (`node_modules/react` inside the package vs the app). Mounting hooks from the wrong instance causes crashes and broken context. The repo comment in [`packages/rn-collection-view/src/index.ts`](packages/rn-collection-view/src/index.ts) states the component will be **re-exported from `src/` once the monorepo uses workspace-hoisted React** (single React for app + library).

**Implication:** [`src/index.ts`](packages/rn-collection-view/src/index.ts) today exports module, layouts, and types — **not** the `CollectionView` component as a drop-in import from the package root. Standalone-library ergonomics are incomplete until that move + Metro/tsconfig alignment.

### Callback and prop surface (current vs desired)

| Area | Current state | Gap vs “library should own internals” |
|------|----------------|----------------------------------------|
| Scroll callbacks | `onScroll` is wrapped internally then `scrollViewProps?.onScroll` is invoked. Drag/momentum handlers are passed **only** from `scrollViewProps` onto `RNCollectionViewContainer`. | Consumers still reach into `scrollViewProps` for several events; **not** a single top-level surface like FlatList. |
| `onContentSizeChange` | Supported as **top-level** `onContentSizeChange` **or** `scrollViewProps.onContentSizeChange` (single winner: top-level overrides scrollViewProps). | Desired: **one** CollectionView-level API; internally consume, adjust, then **forward** to consumer (and if both provided, policy should be explicit — e.g. call both or deprecate one). |
| Horizontal cross-axis height | **Internal:** auto-height from native `contentSize` with bootstrap guard (avoids latching full viewport height). **Demos:** `LayoutsTab` horizontal masonry / horizontal grid / adaptive H-grid still use **local `containerH` + `onContentSizeChange`** to size wrapper `View`s and show subtitles. | Demo code still duplicates work the component should own; should be removed once internal sizing is trusted everywhere. |
| Types | [`src/types/protocol.ts`](packages/rn-collection-view/src/types/protocol.ts) defines a slimmer `CollectionViewProps` (`onScroll` shape, `scrollViewProps?: Record<string, unknown>`) that **does not match** the rich `RiffProps` in the example component. | Public TS contract for a standalone package should be **one** aligned interface. |

### Recommended follow-ups (after perf branch is stable)

1. **API cleanup milestone:** Hoist ScrollView-equivalent callbacks to `CollectionView` top-level; keep `scrollViewProps` only for pass-through props that are not events (or document deprecation).
2. **Demo cleanup:** Remove `containerH` / `onContentSizeChange` wiring from horizontal demos in `LayoutsTab` so demos only use flex + `CollectionView` internal behavior.
3. **Package export:** Re-export `CollectionView` from `src/index.ts` when React hoisting is guaranteed; update Metro/tsconfig and example imports accordingly.
4. **Next perf work per this doc:** **Opt 6** (C++ stable-band skip — already implemented), then **Opt 3** (transform positioning), then **Opt 4+7** (recycling + incremental render), then **Opt 5** if spatial layouts remain hot.

---

## Known Issues (observed during manual testing, 2026-04-09)

1. **Vertical list — separator toggle causes scroll position shifts.** Toggling separators on/off while scrolling (or when scrolled to the lower half of the list) sometimes causes the scroll position to jump. Likely cause: decoration insertion/removal changes content size and the MVC anchor correction doesn't fully compensate for the separator height deltas.

2. **Horizontal grid — cross-axis height flicker on section boundary.** In horizontal grid, after changing the size of `s[0][0]` and scrolling past section 0, the list sometimes shrinks to a smaller cross-axis height then grows back to the correct height when scrolling back to `s[0][0]`. Likely cause: `_maxCrossAxisHeight` re-derivation from visible items (not all items) when the mutated item scrolls off-screen.

3. **MVC should anchor on resize.** When the list container is resized (e.g., orientation change, split view), the currently visible item should remain visually anchored. Currently no MVC correction is triggered on resize — it only activates on data mutations (insert/delete). This needs a resize-triggered MVC path.

4. **Duplicate item at s[0][0] after insert/delete (seen once).** Two instances of the same item stacked at the same position. Not fully diagnosed. Possible causes: (a) LayoutAnimation 350ms spring causing two cells to briefly overlap during the transition; (b) a pooled SlotManager slot with `Activity=hidden` rendering at a valid LayoutCache position (the pooled cell should be invisible but may flash for 1 frame before Fabric commits `display:none`); (c) a SlotManager edge case where two slots share the same `cacheKey` after mutation-induced pool churn. To investigate: add `__DEV__` assertion in `SlotManager.sync()` after Phase 3 that verifies no two non-pooled slots share the same `cacheKey`. If the assertion fires, it's a recycling bug; if not, it's a visual overlap from LayoutAnimation.

5. **`apply()` removeAttributes key format mismatch (pre-existing, masked by cache clear).** `apply()` in CollectionView.tsx line 1458-1465 calls `removeAttributes(key)` using raw keyExtractor IDs (e.g., `"s0-5"`), but LayoutCache stores entries under prefixed keys (e.g., `"sticky-identity:s0-5"`). The removal is always a no-op. Currently harmless because the fingerprint-based `cache.clear()` in `list.ts prepare()` wipes everything. Will need fixing if the clear behavior ever changes. Fix: map removed keys through the section-key prefix format from `layoutContext.sections[s].itemKeys`.

---

## Correctness Fixes (not perf, but identified during perf work)

### Fix 1: Decouple `measureAhead` from `isVariableHeight` ⬜

`isVariableHeight` is `estimatedItemHeight !== undefined` — it gates whether `measureAhead` is passed to `processScroll` and whether `measureRange` state is updated. This is wrong: a list using `itemHeight` (fixed) with `measureAhead > 0` should still pre-measure.

**Locations (3):**
- L1269, L1554: `isVariableHeight && measureAhead > 0` → `measureAhead > 0`
- L1285, L1575: Same pattern in measure-range state update
- L2048: `!isVariableHeight || measureRange.last < measureRange.first` → `measureRange.last < measureRange.first`

See COLLECTIONVIEW_INTERNALS.md § "isVariableHeight" for full analysis.

---

## RN Version Compatibility Testing

Target versions (from MEMORY.md):
- **Primary: RN 0.83.4** — full `Activity` API (React 19.2, exclusively new arch)
- **Compatibility: RN 0.80.x** — new arch, `Activity` absent → top:-9999 fallback

### What to test on each version

Testing must cover both versions before any milestone is marked done. The table below captures what differs between them and what regression risk each area carries.

| Area | RN 0.80.x behaviour | RN 0.83.x behaviour | Risk if broken |
|------|---------------------|---------------------|----------------|
| Measure-range cells | `top: -9999` (no `Activity`) | `Activity mode="hidden"` | Blank cells, off-screen render overlap |
| `Activity` prop availability | Not available — `CollectionView.tsx` must not reference it | Available | Crash / JS error if guarded incorrectly |
| ShadowNode `layout()` API | Stable since Fabric introduction — same C++ surface | Same | Low — no API delta here |
| Fabric commit timing | Fabric BG thread; same contract | Same | Low |
| `useLayoutEffect` ordering | React 18 semantics | React 19.2 semantics | Effects fire differently; check measurement feedback loop |
| `useDeferredValue` | Available (React 18+) | Available | Low |
| `processScroll` JSI | Stable — our custom TurboModule, no RN version dependency | Same | Low |
| `applyMeasurements` / height stash | Pure C++ — no RN API | Same | Low |
| MVC correction (`_correctionConsumed`) | Pure C++ — no RN API | Same | Low |

### Test matrix per RN version

Run the following scenarios on **both 0.80.x and 0.83.x** after any C++ or native change:

**Scroll correctness**
- [ ] Fast fling to end of 1000-item list — no blank frames visible after fling stops
- [ ] Slow scroll up and down — measure-range cells appear before viewport reaches them
- [ ] Rotate device mid-scroll — relayout without position jump
- [ ] Horizontal list: all of the above

**Data mutation (MVC)**
- [ ] MVC on → scroll to bottom → delete 3 items at top → no scroll position shift
- [ ] MVC on → scroll to bottom → insert 3 items at top → no scroll position shift
- [ ] MVC on → scroll to bottom → insert 3 → press "Top" button → scrolls to y=0 in one press
- [ ] MVC off → insert/delete → content size changes correctly, no correction applied

**Measure-range (Activity / top:-9999)**
- [ ] Cells in measure range are not visible (either hidden or off-screen)
- [ ] Yoga measurements from measure-range cells flow into LayoutCache correctly
- [ ] No visual artifact from the `top:-9999` fallback on 0.80.x (cell not clipped into view)

**Sticky headers/footers**
- [ ] Sticky header stays pinned during fast scroll
- [ ] Sticky footer (cur-section-footer-test) — verify in both versions
- [ ] No sticky flicker after MVC correction is applied

**Decorations**
- [ ] Separators render correctly and do not shift after insert/delete
- [ ] Section backgrounds render at correct bounds

**SlotManager recycling (Opt 4+7)**
- [ ] Recycled slots receive correct `item` and `cacheKey` props on first render
- [ ] No duplicate items visible during rapid insert/delete cycles
- [ ] Pool drain (maxPoolSize) does not produce blank slots

### How to switch RN versions (local)

The primary dev environment uses **0.83.4** (`packages/rn-collection-view/example/`). To test 0.80.x:

1. Check if a separate example directory or branch exists for 0.80.x; if not, create one.
2. `cd example && npm install react-native@0.80.x` (or update `package.json`).
3. `pod install` in `example/ios/` — Podfile `platform :ios, '15.1'` is already set.
4. Xcode clean build (`Cmd+Shift+K`).
5. Run the test matrix above.

**Key guard to verify in 0.80.x**: Search for `Activity` in `CollectionView.tsx`. It must be wrapped in a runtime or compile-time guard. The current approach uses `top: measureOnly ? -9999 : undefined` as the fallback; confirm the `Activity` import path is conditionally resolved.

### Timing

Run the full matrix:
- After any C++ change that affects `applyMeasurements`, MVC correction, or height stash
- After any native ObjC change to `RNCollectionViewContainerView.mm`
- Before merging any feature branch to `main`
- Before the FlashList comparison benchmark session (REQUIREMENTS.md P6.2)
