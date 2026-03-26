# RNCollectionView — Requirements Specification

> A cross-platform, high-performance list/collection view for React Native New Architecture.
> Inspired by UICollectionView (layout/data separation), AsyncDisplayKit/Texture (async pre-rendering,
> range-based windowing), and React 18 (concurrent rendering, offscreen trees).

---

## 1. Goals

- **Render only what is necessary.** Never render cells outside the visible + render window.
- **Pre-compute everything possible.** Layout, size, position — computed ahead of scroll, not during.
- **Never block the scroll thread.** All JS work is decoupled from the native scroll event path.
- **React-native state model.** No cell recycling. Component identity maps to item identity, always.
- **Layout is a first-class, separable concern.** Decoupled from cell content, cacheable, parallelizable.
- **Memory pressure is a first-class concern.** The view responds to system memory warnings in tiers.
- **React concurrent rendering is native, not bolted on.**
- **Platform targets:** iOS (first), Android, Web.
- **Logic is native; configuration is JS.** C++ modules implement logic but hold no hardcoded tuning
  values. Every configurable parameter — window sizes, velocity factors, budgets, pressure thresholds —
  originates from the JS/RN layer and is passed into native at runtime. Tuning is always OTA-updatable
  even when the logic that uses those values is not.

## 2. Non-Goals (v1)

- Drag-to-reorder (can be layered on top)
- Pull-to-refresh (consumer responsibility via wrapping)
- Animated list mutations (v2)
- **Simultaneous free-scroll on both axes** (spreadsheet, infinite canvas) — see §3.5 for how v1 architecture is designed to not block this

---

## 3. Core Architecture

### 3.1 Four-Tier Window Model

Directly derived from ASRangeController. Every item in the data set is in exactly one tier at any time.

```
[  Data Window (fetch)                                          ]
  [  Layout Window (pre-compute)                             ]
    [  Render Window (React tree mounted, Activity hidden)  ]
      [  Visible Window (painted, interactive)             ]
```

| Tier | What exists | What doesn't exist |
|---|---|---|
| **Visible** | Native view, painted, events active | — |
| **Render** | React tree mounted via `<Activity hidden>`, layout cached | Native view painted |
| **Layout** | Layout attributes cached (size, position, z-index) | React tree |
| **Data** | Data prefetch triggered | Layout computed |
| **Outside** | Nothing | Everything |

**Key invariants:**
- Moving from Data → Layout: pure computation, no React involvement, background thread safe.
- Moving from Layout → Render: React renders into `<Activity hidden>` (no paint, no layout pass cost).
- Moving from Render → Visible: flip `hidden` flag. No mount, no render, near-zero cost.
- Moving inward is cheap. Moving outward (eviction) is tiered and gradual.

**`<Activity>` behavior in this model:**
React 18's `<Activity mode="hidden">` keeps the fiber tree fully mounted in memory:
- All `useState`, `useRef`, `useContext`, `useReducer` state is preserved exactly as last seen.
- `useEffect` is NOT cleaned up — subscriptions, timers, intervals remain active.
- `useLayoutEffect` is **skipped** while hidden — it only runs when the tree is visible.
- React schedules all work on hidden Activity trees at lowest priority (idle), so pre-rendering
  never competes with visible content for the JS thread.
- Native Fabric side: shadow nodes exist and are laid out, but native views are detached from
  the visible view hierarchy (no backing store, no GPU memory for the hidden content).
- Transition to `mode="visible"`: Fabric re-attaches existing native views. No reconciliation,
  no remount. Cost is approximately one compositor commit — sub-millisecond.
- Beyond the render window, `<Activity>` is **removed** from the React tree entirely. The fiber
  unmounts, `useEffect` cleanups run, state is lost. This is a "cold" cell.
- The Activity budget (§7.2) caps how many hidden trees exist before cold eviction begins.

### 3.2 Directional Asymmetry

The window is **not symmetric around the viewport**. It is biased toward the scroll direction.

```
Scroll direction: DOWN

trailing edge (behind):   [ 1× viewport ]
leading edge (ahead):     [ 3× viewport ]
```

- Window sizes are dynamic, driven by **scroll velocity**.
- At rest → tight window (save memory).
- Slow scroll → moderate leading window.
- Fast fling → large leading window, trailing edge collapses aggressively.
- Direction reversal → window flips within one frame (via UI-thread worklet).

The window controller runs on the **UI thread** (Reanimated worklet or native C++ module) so it is never blocked by JS work.

### 3.3 Layout / Content Separation

Mirroring UICollectionView's layout object architecture.

```
CollectionLayout (abstract)
  ├── ListLayout          — single-axis, vertical or horizontal
  ├── GridLayout          — equal or weighted columns/rows
  ├── MasonryLayout       — variable height, column-packing
  ├── CompositionalLayout — sections, each with independent layout
  └── CustomLayout        — user-provided layout function
```

**A layout object takes:**
- Item size hints (from `sizingStrategy`, see §5)
- Section descriptors (count, header, footer, gaps)
- Viewport dimensions

**A layout object produces:**
- `LayoutAttributes[]` — `{ key, frame: Rect, zIndex, section, isSupplementary }`
- These are **pure values** — no React, no native views involved.
- Layout is computed on a **background thread** (JS worker or C++ JSI module).
- Layout results are stored in `LayoutCache` (see §6.1).

### 3.4 Data / Layout / View Separation (Full Stack)

```
DataSource → (item keys + size hints) → LayoutEngine → LayoutCache
                                                            ↓
                                                    WindowController
                                                            ↓
                                              React Renderer (Activity trees)
                                                            ↓
                                                    Fabric / Native Views
```

These layers communicate **unidirectionally**. The data source never touches views. The layout engine never touches the React tree. The window controller never calls the data source directly.

### 3.5 2D Scroll Architecture Preparedness

The v1 component scrolls in one axis only (vertical list or horizontal list). However, **true 2D
simultaneous scrolling** (spreadsheet, infinite canvas, map tiles) must not require an architectural
rewrite. The following constraints are enforced in v1 to keep the door open:

**What "2D simultaneous scrolling" actually means:**
- Both `scrollX` and `scrollY` are non-zero and change simultaneously as the user pans.
- Virtualization must happen in *both* dimensions — cells outside the 2D visible rect are unmounted,
  not just cells above/below.
- A large spreadsheet might have 1000 columns × 10000 rows. A 1D range [startIndex, endIndex]
  is meaningless — the visible set is a 2D rect intersection.

**v1 constraints that prevent a rewrite:**

1. **Window controller speaks `Rect`, not `Range`.**
   The window controller's input and output types are `Rect` (x, y, width, height) in scroll-view
   coordinates. In v1, `x` is always `0` and `width` is always `viewportWidth` — but the *type*
   is a rect. Enabling 2D in v2 means letting `x` and `width` vary. The worklet logic doesn't change.

   ```typescript
   // ✅ Right — works for both 1D and 2D
   visibleRect: Rect

   // ❌ Wrong — encodes 1D assumption, requires rewrite for 2D
   visibleRange: { startIndex: number, endIndex: number }
   ```

2. **Layout cache uses rect-intersection query as its primary interface.**
   ```typescript
   getAttributesInRect(rect: Rect): LayoutAttributes[]
   ```
   The underlying data structure in v1 can be a column-bucketed array (since `x` is fixed),
   but the *interface* is rect-intersection. In v2, swap the backing structure for a spatial
   index (R-tree or grid bucket on both axes) without changing callers.

3. **Scroll engine tracks both axes from day 1.**
   ```typescript
   scrollX: SharedValue<number>      // always 0 in v1, but declared
   scrollY: SharedValue<number>
   scrollVelocityX: SharedValue<number>
   scrollVelocityY: SharedValue<number>
   ```
   The window controller worklet is a pure function of all four values.
   In v1, `scrollX` and `scrollVelocityX` are always 0 — the worklet is correct by degeneration.

4. **`scrollToKey` not `scrollToIndex`.**
   A 2D cell has no meaningful flat index. Key → `LayoutAttributes.frame` → scroll to bring
   that `Rect` into view works in both 1D and 2D. Index-based addressing is permanently excluded.

5. **Layout attributes already have `frame: Rect` with `x` and `y`.**
   No change needed to `LayoutAttributes` for 2D. Layout objects already emit 2D positions —
   `GridLayout` and `MasonryLayout` already do this in v1 (they are 2D in layout space, just
   with a fixed-width scroll container).

**What v2 actually adds (not a rewrite, just lifting constraints):**
- Enable `scrollX` on the native scroll view (remove the axis lock)
- Replace the 1D spatial index backing `getAttributesInRect` with an R-tree
- Expose `scrollVelocityX` in the window controller to bias window expansion horizontally
- Add `ColumnLayout` / `SpreadsheetLayout` layout objects

---

## 4. Scroll Engine

### 4.1 Scroll is Native-Owned

- The scroll view is a native component (UIScrollView on iOS).
- Scroll position is **never driven by JS**. JS only *observes* scroll position.
- Scroll events are delivered to the UI thread worklet **first**, then optionally forwarded to JS.
- The window controller reacts to scroll position changes on the UI thread without a JS round-trip.
- The scroll view is **pluggable** — the consumer controls which component is used and all its props.

### 4.2 Pluggable Scroll View

Three layers of customization, in increasing order of control:

**Layer 1 — Extra props on the default scroll view:**
```typescript
<CollectionView
  scrollViewProps={{
    bounces: false,
    decelerationRate: 'fast',
    showsVerticalScrollIndicator: false,
    contentInset: { top: 0, bottom: 80, left: 0, right: 0 },
    // any prop the underlying ScrollView accepts
  }}
/>
```

**Layer 2 — Swap the component type:**
The replacement receives all contract props (§4.3) merged with `scrollViewProps`.
Must be an `Animated.createAnimatedComponent`-wrapped component or already animated,
because the `onScroll` contract prop is a Reanimated animated event handler.

```typescript
import Animated from 'react-native-reanimated'
import { ScrollView as GHScrollView } from 'react-native-gesture-handler'

const AnimatedGHScrollView = Animated.createAnimatedComponent(GHScrollView)

<CollectionView
  ScrollViewComponent={AnimatedGHScrollView}
  scrollViewProps={{ waitFor: panRef }}
/>
```

**Layer 3 — Full render control:**
Receives all contract props to spread. Overrides Layers 1 and 2 when provided.
Consumer is responsible for spreading every contract prop — omitting any breaks
window management, sizing, or imperative scroll control.

```typescript
<CollectionView
  renderScrollView={(contractProps) => (
    <Animated.ScrollView
      {...contractProps}
      decelerationRate={0.997}
      onScrollBeginDrag={(e) => {
        contractProps.onScrollBeginDrag?.(e)  // always call through
        analytics.track('drag_start')
      }}
    />
  )}
/>
```

**Precedence:** `renderScrollView` > `ScrollViewComponent` + `scrollViewProps` > defaults.

### 4.3 ScrollView Contract

The interface any replacement scroll view must satisfy. Event names and payload shapes
are **identical to UIScrollView delegate methods and React Native's ScrollView** — no
invented names, no remapped shapes.

```typescript
/**
 * Props injected by CollectionView into the scroll view component.
 * These must not be overridden; user-supplied scrollViewProps are merged
 * BEFORE contract props so contract props always win.
 */
interface CollectionScrollViewContractProps {
  // ── Layout & sizing ───────────────────────────────────────────────────────
  ref: React.Ref<ScrollViewImperativeHandle>
  style: StyleProp<ViewStyle>
  contentContainerStyle: StyleProp<ViewStyle>  // sets scroll content size
  onLayout: (event: LayoutChangeEvent) => void  // viewport size measurement
  onContentSizeChange: (width: number, height: number) => void

  // ── Scroll events — mirrors UIScrollViewDelegate exactly ──────────────────
  onScroll: AnimatedScrollHandler  // Reanimated animated handler, UI thread
  scrollEventThrottle: number      // always 1 (every frame) for window controller accuracy

  // User finger down, list has velocity from drag — UIScrollViewDelegate:scrollViewWillBeginDragging
  onScrollBeginDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void

  // User finger up — UIScrollViewDelegate:scrollViewWillEndDragging / didEndDragging
  onScrollEndDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void

  // Deceleration begins after finger up — UIScrollViewDelegate:scrollViewWillBeginDecelerating
  onMomentumScrollBegin: (event: NativeSyntheticEvent<NativeScrollEvent>) => void

  // Deceleration ends, list fully stopped — UIScrollViewDelegate:scrollViewDidEndDecelerating
  onMomentumScrollEnd: (event: NativeSyntheticEvent<NativeScrollEvent>) => void

  // iOS: scroll-to-top via status bar tap — UIScrollViewDelegate:scrollViewDidScrollToTop
  onScrollToTop?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void

  children: React.ReactNode
}

/**
 * Imperative handle the scroll view ref must expose.
 * Mirrors RN ScrollView's own imperative API.
 */
interface ScrollViewImperativeHandle {
  scrollTo(options: { x?: number; y?: number; animated?: boolean }): void
  scrollToEnd(options?: { animated?: boolean }): void
  flashScrollIndicators(): void
  // For 2D-ready axis locking (§3.5):
  setScrollEnabled(enabled: boolean): void
}
```

**Event passthrough rule:** CollectionView wraps every contract event to do its own
bookkeeping first, then calls the consumer's handler from `scrollViewProps` (or
`renderScrollView`'s inline handler). The consumer always receives the same event.

```typescript
// Internal implementation pattern:
const handleMomentumScrollEnd = useCallback((event) => {
  // 1. CollectionView internal: collapse trailing window, etc.
  windowController.onDecelEnd(event.nativeEvent.contentOffset)
  // 2. Consumer passthrough — never skipped
  scrollViewProps?.onMomentumScrollEnd?.(event)
}, [scrollViewProps?.onMomentumScrollEnd])
```

### 4.4 Internal Shared Values (UI Thread)

Populated by the animated `onScroll` handler; these are what the window controller
worklet reads. Not part of the public API but documented for custom scroll integrations.

```typescript
// Populated from contractProps.onScroll (Reanimated animated handler)
scrollX: SharedValue<number>
scrollY: SharedValue<number>
scrollVelocityX: SharedValue<number>
scrollVelocityY: SharedValue<number>
scrollDirection: SharedValue<'forward' | 'backward' | 'idle'>
isDecelerating: SharedValue<boolean>
isDragging: SharedValue<boolean>
```

**Advanced:** For consumers who manage scroll position externally (e.g., gesture-driven
infinite canvas), these can be injected directly, bypassing `onScroll` entirely:

```typescript
<CollectionView
  externalScrollPosition={{
    x: myScrollX,      // SharedValue<number>
    y: myScrollY,      // SharedValue<number>
  }}
  // CollectionView will not attach its own onScroll handler;
  // consumers must still render their own scroll container.
  renderScrollView={(contractProps) => (
    <MyGestureScrollContainer
      onContentSizeChange={contractProps.onContentSizeChange}
      onLayout={contractProps.onLayout}
      ref={contractProps.ref}
    >
      {contractProps.children}
    </MyGestureScrollContainer>
  )}
/>
```

### 4.5 Velocity-Aware Window Sizing

```
renderWindowSize = baseRenderMultiplier × viewport
                 + velocityFactor × |scrollVelocity|

velocityFactor: tunable (default: 0.5 viewport per 1000px/s)
cap: maxRenderWindow (default: 8× viewport, memory-gated)
```

---

## 5. Sizing Strategy

One of the hardest problems in any list. Must be explicitly modeled with four strategies:

### 5.1 `fixed`
All items have the same size. Known upfront, zero measurement cost. Enables O(1) scroll-to-index.

### 5.2 `estimated(value)`
A hint is provided. Layout uses estimate, then **corrects in place** without scroll position drift.
- Correction uses a `positionAdjustment` applied as a native scroll view content offset delta.
- Scroll position is preserved; the list does not "jump". (This is the fix FlashList doesn't have.)

### 5.3 `measured`
React renders the cell into an off-screen `<Activity>` first. Size is measured via synchronous JSI call (Fabric allows this). Layout cache is updated. Cell becomes visible.
- Measurement happens at Layout-tier entry, before Render-tier.
- Uses a dedicated offscreen measurement container (not the list's scroll view).

### 5.4 `selfSizing` (per-cell)
Cell component calls `useCellSize({ width, height })` hook to report its own intrinsic size.
- Analogous to UICollectionView `preferredLayoutAttributesFitting`.
- Triggers a layout cache update and a local position correction.

---

## 6. Layout Cache

The source of truth for all positional data.

### 6.1 Structure

```typescript
interface LayoutAttributes {
  key: string              // item key
  section: number
  index: number            // within section
  frame: Rect              // { x, y, width, height } in scroll-view coordinate space
  zIndex: number
  isSupplementary: boolean // header, footer, decoration
  layoutVersion: number    // invalidated on data change
  isDirty: boolean
  sizingState: 'estimated' | 'measured' | 'fixed' | 'selfSized'
}

interface LayoutCache {
  attributes: Map<string, LayoutAttributes>
  sectionOffsets: number[]   // absolute Y of each section start
  totalContentSize: Size
  version: number
}
```

### 6.2 Invalidation

- **Partial invalidation**: only affected items + all subsequent items are re-laid-out.
- Items before the changed item are never re-laid-out (their absolute positions don't change).
- Analogous to `UICollectionViewLayoutInvalidationContext` with `invalidateItems(at:)`.
- Layout invalidation is debounced and batched; multiple data changes in one frame = one layout pass.

### 6.3 Accurate scroll-to-index

Because all absolute positions are in `LayoutCache`, `scrollToIndex(index)` is **exact** — even for items that have never been rendered, as long as they are in the Layout tier or beyond.

For items in the Data tier (not yet laid out), a progressive layout pass is triggered before the scroll is executed.

---

## 7. Memory Management

### 7.1 Tiered Eviction

On memory pressure (low, moderate, critical), cascade down the tiers:

| Pressure | Action |
|---|---|
| Low | Collapse Data window. Stop prefetching. |
| Moderate | Collapse Render window. Unmount `<Activity>` trees outside 1.5× viewport. |
| Critical | Collapse to visible window only. Evict all Layout cache entries outside 1.2×. |
| App backgrounded | Keep only visible window. Serialize layout cache to disk (optional). |

### 7.2 Activity Tree Budget

- Render-tier `<Activity hidden>` trees are capped at a configurable count (default: 40 cells).
- LRU eviction: least-recently-visible cells are unmounted first when budget is hit.
- Budget is separate from memory pressure — it is a baseline cap.

### 7.3 Layout Cache Persistence (optional)
- Layout cache can be serialized to `AsyncStorage` / `MMKV`.
- On cold start, pre-populate Layout tier from cache, avoiding first-scroll blank areas.
- Cache is keyed by data hash + viewport width + layout config hash.

---

## 8. Data Layer

### 8.1 Data Source Protocol

```typescript
interface CollectionDataSource<T> {
  // Required
  sections: Section<T>[]

  // Item identity — must be stable across re-renders
  keyExtractor: (item: T, index: number, section: number) => string

  // Size hint for layout pre-computation (before measurement)
  sizeHint?: (item: T) => SizeHint   // { width?, height?, aspectRatio? }

  // Prefetch trigger — called when item enters Data tier
  onPrefetch?: (keys: string[]) => void

  // Called when items leave all tiers (fully evicted)
  onEvict?: (keys: string[]) => void
}
```

### 8.2 Diffing

- Data updates go through a **diff engine** before reaching the layout cache.
- Diff is performed on a background thread (key-based, O(n) Myers diff or identity comparison).
- Output: `{ inserted, removed, moved, updated }` patch set.
- Layout cache applies patch: inserts/removes trigger partial invalidation; moves/updates may not.
- React receives the patch as a state update via `startTransition` — non-urgent, interruptible.

### 8.3 Snapshot Updates

Inspired by `NSDiffableDataSourceSnapshot`. Consumers can do:

```typescript
const snapshot = list.snapshot()
snapshot.appendItems(newItems, toSection: 0)
snapshot.deleteItems(staleKeys)
snapshot.moveItem(fromKey, afterKey)
list.applySnapshot(snapshot, animating: false)
```

This is the primary mutation API. Direct index-based mutations are not supported (they are error-prone and layout-cache-hostile).

---

## 9. React / New Architecture Integration

### 9.1 Adaptive Render/Visible Tier — `CellContainer`

The render tier and visible tier are managed by a single `CellContainer` component that
adapts its behaviour based on whether the `<Activity>` API is available at runtime.

**RN 0.83+ / React 19.2 — full Activity path:**
- Render-tier cells: `<Activity mode="hidden">` — fiber alive, paint skipped, `useLayoutEffect`
  **not** called, React scheduler treats as idle priority.
- Visible-tier cells: `<Activity mode="visible">` — zero-cost flip, no reconciliation.
- React is explicitly aware of the hidden/visible distinction at the scheduler level.

**RN new arch < 0.83 — scroll-clip degradation path:**
- Both render-tier and visible-tier cells are simply **mounted at their absolute positions**
  in the scroll view's content area.
- The scroll view's own viewport clipping makes off-screen cells visually invisible at zero cost
  — no `display:none`, no opacity, no special React primitive required.
- React sees no distinction between render-tier and visible-tier cells; both are just "mounted".
- The C++ window controller still tracks both tiers identically — it controls when components
  mount and unmount. Only the React rendering layer collapses the two tiers.
- `useLayoutEffect` fires for all render-window cells (slightly more measurement work, not incorrect).
- Pre-rendering priority: `startTransition` (a hint) rather than guaranteed idle.

**Detection (once at module load):**
```typescript
import * as React from 'react'

// Activity is stable in React 19.2 (import { Activity } from 'react')
const ActivityComponent: React.ComponentType<{ mode: 'visible' | 'hidden'; children: React.ReactNode }> | null =
  typeof (React as any).Activity === 'function'
    ? (React as any).Activity
    : null

export const isActivityAvailable = ActivityComponent !== null
```

**`CellContainer` implementation:**
```typescript
function CellContainer({ tier, frame, renderItem }) {
  const content = <AbsoluteCell frame={frame}>{renderItem()}</AbsoluteCell>

  if (!ActivityComponent) {
    // Degraded: mount for both render and visible tiers
    // ScrollView viewport clipping handles visual hiding
    return content
  }

  // Full: React scheduler-aware hidden/visible
  return (
    <ActivityComponent mode={tier === 'visible' ? 'visible' : 'hidden'}>
      {content}
    </ActivityComponent>
  )
}
```

**Behaviour comparison:**

| | With Activity (RN 0.83+) | Without Activity (new arch < 0.83) |
|---|---|---|
| C++ window controller | identical | identical |
| Cells outside render window | unmounted | unmounted |
| Render-tier cells | Activity hidden — React idles | Mounted — ScrollView clips |
| Visible transition cost | mode flip — ~zero | Already mounted — zero |
| `useLayoutEffect` off-screen | skipped | fires (not incorrect) |
| Scheduler priority | idle guarantee | `startTransition` hint |
| Native view created for render-tier | deferred | created (slightly more memory) |

### 9.2 `startTransition` for All Data Updates

- All list data mutations are wrapped in `startTransition`.
- Urgent: scroll position, window boundary updates (on UI thread, not React).
- Non-urgent (transitioned): cell content updates, new data, layout recalculation.
- This ensures scroll is never jank-inducing due to a large data update.

### 9.3 Suspense in Cells

- Cells can use `Suspense` natively.
- The list renders a `fallback` cell (configurable skeleton) while the cell's data resolves.
- This is safe because cells are not recycled — the Suspense boundary belongs to the item key.

### 9.4 Concurrent Layout Pre-Rendering

- Cells entering the Render tier are rendered via `startTransition` with a low priority.
- The scheduler can interrupt this pre-rendering if scroll events or user interactions arrive.
- Pre-rendering resumes when the thread is idle.

### 9.5 Fabric / JSI Layout Measurement

- Cell measurement (§5.3 `measured` strategy) uses synchronous Fabric measurement.
- `measureInWindow` equivalent via JSI, called synchronously in a `runOnJS` context.
- No async round-trip needed — this was impossible in old arch.

---

## 10. Compositional Layout

Modeled on UICollectionView Compositional Layout but expressed as a JS/TS layout spec.

### 10.1 Concepts

```
CompositionalLayout
  └── Section[]
        ├── orthogonalScrolling: boolean  // horizontal carousel inside vertical list
        ├── header: SupplementaryItem?
        ├── footer: SupplementaryItem?
        ├── group: Group
        │     ├── ListGroup   — items stacked in scroll direction
        │     ├── GridGroup   — items in fixed columns
        │     └── CustomGroup — user layout function
        └── decoration: DecorationItem?   // background, separator — not data-bound
```

### 10.2 Orthogonal Sections

- A section marked `orthogonalScrolling: true` is itself a horizontally-scrolling list.
- It has its **own** window controller, layout cache, and scroll engine instance.
- It participates in the parent list's Layout tier (its height contributes to parent scroll content size).
- Memory management: an orthogonal section outside the parent's Render tier is fully unmounted.

### 10.3 Supplementary Views

Modeled on UICollectionView's supplementary view system. Supplementary views are
**registered by kind** (any string), dequeued by the layout, and positioned via layout
attributes — not hardcoded to "header" and "footer".

```typescript
// Register any kind
layout.register('section-header', SectionHeaderComponent)
layout.register('section-footer', SectionFooterComponent)
layout.register('badge', BadgeComponent)              // custom kind
layout.register('section-background', BgComponent)    // decoration kind
```

**Built-in kinds (v1):**
- `"section-header"` — top of section
- `"section-footer"` — bottom of section
- `"global-header"` — above all sections, outside scroll content (fixed to top of component)
- `"global-footer"` — below all sections

**Supplementary view data binding:**
```typescript
dataSource.supplementaryData = (kind, section) => ({
  title: sections[section].title,
  count: sections[section].items.length,
})
```
Supplementary views receive data independently of cell data. They are in the same
4-tier window as cells — they enter Layout tier, Render tier, Visible tier — but have
their own Activity budget (not deducted from cell budget).

### 10.4 Sticky Supplementary Views

Stickiness is a **layout engine concern**, not a scroll event concern.
The sticky position is computed in the C++ layout engine every scroll frame,
not in JS. This means sticky positioning is never a frame behind scroll.

**Correct UICollectionView push behavior (v1 requirement):**

The push behavior is what distinguishes a correct sticky implementation:
```
While section N is visible:
  header N sticks at y = 0 (top of viewport)

As section N+1's header approaches:
  header N's sticky position = min(
    0,                                        // normal sticky
    headerN1.frame.origin.y - headerHeight    // pushed up by next header
  )
  → header N slides upward, pushed by the incoming header
  → at the moment header N+1 reaches y=0, header N is fully gone

Scrolling back up:
  header N returns from top as section N re-enters viewport
```

This requires the layout engine to compute header positions as a function of
scroll offset — not a static `position: sticky`. It is updated every scroll frame
via the C++ window controller.

**Sticky kinds scope (v1):**
- `"section-header"` — sticky at top, push behavior as above
- `"section-footer"` — optional sticky at bottom of section
- `"global-header"` — always pinned at top (above sticky section headers)

**Not in v1:** arbitrary sticky positions, sticky at fixed Y offsets, multiple concurrent
sticky views of the same kind within one section.

### 10.5 Decoration Views

- Data-free. Placed by the layout object, not the data source.
- Examples: rounded card background per section, row separators, section dividers.
- Positioned in layout space alongside cells and supplementaries.
- Not in Activity budget (simpler static native views, not React components).
- Registered by kind, same API as supplementary views but no data binding:

```typescript
layout.registerDecoration('section-card', SectionCardView)
// Layout positions it to span the section's frame
```

### 10.6 Compositional Layout — Examples

**Example 1 — App Store Today tab:**
```
Section 0: full-width featured card          ListGroup, fixed height: 400
Section 1: horizontal app carousel           orthogonalScrolling: true
                                             ListGroup (horizontal), itemWidth: 80
Section 2: "Top Charts" 2-col grid           GridGroup, columns: 2
Section 3: editorial article                 ListGroup, selfSizing
Section 4: "Categories" 3-col grid           GridGroup, columns: 3
```

**Example 2 — Instagram Explore (irregular grid):**
```
Section 0: stories                           orthogonalScrolling: true, itemWidth: 72
Section 1: explore grid
  CustomGroup repeating pattern:
    item A: fractionalWidth: 2/3, fractionalHeight: 2/3   ← large
    item B: fractionalWidth: 1/3, fractionalHeight: 1/3   ← small
    item C: fractionalWidth: 1/3, fractionalHeight: 1/3   ← small (stacked on B)
```
The irregular grid is a `CustomGroup` with a layout function — not a special component.
The same `renderItem` renders all cells; only their sizes differ.

**Example 3 — Spotify Home:**
```
Section 0: "Recently played"                 orthogonalScrolling: true
                                             GridGroup, rows: 2, itemWidth: 160
Section 1: "Recommended radio"               header: { height: 44, sticky: true }
                                             orthogonalScrolling: true
Section 2: full-width banner                 ListGroup, fixed height: 200, no header
Section 3: "Your shows"                      header: { height: 44, sticky: true }
                                             orthogonalScrolling: true
                                             contentInset.right: 32  ← peek next item
```

**Example 4 — Settings (grouped, card sections):**
```
Section N: grouped settings items            ListGroup, selfSizing
           decoration: "section-card"        → rounded card bg behind entire section
           section-header: label             → plain text above card
           section-footer: description       → plain text below card
```
Swapping from a flat list to grouped card appearance = swapping the decoration
registration + layout insets. `renderItem` doesn't change.

**Example 5 — News feed (mixed content):**
```
Section 0: promoted banner                   fixed height: 120
Section 1: tweet thread                      selfSizing per item, section-header sticky
Section 2: "You might like"                  section-header sticky
           profile cards                     ListGroup, selfSizing
```

**Key insight across all examples:** `renderItem` is unchanged. Layout drives
the visual structure entirely. Same data source, same cell — completely different
appearance by swapping the layout object.

---

## 11. Developer API

### 11.1 Core Component

```typescript
<CollectionView
  // Data
  dataSource={dataSource}

  // Layout
  layout={new ListLayout({ estimatedItemHeight: 72 })}
  // or
  layout={new CompositionalLayout({ sections: [...] })}

  // Cell rendering
  renderItem={({ item, section, index }) => <MyCell item={item} />}
  renderSectionHeader={({ section }) => <SectionHeader section={section} />}

  // Window config (optional, defaults tuned for most cases)
  // All values passed into C++ window controller at runtime — OTA-updatable
  windowConfig={{
    // ── Window size multipliers (× viewport height) ──────────────────────
    renderMultiplier: 3,        // cells pre-mounted ahead of scroll position
    trailingMultiplier: 1,      // cells kept mounted behind scroll position
    layoutMultiplier: 8,        // layout-only zone (no React tree, C++ cache only)
    dataMultiplier: 12,         // data prefetch zone (triggers onPrefetch)

    // ── Velocity-adaptive sizing ──────────────────────────────────────────
    // renderWindow leading edge expands as: renderMultiplier + velocityScaleFactor × |v|/1000
    velocityScaleFactor: 0.5,   // viewport expansion per 1000 px/s of scroll velocity
    maxWindowMultiplier: 8,     // absolute cap on render window regardless of velocity

    // ── Cell budget (memory) ──────────────────────────────────────────────
    mountedCellBudget: 40,      // max simultaneously mounted cells (LRU eviction beyond this)
    supplementaryBudget: 20,    // separate budget for supplementary views

    // ── Memory pressure overrides ─────────────────────────────────────────
    // Each level collapses the render window inward to save memory.
    // Values are render window multipliers applied when pressure is detected.
    memoryPressure: {
      low:         { renderMultiplier: 2, mountedCellBudget: 30 },
      moderate:    { renderMultiplier: 1, mountedCellBudget: 20 },
      critical:    { renderMultiplier: 1, mountedCellBudget: 10 },
      backgrounded:{ renderMultiplier: 0, mountedCellBudget: 0  }, // unmount all off-screen
    },

    // ── Sizing correction ─────────────────────────────────────────────────
    correctionMinDelta: 1,      // px — ignore corrections smaller than this (sub-pixel noise)
  }}

  // ── Scroll view — three layers of customization (§4.2) ──────────────────

  // Layer 1: extra props forwarded to the default scroll view
  scrollViewProps={{
    bounces: false,
    decelerationRate: 'fast',
    showsVerticalScrollIndicator: false,
    contentInset: { top: 0, bottom: 80, left: 0, right: 0 },
    // onScroll, onScrollBeginDrag, etc. are forwarded after CollectionView's own handlers
  }}

  // Layer 2: swap the scroll view component type (must support animated onScroll)
  ScrollViewComponent={Animated.ScrollView}

  // Layer 3: full render control (overrides layers 1 & 2)
  renderScrollView={(contractProps) => (
    <Animated.ScrollView {...contractProps} />
  )}

  // Advanced: inject externally managed scroll position shared values (§4.4)
  externalScrollPosition={{ x: myScrollX, y: myScrollY }}

  // ── Collection-level scroll behaviour ────────────────────────────────────
  initialScrollIndex={0}
  maintainVisibleContentPosition={true}

  // ── Perf ─────────────────────────────────────────────────────────────────
  onBlankAreaChange={({ ratio }) => {}}   // 0 = no blank, 1 = fully blank
/>
```

### 11.2 Imperative Handle

```typescript
const ref = useRef<CollectionViewHandle>()

ref.current.scrollToIndex(index, { animated, align: 'top' | 'center' | 'bottom' })
ref.current.scrollToKey(key, { animated })
ref.current.scrollToOffset(offset, { animated })
ref.current.applySnapshot(snapshot)
ref.current.invalidateLayout()     // force full layout recalculation
ref.current.getLayoutAttributes(key): LayoutAttributes
```

### 11.3 Cell Contract

```typescript
// Cells receive a stable, non-recycled instance per key
function MyCell({ item }: { item: MyData }) {
  // Local state is SAFE — this component is never recycled to another item
  const [expanded, setExpanded] = useState(false)

  // Optional: report self-size
  useCellSize({ height: expanded ? 200 : 72 })

  return <View>...</View>
}
```

### 11.4 Layout Spec API

```typescript
// List layout
new ListLayout({
  estimatedItemHeight: 72,      // or 'selfSizing'
  sectionInsets: { top: 8, bottom: 8, left: 0, right: 0 },
  itemSpacing: 4,
})

// Grid layout
new GridLayout({
  columns: 3,
  columnSpacing: 8,
  rowSpacing: 8,
  estimatedItemHeight: 120,
})

// Masonry
new MasonryLayout({
  columns: 2,
  columnSpacing: 8,
  estimatedItemHeight: 150,
})

// Compositional
new CompositionalLayout({
  sections: (sectionIndex, environment) => ({
    orthogonalScrolling: sectionIndex === 0,
    group: new GridGroup({ columns: 2 }),
    header: { height: 44, sticky: true },
  })
})
```

### 11.5 WindowConfig — Full TypeScript Interface

All values are passed from JS into the C++ window controller via JSI at mount time
and can be updated at runtime (`ref.current.updateWindowConfig(partial)`).
No value in this interface is hardcoded in C++.

```typescript
interface MemoryPressureOverride {
  renderMultiplier:  number   // render window shrinks to this multiplier
  mountedCellBudget: number   // LRU eviction target under this pressure
}

interface WindowConfig {
  // Window size multipliers — all × viewport height
  renderMultiplier:      number   // default: 3   — pre-mount zone ahead of scroll
  trailingMultiplier:    number   // default: 1   — keep-mounted zone behind scroll
  layoutMultiplier:      number   // default: 8   — C++ layout cache zone
  dataMultiplier:        number   // default: 12  — onPrefetch trigger zone

  // Velocity-adaptive leading edge expansion
  // Effective leading multiplier = renderMultiplier + velocityScaleFactor × |v|/1000
  velocityScaleFactor:   number   // default: 0.5  (viewport per 1000 px/s)
  maxWindowMultiplier:   number   // default: 8    (hard cap regardless of velocity)

  // Cell budget
  mountedCellBudget:     number   // default: 40  — max mounted cells; LRU evicts beyond this
  supplementaryBudget:   number   // default: 20  — independent budget for supplementary views

  // Memory pressure behaviour — passed to C++, applied on system memory warnings
  memoryPressure: {
    low:          MemoryPressureOverride  // default: { renderMultiplier: 2, mountedCellBudget: 30 }
    moderate:     MemoryPressureOverride  // default: { renderMultiplier: 1, mountedCellBudget: 20 }
    critical:     MemoryPressureOverride  // default: { renderMultiplier: 1, mountedCellBudget: 10 }
    backgrounded: MemoryPressureOverride  // default: { renderMultiplier: 0, mountedCellBudget: 0  }
  }

  // Sizing correction
  correctionMinDelta:    number   // default: 1px — suppress sub-pixel correction noise
}

// Imperative update — applies partial config delta to the live C++ module immediately
ref.current.updateWindowConfig(partial: Partial<WindowConfig>): void
```

**Defaults are tuned for a typical social feed on iPhone 12 (60fps, 6GB RAM).**
Consumers with memory-constrained targets (low-end Android) or unusual content
(very tall cells, lots of images) should tune these values without any native change.

---

## 12. Observability & Diagnostics

### 12.1 Metrics Emitted

| Metric | Description |
|---|---|
| `blankAreaRatio` | Fraction of viewport showing blank/placeholder content |
| `renderWindowUtilization` | % of Render tier budget used |
| `layoutCacheHitRate` | % of layout requests served from cache |
| `meanCellRenderTime` | Average time from Activity hidden→visible |
| `droppedFrames` | Frames where scroll was >16ms |
| `memoryTier` | Current memory pressure tier |
| `activityTreeCount` | Live Activity trees |

### 12.2 Debug Overlay

A `<CollectionViewDebugOverlay>` component (dev-only) renders:
- Color-coded cells by tier (visible=green, render=yellow, layout=orange, data=blue)
- Window boundaries as horizontal lines
- Live metrics panel
- Layout attributes tooltip on cell press

### 12.3 Perf Marker Integration

Integrates with `Performance.mark` / React DevTools timeline profiler to annotate:
- Window boundary updates
- Layout pass start/end
- Activity tree mounts/unmounts
- Snapshot apply start/end

---

## 13. Native vs JS Boundary

**The rule:**
- **Logic** that must be fast → C++ JSI modules (not OTA-updatable)
- **Configuration** of that logic → always from JS props / `windowConfig` (OTA-updatable)
- **Product code** (cells, layout specs, data) → JS (OTA-updatable)

C++ modules expose a `configure(config)` JSI method. Every tuning parameter they use
comes from JS at runtime. No C++ module contains hardcoded tuning values. This means
consumers can experiment with window sizes, velocity factors, memory thresholds, etc.
via a JS bundle update — no native rebuild required.

### 13.1 Boundary Table

| Subsystem | Logic location | Configuration origin | Logic OTA | Config OTA |
|---|---|---|---|---|
| Scroll physics | Native UIScrollView | UIScrollView props via JS | No | Yes |
| **Window controller** | **C++ JSI (UI thread)** | `windowConfig` prop → JSI `configure()` | No | **Yes** |
| **Layout engine** (built-in) | **C++ JSI (background thread)** | Layout spec objects from JS | No | **Yes** |
| **Spatial index** | **C++ JSI** | No tuning needed | No | — |
| **Diff engine** | **C++ JSI** | No tuning needed | No | — |
| **Layout cache** | **C++ JSI** | Cache key policy from JS | No | **Yes** |
| **Scroll position persistence** | **Native module** | `listId` from JS | No | **Yes** |
| Layout engine (custom layouts) | JS plugin | Layout spec from JS | Yes | Yes |
| Cell mounting / `CellContainer` | React JS | `windowConfig` via context | Yes | Yes |
| Data prefetch triggers | JS | `windowConfig.dataMultiplier` | Yes | Yes |
| Diff result → `startTransition` | JS | No tuning needed | Yes | — |
| Cell components | JS / React | Entirely product code | Yes | Yes |

### 13.2 Custom Layout Plugin Performance Tiers

Consumers who write custom layouts can choose their tier:

```
Tier 1 — C++ plugin (native module):
  Fastest. Not OTA-updatable. Requires C++/CMake.
  Use for: core product layouts that never change.

Tier 2 — JS layout plugin:
  Runs in JS background worker (off main thread).
  OTA-updatable. Subject to JS GC pauses.
  Use for: frequently iterated product layouts.

Tier 3 — JS layout plugin (main thread):
  Not recommended. Only if measurement requires synchronous React context.
```

### 13.3 Platform Strategy (by phase)

**iOS (Phase 1)**
- Scroll container: native `UIScrollView` via Fabric.
- Layout engine: C++ JSI module (background thread). JS plugin fallback for custom layouts.
- Window controller: C++ JSI module on UI thread. Reanimated worklet for POC phase.
- `<Activity>`: React 18 `<Activity>` (RN 0.74+).

**Android (Phase 2)**
- Scroll container: native `ScrollView` via Fabric (not RecyclerView — see §13.1, cell management is never delegated to RecyclerView).
- All C++ modules are cross-platform (CMake); same layout engine, diff engine, spatial index.
- State restoration (§16) is critical on Android due to aggressive view destruction.

**Web (Phase 3)**
- Scroll container: `<div style={{ overflowY: 'auto' }}`.
- Window controller: `IntersectionObserver` + `requestAnimationFrame` (no Reanimated).
- `<Activity>`: same React 18 primitive (`display: contents` / `visibility: hidden` on web).
- CSS `content-visibility: auto` as a progressive enhancement for Layout-tier cells.
- C++ JSI modules replaced with WASM equivalents for layout engine and diff engine.

---

## 14. State Persistence & Restoration

Critical on Android (view hierarchy destroyed on navigation, config change, process death).
Required on iOS for backgrounded app restoration.

### 14.1 What Must Be Restored

| State | Storage | Restore timing |
|---|---|---|
| Scroll position (contentOffset x, y) | Native (synchronous, pre-first-frame) | Before Fabric first commit |
| Viewport size | Re-measured on layout | On `onLayout` |
| Layout cache | MMKV (fast synchronous KV) | Hydrated before first scroll event |
| Activity tree tier assignments | Derived from restored scroll + layout cache | After layout cache restored |
| Data window state | Re-triggered via `onPrefetch` | After scroll position restored |
| Cell component state | Cell responsibility (Zustand/MMKV per item key) | Not CollectionView's concern |

### 14.2 Restoration Sequence

```
1. [Native, pre-first-frame]
   Read scroll position from native persistence store.
   Set UIScrollView contentOffset synchronously before first Fabric commit.
   → User never sees position 0 flash.

2. [JS, before first render]
   Hydrate LayoutCache from MMKV serialized snapshot.
   Cache key = hash(dataSourceIdentifier + viewportWidth + layoutConfigHash)
   → Window controller has accurate positions from frame 0.

3. [JS, first render]
   Compute initial visible rect from restored scrollY.
   Enter cells in visible + render window into their tiers.
   Cells with cached layout: skip layout computation, go directly to Render tier.
   Cells without cached layout: enter Layout tier, compute, then Render tier.

4. [JS, async]
   Validate restored layout cache against current data snapshot.
   If data has changed: partial invalidation (only changed items + downstream).
   Re-trigger onPrefetch for items in data window.
```

### 14.3 Layout Cache Serialization

- Format: FlatBuffers (zero-copy reads, no parse step on restore) — preferred.
  JSON fallback for initial POC (easier debugging).
- Stored in MMKV keyed by `collectionViewId + dataHash + viewportWidth`.
- Max cache age: 24h (invalidated on app update, data schema change).
- Max cache size per list: 2MB (evict oldest if exceeded).
- Invalidation triggers: app version change, layout config change, viewport width change.

### 14.4 Android-Specific

- `onSaveInstanceState` / `onRestoreInstanceState` → scroll position.
- React Navigation screen focus/blur: on blur, serialize current scroll + layout cache.
  On focus, restore. No view destruction needed if react-native-screens view preservation
  is enabled — but assume it isn't, and implement full restore as the baseline.
- Process death: layout cache in MMKV survives process death. Scroll position in
  native bundle (SavedStateHandle). Full restoration without app restart state loss.

---

## 15. Observability, Perf HUD & Historical Analysis

### 15.1 Metric Taxonomy

**Scroll performance:**
| Metric | Unit | Collection method |
|---|---|---|
| `frameTime` | ms per frame | Choreographer / CADisplayLink callback |
| `droppedFrames` | count + timestamps | Frame time > 16.67ms (60fps) or >8.33ms (120fps) |
| `jankScore` | 0–100 | Weighted dropped frame ratio (Janky Frames metric) |
| `blankAreaRatio` | 0.0–1.0 | Fraction of viewport height showing no cell content |
| `blankAreaDuration` | ms | Cumulative time with blankAreaRatio > 0.05 |
| `scrollVelocityHistogram` | px/s buckets | Distribution of scroll velocities during session |

**Window & rendering:**
| Metric | Unit | Collection method |
|---|---|---|
| `cellRenderTime` | ms | Time from Activity mount to mode="visible" flip |
| `activityTreeCount` | count | Live Activity trees at any instant |
| `renderWindowUtilization` | % | activityTreeCount / activityBudget |
| `coldMountRate` | % | Cells that had to cold-mount (not warm) / total cells shown |
| `layoutCacheHitRate` | % | Layout cache hits / total layout requests |
| `windowControllerLatency` | ms | Time from scroll event to window boundary update |

**Memory:**
| Metric | Unit | Collection method |
|---|---|---|
| `jsHeapUsed` | MB | `performance.measureUserAgentSpecificMemory()` |
| `nativeHeapUsed` | MB | Platform memory API (JSI) |
| `memoryPressureTier` | 0–3 | System memory warning level |
| `layoutCacheSize` | bytes | Serialized layout cache size |

**Data:**
| Metric | Unit | Collection method |
|---|---|---|
| `prefetchHitRate` | % | Data ready before cell visible / total cells |
| `prefetchLeadTime` | ms | Time between prefetch trigger and data ready |

### 15.2 Debug Perf HUD

Switchable in **any build mode** (not dev-only). Toggled via:
- Shake gesture → menu → "CollectionView HUD"
- `CollectionViewDebugHUD.show(listRef)` programmatically
- URL scheme: `app://debug/collection-hud?id=myList`
- Persistent: last state remembered across app restarts (MMKV)

**HUD layout:**
```
┌─────────────────────────────────────────┐
│ FPS: 59.2  Jank: 2.1%  Blank: 0.0%     │ ← always visible row
│ Cells: V:8 R:28 L:64 D:120  Cold: 0%   │
│ Mem: JS 42MB  Native 18MB  Pressure: 0  │
│ LayoutCache: 98% hit  Prefetch: 94% hit │
├─────────────────────────────────────────┤
│ [COLOR OVERLAY]  [RECORD]  [EXPORT]     │ ← action buttons
└─────────────────────────────────────────┘
```

**Color overlay mode:** cells are tinted by tier:
- Visible: transparent (no tint)
- Render (warm): green tint + "W" badge
- Cold mount: red flash on the frame the cell first appeared
- Layout-only: orange border on the cell frame (invisible cell, just border in overlay)
- Sticky headers: blue border

### 15.3 Session Recording & Historical Storage

A "perf session" is a recorded scroll interaction with all metrics sampled.

**Session data model:**
```typescript
interface PerfSession {
  id: string                    // UUID
  timestamp: number             // unix ms
  appVersion: string
  rnVersion: string
  device: DeviceInfo            // model, OS version, RAM, CPU
  listId: string                // consumer-provided identifier
  layoutType: string            // 'ListLayout' | 'GridLayout' | etc.
  dataSize: number              // total item count
  durationMs: number            // session length

  // Time-series (sampled at 60Hz during scroll)
  frameTimeSeries: number[]
  blankAreaSeries: number[]
  scrollVelocitySeries: number[]
  activityCountSeries: number[]

  // Aggregates
  aggregates: {
    p50FrameTime: number
    p95FrameTime: number
    p99FrameTime: number
    maxBlankAreaRatio: number
    totalDroppedFrames: number
    jankScore: number
    coldMountRate: number
    layoutCacheHitRate: number
    prefetchHitRate: number
    peakJsHeapMB: number
    peakNativeHeapMB: number
  }
}
```

**Storage:**
- On-device: SQLite via `op-sqlite` (fast, queryable, survives process death).
- Schema: `sessions` table + `timeseries` table (foreign key on session id).
- Max stored sessions: 200 (LRU eviction).
- Export: JSON export via share sheet, importable by the analysis tool.

### 15.4 Comparative Analysis Tool

A standalone React Native screen (ships as a dev dependency):

```
<CollectionViewPerfAnalyzer />
```

**Features:**
- Lists all stored sessions, sortable by jank score, date, data size.
- Side-by-side comparison of two sessions (diff view on aggregates).
- Time-series chart overlay: plot frame time from session A vs session B on same axis.
- Filter by: listId, layout type, device model, app version.
- Highlight regressions: if session B has jankScore > session A by >10%, flag red.
- Export comparison as JSON or sharable URL (deep-linked to the analyzer).

### 15.5 Automated Perf Test Cases

Test cases run via Detox or custom native test harness. Each case records a `PerfSession`.

**Baseline test suite (must pass before any release):**

| Test ID | Scenario | Data | Pass criteria |
|---|---|---|---|
| `SCROLL-001` | Constant velocity scroll, fixed height | 10k items, 72px fixed | jankScore < 1, blankArea = 0 |
| `SCROLL-002` | Constant velocity scroll, variable height | 10k items, 50–300px random | jankScore < 3, blankArea < 1% |
| `SCROLL-003` | Fast fling (2000px/s) | 10k items, fixed | blankArea peak < 5%, recovery < 200ms |
| `SCROLL-004` | Fast fling (2000px/s) | 10k items, variable | blankArea peak < 15%, recovery < 400ms |
| `SCROLL-005` | Direction reversal during fling | 10k items, fixed | No jank spike on reversal |
| `SCROLL-006` | Slow scroll (100px/s) | 10k items, selfSizing | jankScore = 0 |
| `MOUNT-001` | Cold start, immediate scroll | 10k items | First visible cell < 100ms |
| `MOUNT-002` | Navigate away and back | 10k items | Scroll position restored, no flash |
| `MOUNT-003` | Background → foreground | 10k items mid-scroll | Position exact, no layout recalc |
| `MEMORY-001` | Idle at position 5000 | 10k items | JS heap < baseline + 50MB |
| `MEMORY-002` | Simulate low memory warning | 10k items | Tier collapse within 1 frame, no crash |
| `DATA-001` | Snapshot apply during scroll | 1k item change during fling | No scroll interruption |
| `STICKY-001` | Scroll through 50 sections | 50 sections, sticky headers | Push behavior correct, no jank |
| `LAYOUT-001` | scrollToIndex(9999) fixed | 10k fixed items | < 16ms, exact position |
| `LAYOUT-002` | scrollToIndex(9999) variable | 10k variable items | < 100ms, position within 1px |

**Test data generators (deterministic, seeded):**
```typescript
TestDataGenerator.fixedHeight(count, height, seed)
TestDataGenerator.variableHeight(count, minH, maxH, seed)
TestDataGenerator.selfSizing(count, minWords, maxWords, seed)  // text wrapping
TestDataGenerator.imageGrid(count, aspectRatioVariance, seed)
TestDataGenerator.sections(sectionCount, itemsPerSection, seed)
TestDataGenerator.mixedContent(seed)  // text + images + varying heights
```

---

## 16. Performance Targets

| Scenario | Target |
|---|---|
| Initial render (first frame) | < 100ms to first visible cell |
| Scroll at 60fps | 0 dropped frames during constant-velocity scroll |
| Fast fling (2000px/s) | < 5% blank area at peak velocity |
| 10,000 item list, cold start | < 200ms to interactive |
| Memory, 10k items, idle | < 50MB above baseline (only visible + render tier in memory) |
| `scrollToIndex(9999)` on fixed-size list | < 16ms (O(1) calculation) |
| `scrollToIndex(9999)` on variable-size list | < 100ms (layout pass triggered) |
| Data snapshot apply (1000 item diff) | < 16ms off main thread |

---

## 17. Open Questions / Phase 2 Scope

1. **C++ vs TypeScript Layout Engine**: ⏳ OPEN — decision deferred pending cross-platform comparison (iOS + Android + others).

   **Both paths are maintained as first-class implementations:**
   - **C++ path**: `LayoutCache` (C++) + `ListLayout` (C++) — established built-in layouts, runs in native thread
   - **TS path**: `TSLayoutCache` (TS) + `TSListLayout` (TS) — dynamic/custom layouts, the `CustomLayoutPlugin` route, works on any platform without native build step

   These are complementary, not competing. Even if C++ wins for built-in list/grid layouts, the TS path is permanently required for consumer-provided custom layouts via `CustomLayoutPlugin`.

   **iOS benchmark data collected (M1.3b, 2026-03-22) — 10 000 items, estimated heights, pivot at 5 000:**

   | Operation                          | C++     | TypeScript | Note |
   |------------------------------------|---------|------------|------|
   | computeListLayout (estimated)      | 7.89ms  | 14.09ms    | C++ ~1.8× faster |
   | invalidateFrom (tail 5 000 items)  | 3.87ms  | 12.24ms    | C++ ~3.2× faster |
   | getAttributesInRect (390×844)      | 2.54ms  | 4.42ms     | C++ ~1.7× faster |
   | getAll (10 000 items)              | 23.80ms | 1.09ms     | TS ~22× faster — JSI marshalling cost for bulk object transfer |

   Key observation: `getAll` result reveals that JSI object marshalling overhead dominates bulk reads.
   The scroll-frame hot path uses `getAttributesInRect` (returns ~15–30 items), which is fast on both paths.
   `getAll` should never be called on a scroll frame regardless of which path is in use.

   **Decision pending:** Android + other platform benchmarks required before choosing default path for built-in layouts.

2. **Layout Cache Serialization format**: FlatBuffers vs. JSON for disk persistence. FlatBuffers is zero-copy but complex.

3. **Animated mutations**: Insertions/deletions with spring/fade transitions require coordinating layout invalidation with React animation drivers. Needs separate design.

4. **Shared element transitions**: Cells may need to participate in navigation-level shared element transitions. Requires exposing cell native view refs.

5. **Infinite bidirectional scroll** (chat-style): `maintainVisibleContentPosition` needs careful integration with the position correction in §5.2 (estimated size correction) to avoid conflicts.

6. **Layout spec serialization**: Should layout specs be serializable (for cache, for server-driven layouts)? Would require a layout spec IR.

7. **Multi-column orthogonal scroll** (Instagram Explore grid): Two-axis layout is a fundamentally different problem — separate component or extension of CompositionalLayout?
