# Riff Architecture

Reference document for engineers joining the project. Covers current architecture and key decisions. For ShadowNode implementation details, see `plan_shadownode_phases.md` in project memory (Phases 1-3 complete, Phases 4-6 remaining).

---

## 1. Project Vision and Goals

Riff is a high-performance cross-platform collection view for React Native's New Architecture. It draws from UICollectionView (layout/data separation), AsyncDisplayKit/Texture (range-based windowing, async pre-rendering), and React 19 (Activity API for offscreen trees).

### What Riff does differently from FlashList

| Concern | FlashList | Riff |
|---|---|---|
| **Cell identity** | Recycling pool. Component remounts when scrolled back into view. State is lost. | Identity-based rendering. Component identity maps to item identity. State preserved across visibility changes. |
| **Layout engine** | Single layout: vertical/horizontal list with optional columns. | Pluggable layout protocol with four built-in engines (list, grid, masonry, flow) and a custom layout path. |
| **Layout computation** | JavaScript, on the JS thread. | C++ JSI engines for built-in layouts, running off the JS thread. TypeScript path available for custom layouts. |
| **Measurement correction** | `onLayout` (async, 2-frame gap) + `maintainVisibleContentPosition`. | Custom ShadowNode reads Yoga results in its `layout()` override, computes positions, and delivers them to the native view via `ConcreteState` — all in the same commit cycle (zero-frame correction). Phase 3 complete; remaining phases add scroll offset correction and sticky headers. |
| **Scroll container** | Owns a RecyclerListView-based scroll internally. Limited customization. | Three-layer pluggable scroll container: `scrollViewProps`, `ScrollViewComponent`, `renderScrollView`. |
| **Height handling** | Distinguishes "variable height" vs "fixed height" with separate code paths. | All heights are estimates. Single unified path: estimate, render, measure, correct. |

### Platform targets

iOS first. Android and web follow. The architecture is designed to support all three without rewrite (C++ core is cross-platform; web uses the TypeScript layout path).

---

## 2. Core Architecture

### Identity-based rendering

Every React component instance maps 1:1 to a data item. When a cell scrolls out of the render window, its component is unmounted. When it scrolls back in, a new component is mounted from scratch. There is no recycling pool.

This means:
- `useState`, `useRef`, and local component state are preserved while the cell is in the render window (including the hidden Activity tier).
- No `prepareForReuse`-style lifecycle. No type-based pooling.
- Memory cost scales with the render window size, not the full dataset.

Recycling/pooling is a future optimization path, not permanently excluded. The current design does not preclude it.

### Windowing model

Every item in the dataset is in exactly one tier at any time:

```
[  Data Window (prefetch)                                          ]
  [  Layout Window (pre-compute)                                ]
    [  Render Window (React tree mounted, visible)             ]
      [  Visible Window (painted, interactive)               ]
```

- **Layout Window** items have positions computed in `LayoutCache` (pre-computation), but no React component mounted. This is pure arithmetic, enabling fast spatial queries when items enter the render window.
- **Render Window** items have React components mounted and are `Activity mode="visible"`. They are positioned at their correct layout coordinates.
- **Visible Window** is the subset of the render window currently in the viewport (painted and interactive).

> **ShadowNode note (Phase 3 complete):** The ShadowNode reads Yoga-computed heights from children already in the render window during its `layout()` override — no separate measurement pass needed. The legacy **Measure Range** tier (cells mounted with `Activity mode="hidden"` at `top:-9999` solely for height measurement) is no longer required and will be removed in Phase 6 cleanup.

| Tier | Layout in cache | React component | Painted | Mechanism |
|---|---|---|---|---|
| Visible | Yes | Mounted | Yes | `Activity mode="visible"` |
| Render (non-visible) | Yes | Mounted | No | `Activity mode="visible"` (positioned correctly, outside viewport) |
| Layout | Yes | Not mounted | No | -- |
| Data | No | Not mounted | No | `onPrefetch` callback |
| Outside | No | Not mounted | No | -- |

The window is **asymmetric**, biased toward the scroll direction:

- Leading edge (direction of travel): `renderMultiplier * viewport` (default 3x)
- Trailing edge (behind scroll): `trailingMultiplier * viewport` (default 1x)
- On fast fling: leading window expands (up to +4 viewports), trailing edge collapses to 0.25x minimum.
- All multipliers are runtime-configurable from JS via `windowConfig`.

### Activity mode vs top:-9999 fallback

On RN 0.83+ (React 19.2), `<Activity mode="hidden">` keeps the fiber tree mounted in memory without painting:
- All `useState`, `useRef` state preserved.
- `useEffect` remains active. `useLayoutEffect` is skipped while hidden.
- React schedules hidden tree work at idle priority.
- Transition to `mode="visible"` re-attaches existing native views (sub-millisecond).

On RN 0.80.x (no Activity API), render-range and measure-range cells are positioned at `top: -9999` and rely on ScrollView clipping for visual hiding. Functionally equivalent but without React's priority scheduling for hidden trees.

**Critical detail:** `Activity mode="hidden"` is used only for **measure-range** cells (those beyond the render window, mounted solely for height measurement at `top:-9999`). All render-range cells use `mode="visible"`, regardless of whether they are currently in the viewport. Cells outside the render window (and outside the measure range, if present) are unmounted entirely. Post-ShadowNode, the measure range is removed and `Activity mode="hidden"` is no longer used.

### Layout protocol

The layout protocol is modeled after `UICollectionViewLayout`. All built-in and custom layouts implement the `CollectionViewLayout` interface:

```typescript
interface CollectionViewLayout {
  readonly type: string;
  prepare(context: LayoutContext): void;
  attributesForElements(inRect: Rect): LayoutAttributes[];
  attributesForItem(index: number, section: number): LayoutAttributes | null;
  attributesForSupplementary(kind: string, section: number): LayoutAttributes | null;
  contentSize(): Size;
  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean;
  invalidationScope?(oldBounds: Rect, newBounds: Rect): InvalidationScope;
  invalidateFrom?(key: string, context: LayoutContext): void;
}
```

The flow is query-driven:
1. `prepare(context)` — upfront computation. For C++ layouts, this calls into JSI. For TS layouts, runs in JS.
2. `attributesForElements(inRect)` — spatial query. Primary interface for the window controller. Returns attributes for items intersecting the given rect.
3. `contentSize()` — total scrollable area.
4. `shouldInvalidate(old, new)` — layout decides if a bounds change requires recomputation. Container width change: yes. Scroll-only: usually no.
5. `invalidateFrom(key, context)` — incremental invalidation when a cell's measured size differs from its estimate.

`LayoutContext` provides container dimensions, scroll offset, section metadata, and a `measuredHeightForItem` callback that returns actual Yoga-measured heights when available:

```typescript
interface LayoutContext {
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly scrollOffset: { x: number; y: number };
  readonly sections: readonly SectionInfo[];
  readonly measuredHeightForItem?: (index: number, section: number) => number | undefined;
}
```

### All heights are estimates

Every consumer-provided height is a best-effort estimate, regardless of how specific it is:

- `estimatedItemHeight` (global default) -- estimate
- `heightForItem(i, section, containerWidth)` (per-item callback) -- estimate
- `sizeForItem(i, section, containerWidth)` (per-item width+height) -- estimate

The only difference between these is **granularity**, not **certainty**. Yoga measurement is always the source of truth. There is no `isVariableHeight` flag. There is one unified path: estimate, render, measure, correct.

This means the layout engine always accepts measurement corrections. When a cell renders and its actual height differs from the estimate, the layout runs `invalidateFrom` to propagate the position delta to all downstream items.

---

## 3. Layout Engine Design

### Built-in layouts

Four layout engines ship with Riff, each backed by a C++ implementation callable via JSI:

**List** (`list()`) -- Single-column vertical layout. Supports fixed height, estimated height with per-item callbacks, multi-section with headers/footers, sticky headers, and incremental invalidation from a pivot point.

```typescript
layout={list({ estimatedItemHeight: 60, itemSpacing: 8 })}
layout={list({ heightForItem: (i, s, w) => heights[i], stickyMode: 'push' })}
```

**Grid** (`grid()`) -- Fixed columns, row-aligned heights. Items placed left-to-right in rows. Each row's height equals the tallest item in that row (or a fixed `rowHeight` if provided). Item width is derived: `(containerWidth - insets - spacing) / columns`.

```typescript
layout={grid({ columns: 3, rowHeight: 100, columnSpacing: 8, rowSpacing: 8 })}
layout={grid({ columns: 3, heightForItem: (i) => heights[i], columnSpacing: 8 })}
```

**Masonry** (`masonry()`) -- Fixed columns, variable-height items, shortest-column placement (Pinterest-style). `columns` and `heightForItem` are mandatory since masonry cannot work without both.

```typescript
layout={masonry({
  columns: 3,
  heightForItem: (index, section, containerWidth) => imageHeights[index],
  columnSpacing: 8,
  rowSpacing: 8,
})}
```

**Flow** (`flow()`) -- Dynamic columns based on item dimensions. Items pack left-to-right; when the next item does not fit in the remaining row width, it wraps to a new line. Row height equals the tallest item in that row. `sizeForItem` is mandatory since flow needs both width and height to determine line breaks.

```typescript
layout={flow({
  sizeForItem: (index) => ({ width: tagWidths[index], height: 32 }),
  itemSpacing: 6,
  lineSpacing: 8,
})}
```

### C++ JSI path

The standard interface is `CollectionViewLayout` (TypeScript). Every layout — built-in and custom — implements it. The C++ JSI methods are implementation details: each built-in layout's TS wrapper calls its specific JSI method inside `prepare()`. The collection view only ever talks to `CollectionViewLayout`; it has no knowledge of which methods are C++ vs TS.

```
┌─────────────────────────────────────────────────────────────┐
│  CollectionView (consumer)                                  │
│    uses: layout={list({ estimatedItemHeight: 60 })}         │
└──────────────────────┬──────────────────────────────────────┘
                       │ CollectionViewLayout interface
                       │ (prepare, attributesForElements, ...)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Layout Factory (list / grid / masonry / flow / custom)      │
│  Returns a CollectionViewLayout implementation                │
│                                                              │
│  Built-in: prepare() calls C++ JSI   Custom: prepare() runs │
│  method under the hood               pure TypeScript         │
└──────────┬───────────────────────────────────┬───────────────┘
           │ JSI call                          │ JSI write
           ▼                                   ▼
┌──────────────────────────────────────────────────────────────┐
│  C++ Layer                                                   │
│  ┌──────────────┐  ┌──────────────────────────────────────┐  │
│  │ Layout Engine │  │ LayoutCache (shared, mutex-guarded)  │  │
│  │ (ListLayout,  │──▶ Stores LayoutAttributes per item     │  │
│  │  GridLayout,  │  │ Spatial index for rect queries       │  │
│  │  etc.)        │  └──────────────────────────────────────┘  │
│  └──────────────┘                                            │
└──────────────────────────────────────────────────────────────┘
```

Each built-in layout has a C++ implementation in the `cpp/layouts/` directory:

| C++ class | JSI method | Key operations |
|---|---|---|
| `ListLayout` | `computeListLayout`, `invalidateListLayoutFrom`, `computeSections`, `invalidateSectionsFrom` | Full O(n) compute, partial O(n-pivot) invalidation, multi-section |
| `GridLayout` | `computeGridLayout` | Row-aligned placement with column count |
| `MasonryLayout` | `computeMasonryLayout` | Shortest-column placement |
| `FlowLayout` | `computeFlowLayout` | Line-breaking placement |

All layout engines are pure functions: they take parameters and write `LayoutAttributes` into the shared `LayoutCache`. No retained state. Safe to call from any thread (the `LayoutCache` is mutex-guarded).

The `LayoutCache` (`cpp/LayoutCache.h`) is the single source of truth for all positional data:
- Stores `LayoutAttributes` per item key (frame, sizingState, tier, zIndex, `isDecoration`, `decorationKind`, etc.)
- `getAttributesInRect(rect)` spatial query backed by a `SpatialIndex`
- Thread-safe: all public methods acquire a mutex
- Versioned: monotonic counter increments on every write, enabling staleness detection without content comparison

**Layout fingerprinting:** JS layout delegates build a data-shape fingerprint (containerWidth + per-section item counts, header/footer heights, decoration flags). The cache is cleared and fully recomputed only when the fingerprint changes. Between renders, incremental `invalidateFrom` / `invalidateSectionsFrom` is used instead. This preserves Yoga-measured heights across measurement-triggered re-renders — a key correctness invariant.

### TypeScript path for custom layouts

Custom layouts implement the `CollectionViewLayout` interface in TypeScript. The TS path is permanent, not a fallback:
- Custom layouts written by product teams must be OTA-updatable.
- Web platform has no C++ JSI; TS is the only option there.
- On iOS/Android in production, TS custom layouts write into the C++ `LayoutCache` via JSI for spatial query performance.

### Layout configs

Each built-in layout accepts a configuration object (the options argument to its factory function). These are plain data objects, not UIKit-style delegates — they fit React's declarative model: `layout={list({ estimatedItemHeight: 60 })}`.

| Config | Key fields | Notes |
|---|---|---|
| `ListLayoutDelegate` | `itemHeight`, `estimatedItemHeight`, `heightForItem`, `itemSpacing`, `sectionSpacing`, `stickyMode`, header/footer sizing, `separator`, `sectionBackground` | Sizing: provide one of `itemHeight` / `estimatedItemHeight` / `heightForItem`. `sectionSpacing` = gap between sections (outside bg frame). `separator` = layout-driven inter-item separator. `sectionBackground = true` emits a bg decoration. |
| `GridLayoutDelegate` | `columns` (mandatory), `rowHeight` or `heightForItem`, `columnSpacing`, `rowSpacing` | `columns` can be `number` or `(containerWidth) => number` for responsive grids |
| `MasonryLayoutDelegate` | `columns` (mandatory), `heightForItem` (mandatory), `columnSpacing`, `rowSpacing` | Both mandatory: masonry is meaningless without column count and variable heights |
| `FlowLayoutDelegate` | `sizeForItem` (mandatory), `itemSpacing`, `lineSpacing` | Returns `{ width, height }` per item |

All configs support responsive variants: `columns`, `rowHeight`, and `itemHeight` accept functions of `containerWidth`.

### Consumer API tiers

The component supports three tiers of complexity:

- **Tier 1:** Simple props on `CollectionView` (`data`, `renderItem`, `itemHeight`). Default list layout.
- **Tier 2:** Layout config via factory functions (`list()`, `masonry()`, `grid()`, `flow()`).
- **Tier 3:** Full `sections` array with supplementary items, custom layout config, section backgrounds.

### Stable Keys End-to-End

Stable item identity flows from JS to C++ to the LayoutCache:

1. **Consumer** provides `keyExtractor` (same as FlatList). For sectioned mode, the section key is the `SectionConfig.key`.
2. **CollectionView.tsx** builds `itemKeys: string[]` per section and passes them in `LayoutContext.sections[s].itemKeys`.
3. **JS layout wrapper** (`list.ts`) passes `keys: itemKeys` to C++ `computeSections()`.
4. **C++ ListLayout** stores each item under its provided key instead of the positional `"item-{section}-{index}"` default.
5. **Cache key format for scrollToItem:** `"sectionKey:itemId"` (e.g. `"cell-animation:s1-17"`).

**Why stable keys matter:**
- Incremental `invalidateFrom` / `invalidateSectionsFrom` works correctly when data reorders — the layout engine finds the item by key, not position.
- `scrollToItem` accepts stable keys, not indices. This means the consumer never needs to know the current index of an item; the key is permanent.
- Without `keyExtractor`, positional keys are used (`item-0-3`, `grid-5`, etc.). Reordering without keys causes the layout cache to see the same key at a different position, which is incorrect and leads to layout artifacts.

For Grid/Masonry/Flow, keys follow the pattern `"grid-N"` / `"masonry-N"` / `"flow-N"` when no `keyExtractor` is provided. Stable keys are supported but multi-section is not yet available for these layouts.

### Decoration Views

Layout-driven views that belong to the layout engine, not to data. The layout emits `LayoutAttributes` with `isDecoration: true` and `decorationKind: string`. They are windowed, z-ordered, and positioned like cells — but have no React data binding.

**Built-in kinds (ListLayout):**
- `"sectionBackground"` — covers the items area of a section (after header, before footer). `zIndex: -1`, so it renders behind cells.
- `"separator"` — a thin horizontal line between consecutive items. `zIndex: 0`. Configurable height, leading/trailing inset.

**UIKit inspiration:** The section background behavior matches `NSCollectionLayoutDecorationItem.background` in `UICollectionViewCompositionalLayout` — it covers the section's content area (items + content insets), not the boundary supplementaries (header/footer). This is the expected behavior from a UIKit perspective: headers/footers float above the background in the Z stack, while the background decorates the content region.

**Why not include header/footer in the background:** Compositional layout's `NSCollectionLayoutDecorationItem` explicitly excludes boundary supplementaries. Riff follows the same convention. A future `contentInsets` API (L3.1) will allow extending the bg frame with negative insets to cover headers/footers if desired.

**Consumer API:**
```typescript
list({
  separator: { color: '#ccc', height: 0.5, insetLeading: 16 },
  sectionBackground: true,
  sectionSpacing: 20,
})

// On <CollectionView>:
decorationRenderers={{
  sectionBackground: (sectionIndex, frame) => <AnimatedBg sectionIndex={sectionIndex} frame={frame} />,
}}
```

**applyMeasurements and decorations:** When Yoga measures a cell and its height differs from the estimate, `applyMeasurements()` cascades Y-position shifts to all downstream items. Decorations use a shift-based second pass: the section background's Y origin and height are adjusted by tracking `entryShift` (cumulative shift before the section's first item) and `exitShift` (cumulative shift after the section's last item). This preserves the original `sectionInsetTop`/`sectionInsetBottom` padding in the bg frame even after measurement corrections. Decorations are excluded from MVC anchor selection (`_snapshotAnchorLocked` skips entries where `isDecoration == true`).

---

## 4. Scroll Container Design

### Three-layer pluggable system

The scroll container is not hardcoded. Three layers of customization, from simplest to most powerful:

**Layer 1: `scrollViewProps`** -- A passthrough property bag forwarded directly to the underlying ScrollView. No maintenance burden: as RN adds new ScrollView props, they work automatically.

```typescript
<Riff
  scrollViewProps={{
    bounces: false,
    showsVerticalScrollIndicator: false,
    onMomentumScrollEnd: handleEnd,
  }}
/>
```

**Layer 2: `ScrollViewComponent`** -- Swap the scroll view class entirely. Use this for gesture-handler-based scroll views, Reanimated scroll views, or custom scroll implementations.

```typescript
<Riff ScrollViewComponent={Animated.ScrollView} />
```

**Layer 3: `renderScrollView`** -- Full render control. The consumer receives the scroll content as children and wraps it in whatever scroll container they want.

```typescript
<Riff renderScrollView={({ children, ...props }) => (
  <CustomScrollContainer {...props}>{children}</CustomScrollContainer>
)} />
```

### scrollToItem / scrollToOffset (L4)

Imperative scroll API exposed via `RiffHandle`:

```typescript
cvRef.current?.scrollToItem('sectionKey:itemId', { position: 'top' | 'center' | 'bottom' | 'nearest' });
cvRef.current?.scrollToOffset({ x: 0, y: 400 }, { animated: true });
```

**3-layer dispatch architecture:**
1. JS reads the item's frame from `LayoutCache` using the stable key.
2. Computes target offset for the requested `position` option, clamped to `[0, contentHeight - viewportHeight]`.
3. Calls C++ JSI `nativeMod.scrollTo({ x, y, animated })`.
4. C++ looks up the native scroll handler registered for this `layoutCacheId` and calls `_scrollToX:y:animated:` directly on the `UIScrollView`.

**Scroll handler registry:** A static `std::map<int, ScrollHandler>` + mutex in `CollectionViewModule.cpp` decouples JSI from the native view lifecycle. The native `RNCollectionViewContainerView` registers its handler on first state update and unregisters in `prepareForRecycle`. This handles Fabric view recycling: a recycled view with a new `layoutCacheId` re-registers at the correct key.

**`contentHeightRef` pattern:** `useImperativeHandle` deps do not include `contentHeight` (adding it would recreate the handle on every layout pass). Instead, a `contentHeightRef` mirrors the state value — same pattern used for `viewportHeightRef`. The scroll computation reads the ref, not the closure-captured value.

**Key stability:** `scrollToItem` accepts the same stable `"sectionKey:itemId"` key format that the layout engine stores. No index translation needed.

### Native scroll ownership

`RNCollectionViewContainerView` owns the scroll container natively — the native `UIView` internally creates and manages a `UIScrollView`. This eliminates the scroll offset roundtrip (native UIScrollView -> JS onScroll -> prop back to native). The three-layer customization system (Section 4 above) is preserved: the consumer-injected ScrollView becomes a child of the native component, and the native view finds and delegates to it.

---

## 5. Performance Design

### C++ JSI layout engines

Built-in layouts run in C++ via JSI. Benchmark results on iOS (10,000 items, estimated heights 50-300px):

| Operation | C++ | TypeScript | Ratio |
|---|---|---|---|
| `computeListLayout` (estimated) | 7.89ms | 14.09ms | C++ 1.8x faster |
| `invalidateFrom` (tail 5,000) | 3.87ms | 12.24ms | C++ 3.2x faster |
| `getAttributesInRect` (390x844) | 2.54ms | 4.42ms | C++ 1.7x faster |
| `getAll` (10,000 items) | 23.80ms | 1.09ms | TS 22x faster (JSI marshal cost) |

The scroll-frame hot path is `getAttributesInRect` (returns ~15-30 items). Neither path calls `getAll` on a scroll frame.

### Window controller

The `WindowController` (`cpp/WindowController.h`) is a stateless C++ class with pure arithmetic functions:

- **Fixed-height mode:** O(1) division to compute render and visible index ranges from scroll position.
- **Variable-height mode:** O(log n) binary search on a positions array.
- **Velocity-aware:** Each 1 px/ms of scroll speed adds 1 additional viewport on the leading edge (capped at +4). Trailing edge shrinks to 0.25x minimum.
- **Budget constraint:** `applyBudget()` trims the render range to fit within `mountedWindowSize` viewport-multiples, anchored around the visible area.
- **Measure range:** Extends the budgeted render range by a configurable number of items in both directions for pre-measurement.

All methods are sub-microsecond. No allocations, no locks.

### Activity mode for offscreen cell suspension

All cells in the render window use `<Activity mode="visible">`, regardless of whether they are currently in the viewport. In the pre-ShadowNode POC, a separate measure range existed where cells used `<Activity mode="hidden">` solely for Yoga measurement. With the ShadowNode implementation (Phase 3 complete), the measure range is eliminated — the ShadowNode reads Yoga heights from render-window children during `layout()`, so `Activity mode="hidden"` is no longer used.

### No Reanimated dependency in core

The window controller is C++ JSI, not a Reanimated worklet. Consumers can use Reanimated for scroll animations via `ScrollViewComponent={Animated.ScrollView}`, but the core library has no Reanimated dependency.

---

## 6. Compatibility Strategy

### Primary target: RN 0.83.4 (React 19.2)

Full Activity API. Exclusively New Architecture. All features available.

### Must support: RN 0.80.x

Core Fabric ShadowNode APIs (`ConcreteViewShadowNode`, `layout()` override, `ConcreteState`) have been stable since Fabric's introduction (0.68+) and are confirmed working in Riff's ShadowNode implementation (Phase 3). The only 0.83-specific API is Activity.

**Activity fallback:** On pre-0.83, measure-range cells are positioned at `top: -9999` instead of using `Activity mode="hidden"`. Functionally equivalent for hiding, but without React's idle-priority scheduling for hidden tree work.

### iOS minimum deployment target: 15.1

---

## 7. Key Decisions Log

### Identity-based rendering over cell recycling

**Decision:** Component identity maps to item identity. No recycling pool.

**Alternatives considered:** FlashList-style type-based recycling with `prepareForReuse`.

**Why:** Recycling adds complexity (state management on reuse, type classification, pool sizing) and conflicts with React's component model (components should not need to handle external state resets). Identity-based rendering is simpler, matches React semantics, and avoids an entire class of bugs (stale state after reuse, wrong type reuse). The Activity API makes the cost acceptable: hidden trees have near-zero CPU/GPU cost. Recycling remains a future optimization path if memory pressure demands it.

### C++ layout engines over pure JavaScript

**Decision:** Built-in layouts are computed in C++ via JSI.

**Alternatives considered:** Pure TypeScript layout engines (the TS path exists and works).

**Why:** Layout computation happens on every data change and every measurement correction. C++ is 1.8-3.2x faster on the hot paths (compute, invalidate) and runs off the JS thread, avoiding contention with React rendering. The TS path is preserved for custom layouts and web.

### All heights are estimates (no isVariableHeight)

**Decision:** Every consumer-provided height/dimension is treated as a best-effort estimate. No separate code paths for "fixed" vs "variable" height.

**Alternatives considered:** An `isVariableHeight` flag that enables/disables measurement correction.

**Why:** In practice, even "fixed" heights can be wrong (dynamic text, accessibility font scaling, orientation changes). Maintaining two code paths doubles testing surface and creates subtle bugs when the wrong path is active. One path -- estimate, render, measure, correct -- handles all cases. The layout engine always accepts measurement corrections.

### ShadowNode for measurement correction (Phase 3 complete)

**Decision:** A custom Fabric ShadowNode reads Yoga-computed child heights in its `layout()` override, computing positions and delivering them to the native view via `ConcreteState` — all in the same Fabric commit cycle. This eliminates the native-to-JS-to-native roundtrip for measurement feedback.

**Alternatives considered:** Continue using async `onLayout` / `onMeasured` events with `maintainVisibleContentPosition`.

**Why:** The async path has a 2-frame gap between Yoga measurement and position correction. Users see a visible jump when cells are first measured. FlashList has the same limitation. The ShadowNode approach reads measurements in the same commit cycle, enabling correct positions from frame 1.

**Status:** Phases 1-4 implemented and working. The ShadowNode reads child heights, runs the layout engine, writes position arrays into state, and applies MVC scroll offset correction to keep visible content stable when items above the viewport change height. Remaining: Phase 5 (sticky headers via ShadowNode), Phase 6 (legacy cleanup — remove JS cell wrapper positioning).

### Approach A: ShadowNode owns scroll container

**Decision:** The `CollectionViewShadowNode` is the top-level component. Its native view (`RNCollectionViewComponentView`) internally creates and manages a `UIScrollView`.

**Alternatives considered:** Approach B -- ShadowNode as a child of a JS-managed ScrollView.

**Why initially chose B:** Simpler initial implementation; existing ScrollView handles scroll natively.

**Why reversed to A:** The ShadowNode needs the scroll offset for offset corrections and sticky header positioning. With Approach B, scroll offset flows: native UIScrollView -> JS onScroll -> prop to ShadowNode. This is the same native-to-JS-to-native roundtrip the ShadowNode is designed to eliminate. With Approach A, the native view reads scroll offset directly from its internal UIScrollView via the scroll delegate -- no JS hop. Additionally, the API is more natural: the collection view IS the scrollable thing, not a child of one.

### scrollViewProps bag over direct scroll props

**Decision:** Scroll configuration is passed via `scrollViewProps={{ bounces, onScroll, ... }}`, not as direct props on Riff.

**Alternatives considered:** Mirror every ScrollView prop directly on the Riff component.

**Why:** ScrollView has dozens of props, and RN adds more over time. Mirroring them creates a maintenance burden and version coupling. The passthrough bag auto-scales: any new ScrollView prop works immediately without a Riff release. Only collection-view-specific props (like `maintainVisibleContentPosition` for offset correction) live directly on Riff.

### Scroll offset correction is opt-in

**Decision:** `maintainVisibleContentPosition` prop, default `true`. When items above the viewport change height, the scroll offset is adjusted so visible content stays stable.

**Alternatives considered:** Always-on, no opt-out.

**Why:** Chat interfaces and some custom scroll anchoring strategies need to control scroll position themselves. Providing an opt-out avoids fighting with the consumer.

### Layout protocol as the unified layout interface

**Decision:** All layouts -- built-in and custom -- implement the same `CollectionViewLayout` interface.

**Alternatives considered:** Built-in layouts use an internal fast path; custom layouts use a separate, simpler API.

**Why:** A single interface means the window controller, measurement correction, and cell positioning code have one path to maintain. Built-in layouts get their speed from C++ implementations behind the interface, not from a separate interface. Custom layouts get the same spatial query, invalidation, and measurement correction infrastructure for free.

---

## 8. Future Work

These are upcoming architectural pieces. Design details live in project memory files; this section is pointers only.

- **Custom ShadowNode for zero-frame measurement (Phases 1-4 complete)** -- The ShadowNode reads Yoga-computed child heights in its `layout()` override, computes positions via the C++ layout engine, delivers position arrays to the native view via `ConcreteState`, and applies MVC scroll offset correction — all in the same Fabric commit cycle. Phase 5 (sticky headers via ShadowNode) and Phase 6 (JS cell wrapper cleanup) remain. Full plan in `plan_shadownode_phases.md`. State contract in `arch_state_contract.md`.

- **View pooling / recycling** -- Future optimization for memory-constrained scenarios. Not architecturally excluded; the current identity-based approach is the default, not the only option.

- **Android support** -- C++ core is cross-platform. Native view layer (`ComponentView`) needs an Android equivalent. Layout engines, `LayoutCache`, and `WindowController` are ready.

- **Animated list mutations** -- Insert/delete with spring/fade animations. Requires a separate design pass.

- **2D simultaneous scrolling** -- Spreadsheet/canvas use cases. The architecture is prepared: window controller speaks `Rect` not `Range`, layout cache uses rect-intersection queries, scroll engine tracks both axes. Enabling 2D means lifting constraints, not rewriting. See REQUIREMENTS.md section 3.5.

- **Web platform** -- TypeScript layout path handles computation. C++ modules need WASM equivalents. Phase 3.

---

## 9. RN New Architecture Learnings

Hard-won implementation knowledge about React Native Fabric internals. These details are not well-documented in the official RN sources and are captured here for future contributors.

### 1. ComponentDescriptor::adopt() — Pre-layout Hook

`adopt()` on the `ComponentDescriptor` is called every time a ShadowNode is created or cloned, **before** Yoga layout runs. It is the correct place to inject native-only information into the Yoga tree that affects layout.

**How it works:**
- Fabric calls `adopt(shadowNode)` after constructing or cloning a ShadowNode, before the Yoga layout pass.
- Inside `adopt()`, you cast to `YogaLayoutableShadowNode` and call mutation methods like `setPadding()`, `setSize()`, `setPositionType()`.
- These mutations affect the Yoga node directly, so the next layout pass incorporates the native values.

**Real-world example:** `SafeAreaViewComponentDescriptor::adopt()` reads safe area insets from `ConcreteState` and calls `layoutableShadowNode.setPadding(stateData.padding)` to set Yoga padding from native-detected insets.

**RN source reference:** `react/renderer/components/safeareaview/SafeAreaViewComponentDescriptor.h`

### 2. Fabric's updateLayoutMetrics: Uses center+bounds, Not frame

Fabric sets native view geometry via `self.center` and `self.bounds`, **not** `self.frame`.

**Why:** Setting `frame` when `layer.transform` is not identity is undefined behavior in UIKit. Using center+bounds avoids this.

**Source:** `UIView+ComponentViewProtocol.mm` -> `updateLayoutMetrics:oldLayoutMetrics:`

**Implication:** Any native code that overrides child positions must be aware that Fabric will reset `center` and `bounds` on every layout commit. Setting `frame` directly may be silently overwritten or produce incorrect results when transforms are present.

### 3. Fabric Mutation Ordering

`RCTPerformMountInstructions()` processes all mutations synchronously on the main thread in a single pass.

**INSERT sequence per view:**
1. `updateProps:`
2. `updateState:`
3. `updateLayoutMetrics:`
4. `finalizeUpdates:`
5. `mountChildComponentView:index:` (called on the parent)

**UPDATE sequence per view:**
1. Conditionally `updateProps:` / `updateState:` / `updateLayoutMetrics:` (only if that aspect changed)
2. `finalizeUpdates:` (only if at least one update was applied)

**Key details:**
- `finalizeUpdates:` receives a bitmask (`RNComponentViewUpdateMask`) indicating which updates were applied in this commit (props, state, layoutMetrics, or any combination).
- Parent UPDATE mutations may come before or after child UPDATE mutations in the same commit. Do not assume ordering between parent and child updates.

### 4. ShadowNode Sealed Assertion

Children accessed via `getLayoutableChildNodes()` may be **sealed** (shared from a previous commit) during scroll-triggered state updates.

**Why:** Only the directly-affected ShadowNode is cloned during a state update. Siblings and children are shared references to the previous tree's nodes.

**Consequence:** Calling `setLayoutMetrics()` on a shared (sealed) child triggers an `ensureUnsealed()` assertion crash. You cannot mutate children you did not clone.

**Safe pattern:** Calling `setStateData()` on the **current** ShadowNode during `layout()` is safe and expected. This is the standard pattern used by `ScrollViewShadowNode` to communicate content size.

### 5. setStateData() During layout()

`setStateData()` called during `layout()` updates the state of the current commit's ShadowNode. It does **not** trigger a new commit or a new layout pass.

**The layout-to-state flow:**
1. `layout()` override runs, reads Yoga results from children
2. `layout()` calls `setStateData(newState)` on `self`
3. The native view receives the updated state via `updateState:` in the same commit

This is how `ScrollViewShadowNode` communicates computed content size to the native `UIScrollView` without a JS roundtrip. The state written in `layout()` is delivered to the native view in the same Fabric commit cycle.

### 6. Dual react-native Registry Trap

When a monorepo has both a library package and an example app, importing native component specs from the library's `src/specs/` directory in example app code may resolve to the **library's** copy of `react-native` instead of the example app's copy.

**Symptom:** `"View config getter callback must be a function (received undefined)"` — silent wrong-registry registration.

**Root cause:** The library's `node_modules/react-native` and the example app's `node_modules/react-native` are different installations. Native component registration happens in the `react-native` instance that the spec file resolves to. If the spec resolves the library's `react-native`, the component is registered in a registry the app never checks.

**Fix:** Create re-export wrappers in `example/components/` that import the spec and re-export it. These wrappers resolve `react-native` from the example app's `node_modules`.

### 7. Native-Side Position Override Challenge

Overriding child view positions from native code is non-trivial because Fabric's `updateLayoutMetrics:` resets child frames (center/bounds) based on Yoga results every commit.

**What gets overwritten:**
- Direct changes to `center`, `bounds`, or `frame` on child views are reset when Fabric processes the next layout commit.
- This includes changes made in `updateState:`, `finalizeUpdates:`, or `layoutSubviews`.

**What persists:**
- `CGAffineTransform` (set via `transform` property) is independent of Fabric's frame management. Transforms persist across Fabric layout updates.
- This makes transform-based positioning a viable strategy for native-side overrides.

**Timing:** `layoutSubviews` runs during `CATransaction` commit, **after** all Fabric mutations in `RCTPerformMountInstructions()` complete. This makes it a valid place to apply post-Fabric position adjustments, though they will be overwritten on the next Fabric commit that includes layout changes for those children.

### 8. Fabric View Flattening and Custom Containers

Fabric's view flattening optimization removes intermediate UIViews that are "layout-only" and mounts their children as direct subviews of the nearest non-flattened ancestor, with absolute positions. This means a custom container component that overrides `mountChildComponentView:` may receive mount calls for grandchildren and deeper descendants — not just direct React children. The `_contentView.subviews.count` can be much larger than the ShadowNode's `getLayoutableChildNodes().size()`.

**Consequence:** Position arrays computed in the ShadowNode (one entry per direct child) cannot be applied by iterating `_contentView.subviews` by index — the indices don't match.

**Fix:** Wrap each cell in a View with `collapsable={false}` to prevent flattening at that level. Internal cell content still benefits from flattening normally. This is analogous to UICollectionViewCell — a concrete view that contains user content.

### 9. Fabric View Recycling (Component View Pool)

Fabric maintains a **component view pool** (`RCTComponentViewFactory`) that recycles native view instances. When React unmounts a component and later mounts a new instance of the same type, Fabric may hand back the **same native UIView instance** instead of creating a new one.

**Impact for custom views:**
- `initWithFrame:` is only called once per view instance, not once per React mount.
- Internal state (scroll offsets, cached data, flags) persists across React mount/unmount cycles unless explicitly reset.
- Fabric calls `prepareForRecycle` before returning a view to the pool — this is where custom views must clear their state.

**Our approach:**
- `RNCollectionViewContainerView` implements `prepareForRecycle` to reset `_state`, `_hasReceivedFirstState`, scroll offset, and content size.
- A `_hasReceivedFirstState` flag ensures scroll offset is reset to zero on the first state update after (re-)mount, even if `prepareForRecycle` wasn't called.

**Symptom that exposed this:** UIScrollView retained its `contentOffset` between navigations — scrolling down, going back, and re-entering showed the list mid-scroll instead of at the top.
