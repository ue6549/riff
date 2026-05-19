# RNCollectionView — Implementation Plan (Performance-First)

Platform: iOS first, then Android. RN New Architecture (Fabric + JSI). RN 0.83.4 (React 19.2).
Graceful degradation: RN 0.76+ (new arch, Activity absent).

**Ordering principle:** Performance, speed, memory, stability, metrics, and traces FIRST.
Features second. Research last. Documentation closes it out.

> **All remaining work is tracked in [`BACKLOG.md`](BACKLOG.md).** This file is now a record of completed milestones. Archived plans (cursor-plan.md, ethereal-seeking-willow.md, PERF-PLAN.md, perf-opti-claude.md) are in `docs/archived-plans/`.

---

## ✅ Completed Milestones

### Phase 0 — Project Foundation (DONE)
- **M0.1** Package scaffold — buildable package, example app
- **M0.2** Core TypeScript types — Rect, Size, Point, LayoutAttributes, etc.
- **M0.3** C++ JSI module boilerplate — `ping()→"pong"` synchronous JSI call

### Phase 1 — Layout Engine (DONE)
- **M1.1** LayoutCache (C++) — CRUD, version, getAll, getTotalContentSize, getSectionOffsets
- **M1.2** ListLayout: fixed height — 10k items × 72px in < 1ms
- **M1.3** ListLayout: estimated + invalidation — variable heights, invalidateFrom pivot
- **M1.3b** TS layout parity — TSLayoutCache, TSListLayout, CustomLayoutPlugin
- **M1.4** SpatialIndex — getAttributesInRect, bucket-based, < 0.05ms for 10k items
- **M1.5** ListLayout: multi-section — 10 sections × 1k items, headers, footers

### Phase 2 — Scroll + Rendering (DONE)
- **M2.1** CollectionView shell + pluggable ScrollView
- **M2.2** Native scroll bridge — UIScrollViewDelegate → C++ window controller on UI thread
- **M2.3** Render all cells (absolute positioning, no virtualization)
- **M2.4** Window controller — visible/render tiers, velocity-adaptive, mountedWindowSize budget

### Phase 3 — Virtualization (DONE)
- **M3.1** Activity-based cell suspension (CellWrapper with Activity=hidden/visible)
- **M3.3** Cold eviction — unmount outside render window, remount at correct position
- **M3.4** Velocity-adaptive window — render range expands toward direction of travel
- **M3.5** Cell budget (mountedWindowSize) — mounted content capped in viewport multiples

### Phase 4 — Sizing Strategies (DONE)
- **M4.1** Estimated sizing — variable-height mode, RAF-batched scroll corrections, measure range
- **M4.2** RNMeasuredCell Fabric component — native `layoutSubviews` fires `onMeasured` before paint
- **M4.3** Self-sizing cells — tap to expand/collapse, dynamic resize, automatic scroll correction

### JS Optimizations Applied (within M4.1/M4.2)
1. Activity mode fix — render-range=visible, only measure-range=hidden
2. Microtask flush for off-screen cells
3. Running average height fallback for unmeasured items
4. Measure range in scroll handler (same frame as render range)
5. Skip startTransition for measure range on fast scroll
6. Phantom correction fix — measure-only cells removed from RAF batch
7. `initialNumToRender` — first screenful on first frame
8. `useLayoutEffect` for layout pass — committed before paint
9. Eager initial range in `onContainerLayout` — 3-render init chain → 2
10. `React.memo` on cell content (MemoizedCellContent) + stable renderItem ref — 1fps → 40-50fps win on simulator. Scroll events no longer re-render stable cells.
11. `startTransition` placement — render range updates are intentionally synchronous (delayed range = blank frames). Only snapshot API data commits use startTransition. `useLayoutEffect` for layout pass is incompatible with startTransition by design.

---

## ✅ Phase P1 — C++ Window Controller on UI Thread

> **DONE.** `processScroll` is a single batched C++ JSI call. Binary search for sorted layouts (Opt 1), batched call (Opt 2), stable-band skip (Opt 6), incremental render (Opt 7), SlotManager recycling (Opt 4) all shipped. See `docs/archived-plans/PERF-PLAN.md` for full optimization history.

### P1.1 — Window controller → C++ JSI module

Port window boundary computation from JS to native C++. Not optional.

**Why:** JS window controller runs in Hermes on the main thread. Even with synchronous JSI,
the JS-side computation pays interpreter overhead (~2–5ms). C++ is sub-microsecond.

**Deliverable:** `cpp/WindowController.h/.cpp`
- Registered as synchronous JSI module
- Scroll position fed from UIScrollView delegate callback (C++ → C++, no JS)
- Window boundary computation in C++ (arithmetic + clamp)
- Notifies React via batched async dispatch when tier assignments change
- React processes tier changes via startTransition (non-urgent)

**Acceptance:**
- Window boundary update: < 0.5ms from UIScrollView delegate to boundary update
- Instruments Time Profiler: zero JS frames in scroll hot path
- All M2.4 + M3.x test cases pass unchanged
- Blank area at 2000px/s fling: same or better than JS baseline

**Deps:** M2.4 (behavioral reference), M0.3 (C++ JSI infrastructure)

---

## ~~Phase P2 — YGMeasureFunc: Native Cell Measurement~~ ✗ INFEASIBLE

### ~~P2.1~~ — Custom YGMeasureFunc for cell height — **INFEASIBLE**

**Why infeasible:** Fabric restricts `YGMeasureFunc` to **leaf nodes only** — nodes with
no Fabric children. Cell containers always have children (the consumer's component tree),
so they cannot be leaf nodes. No workaround without forking Fabric internals.

**What we have instead (M4.2):** `RNMeasuredCell` fires `onMeasured` from `layoutSubviews`
before the first paint — this fires synchronously during the native layout pass, before any
frame is drawn. It's effectively as good as YGMeasureFunc for the initial measurement case.
Self-sizing cells (M4.3) continue to use this path for dynamic resizes.

---

## ✅ Phase P3 — Offscreen Pre-rendering via Activity

### P3.1 — Activity-flip pre-rendering ✅ DONE

**Implemented approach (RN 0.83+ / Activity API):**
Measure-range cells mount at their real estimated position with `Activity=hidden`.
The cell is invisible to the user but Fabric lays it out at the correct location.
When the viewport reaches the cell, only the Activity mode flips (`hidden→visible`) —
a single atomic Fabric commit with no position change, no re-render, no blank flash.

**Degraded path (RN < 0.83, Activity absent):** cells park at `top: -9999`.

**Why the original plan's approach was abandoned:**
The plan described building shadow trees via Fabric's internal commit pipeline ahead of time.
This uses non-public Fabric APIs (`FabricUIManager.createNode`, scheduler internals) that are
not accessible from userspace RN. The Activity-flip approach achieves the same visible result
(cell appears instantly at correct position) without touching internals.

**Deps:** M3.1, M4.2

---

## ✅ Phase P4 — Memory Optimization

### P4.1 — Mounted cell budget refinement ✅ DONE

**Implemented:**
- `nativeMod.memory` JSI sub-object: `availableBytes()`, `pressureLevel()`, `onPressure(cb)`, `simulate(level)`
- `os_proc_available_memory()` (iOS) wired via ObjC callback — synchronous, called on JS thread
- `UIApplicationDidReceiveMemoryWarningNotification` → C++ `triggerMemoryPressure(2)` → `jsInvoker_->invokeAsync` → JS callback
- CollectionView internal `memoryMultiplier` state: 1.0 / 0.75 / 0.5 on levels 0/1/2
- `effectiveMountedWindowSize = mountedWindowSize × memoryMultiplier` — all applyBudget calls use this
- Test screen `P4_1_MemoryBudget.tsx`: live available MB, pressure level, mounted count, simulate buttons
- Android: deferred to F5 / R0.3 (uses `ActivityManager.getMemoryInfo()` + `onTrimMemory`)

**Deps:** M3.5

---

## ✅ Phase P5 — Instrumentation & Metrics

### P5.1 — Metric collection infrastructure ✅ DONE

Core metric pipeline baked into the component.

**Deliverable:** `src/metrics/MetricCollector.ts`
- Frame time: CADisplayLink callback (native) → circular buffer (C++) → JS read
- Blank area: computed from visibleRect vs cells in visible tier each frame
- Cell render time: timestamp at mount → timestamp at visible flip
- Cold mount rate, scroll correction count, pre-render hit rate
- All metrics collected always (low overhead), ring buffer storage

**Acceptance:**
- Frame time accurate to ±0.5ms (CADisplayLink hardware timer)
- Blank area ratio updates every frame during scroll
- Overhead: < 0.5ms/frame on iPhone 12

**Deps:** M3.3, M2.2

---

### P5.2 — Debug Perf HUD ✅ DONE

Live metrics overlay in the sample app.

**Deliverable:** `src/debug/CollectionViewHUD.tsx`
- Toggle via shake gesture or programmatic API
- Displays: FPS, blank area %, mounted cells, cold mount rate, corrections, memory
- Color overlay mode: tints cells by tier (visible/render/measure)
- Works in release builds

**Acceptance:**
- HUD appears within 100ms of toggle
- Metrics update at 10Hz (not 60Hz)
- HUD is a separate React root (doesn't affect CV perf)

**Deps:** P5.1

---

### P5.3 — Traces in sample app ✅ DONE

Instrument the example app with structured traces for release-build profiling.

**Deliverable:**
- `os_signpost` integration for scroll handler, layout pass, cell mount/unmount
- Instruments trace template for CollectionView analysis
- Sample app screens annotated with trace regions
- Export capability: trace summary as JSON for comparison

**Acceptance:**
- Instruments shows named signpost regions for all critical paths
- Trace data available in release builds (signpost, not NSLog)
- Example app produces reproducible trace sessions

**Deps:** P5.1

---

## ✅ Phase P6 — FlashList Comparison (Release Build)

> **DONE.** P6.1 comparison demo shipped (7 tabs). P6.2 device measurement completed (iPhone 15 Pro). Bench 2 (post H-4/H-5) results: Riff dominates Storefront, Homepage, SRP on min FPS, p5 FPS, active mounts. Fling ↑ Storefront regression from Bench 1 is fixed (60 = 60).

### P6.1 — FlashList comparison demo

Side-by-side CollectionView vs FlashList across 6 tabs. Each tab isolates one
differentiator that is either impossible or visibly broken in FlashList. Same data,
same cell complexity, same interaction — only the list engine differs.

**Deliverable:** `example/screens/Comparison.tsx` (extend existing)

**Pre-requisites:**
- F3.2 — MasonryLayout (C++) for Tab 4
- Circular TS layout plugin for Tab 4
- FlashList installed in example app as a dependency

---

**Tab 1 — Prefetch + Simulated Loading** _(strongest visual)_

Cells contain simulated "images" — colored gradients behind a 300–800ms random delay
before they "load." CollectionView's `onPrefetch` fires 12× viewport ahead, so loading
starts well before cells are visible.

| | CollectionView | FlashList |
|---|---|---|
| Scroll at moderate speed | Cells arrive fully loaded, zero placeholders | Every new cell shows gray skeleton, pops in after delay |
| Mechanism | `onPrefetch(keys)` → start load → cell mounts with data ready | No prefetch API — load starts on mount |
| Visual | Smooth, populated content | Flickering gray → content transitions |

---

**Tab 2 — Sticky Headers: Push + Animation Continuity** _(undeniable)_

5+ sections. Each sticky header contains:
- A **millisecond ticker** updating every 16ms (shows elapsed time since section appeared)
- A **shimmer animation** — looping gradient sweep, purely cosmetic but continuous

Two FlashList bugs demonstrated at once:

| | CollectionView | FlashList |
|---|---|---|
| Push behavior | Incoming header pushes outgoing header up pixel-perfectly (RNScrollCoordinatedView, CATransform3D on UI thread) | Headers overlap at the top — no push logic |
| Animation continuity | Outgoing header's ticker and shimmer never reset — same component instance, just translated | Header re-mounts on section change — ticker resets to 0, shimmer restarts from frame 1 |
| JS per scroll frame | Zero — KVO on contentOffset, transform in native | JS handler repositions sticky view each frame |

---

**Tab 3 — Section Decorations with Animated Backgrounds** _(visual polish gap)_

5 sections, each with a distinct animated background:
- Looping shimmer gradients (e.g. gold shimmer, blue wave, green pulse)
- Animated via `Animated.loop` — continuous, never restarts
- Background spans behind all cells in the section (headers, items, footers)
- Cells float above the decoration with transparent/semi-transparent styling

The decoration is a real stateful React component — not a paint trick. Within the
render window, the animation runs continuously. Scrolling a section out and back in
(within render range) shows the shimmer exactly where it left off.

| | CollectionView | FlashList |
|---|---|---|
| Section backgrounds | `renderSectionBackground` — first-class API, real React component | No concept of decoration views |
| Animated backgrounds | Works — looping Animated.View behind cells | Would require absolute-positioned Views with manual height calc, breaks on dynamic content |
| Animation persistence | Within render window: animation continues seamlessly | N/A — can't be built |

---

**Tab 4 — Custom Layouts: Masonry + Circular** _(capability gap)_

Two sub-demos showing layouts that FlashList structurally cannot do:

**Masonry (C++):** Variable-height items in a 2–3 column waterfall. Items placed in
shortest column, no gaps, no overlaps. Layout computed in C++ in < 1ms for 1k items.
`cpp/layouts/MasonryLayout.h/.cpp`.

**Circular / Radial (TS CustomLayoutPlugin):** Items arranged in an arc.
`x = cx + r·cos(θ)`, `y = cy + r·sin(θ)`. Demonstrates arbitrary 2D positioning
via the TS layout plugin path. Scrolling rotates items around the arc.

| | CollectionView | FlashList |
|---|---|---|
| Masonry | Native C++ layout, sub-ms computation | Impossible — layout assumes linear sequential Y |
| Radial / circular | TS plugin: arbitrary x,y per item | Impossible — scroll container is linear, items must be sequential along one axis |
| Grid | C++ GridLayout (F3.1) | Possible (numColumns prop) — parity here |

---

**Tab 5 — Performance Metrics** _(hard numbers across 4 scenarios)_

Same metrics measured across 4 cell composition scenarios that exercise different
recycling/windowing trade-offs. Each scenario is a sub-tab or picker within Tab 5.

**Scenarios:**

| # | Scenario | What it tests | FlashList advantage | CollectionView advantage |
|---|---|---|---|---|
| 1 | **Homogeneous, fixed height** — 10k identical cells (text only, 44px) | FlashList's best case: single cell type, perfect pool reuse | Maximum recycling efficiency — one pool, instant reuse | C++ layout, zero-JS scroll path. Should be competitive even here. |
| 2 | **Homogeneous, dynamic height** — 10k cells, same component but varying text lengths (3–8 lines) | Measurement overhead. FlashList recycles but must re-measure. | Pool still useful (one type) but measurement causes layout shifts | Native measurement before first paint (M4.2). Scroll corrections < FlashList's. |
| 3 | **Heterogeneous, repeating** — 10k cells, 4–5 distinct item types (image card, text row, banner, compact row, separator) repeating in pattern | Recycling pool per type. FlashList benefits from type-based pools. | Multiple pools, each type recycled. This is FlashList's design target. | No recycling overhead. Same windowing cost regardless of type count. |
| 4 | **Heterogeneous, non-repeating** — Long product-detail-style page. Each cell is unique (hero image, description, specs table, reviews, related items, legal text). 50+ unique components, no repetition. | **Recycling is useless** — every cell is unique, pool never hits. FlashList pays mount cost on every recycle. | None. Pool miss on every cell = full mount cost, same as no recycling. | **Clear win.** Windowing + Activity suspension. Cells stay mounted within render range. No mount/unmount churn. Budget-controlled eviction only for far-off cells. |

**Metrics per scenario:**

| Metric | How measured | Notes |
|---|---|---|
| FPS | CADisplayLink hardware timer, 30-frame rolling average | Measured during sustained 2000px/s fling |
| Blank area % | Visible rect vs mounted cell rects, per frame | Key metric for scenario 2 (dynamic height) |
| Mounted cell count | `onRenderCountChange` callback | CV: budget-controlled. FlashList: pool size |
| Layout computation time | Timed in C++ / JS respectively | CV: < 1ms (C++). FlashList: 5–50ms (JS) |
| Mount/unmount rate | Count cell mount/unmount events per 1000 frames | **Scenario 4 killer metric**: FlashList mounts on every recycle, CV mounts once |
| Memory (available MB) | `os_proc_available_memory()` | CV: adaptive budget. FlashList: static |
| Memory pressure response | Simulate via P4.1 | CV: budget halves instantly. FlashList: no response |

**Expected narrative across scenarios:**
- Scenario 1: FlashList competitive or slightly ahead (its ideal case). CV shows parity.
- Scenario 2: CV ahead on scroll corrections and blank area (native measurement).
- Scenario 3: Close. FlashList pools help, but CV's zero-recycle avoids type-mismatch pool misses.
- Scenario 4: **CV clear winner.** FlashList degrades to full-mount-per-scroll. CV's windowed cells stay alive. Mount rate: CV near-zero vs FlashList ~every cell.

---

**Tab 6 — Dynamic Resize Reflow** _(architectural differentiator)_

Animated container resize (simulating iPad split-view or foldable) showing layout
adaptation per-frame. Container width animates 100%→50%→100% over ~2 seconds.

| | CollectionView | FlashList |
|---|---|---|
| Resize cost | O(window) — layout recomputes ~30 visible items per frame | O(N) — `relayoutFromIndex(0)` recomputes all items |
| C++ layout | Masonry reflows in <0.1ms per frame | N/A — all JS |
| Frame drops | None — windowed computation | Likely drops on large datasets |
| shouldInvalidate | Layout decides if bounds change requires recompute | Always full relayout on onLayout |

Demonstrates with:
1. C++ masonry layout (sub-ms windowed recompute)
2. TS custom layout (still fast — windowed)
3. Frame time overlay showing per-frame layout cost

---

**Tab 7 — State Bleed** _(soft demo, honest framing)_

Like buttons + TextInput in cells. Scroll away and back.

| | CollectionView | FlashList |
|---|---|---|
| Within render window (5× viewport) | State preserved — Activity suspension | State lost — cell recycled to different item, old state bleeds |
| Outside render window | Clean remount — correct initial state | Same recycling behavior |
| Failure mode | State absent (clean) — never shows wrong state | State corrupt — likes/text appear on wrong items |

Labeled honestly: "manageable in FlashList by lifting state, but default behavior
differs. CollectionView's default is correct; FlashList's default is broken."

---

**Acceptance criteria:**
- All 7 tabs functional on device (release build)
- Prefetch tab: zero visible loading placeholders in CollectionView at moderate scroll
- Sticky tab: millisecond ticker provably continuous across section transitions
- Decoration tab: shimmer animation visibly continuous, no restart on scroll
- Layout tab: masonry + circular render correctly, FlashList side shows "not possible"
- Metrics tab: all 6 metrics displayed live, comparable numbers
- Resize tab: masonry reflows smoothly during animated width change, frame time overlay shows <1ms layout cost
- State tab: state bleed reproducible in FlashList within 5 seconds of scrolling

**Deps:** F3.2 (masonry), circular TS layout, P5.1, F1.3, F2.2–F2.4, P4.1

---

### P6.2 — Device measurement session

Objective performance characterization on real hardware.

**Deliverable:** Documented benchmark results
- Instruments Time Profiler: JS thread occupancy during fast scroll (CV vs FlashList)
- Blank area ratio at 1000/2000/4000 px/s fling
- Memory: heap delta after scrolling 10k items
- Frame drop count per 1000 frames (CADisplayLink)
- Devices: iPhone 15 Pro (A17) + iPhone 12 (A14) minimum

**Acceptance:**
- All measurements recorded and committed
- Release build comparison documented
- Clear win/loss/parity assessment per metric

**Deps:** P5.1, P5.3, P6.1

---

## Phase F1 — Data Layer (Features) _(remaining work → BACKLOG.md B2.1–B2.4)_

### F1.1 — Diff engine (C++)

Key-based diff, runs off main thread.

**Deliverable:** `cpp/DiffEngine.h/.cpp`
```
diff(oldKeys, newKeys) → { inserted, removed, moved }
```
- Identity diff: same key = same item
- O(n) for pure insertions/deletions; O(n log n) for moves

**Acceptance:**
- 1k item diff (50 inserts, 20 deletes, 5 moves): < 2ms incl. JSI string marshalling
  (JSI utf8() costs ~0.65µs/string; pure C++ diff algorithm is sub-ms at any realistic size)
- Correctness: diff(A, B) applied to A produces B exactly

**Deps:** M0.3

---

### F1.2 — Snapshot API

Consumer-facing mutation API modelled after `NSDiffableDataSourceSnapshot`.
All mutation methods are **identity-based** (keys, not indices) — matching Apple's
design that eliminated the index-ordering bugs of the old `performBatchUpdates` era.

**Deliverable:** `example/components/CollectionSnapshot.ts` + CollectionView `handle` prop
```typescript
// Identity-based mutations (UICollectionView-style)
const snap = listRef.current.snapshot()
snap.appendItems(items)
snap.deleteItems(keys)                           // array of keys
snap.moveItem(key, { after: anchorKey })         // single move per call (sequential)
snap.reloadItems(keys)
listRef.current.apply(snap)                      // diff + LayoutAnimation + startTransition
// — or for simple refresh (FlashList-style): just change data prop, no snapshot needed
```

Move is intentionally singular (not array) — each move changes relative positions
for subsequent moves, so ordering is sequential. Same design as Apple's snapshot API.

**Acceptance:**
- Append 100 items: only new items computed in layout
- Delete item at index 50 of 1000: items 51–999 recomputed, 0–49 unchanged
- Apply during active scroll: no interruption (startTransition)
- Move/shift animations via LayoutAnimation on apply()

**Deps:** F1.1, M3.3

---

### F1.2b — Enter/exit cell animations _(follow-up)_

Per-item mount/unmount animations for snapshot transitions.

**Deliverable:**
- Deleted cells: keep mounted briefly, animate opacity→0 + collapse, then unmount
- Inserted cells: mount at opacity 0, animate to 1 + expand
- "Pending removal" queue in the cell renderer

**Acceptance:**
- Delete visually fades out before unmounting
- Insert visually fades in after mounting
- Interruptible: new snapshot applied mid-animation cancels gracefully

**Deps:** F1.2

---

### F1.2c — UICollectionView-parity animations _(follow-up)_

Full coordinated batch animations matching UICollectionView's native behavior.

**Deliverable:**
- Per-item animation types (fade, slide, custom)
- Interruptible spring physics
- Coordinated batch: inserts, deletes, and moves animate simultaneously
- Animation completion callbacks

**Acceptance:**
- Visual parity with `UICollectionViewDiffableDataSource.apply(snapshot, animatingDifferences: true)`
- Animations interruptible mid-flight by new snapshot apply
- Custom animation configuration per operation type

**Deps:** F1.2b

---

### F1.3 — Prefetch callbacks

Notify consumer as items enter/leave the data window.

**Deliverable:**
```typescript
dataSource.onPrefetch = (keys) => { /* fetch */ }
dataSource.onEvict = (keys) => { /* cancel, release */ }
```

**Acceptance:**
- `onPrefetch` fires ~12× viewport ahead
- `onEvict` fires after cell leaves render window + budget

**Deps:** M3.4, M2.4

---

## ✅ Phase F2 — Supplementary Views & Sticky Headers

### F2.1 — Non-sticky supplementary views

Section headers and footers, same tiering as cells.

**Deliverable:**
- `SupplementaryRegistry`: register(kind, Component)
- Layout cache includes supplementary LayoutAttributes (from M1.5)
- Rendered at layout positions, enters/leaves Activity tiers
- Budget: default 20

**Acceptance:**
- 10-section list: headers at correct Y positions
- Headers participate in windowing

**Deps:** M3.3, M1.5

---

### F2.2 — Sticky headers (basic)

Headers stick at top while their section is visible.

**Deliverable:**
- C++ sticky position calculation on UI thread:
  `stickyY(section, scrollY) = max(header.y, scrollY)`
- Separate native view positioned in viewport space
- C++ updates Y every scroll frame

**Acceptance:**
- Section header sticks at top during scroll
- Returns to natural position when scrolling back
- Zero JS involvement during scroll

**Deps:** F2.1, M2.2

---

### F2.3 — Sticky push behavior

Incoming header pushes current sticky header upward (UICollectionView correctness).

**Deliverable:**
```cpp
float stickyY(int section, float scrollY) {
  float naturalY = headers[section].frame.y;
  float nextHeaderY = headers[section + 1].frame.y;
  float clampedY = nextHeaderY - headerHeight[section];
  return max(naturalY, min(scrollY, clampedY));
}
```

**Acceptance:**
- Section 1 header pushed up exactly as section 2 header arrives at top
- Multiple sections in rapid succession: all push correctly

**Deps:** F2.2

---

### F2.4 — Decoration views

Data-free views: section backgrounds, separators.

**Deliverable:**
- Layout engine emits decoration LayoutAttributes (kind + frame, no data)
- `layout.registerDecoration(kind, NativeComponent)` — native, not React
- Not in Activity budget (simple static views, no fiber)

**Acceptance:**
- Section background matches section's total frame
- Decorations not in React DevTools (native views)

**Deps:** F2.1

---

## Phase F3 — Additional Layout Types _(F3.1–F3.5 ✅, F3.6–F3.8 → BACKLOG.md)_

### F3.1 — GridLayout (C++)

Fixed-column equal-width grid.

**Deliverable:** `cpp/layouts/GridLayout.h/.cpp`
```
columns, columnSpacing, rowSpacing, estimatedItemHeight, sectionInsets
```
Item width = (viewportWidth - insets - spacing) / columns.

**Acceptance:**
- 3-column grid, 100 items: < 1ms, correct frames
- Integrates with selfSizing (row height = tallest item)

**Future enhancement:** `rowAlignment: 'top' | 'center' | 'bottom'` — when `heightForItem` produces uneven row heights, align shorter items within the row. Default: `'top'`. Requires C++ change in `GridLayout.cpp` row-end loop (currently always top-aligns). API sketch in `src/types/protocol.ts` GridLayoutDelegate.

**Deps:** M1.5

---

### F3.2 — MasonryLayout (C++)

Variable-height column-packing.

**Deliverable:** `cpp/layouts/MasonryLayout.h/.cpp`
- Place each item in shortest column
- `invalidateFrom`: recompute masonry from that item onward

**Acceptance:**
- 2-column, 50 items (100–400px heights): no gaps, no overlaps
- `totalContentSize.height` = max column height

**Deps:** M4.2

---

### F3.5 — FlowLayout (C++)

Variable-width item packing with dynamic line wrapping (UICollectionViewFlowLayout equivalent).

**Deliverable:** `cpp/layouts/FlowLayout.h/.cpp`
- Items placed left-to-right, wrapping to next line when row is full
- Per-item `{width, height}` via `sizeForItem(index, section)` callback
- Row height = tallest item in that row
- `itemSpacing` (horizontal between items) + `lineSpacing` (vertical between rows)
- Section insets, header/footer support (same pattern as other layouts)
- Windowed computation: only compute positions for items in mounted range
- `shouldInvalidate(forBoundsChange:)`: returns true when container width changes (column count changes)

**Why C++:** Flow layout's bin-packing is the most compute-intensive built-in layout — items of varying width require per-item iteration to determine line breaks. C++ makes this sub-ms even for large datasets.

**Acceptance:**
- 1k items with varied widths (40–200px): correct wrapping, < 1ms
- Container resize: line breaks recomputed, items reflow
- Integrates with supplementary views (headers/footers between sections)

**Deps:** M1.5, R1.3 (layout protocol)

---

### F3.3 — CompositionalLayout ✅ DONE

Sections with independent layout objects.

**Delivered:** `src/layouts/compositional.ts` + `cpp/layouts/CompositionalLayout.{h,cpp}`
- TypeScript public API + C++ engine
- Two-level supplementary system: Level 1 = compositional headers/footers/backgrounds in V-coordinates; Level 2 = leaf-engine items in the leaf's coordinate space
- Section spacing, per-section insets, sticky headers/footers (push + overlay)
- Leaf engines: list, grid, masonry, flow (V) + list, grid (H)

**Acceptance met:** 7-section CompositionalDemo works (list + grid + flow-H + list + flow-V + masonry); CompositionalLab plan in cursor-plan.md will exercise the full mutation matrix.

**Deps:** F3.1, F3.2

---

### F3.4 — Orthogonal scrolling sections ✅ DONE (superseded by H-2 sub-container framework)

Horizontal sections within vertical list.

**Delivered (originally):** `RNOrthogonalSectionView` + JS `OrthogonalSection` wrapper. Each H section is a UIScrollView placed at the section's V position; cells positioned absolutely along the H axis.

**Superseded by H-2 (2026-05-13):** `RNCollectionSubContainer` — generic Fabric component + custom ShadowNode + State carrying per-child `ChildVisualState` (frame + transform + opacity + zIndex + Fabric tag). The H section is now a thin wrapper around the sub-container. Cells get NO absolute styles in JS — frames and transforms are applied natively by `RNCollectionSubContainerView::_applyChildVisualStates` via a tag → UIView map, with one JSI batch (`setAttributesBatch`) per scroll tick. Saves/restores own scroll position via the embedded UIScrollView's content offset.

The legacy `RNOrthogonalSectionView` source remains in the tree as fallback/reference but is no longer wired in the JS H render path.

**Side effect:** the same sub-container framework powers four custom layouts shipped in RiffDemo H-2 tabs: radial, carousel3D (cover-flow), spiral, hex (static honeycomb). See cursor-plan.md "Tier H-2" for the full architecture.

**Acceptance met:** App Store–style layout works (Storefront/Homepage); orthogonal section outside parent render window has all cells unmounted; H scroll position survives section unmount/remount within render window.

**Deps:** F3.3, M3.3

---

### F3.6 — Compositional as flow-with-interludes _(planned)_

**Goal:** Let `compositional` host a primary "feed" layout (list / grid / flow / masonry) that owns a flat data stream, with **special sections inserted at specific anchor points** within that stream. Today the user has to bucket their entire feed into many tiny single-purpose sections. This proposal keeps the feed as one stream and treats specials as inline interludes.

**Why this matters:** the dominant real-world feed pattern is "100 posts with 3 hero blocks, 2 H-carousels, and 1 grid embedded among them," not "5 sections of homogeneous content." The current API forces people to fragment their data and pay per-section bookkeeping; the new API mirrors the consumer's mental model.

**Proposed shape:**

```typescript
compositional({
  primary: {
    layout: list({ /* or grid / flow / masonry */ }),
    data: posts,                       // a single flat array
    keyExtractor: p => p.id,
    renderItem: ({ item }) => <Post {...item} />,
  },
  interludes: [
    {
      anchor: { afterKey: 'post-7' },  // or { afterIndex: 7 } or { atKey: 'top' }
      layout: list({ horizontal: true }),
      data: stories,
      keyExtractor: s => s.id,
      renderItem: ({ item }) => <Story {...item} />,
      sticky: { header: true },
    },
    {
      anchor: { afterIndex: 14 },
      layout: hero(),                  // single-cell layout
      data: [bannerCampaign],
      renderItem: ({ item }) => <Banner {...item} />,
    },
    {
      anchor: { afterKey: 'post-21' },
      layout: grid({ columns: 2 }),
      data: ads,
      renderItem: ({ item }) => <Ad {...item} />,
    },
  ],
});
```

**Anchor semantics:**
- `{ afterKey }` — sticky to a primary item's identity; survives inserts/deletes that shift indices.
- `{ afterIndex }` — fixed flat index in the primary stream (use sparingly, for header/footer-like positions).
- `{ atKey: 'top' | 'bottom' }` — pinned to the start/end of the feed; same role as `ListHeaderComponent` / `ListFooterComponent` but with full layout-engine power.
- Multiple interludes at the same anchor are stacked in declaration order.

**Behavior:**
- Primary is flowed as a single section internally; the engine splits it at interlude anchors and injects each interlude as a sub-section between halves.
- Each interlude is governed by its own layout engine (can be H, grid, custom — same options as today's per-section layout). This lets the H-2 sub-container framework absorb interludes for free: an H carousel interlude is exactly an H sub-container at the right Y.
- MVC, sticky, decorations, prefetch, and the snapshot mutation API all work transparently — the splitter is a layer above leaf engines.
- Primary item recycling pool is unaffected by interludes (interludes use their own pool slot per their leaf type, same `getItemType` model as today).

**Implementation sketch:**
1. **Splitter step in `compositional.ts`** — given the primary stream + ordered interludes, build the equivalent "section list" (`P[0..7], I0, P[8..14], I1, P[15..21], I2, P[22..]`) at JS prepare time. Internally we still produce the section array the C++ engine consumes, so the C++ side needs no protocol change for the static case.
2. **Anchor stability across mutations** — when a primary `keyExtractor` is provided, splits resolve by key on every prepare; inserts/deletes that move `post-7` carry the interlude with it. `afterIndex` resolves once at mount and stays put.
3. **Snapshot API extension** — `snap.appendInterludes(...)`, `snap.removeInterludes(keys)`, `snap.moveInterlude(key, { after: anchorKey })` — same identity-based model as items.
4. **Compatibility** — the existing `sections: [...]` API stays. The new shape is opt-in. If both are provided, sections mode wins (no implicit merge).

**Acceptance:**
- Feed of 200 posts (list) + 4 interludes (1 H carousel, 1 hero, 2 grid) renders correctly, each at the right anchor.
- Insert/delete primary items shifts interludes anchored by `afterKey` correctly; `afterIndex` interludes stay put.
- Sticky on an interlude header sticks at the right Y.
- H carousel interlude scrolls horizontally and survives parent V-scroll out + back in (uses H-2 sub-container).
- Per-cell renderItem for primary never re-runs when an interlude inserts/removes (element cache stays valid).

**Deps:** F3.3 (✅), H-2 sub-container framework (✅), F1.2 snapshot API (✅).

---

### F3.7 — Sub-container framework as a public extension point _(planned, follow-up)_

The H-2 `RNCollectionSubContainer` + `CollectionSubContainerShadowNode` + `ChildVisualState` framework was built to host orthogonal H sections, but it's a fully general "section that owns its own layout and applies frames + transforms + opacity natively" primitive. Document the protocol and ship it as a public extension point so consumers can:

- Write a custom layout in TypeScript by implementing `CollectionViewLayout` + (optional) `processScroll`, calling `setAttributesBatch` from prepare/scroll. → free native fast path, no per-cell JSI cost.
- Write a custom layout in C++ by implementing `LayoutEngine` + (optional) `processScroll`, registering with `registerLayoutEngine`. → same native fast path.
- Drop a sub-container into any consumer screen (not just inside CollectionView) — RiffDemo's four H-2 tabs (radial / carousel3D / spiral / hex) prove this works standalone.

**Deliverable:**
- `docs/Contributing-Layouts.md` walkthrough.
- Public type re-exports: `LayoutAttributes` (with `transform/opacity/zIndex`), `CollectionViewLayout`, `LayoutContext`, `CollectionSubContainerProps`.
- C++ port of one of the four H-2 layouts (probably `hex`) as a reference for native custom layouts.

**Deps:** H-2 ✅, DOC.1.

### F3.8 — Per-section + decoupled V/H windowing knobs ✅ DONE (shipped as H-3.5)

**Motivation (Bench 1, 2026-05-13):** All windowing knobs (`renderMultiplier`, `mountedWindowSize`, `measureAhead`) are top-level CollectionView props applied uniformly to V and H paths. `SectionConfig` has no windowing fields. Storefront's `renderMultiplier={0.25}` (tuned for V efficiency) collapses every H section to `pad = 0.25 * vpWidth`, which contributes to user-observed "H windowing too tight" alongside the missing velocity boost. Real apps need V tight + H wide, and individual sections (hero banner vs dense H carousel vs always-off-screen footer block) have different cost profiles that one global multiplier can't express.

**Solution:**
1. Add top-level `hRenderMultiplier?: number` (defaults to `renderMultiplier`). H path uses this; V path keeps `renderMultiplier`.
2. Add optional `renderMultiplier?` / `mountedWindowSize?` / `measureAhead?` on `SectionConfig`.
3. Build a `sectionWindowingOverrides` map at prepare time, route per-section values into `handleHScroll` and the V render loop.
4. **Precedence:** `section.X` ?? `hRenderMultiplier` (for H sections, where applicable) ?? top-level `X` ?? default. Documented in `docs/Compositional.md`.

**Deliverable:**
- Type changes in `src/types/protocol.ts`.
- Wiring changes in `example/components/CollectionView.tsx`.
- Demo update on `StorefrontDemo.tsx` (`renderMultiplier={0.25}` + `hRenderMultiplier={1.0}` + per-section override on at least one H section to demonstrate).

**Acceptance:**
- Existing usage of top-level props is byte-identical (purely additive).
- Storefront H sections show no leading-edge blank during fast horizontal flings even when V `renderMultiplier=0.25`.
- PerfHood per-section render-range readout reflects per-section overrides.

**Deps:** none (independent of H-3 mechanically; landed together because both touch the H windowing prop plumbing).

---

## Phase F4 — State Persistence & Restoration _(→ BACKLOG.md B6)_

### F4.1 — Layout cache serialization (JSON scaffold)

Serialize LayoutCache to disk. Correctness focus.

**Deliverable:** `cpp/LayoutCacheSerializer.h/.cpp`
- JSON format (temporary — F4.4 replaces with FlatBuffers)
- MMKV via JSI storage
- Cache key: SHA1(listId + dataHash + viewportWidth + layoutConfig)

**Acceptance:**
- 10k items: round-trip byte-identical
- Cache key invalidates on viewport width change

**Deps:** M1.1

---

### F4.2 — Scroll position persistence (native iOS)

Restore scroll position before first Fabric commit.

**Deliverable:**
- On dealloc/viewWillDisappear: write contentOffset to NSUserDefaults
- On viewWillAppear: `setContentOffset:animated:NO` synchronously

**Acceptance:**
- Navigate away + back: exact previous position, zero flash at y=0
- Viewport size changed: stored position cleared

**Deps:** M2.1

---

### F4.3 — Full restoration sequence

Wire F4.1 + F4.2 with data validation.

**Deliverable:** `src/hooks/useStateRestoration.ts`
1. Read scroll offset from native storage → set UIScrollView contentOffset
2. Hydrate LayoutCache from MMKV
3. Compute initial visibleRect from restored scrollY
4. Enter cells into tiers
5. Validate cache: diff current vs cached keys
6. If data changed: invalidateFrom, re-layout

**Acceptance:**
- Full nav cycle (unchanged data): position exact, no layout recomputation
- Full cycle (data changed): position corrected for insertion delta
- Process death + relaunch: restored from MMKV + NSUserDefaults

**Deps:** F4.1, F4.2, F1.2

---

### F4.4 — FlatBuffers layout cache serialization

Replace JSON with FlatBuffers. Zero-copy mmap hydration.

**Why:** JSON parse of 10k LayoutAttributes ≈ 30–50ms. FlatBuffers mmap is zero-copy.

**Deliverable:**
- `fbs/LayoutCache.fbs` — FlatBuffers schema
- MMKV stores raw FlatBuffers bytes
- On restore: mmap MMKV value directly, wrap with FlatBuffers accessor
- Retire JSON serializer

**Acceptance:**
- Serialize 10k items: < 3ms
- Deserialize (mmap, no parse): < 0.1ms
- Layout cache available on frame 0

**Deps:** F4.1

---

## Phase F5 — Cross-Platform _(→ BACKLOG.md B9)_

### F5.1 — Android port

Port C++ modules and React component to Android (new architecture).

**Deliverable:**
- `android/` with CMakeLists wired to existing `cpp/` (no C++ duplication)
- `CollectionViewModule.kt` — TurboModule registration
- Scroll observer equivalent for Android
- All M1–M3 test screens pass on Android emulator

**Acceptance:**
- M1.1–M1.5 layout tests: green on Android
- M2.2 scroll bridge: scrollY tracking confirmed
- M3.3 cold eviction: cells unmount/remount as on iOS
- No iOS-only code in `cpp/`

**Deps:** M3.5. **Platform: Android new architecture (RN 0.76+).**

---

### F5.2 — Web port (React Native Web)

Port to React Native Web using the same TS component layer.

**Deliverable:**
- `web/` adapter: replace C++ JSI calls with JS-only fallbacks
  - Layout engines re-implemented in JS (no JSI on web)
  - ScrollView → DOM scroll container
  - Fabric components (RNMeasuredCell, RNScrollCoordinatedView) → DOM equivalents or no-ops
- All built-in layouts (list, grid, masonry, flow) work on web via JS engines
- Custom TS layouts work unchanged
- C++ features degrade gracefully: no window controller on UI thread (JS fallback), no Activity suspension (visibility observer)

**Acceptance:**
- Grid, masonry, flow, list render correctly in browser
- Scroll virtualization works (IntersectionObserver or scroll event)
- No native module calls crash on web

**Deps:** F5.1. **Platform: React Native Web.**

---

## Phase T1 — Testing (Unit + Integration) _(→ BACKLOG.md B8)_

UTs and ITs for every component in the list view, UI or otherwise.

### T1.1 — C++ Layout Engine Unit Tests

Pure C++ tests. No RN, no JSI — call layout functions directly, assert frames.

**Scope:** ListLayout, GridLayout, MasonryLayout, FlowLayout, LayoutCache.

**Test cases per engine:**
- Empty section (0 items) — contentSize = header + footer + insets only
- Single item
- Fixed height path vs dynamic height path
- Multi-section: total contentSize = sum of sections + sectionSpacing
- Section insets: items offset by insets, contentSize includes insets
- Sticky supplementary: header/footer frames at correct Y
- Separator frames: count = itemCount-1 per section, Y = bottom of each item row
- Section background frame: covers full section content area
- `getAttributesInRect`: returns only items intersecting the rect
- `getAttributes(key)`: returns null for unknown key, correct attr for known key
- Width resize (invalidation): contentSize changes after new width
- `invalidateSectionsFrom(n)`: only sections ≥ n are recomputed

**Framework:** GoogleTest (or Catch2) — add to `cpp/tests/`. CMake target `rncv_cpp_tests`.

**Deps:** None (pure C++).

---

### T1.2 — TS Layout Engine Unit Tests

Jest tests for the TS layout wrappers (list.ts, grid.ts, masonry.ts, flow.ts). Mock `NativeCollectionViewModule` to capture what is sent to C++.

**Scope:** `src/layouts/list.ts`, `grid.ts`, `masonry.ts`, `flow.ts`.

**Test cases:**
- `prepare()` sends correct `computeSections` params for each delegate config
- `attributesForItem(index, section)` uses `lastSectionKeys` when `keyExtractor` keys are present
- `attributesForItem` falls back to `{type}-{section}-{index}` when no identity keys
- `attributesForSupplementary(kind, section)` returns correct key lookup
- `shouldInvalidate`: returns true when width changes > 0.5px, false otherwise
- `invalidationScope()`: returns `{ type: 'full' }`
- Stable Key Rule compliance: key passed to C++ == key used in TS read (for all 4 engines)

**Framework:** Jest (already configured in example/).

---

### T1.3 — CollectionView.tsx Unit Tests

Jest + React Test Renderer. Focus on pure-logic functions — no native module instantiation.

**Scope:** `attrToFlatIndex`, `flattenSections`, scroll offset math in `scrollToItem`, key derivation logic.

**Test cases:**
- `attrToFlatIndex` — item in section 0, item in section 1, header, footer, decoration (returns -1)
- `flattenSections` — correct flat indices, sectionStartFlatIndices, key set
- `scrollToItem` position math:
  - `'top'` without sticky: `targetY = itemY`
  - `'top'` with sticky header H: `targetY = itemY - H`
  - `'bottom'` without sticky: `targetY = itemY - vpH + itemH`
  - `'bottom'` with sticky footer F: `targetY = itemY - (vpH - F) + itemH`
  - `'center'` with both: `targetY = itemY - H - (vpH - H - F - itemH) / 2`
  - `'nearest'`: no-op when fully visible, corrects when above, corrects when below
- Decoration `zIndex`: background renders behind separator (zIndex -1 < 0)

---

### T1.4 — Integration Tests (RN + Native)

End-to-end tests using Detox (or XCUI). Verify that the JS→JSI→C++→native pipeline produces correct visual output.

**Scope:** Core render paths, scrollTo, insert/delete, sticky headers.

**Test cases:**
- List renders correct number of visible cells in viewport
- Grid renders N columns at correct widths
- Insert item: new cell appears at top of list, others shift down
- Delete item: cell disappears, list reflows
- ScrollTo `top`: target item visible at viewport top (below sticky header if present)
- ScrollTo `bottom`: target item visible at viewport bottom (above sticky footer if present)
- Sticky header: stays pinned at viewport top as user scrolls into a new section
- Sticky footer: stays pinned at viewport bottom as user scrolls out of a section
- Section background: covers full section item area (frame check)
- Separator: visible between rows (frame + visibility check)

**Framework:** Detox (iOS). Add `example/e2e/` directory.

**Deps:** T1.1, T1.2, T1.3 (unit layer green first).

---

## Phase R1 — Research

### R00 - first-class breakpoint APIs/callback hooks
User should be able to define rules for resizing, reflowing based on media dimensions.

### R0 — Memory Optimization (Future Research)

Additional memory optimizations beyond P4.1. None are needed for the POC but documented here for production hardening.

**R0.1 — Proactive memory polling**
Poll `availableBytes()` every 5s and pre-emptively reduce budget at level 1, before the OS warning arrives (which is very late). Add hysteresis: restore budget only after memory stays above threshold for 10s to prevent thrashing. Pure JS-side addition to CollectionView.tsx.

**R0.2 — measuredHeightsRef eviction**
The `measuredHeightsRef` Map grows unboundedly — one entry per unique cell key ever measured. At 100k items with variable heights this holds 100k entries (~3–4 MB in V8/Hermes). Fix: evict entries for cells more than `renderMultiplier + measureAhead` viewports away from the visible range. LRU or distance-based.

**R0.3 — Android memory integration**
`ActivityManager.getMemoryInfo()` for `availableBytes()`. `ComponentCallbacks2.onTrimMemory(level)` maps to pressure levels: `TRIM_MEMORY_RUNNING_LOW` → 1, `TRIM_MEMORY_RUNNING_CRITICAL` / `TRIM_MEMORY_COMPLETE` → 2. Wired in `CollectionViewModule.kt`, zero C++ changes needed.

**R0.4 — Image/asset pressure isolation**
When cells contain images, the image cache (not cell views) dominates memory. Track a `hasImages` hint and under pressure: evict cells that are images-only first (highest bytes/cell ratio) rather than furthest-first.

**R0.5 — Per-cell memory estimation**
`Instrumentation.newAllocatedSize()` (Android) / `mach_task_self()` vm_stats (iOS) to measure actual bytes per cell type. Use this to build a typed budget (e.g. "max 20 image cells + 60 text cells") rather than a flat count budget.

---

### R1.1 — UICollectionView host architecture (design + prototype)

Decouple JS component identity from native UIView allocation using UICollectionView
as the physical scroll and layout host.

**Architecture:**
- Native: UICollectionView owns scroll + pool of ~20 UICollectionViewCell shells
- JS/React: one component per item, stable identity, full local state
- Bridge: React component's UIView reparented into whichever cell slot displays it
- Activity mode="hidden": React component stays mounted, UIView held in holding container

**Open questions:**
1. Fabric shadow tree ownership when moving UIView out of shadow-tree parent
2. Scroll ownership: UICollectionView vs RN ScrollView gesture conflict
3. Concurrent React interaction: Fabric may reposition "borrowed" views

**Deliverable:** Design document + working prototype (not production-ready)

**Deps:** P6.2

---

### R1.2 — Virtual-to-physical ShadowNode mapping

Custom Fabric ComponentDescriptor: N virtual ShadowNodes → M physical UIViews (M << N).
React sees N unique components. UIKit sees M reused views.

**Status:** Research. Implement only if R1.1 proves insufficient.

**Deliverable:** Feasibility report + proof-of-concept if feasible

**Deps:** R1.1

---

### R1.3 — Layout Protocol & Unified API Design

Formalize the layout protocol, dimension provider contracts, and three-tier consumer API.

**Core Protocol (aligned with UICollectionView):**
- `CollectionViewLayout` interface: `prepare()`, `attributesForElements(inRect:)`, `attributesForItem()`, `attributesForSupplementary()`, `contentSize()`, `shouldInvalidate(forBoundsChange:)`, `invalidationScope()`
- Each layout type defines its own delegate contract (strict, not optional):
  - **ListLayoutDelegate**: `itemHeight` (fixed) OR `heightForItem(index, section)` (variable) + same pattern for header/footer
  - **MasonryLayoutDelegate**: `columns` + `heightForItem` (mandatory) + header/footer heights
  - **GridLayoutDelegate**: `columns` + `rowHeight` OR `heightForItem` + header/footer heights
  - **FlowLayoutDelegate**: `sizeForItem(index, section) → {width, height}` (mandatory) + header/footer heights
  - **CustomLayoutDelegate**: `attributesForItem(index, section, context) → LayoutAttributes`
- Sizing is symmetric: whatever pattern a layout uses for items, it uses for supplementary views too (fixed OR estimated OR per-index callback)
- Per-index callbacks (not bulk arrays) — layout calls only for windowed range, enabling O(window) not O(N) per frame

**Three-Tier Consumer API:**
- **Tier 1 (simple):** `data` + `renderItem` + `itemHeight` on CollectionView directly. `renderSectionHeader`/`renderSectionFooter` on component, sizing on layout. `stickyHeaderIndices`/`stickyFooterIndices` for index-based pinning.
- **Tier 2 (layout config):** `layout={masonry({columns: 3, heightForItem: fn, stickyMode: 'push'})}`. Layout owns sizing, pinning, behavior.
- **Tier 3 (power user):** `supplementaryItems` on section config — custom kinds, alignment, `pinToVisibleBounds`, `pinBehavior`. Full `attributesForItem` for custom layouts.

**Supplementary View Model (UICollectionView-aligned):**
- Supplementary items are per-section, with `kind`, `alignment`, `pinToVisibleBounds`, `pinBehavior`
- Tier 1 `header`/`footer` shorthand maps to supplementary items internally
- Renderers (`renderSectionHeader`, `renderSectionFooter`) live on CollectionView (view/data layer)
- Sizing/pinning lives on layout delegate (layout layer)
- `stickyMode` on layouts that support it; absent from custom layouts (custom handles own pinning)
- Any layout can support pinning if it defines what "pinned to visible bounds" means in its coordinate space

**Cache Integration:**
- All layouts (C++ and TS) write `LayoutAttributes` to the shared C++ LayoutCache via JSI
- Enables spatial indexing (`getAttributesInRect`) for all layout types
- C++ layouts write directly; TS layouts write via JSI bindings

**Deliverable:** TypeScript interfaces + protocol implementation + migration of existing layouts

**Deps:** F3.1, F3.2, F3.5

---

### R1.4 — TS-to-C++ layout codegen (was R1.3)

Auto-transpile `CustomLayoutPlugin.compute()` from TypeScript to C++ at build time.

**Why:** TS layouts run on the JS thread — one frame behind the native scroll event. C++ layouts run on the UI thread in the same CADisplayLink frame. The 3D carousel and circular layout demonstrate the frame-lag visually (slight jitter on fast scroll). Codegen eliminates it without asking developers to write C++.

**Feasibility:** Layout `compute()` functions are pure: typed numeric inputs → array of `{x, y, width, height, scale, rotateY, opacity}`. No closures, no GC, no dynamic dispatch. Operations map 1:1 to C++ (`Math.cos` → `std::cos`, array iteration → `for` loop, arithmetic → same). The `CustomLayoutPlugin` interface is already the right contract shape.

**Approach:**
1. Static analysis of the `compute()` function body — reject if it contains non-transpilable constructs (closures over mutable state, dynamic property access, async)
2. AST-to-AST transform: TS AST → C++ AST (arithmetic, trig, array ops, struct construction)
3. Generate `cpp/layouts/Generated_<PluginName>.h/.cpp` with JSI bindings
4. Wire into CollectionViewModule automatically (build-step registration)
5. Runtime: use generated C++ version; fall back to TS if codegen was skipped

**Alternatively:** Static Hermes (Meta's AOT compiler for typed JS) may make this unnecessary by compiling typed JS directly to native machine code. Monitor SH progress before building custom codegen.

**Deps:** F3.3 (CompositionalLayout — proves the plugin interface is stable)

---

### R1.5 — JSI object lifecycle on RN reload (dev mode)

On JS-only reload (Cmd+R), cached `std::optional<jsi::Object>` fields in CollectionViewModule
hold dangling pointers to the destroyed runtime, causing a crash.

**Fix direction:** Override `invalidate()` in CollectionViewModule — reset all cached JSI objects.
Alternatively, skip caching and recreate JSI objects on each `get()` call (safe, minor overhead).

**Priority:** Dev-only. Does not affect production. Fix before open-sourcing.

**Deps:** M0.3

---

### R1.6 — Keyboard handling via `adopt()`

Investigate using `ComponentDescriptor::adopt()` to inject keyboard height into the Yoga tree before layout, enabling automatic keyboard avoidance without JS roundtrips. The native side observes keyboard show/hide notifications, then in `adopt()` adjusts padding or content inset on the collection view's Yoga node so Yoga produces a layout that accounts for the keyboard — all synchronous, no async JS bridge calls.

See `docs/ARCHITECTURE.md` Section 9 (RN New Architecture Learnings) for `adopt()` documentation.

**Deps:** R1.1

---

### R1.7 — Safe area handling via `adopt()`

Follow SafeAreaView's pattern: native view detects safe area insets → updates state → `adopt()` calls `setPadding()` on the Yoga node before layout. This gives the collection view automatic safe-area-aware content insets without requiring JS measurement or manual padding props.

See `docs/ARCHITECTURE.md` Section 9 (RN New Architecture Learnings) for `adopt()` documentation.

**Deps:** R1.1

---

### R1.8 — Foldable device handling via `adopt()`

Research using `adopt()` to inject fold position/hinge dimensions into layout calculations for dual-screen devices (e.g., Surface Duo, Galaxy Fold). The native side detects the fold geometry and passes it through `adopt()` so the layout engine can split or reflow content around the hinge — synchronous with the Yoga layout pass.

See `docs/ARCHITECTURE.md` Section 9 (RN New Architecture Learnings) for `adopt()` documentation.

**Deps:** R1.1, F5.1 (Android)

---

### R1.9 — Fabric view flattening behavior verification

Verify exactly when and why Fabric flattens views inside a custom ShadowNode container. During Phase 3 testing, item Views with `backgroundColor` and `borderRadius` were unexpectedly flattened (90 subviews for 30 items), causing position mismatch. `collapsable={false}` fixed it.

**Open questions:**
1. Does Fabric's `isLayoutOnly()` behave differently for children of custom ShadowNode components vs standard View?
2. Does `backgroundColor` alone prevent flattening in all cases, or are there edge cases?
3. What is the exact performance cost of `collapsable={false}` per cell? (Extra UIView + CALayer overhead for the windowed cell count)
4. Is there a native-side equivalent to `collapsable={false}` that our ShadowNode/ComponentDescriptor could enforce automatically?
5. Can we use child ShadowNode tags in state as an alternative to preventing flattening?

**Goal:** Understand flattening rules definitively so we can make an informed architectural choice between preventing flattening (wrapper View) vs handling it (tag-based matching).

**Deps:** Phase 3 complete

---

### R1.10 — Horizontal variants of vertical layouts

**ListLayout horizontal: ✅ DONE** (`list({ horizontal: true })` — full feature parity with vertical: sticky headers/footers, section backgrounds, separators, insert/delete/resize, MVC, scrollToItem/scrollToOffset.)

Remaining layouts (Grid, Masonry, Flow):

**Scope per layout:**
- **GridLayout horizontal:** Rows × columns but scrolling horizontally — items fill top-to-bottom first, then wrap to the next column.
- **MasonryLayout horizontal:** Columns become rows — items pack into the shortest row. Rare but completeness.
- **FlowLayout horizontal:** Already partially horizontal (items flow left-to-right), but currently wraps to new rows vertically. Horizontal variant: items flow top-to-bottom, wrap to new columns when a column is full, scrolls horizontally.

**Implementation approach:** Each layout takes a `scrollDirection: 'vertical' | 'horizontal'` config. Internally, swap width↔height, x↔y in computation. Scroll offset correction needs to diff X positions instead of Y when horizontal.

**Also affects:**
- ShadowNode `computeOffsetCorrection` — must respect scroll axis (currently hardcoded to Y)
- F3.4 Orthogonal sections — these are inherently horizontal layouts embedded in vertical scroll

**Deps:** F3.1, F3.2, F3.5

---

### R1.11 — Insertion/removal behavior across all layout types

Test insertion, removal, and resize of items at various positions across all layout types to verify scroll offset correction and visual stability.

**Test matrix:**
- **Layouts:** List, Grid, Masonry, Flow, Carousel (custom), Radial Arc (custom)
- **Operations:** Insert at index 0, remove at index 0, resize item at index 0, insert in middle, remove in middle
- **Scroll positions:** At top (no correction needed), at middle (correction needed), near bottom
- **Correction behavior:** With `maintainVisibleContentPosition` on (default) and off

**Special considerations per layout:**
- **List/Grid:** Items Y-sorted — `break` optimization works in `computeOffsetCorrection`
- **Masonry:** Items interleave across columns, NOT strictly Y-sorted — `break` must be removed, iterate all items
- **Flow:** Similar to masonry — items wrap, not strictly Y-sorted within a row
- **Carousel (horizontal):** Correction on X axis, not Y
- **Radial Arc:** Scroll correction may not apply — items are positioned on a circle, not in a scrollable linear axis. Need to define what "maintain position" means for radial layouts, if anything.

**Goal:** Verify the correction algorithm is truly layout-agnostic, identify any layout-specific edge cases, and document which layouts need the `break` optimization removed.

**Deps:** ShadowNode Phase 4 (scroll offset correction), F3.1, F3.2, F3.5

---

### R1.12 — Proper Decoration Views (UICollectionView-style)

The current `renderSectionBackground` prop is a **consumer-injected** React component wrapped into
the ScrollView's `renderScrollView` slot. It is architecturally incorrect: the consumer is manually
positioning absolute Views inside the scroll container, computing section frames in JS, and injecting
them through a scroll container hook. This is a workaround, not a first-class feature.

**How UICollectionView decoration views actually work:**

UICollectionView decoration views are **layout artifacts** — they have no data source involvement
whatsoever. The layout owns them entirely:
1. Consumer calls `layout.register(MyView.self, forDecorationViewOfKind: "sectionBackground")`
2. Layout's `layoutAttributesForElements(in:)` returns decoration LayoutAttributes alongside cell attributes
3. UICollectionView creates/reuses the view automatically from the registered class
4. The view is positioned and z-ordered by the framework — the consumer never touches it

Key properties of true decoration views:
- **Registered on the layout**, not the collection view — layout decides when/where they appear
- **Identified by `elementKind` string** — arbitrary kinds, not just one "background" concept
- **No data** — layout provides frame, zIndex, alpha, transform. No `cellForItemAt`.
- **Layout-driven frame** — layout computes it from section geometry; consumer does not compute positions
- **Windowed by framework** — enter/leave render window like cells; not always mounted
- **Z-order** — typically `zIndex < 0` (behind cells), but configurable per kind
- **Examples:** section background, inter-item separator, grid rule line, watermark, floating section label, corner badge

**How the current `renderSectionBackground` differs:**

| | `renderSectionBackground` (current) | Proper decoration views |
|---|---|---|
| Who positions | Consumer computes JS frame, injects via `renderScrollView` | Layout writes LayoutAttributes; CV framework positions |
| Registration | Prop on CollectionView | `layout.registerDecoration(kind, Component)` |
| Arbitrary kinds | No — single "section background" concept | Yes — any `elementKind` string |
| Frame source | JS consumer | LayoutCache (written by layout engine) |
| Windowing | Not windowed — consumer decides mount | Same render-window lifecycle as cells |
| Z-order | Ad-hoc | `zIndex` field in LayoutAttributes |

**Design (to implement in F2.4 or a new F2.5):**

**LayoutCache changes:**
- `LayoutAttributes`: add `isDecoration: bool`, `decorationKind: string`
- Key convention: `deco-<kind>-<section>[-<index>]` — section-level or item-level decorations
- `getDecorationAttributes(kind, section)` / `getAllDecorations()` query methods

**Layout engine changes (ListLayout):**
- `sectionBackground` kind: emitted per section with frame = `{ x: 0, y: sectionTop, width: containerWidth, height: sectionHeight }` (full section rect including header, items, footer, insets). Opt-in: `showSectionBackground: true` on list config.
- `separator` kind: emitted between items. Frame = `{ x: separatorInset.left, y: itemBottom, width: contentWidth - insets, height: StyleSheet.hairlineWidth }`. Opt-in: `showSeparators: true`, `separatorInset: {left, right}`.
- Both emitted only when opted in — no overhead for consumers who don't use them.

**CollectionView render path:**
- New prop: `decorationRenderers: Record<string, (attrs: LayoutAttributes) => ReactElement>`
- CV reads all decoration attributes from LayoutCache (same JSI call as cells)
- Decorations rendered before cells in the React tree (natural z-order: decorations behind)
- Decorations participate in the same render window (evicted when far from viewport)
- Budget: separate from cell budget — default 40 (decorations are simple, lightweight)

**Consumer API:**
```typescript
// Register on layout config
const listLayout = list({
  estimatedItemHeight: 72,
  showSectionBackground: true,   // emits deco-background-<N> per section
  showSeparators: true,          // emits deco-separator-<N>-<i> between items
  separatorInset: { left: 16, right: 0 },
});

// Provide renderers on CollectionView
<CollectionView
  layout={listLayout}
  decorationRenderers={{
    sectionBackground: (attrs) => <AnimatedShimmer style={StyleSheet.absoluteFill} />,
    separator: (attrs) => <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: '#333' }} />,
  }}
/>
```

**Migration:** `renderSectionBackground` deprecated → replace with `decorationRenderers.sectionBackground`.
`DecorationsTab` and `ListDemo` updated to use the new API once implemented.

**Deps:** F2.1, M1.5 (multi-section layout), ShadowNode Phase 5 (positions from cache)

**✅ Critical bug fixed (2026-04-05): Universal tag-based native positioning**

Root cause confirmed via runtime logs: Fabric's reconciler "last index" optimization leaves native subview ordering inconsistent with ShadowNode child ordering when new children (separators) are inserted before existing non-moved children (section backgrounds). Index-based `positions[i] → subviews[i]` mapping applied wrong frames to wrong views.

Fix: `CollectionViewContainerState` now carries `std::vector<int32_t> childTags` parallel to `positions`. ShadowNode populates `childTags_[i] = children[i]->getTag()` for ALL children in Phase 1. Native `applyPositionsFromState` builds a `tag → UIView*` map and looks up by Fabric tag identity. Universal — covers items, decorations, and supplementaries. Protects against any future layout that generates the same insert-before-non-moved pattern.

Full analysis and design rationale in `docs/COLLECTIONVIEW_INTERNALS.md` → "Two-Layer Identity" section.

---

### R1.13 — scrollToItem with estimated heights (settling loop)

**Problem:** `scrollToItem` uses layout positions from LayoutCache. Before items are measured by Yoga, all positions are based on `estimatedItemHeight`. For items far from the visible viewport, the accumulated error is `(actualHeight - estimatedHeight) × numberOfItemsBefore`. For a list of 100 items with estimated 44px and actual 90px, the last item's estimated Y is ~4400px but its actual Y is ~9000px. The scroll lands 5000px short.

Two compounding issues:
1. `attrs.frame.y` from the cache is wrong (estimated, not measured)
2. `contentHeightRef.current` is also underestimated — the `maxY` clamp cuts the target too low

**Current behavior:** First scroll to bottom lands mid-list. After manually scrolling to the end (which triggers measurement of items), scrollTo works correctly because positions are now measured.

**Known approaches:**
- **Two-phase scroll:** After initial scroll, check `attrs.sizingState`. If not 'measured', schedule a `requestAnimationFrame` retry. Problem: convergence is undefined — retrying once may not be enough; depends on how many items are in the render window after the first scroll.
- **Settling loop:** After scrollToItem, set `_pendingScrollTarget`. On each `onScroll` event, check if the target item is at the expected viewport position. If not, re-scroll. Stop after N consecutive stable frames or max 10 retries. Problem: complex to implement correctly (handle concurrent scrolls, rapid multi-scrollTo calls, direction reversals).
- **Force-measure ahead:** Before scrolling far, trigger a virtual layout pass that uses actual measured heights for all items up to the target. Problem: requires items to be measured first, which requires render, which requires scroll.

**UICollectionView approach:** `scrollToItem(at:at:animated:)` in UICollectionView works correctly because the layout engine knows exact heights (via `UICollectionViewDelegateFlowLayout.sizeForItemAt` or `estimatedItemSize`). There is no re-scroll settling — estimates are trusted. For truly dynamic heights, UICollectionView uses `preferredLayoutAttributesFitting:` to self-size, and the layout invalidates+recalculates. The scroll works on the first attempt because the layout already has final heights by the time scroll is triggered (items are pre-measured in the layout pass).

**RN CollectionView parallel:** Our equivalent would be pre-computing the exact position by running `prepare()` with measured heights for all items up to the target before scrolling. This is only possible once Yoga has measured those items — which requires them to be in the render window. A proper solution may require: (a) a "measure ahead" API that renders items off-screen up to the target, (b) using the settling loop, or (c) accepting the limitation and documenting that scrollToItem is approximate until all items between viewport and target are measured.

**Deps:** F1.3 (prefetch callbacks), ShadowNode Phase 4+ (layout invalidation cascade).

---

## Phase DOC — Documentation _(→ BACKLOG.md B5)_

### DOC.1 — Solution document (HLD, LLD, optimizations)

Comprehensive technical document covering the entire implementation.

**Deliverable:** Solution document with:
- **High-Level Design (HLD):** Architecture overview, component relationships, data flow,
  platform strategy (iOS-first, Android port), technology choices and rationale
- **Low-Level Design (LLD):** C++ module internals (LayoutCache, ListLayout, SpatialIndex,
  WindowController), Fabric component (RNMeasuredCell), JS component (CollectionView.tsx),
  memory management, threading model
- **All optimizations:** Numbered list of every optimization applied, why it was needed,
  what it fixed, before/after impact (from JS optimizations #1–9 through P1–P3)
- **Design decisions log:** Key architectural decisions with alternatives considered,
  trade-offs, and reasoning (no-recycling, C++ vs TS layout, Activity API usage,
  dual-RN-instance workaround, YGMeasureFunc, etc.)
- **Problem-solving log:** All significant bugs/issues encountered, root cause analysis,
  and solutions (codegen pipeline, RCTThirdPartyComponentsProvider, Folly coroutine headers,
  slow init, phantom corrections, etc.)
- **Performance comparison:** FlashList vs CollectionView benchmark results and analysis

**Acceptance:**
- Complete, accurate, reviewable by someone unfamiliar with the project
- All design decisions and optimizations documented with rationale
- Can serve as onboarding material for new contributors

**Deps:** All prior milestones complete (or near-complete)

---

### DOC.2 — ShadowNode architecture writeup in ARCHITECTURE.md

Update `docs/ARCHITECTURE.md` with comprehensive ShadowNode documentation covering the full implementation journey (Phases 1-6).

**Deliverable:** New and updated sections in ARCHITECTURE.md:
- **ShadowNode measurement architecture** — how layout() reads Yoga, computes positions, delivers via ConcreteState. The full data flow diagram.
- **Progressive layout cache seeding** — estimatedItemHeight fallback → per-item estimates → Yoga actuals. Three-tier accuracy model. Incremental JSI writes. First-frame optimization.
- **Scroll offset correction** — the algorithm (find first visible item, detect above-viewport mutations, compute delta). Timing: correction after position application in layoutSubviews. The `_applyingCorrection` guard against feedback loops. `_lastCorrectedRevision` to prevent double-application.
- **Fabric view flattening** — why `collapsable={false}` is required on cell wrappers, what happens without it (subview count mismatch), why internal cell content still benefits from flattening.
- **Fabric view recycling** — `prepareForRecycle` pattern, what state must be reset, why `_hasReceivedFirstState` belt-and-suspenders exists.
- **Key problem-solving decisions** — why frame.origin over center/transform/multi-hook, why correction moved from updateState: to layoutSubviews, why measure range is still needed (ShadowNode only sees mounted children), the thread safety approach for shared layout cache.
- **What became redundant** — RNMeasuredCell, measuredHeightsRef, microtask flush, isVariableHeight, maintainVisibleContentPosition hack. Why each was originally needed and why the ShadowNode eliminates it.

**Acceptance:**
- Someone reading ARCHITECTURE.md understands the ShadowNode design end-to-end without needing project memory files
- All non-obvious decisions have rationale documented
- Learnings from Section 9 are integrated into the main narrative (not just appendix items)

**Deps:** ShadowNode Phase 6 (all phases complete)

---

## Execution Order

```
COMPLETED:  M0.1–M0.3 → M1.1–M1.5 → M2.1–M2.4 → M3.1–M3.5 → M4.1–M4.3
                                                                    ↓
PERFORMANCE:  P1.1 (C++ window ctrl) ✅ → P2.1 (YGMeasureFunc — INFEASIBLE, leaf-node constraint) ✗
              P3.1 (Activity-flip pre-render) ✅ + React.memo opt ✅ + startTransition audit ✅
                                                                    ↓
METRICS:      P5.1 (collection) → P5.2 (HUD) → P5.3 (traces)
              [needed to quantify everything that follows]
                                                                    ↓
FEATURES:     F1.1 (diff engine) ✅ → F1.2 (snapshot API) ✅ → F1.3 (prefetch) ✅
              F2.1 (supplementary) ✅ → F2.2 (sticky) ✅ → F2.3 (sticky push) ✅ → F2.4 (decorations) ✅
              F3.1 (grid C++) ✅ → F3.2 (masonry C++) ✅ → F3.5 (flow C++) ✅
              F3.3 (compositional) ✅ → F3.4 (orthogonal — superseded by H-2 sub-container) ✅
              F3.6 (compositional with intermixed special sections) → F3.7 (sub-container as public extension point)
              F4.1–F4.4 (state persistence + scroll restore)
              F5.1 (Android) → F5.2 (Web / React Native Web)
                                                                    ↓
MEMORY:       P4.1 (budget refinement) ✅ — os_proc_available_memory + UIApplicationDidReceiveMemoryWarning
                                                                    ↓
COMPARISON:   P6.1 ✅ (all 7 tabs: prefetch/sticky/deco/layouts/perf/resize/state)
              → P6.2 (device benchmarks on release build — only remaining for POC)
                                                                    ↓
RESEARCH:     R1.5 (JSI reload fix) → R1.1 (UICollectionView host) → R1.2 (virtual ShadowNode)
              R1.3 (layout protocol) ✅ → R1.4 (TS→C++ codegen)
              R1.6 (keyboard via adopt) → R1.7 (safe area via adopt) → R1.8 (foldable via adopt)
              R1.10 (horizontal layout variants) → R1.11 (insertion/removal across all layouts)
              R0.1–R0.5 (memory optimizations)
                                                                    ↓
DOCS:         DOC.1 (solution document) + DOC.2 (ShadowNode architecture writeup)
```

---

## Future Enhancements

### F-Flow.1 — Flow row justification

`justification?: 'leading' | 'center' | 'trailing' | 'spaceBetween' | 'spaceEvenly'` on `FlowLayoutDelegate`.

After computing each row, shift item X positions based on remaining horizontal space. ~20 lines in `computeSection`/`computeSectionFromCache`. No structural change to the bin-packing algorithm — justification is a post-pass over each completed row's items.

Current: leading-aligned only (same as UICollectionViewFlowLayout default).

### F-Flow.2 — Flow item weight/stretching

Items grow proportionally to fill row based on a per-item weight. Needs:
- `weightForItem?: (index, section) => number` on `FlowLayoutDelegate`
- Proportional width calculation: `item.width + (remainingSpace * weight / totalWeight)`
- Interacts with Yoga measurement — weight affects estimated width, which Yoga then refines
- Research needed before implementation

### F-Grid.1 — Grid row alignment

`rowAlignment?: 'top' | 'center' | 'bottom'` on `GridLayoutDelegate`.

Alignment of shorter items within a row when `heightForItem` produces uneven heights. 'top' (default) aligns all items to the row's top Y. 'center'/'bottom' offset shorter items downward. See `ethereal-seeking-willow.md`.

---

## Research Backlog

- [ ] **R1: Hexagonal architecture review** — Audit the current layout engine ↔ LayoutCache ↔ ShadowNode ↔ native view boundaries. Ensure we have clean ports/adapters: LayoutEngine protocol (contract-first), LayoutCache as the shared port, ShadowNode as a layout-agnostic consumer. Verify no layer reaches into another's internals. Document the contract boundaries.

- [ ] **Sticky supplementary view animations during MVC** — Section headers/footers that are actively sticking show a minor flicker during insert/delete mutations. Regular cells have LayoutAnimation support but supplementary views don't transition smoothly when their positions shift during MVC correction. Investigate adding LayoutAnimation or CATransaction-based animation for sticky view transform updates during mutations.

- [ ] **Opt E: ShadowNode short-circuit** — Skip Phases 1-3 in `correctChildPositionsIfNeeded()` when children and cache version are unchanged. Low impact: ShadowNode only runs on Fabric commits (child mount/unmount), not every scroll tick, and most commits during scroll *do* change positions. Only saves ~30-60μs on commits triggered by non-position reasons (e.g. prop-only re-renders). Implement after profiling shows unnecessary ShadowNode work.

- [ ] **Homepage/Storefront memory investigation** — Riff uses 62.5 MB (Homepage) and 72.3 MB (Storefront) vs FlashList's 78.8 / 50.2 MB. Storefront is the one screen where FlashList wins on memory. Likely causes: H-section mount/unmount churn, masonry S7 (60 items), per-type recycle pool overhead. Requires Instruments Allocations profiling on device — cannot diagnose from code alone.

### R2: Horizontal Grid — Fill Order (column-major vs row-major)

**Decision (2026-04-05):** Ship column-major only. Don't add a `fillOrder` prop now.

Column-major (`columns=3`): items fill top→bottom in a column-group, then advance right.
```
Col-group 0    Col-group 1    Col-group 2
Item 0         Item 3         Item 6
Item 1         Item 4         Item 7
Item 2         Item 5         Item 8
```

Row-major: items fill left→right across column-groups, then down.
```
Col-group 0    Col-group 1    Col-group 2
Item 0         Item 1         Item 2
Item 3         Item 4         Item 5
Item 6         Item 7         Item 8
```

**Reasons to defer row-major:**

1. **Column-major is the platform default** — UIKit, CSS grid with `grid-auto-flow: column`, all do this for horizontal scroll.
2. **Row-major for bounded data is really a flow layout use case** — the flow layout engine (which tiles items by fitting widths) already handles this more naturally.
3. **Adding it later is cheap** — it's just an index remapping (`columnGroup = i / cols, row = i % cols` vs `row = i % cols, columnGroup = i / cols`). No structural change needed. If a real use case surfaces, it's a one-line formula swap behind a prop.
4. **Avoids prop surface area** that needs testing for both orders × all features (separators, backgrounds, sticky, MVC).

### R1 Deep Dive: Frame Application Architecture — Option 1 vs Current Approach

#### Current Approach (State-Based Frame Override)

**How it works:**
1. Yoga runs layout on all children → computes child frames based on flexbox rules
2. ShadowNode `layout()` runs AFTER Yoga → reads Yoga-computed heights, reads LayoutCache for positions
3. ShadowNode computes corrected `[x,y,w,h,...]` positions using three-tier resolution
4. Positions stored in `CollectionViewContainerState.positions`
5. Fabric commits → native view receives state update
6. Native view's `layoutSubviews` calls `applyPositionsFromState:` → sets `child.frame` directly on UIViews

**The conflict:**
Fabric also sets child frames from `LayoutMetrics` (computed by Yoga). On each commit cycle, Fabric calls `updateLayoutMetrics:` on each child view, setting frames from Yoga results. Then our `layoutSubviews` fires and overwrites those frames with state-based positions. This works because:
- Our state update triggers `setNeedsLayout` → `layoutSubviews` runs after Fabric's frame application
- On scroll, state updates re-trigger the cycle

But it's fragile: Fabric "owns" the frame and we're fighting it every cycle.

**Frame-by-frame timeline (current):**

```
Frame N: Scroll event fires
  ├─ JS thread: scroll handler computes new render range
  ├─ JS thread: React reconciles → new children added/removed
  ├─ Fabric commit begins (background thread):
  │   ├─ ShadowNode cloned with new children
  │   ├─ Yoga runs layout → children get Yoga-computed frames
  │   │   (these frames are WRONG for our use case: Yoga stacks children
  │   │    vertically from 0, doesn't know about scroll offset or LayoutCache)
  │   ├─ ShadowNode::layout() runs AFTER Yoga:
  │   │   ├─ Reads Yoga heights (tier 1 measurement)
  │   │   ├─ Reads LayoutCache for position/size (tier 2)
  │   │   ├─ Falls back to estimatedItemHeight (tier 3)
  │   │   ├─ Computes corrected [x,y,w,h,...] positions
  │   │   ├─ Writes positions to state
  │   │   └─ Writes Yoga measurements back to LayoutCache
  │   └─ Fabric diff: detects state change → schedules mount
  │
  └─ Main thread (mount phase):
      ├─ Fabric applies LayoutMetrics to child UIViews
      │   → child.frame = Yoga-computed frame (WRONG positions)
      ├─ State update delivered → updateState: called
      ├─ setNeedsLayout → layoutSubviews fires
      └─ applyPositionsFromState: overwrites child.frame with CORRECT positions
         → For ONE frame, children may flash at Yoga positions before correction
         → In practice, this is usually invisible (same runloop)
```

**Risks:**
- Double frame set per commit (Yoga frame → our frame override)
- If Fabric ever batches layout differently or defers `layoutSubviews`, children flash at wrong positions
- Fabric's frame management is a black box we're working against, not with

---

#### Option 1: Pre-Yoga Position Injection (Ideal)

**How it would work:**
1. BEFORE Yoga runs, set position/size on each child's YGNode via `YGNodeStyleSetPosition()` and `YGNodeStyleSetWidth/Height()`
2. Yoga runs → computes layout with our positions baked in → `LayoutMetrics` are CORRECT
3. Fabric commits → native view receives correct frames automatically
4. No `applyPositionsFromState:` needed. No frame override. No conflict.

**The key insight:** Instead of correcting Yoga's output, we'd configure Yoga's input. The child YGNodes would have `position: absolute` with explicit `left`, `top`, `width`, `height` — Yoga respects these and produces the exact frames we want.

**Where positions come from (unchanged):**
- LayoutCache is still the source of truth
- Layout engines still write to LayoutCache
- Three-tier height resolution still applies
- ShadowNode still reads LayoutCache during `layout()`

**What changes:**
- ShadowNode reads LayoutCache BEFORE calling `ConcreteViewShadowNode::layout()` (i.e., before Yoga)
- For each child, sets YGNode style properties: `position: absolute`, `left: X`, `top: Y`, `width: W`, `height: H`
- Then calls parent `layout()` → Yoga produces correct LayoutMetrics
- No post-Yoga correction needed. No state-based positions. No native frame override.

**Frame-by-frame timeline (Option 1):**

```
Frame N: Scroll event fires
  ├─ JS thread: scroll handler computes new render range
  ├─ JS thread: React reconciles → new children added/removed
  ├─ Fabric commit begins (background thread):
  │   ├─ ShadowNode cloned with new children
  │   ├─ ShadowNode::layout() runs:
  │   │   ├─ BEFORE Yoga: reads LayoutCache for each child
  │   │   │   ├─ Gets frame (x, y, width, height) from cache
  │   │   │   ├─ Sets child YGNode: position=absolute, left=x, top=y, width=w, height=h
  │   │   │   └─ (Height uses three-tier: cache > estimate. Yoga measurement overrides later.)
  │   │   ├─ Calls ConcreteViewShadowNode::layout() → Yoga runs
  │   │   │   ├─ Yoga respects absolute positioning → LayoutMetrics are CORRECT
  │   │   │   ├─ For cells with content, Yoga measures actual height
  │   │   │   └─ LayoutMetrics.frame = exactly what we wanted
  │   │   ├─ AFTER Yoga: reads Yoga-measured heights (tier 1)
  │   │   │   ├─ Writes measurements back to LayoutCache
  │   │   │   └─ If height changed: update YGNode height? Or accept for next frame.
  │   │   └─ Computes contentSize, offset correction → updates state
  │   └─ Fabric diff: detects LayoutMetrics changes → schedules mount
  │
  └─ Main thread (mount phase):
      ├─ Fabric applies LayoutMetrics to child UIViews
      │   → child.frame = CORRECT positions (set by Yoga from our inputs)
      │   → No override needed. Fabric and us agree on the frame.
      └─ State update delivered (contentSize, correction only — no positions array)
         → Native view applies scroll offset correction if needed
         → No applyPositionsFromState: — frames are already correct
```

**Advantages:**
- Zero frame conflict — Fabric's frame management works FOR us, not against us
- Single frame set per commit (no double-write)
- No risk of flash at wrong position
- `applyPositionsFromState:` removed entirely
- `positions` vector removed from state (smaller state, fewer state updates)
- Native view simplified — only handles scroll container + offset correction

**Challenges / Open questions:**
1. **YGNode access:** Can ShadowNode access children's YGNodes before Yoga runs? `YogaLayoutableShadowNode` provides access via `yogaNode_`. Need to verify children's YGNodes are accessible and mutable at this point.
2. **Sealed children (again):** If children are shared/sealed on scroll, can we modify their YGNodes? This was the exact problem with `setLayoutMetrics()`. YGNode style setting may also require unsealed children.
3. **Yoga measurement conflict:** If we set explicit height on YGNode but Yoga measures a different height (from cell content), which wins? We want Yoga measurement to win (tier 1). May need to set height as `max-height` or use a measure func.
4. **Two-pass for measurement:** First mount: we set estimated height → Yoga measures actual → we write back to cache → NEXT frame uses correct height. This is the same as current approach but cleaner.
5. **Performance:** Setting YGNode properties per child per layout pass — any overhead vs current approach?

**Verdict:** Option 1 is architecturally cleaner but may hit the same sealed-children wall that killed adopt(). Worth a spike to verify YGNode mutability on shared children. If it works, it eliminates the frame-fighting entirely. If sealed children block it, the current state-based approach is the pragmatic fallback.

---

#### Comparison Table

| Aspect | Current (State Override) | Option 1 (Pre-Yoga Injection) |
|---|---|---|
| Frame source of truth | State → native override | Yoga LayoutMetrics (correct from start) |
| Frame sets per commit | 2 (Fabric + our override) | 1 (Fabric only) |
| Flash risk | Minimal (same runloop) but possible | None |
| State size | Large (positions array) | Small (contentSize + correction only) |
| Native view complexity | applyPositionsFromState + layoutSubviews | Scroll container + correction only |
| Sealed children risk | No (state-based, no child mutation) | Unknown — needs spike |
| Fabric compatibility | Works against Fabric | Works with Fabric |
| Implementation effort | Done (current) | Requires spike + potential refactor |
- [ ] **R2: LayoutEngine protocol formalization** — Define the `LayoutEngine` contract: `compute(context)`, `governedDimensions()`, `invalidate()`. Ensure C++ built-in layouts and JS custom layouts both conform. Clarify which dimensions each layout type governs vs leaves to Yoga.
- [ ] **R3: Visual attribute application path** — Decide how alpha, zIndex, transform3D, isHidden flow from LayoutCache → state → native view. Currently only frame is applied. Needed for animation, z-ordering, and fade effects.

## POC Checkpoints

| After | What you can show |
|---|---|
| M4.3 ✅ | Variable height, self-sizing, scroll correction — all working |
| P1.1 ✅ | C++ window controller — JS scroll path largely native |
| P3.1 ✅ | Pre-rendering at real position — Activity-flip approach (Fabric-internal APIs not accessible) |
| memo ✅ | React.memo on cell content — JS FPS 1→40-50fps on simulator |
| P2.1 ✗ | YGMeasureFunc infeasible — leaf-node constraint; M4.2 (layoutSubviews) is equivalent |
| P5.2 ✅ | Perf HUD — live FPS, blank area, cold mount rate, memory overlay |
| P4.1 ✅ | Memory budget — os_proc_available_memory, pressure levels, automatic budget reduction |
| F1.2 ✅ | Snapshot API — insert/delete/move with per-item animation, O(delta) reconciliation |
| F2.3 ✅ | Sticky headers, UICollectionView-style — one instance repositioned, no duplication |
| F3.3 ✅ | CompositionalLayout — list + grid + masonry + flow + H sections in one scroll view |
| F3.4 ✅ | Orthogonal sections — H-2 sub-container framework (`RNCollectionSubContainer`) |
| F3.6 | Compositional as flow-with-interludes — primary feed + special blocks at named anchors |
| F3.7 | Sub-container as public extension point — TS + C++ custom layouts via `setAttributesBatch` |
| F3.8 ✅ | Per-section + decoupled V/H windowing knobs — shipped as H-3.5 |
| F4.3 | State restoration — navigate away and back, exact position on frame 0 |
| P6.2 ✅ | **Full FlashList comparison on release build — the money shot** (Riff dominates Search; wins Min/p5 FPS + Active Mounts everywhere) |
| F5.1 | Android port — same C++ engine, cross-platform |
| DOC.1 | Complete solution document with all optimizations and design decisions |
