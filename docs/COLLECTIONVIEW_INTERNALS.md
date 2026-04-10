# CollectionView.tsx — Implementation Reference

Internal implementation details for `packages/rn-collection-view/example/components/CollectionView.tsx`.
This complements `ARCHITECTURE.md` (high-level) with the actual code structure and line references.
Line numbers are approximate — verify against current code.

---

## Section Rendering Pipeline

### Flat items array

CollectionView flattens sections + items into a single array for rendering. Each entry is tagged with a `_kind` discriminant:

```
_kind: 'header' | 'item' | 'footer'
```

Headers and footers are interspersed with items in section order. The flat array is what gets windowed and rendered.

### sectionedRenderItem dispatch (~line 794)

The internal `sectionedRenderItem` callback dispatches based on `_kind`:

```ts
if (fi._kind === 'header') return propSections[fi.sectionIndex]?.header?.render() ?? null;
if (fi._kind === 'footer') return propSections[fi.sectionIndex]?.footer?.render() ?? null;
// else: regular item
propRenderItem({ item: fi.item, sectionIndex: fi.sectionIndex, itemIndex: fi.itemIndex })
```

**renderItem signature in sectioned mode:** `({ item, sectionIndex, itemIndex })` — NOT just `({ item, index })`. One single `renderItem` prop serves all sections; the consumer switches on `sectionIndex` to render different cell types.

---

## Sticky Headers/Footers

### Which cells get sticky treatment

During flattening, flat indices of sticky cells are collected (~line 498 for headers, ~531 for footers):

```ts
if (s.header?.sticky) → stickyHeaderFlatIndices.push(flatIdx)
if (s.footer?.sticky) → stickyFooterFlatIndices.push(flatIdx)
```

The resulting map `stickyConfigMap` maps flatIndex → `{ naturalY, boundaryY, boundaryX, primaryAxisExtent, kind }`.

### Sticky wrapping (~lines 1530-1552)

At render time, if a cell's flat index is in `stickyConfigMap` AND it's not measure-only, it is wrapped in `<RNScrollCoordinatedView>` instead of the normal `<RNMeasuredCell>`:

```tsx
<RNScrollCoordinatedView
  behavior={stickyMode}                         // ← 'push' or 'sticky'
  naturalY={stickyConfig.naturalY}
  boundaryY={stickyConfig.boundaryY}
  boundaryX={stickyConfig.boundaryX}            // horizontal push boundary
  headerHeight={stickyConfig.primaryAxisExtent} // primary-axis size (not always a height)
  horizontal={isHoriz}
  enabled={true}
  type="supplementary"
  kind={stickyConfig.kind}                      // 'header' or 'footer'
  ...
>
  {cellContent}
</RNScrollCoordinatedView>
```

**`primaryAxisExtent`** (renamed from `sizeHeight`): the sticky view's size along the scroll axis. For vertical = `frame.height`; for horizontal = `frame.width`. This is passed as `headerHeight` to the native component where it drives push-boundary capping and footer trailing-edge positioning. Using the cross-axis dimension here causes all three symptoms: footer overlap on load, header un-sticking early, and wrong push boundary.

**Horizontal supplementary `containerStyle`:** For horizontal headers/footers the C++ layout sets `frame.height = viewportHeight` (cross-axis). Without an explicit `height` in `containerStyle`, Yoga measures the cell content (~100px) and ShadowNode Phase 2 creates a delta that overwrites the cached cross-axis height. Fix: inject `height: attr.frame.height` for horizontal supplementary views in `renderCell`:

```typescript
const isHorizSupp = (effectiveLayout.horizontal ?? false)
  && (fiDesc?._kind === 'header' || fiDesc?._kind === 'footer');
const containerStyle = [{
  position: 'absolute' as const,
  left, top,
  ...(viewportWidth > 0 ? { width: cellWidth } : {}),
  ...(isHorizSupp && attr ? { height: attr.frame.height } : {}),
}];
```

Content inside uses `flex: 1` to fill the pinned frame.

### stickyMode prop

- **Declared on `<CollectionView>`**: `stickyMode?: 'sticky' | 'push'`, default `'push'` (~line 360 / 757)
- **NOT a `list()` layout param** — the layout factory `list()` ignores `stickyMode` even if passed
- **Flows as `behavior` prop** to every `RNScrollCoordinatedView` (~line 1539)
- Native `RNScrollCoordinatedViewView` handles the actual push/overlap behavior on UI thread via KVO

---

## Per-Section Insets — Bug + Fix

### The bug (as of this writing)

`SectionConfig` type did NOT include an `insets` field. In the `layoutContext` useMemo, the sectioned branch hardcodes:

```ts
// ❌ Before fix — line ~956
insets: undefined,
```

The C++ `ListLayout` reads `sec.insets?.top/bottom/left/right` — so all sections got zero insets.

### The fix

1. Add `insets` to `SectionConfig` (~line 148):
   ```ts
   insets?: { top?: number; bottom?: number; left?: number; right?: number };
   ```

2. Pass it through in `layoutContext` (~line 956):
   ```ts
   insets: s.insets,   // ✅
   ```

Note: flat (non-sectioned) mode already passes insets correctly via the `sectionInsetTop/Bottom/Left/Right` props on `<CollectionView>`.

---

## Layout Context Construction (~lines 947-988)

```ts
const layoutContext: LayoutContext = {
  containerWidth: viewportWidth,
  containerHeight: viewportHeight,
  scrollOffset: { x: 0, y: prevScrollYRef.current },
  sections: propSections
    ? propSections.map(s => ({
        itemCount: s.data.length,
        insets: s.insets,           // ← after fix
        supplementaryItems: [
          ...(s.header ? [{ kind: 'header', size: { width, height: s.header.height },
                            alignment: 'top', pinToVisibleBounds: s.header.sticky ?? false,
                            pinBehavior: 'push' }] : []),
          ...(s.footer ? [{ kind: 'footer', size: { width, height: s.footer.height },
                            alignment: 'bottom', pinToVisibleBounds: s.footer.sticky ?? false,
                            pinBehavior: 'push' }] : []),
        ],
      }))
    : [{ itemCount: data.length, insets: { top, bottom, left, right }, supplementaryItems: [] }],
  measuredHeightForItem: (index, section) => measuredHeightForItemRef.current(index, section),
};
```

**Item spacing** (`itemSpacing`) is a global param on the `list()` layout delegate — NOT per-section. There is no per-section item spacing in the current architecture.

**Section spacing** (`sectionSpacing`) IS a per-layout param on `ListLayoutDelegate`. It adds a gap after each section's footer (or last item if no footer) before the next section's header. Sits outside the section background frame. Analogous to `NSCollectionLayoutSection.interSectionSpacing`.

**Decoration params** (`emitSeparators`, `emitSectionBackground`, `separatorHeight`, `separatorInsetLeading/Trailing`) are passed from the JS `list()` delegate into the C++ `computeSections()` call. They control which decoration `LayoutAttributes` the engine emits. They are also included in the data-shape fingerprint so toggling them triggers a full cache clear and recompute.

---

## Decoration Rendering Pipeline

Decorations are layout-engine-owned visual entries with `isDecoration: true` in `LayoutAttributes`. They are windowed and z-ordered like cells but carry no React data.

**Query:** `CollectionView.tsx` calls `nativeMod.layoutCache.getAttributesInRect(decoRect)` and filters for `attrs.isDecoration === true`. This only runs when at least one of `decorationRenderers`, `renderSectionBackground`, or `hasSeparators` is truthy, and when `layout.type === 'list'`.

**Z-ordering:**
- `sectionBackground` entries: `zIndex: -1` → rendered first, behind cells
- `separator` entries: `zIndex: 0` → rendered after backgrounds, between item layers
- Cells: `zIndex: 1+` (from `LayoutAttributes.zIndex`)

**Rendering:**
- Separators: flat `<View>` with `backgroundColor` from `listDelegate.separator.color` (defaults to white). Width is `frame.width - insetLeading - insetTrailing`.
- Section backgrounds: consumer-provided render function via `decorationRenderers.sectionBackground(sectionIndex, frame)` or legacy `renderSectionBackground` prop.
- Custom decoration kinds: `decorationRenderers[decorationKind](sectionIndex, frame)` for extensibility.

**Frame semantics:** The section background frame covers the items area only — from `sectionInsetTop` below the header to `sectionInsetBottom` above the footer. This matches `NSCollectionLayoutDecorationItem.background` in `UICollectionViewCompositionalLayout`. Headers/footers float above the background in Z and sit outside the bg rect.

**applyMeasurements:** Decoration entries are skipped in the primary item-shift loop. A second pass updates bg frames using `entryShift` / `exitShift` per section (cumulative shift before/after each section's items). This preserves inset padding in the bg frame after Yoga measurement corrections.

**MVC anchor exclusion:** `_snapshotAnchorLocked()` in `LayoutCache.cpp` skips entries where `isDecoration == true`. Without this, a section background (large frame, low Y) would be selected as the MVC anchor, causing incorrect scroll offset corrections on insert/delete.

---

## Two-Layer Identity: cacheKey + Fabric Tag

**CRITICAL — read before touching decoration rendering, applyPositionsFromState, or any code that maps layout positions to native views.**

The position pipeline uses two orthogonal identity systems, each covering a distinct domain.

### Layer 1: cacheKey (stable string) — "What position?"

```
C++ layout engine  →  LayoutCache  →  SpatialIndex  →  JS getAttributesInRect
                                                         →  React render (cacheKey prop)
                                                            →  ShadowNode Phase 1 (cache lookup)
```

The layout engine writes `cache["decoration-0-sectionBackground"] = {x:8, y:44, w:377, h:588}`. The ShadowNode reads `cache[child.props.cacheKey]` to get the position for each child. This is a hashmap lookup — order-independent, deterministic, and entirely our code. The cacheKey is discarded after Phase 1 (it's not propagated to state).

### Layer 2: Fabric tag (int32) — "Which native view?"

```
ShadowNode (children[i]->getTag())  →  state.childTags  →  native applyPositionsFromState
                                                             (tag → UIView* lookup)
```

After Phase 1, `correctedPositions_[i]` holds the frame for `children[i]`. The child's Fabric tag is recorded in parallel: `childTags_[i] = children[i]->getTag()`. Both are stored in state. The native view builds a `tag → UIView*` map from `_contentView.subviews` and applies each position to the matching view by tag.

### Why index-based mapping fails (confirmed in production logs, 2026-04)

Fabric's reconciler uses a **"last index" optimization** to minimize move operations: when processing a new children list left-to-right, if an existing child's old index is ≥ the highest old-index seen so far (`lastIndex`), Fabric doesn't generate a MOVE for it — it stays at its current native position.

This is correct for relative ordering, but breaks **absolute positioning** when new children are inserted before existing non-moved children. Example:

```
Old children: [bg0@native0, bg1@native1, bg2@native2, items...]
Toggle separators ON:
New ShadowNode: [sep0, bg0, sep1, bg1, sep2, bg2, items...]  ← seps interleaved

Fabric sees bg0's old index (0) >= lastIndex → no move needed
Fabric inserts sep0, sep1, sep2 starting at native index 1 (after bg0)

Native result: [bg0@native0, sep0@native1, sep1@native2, ..., bg1@native23, ...]
ShadowNode:    [sep0, bg0, sep1, ...]

Index-based: positions[0] = sep0 frame → applied to native[0] = bg0 → WRONG
Tag-based:   positions[0] has tag=sep0.tag → looks up sep0 by tag → CORRECT
```

Confirmed via runtime logs: `apply[0] tag=3942 target=(28.0,125.7,353.0,0.5) current=(12.0,56.0,369.0,1979.0)` — the bg view (current: section-spanning 1979px tall) received a separator's frame (0.5px tall).

### Why decorations trigger this but items usually don't

Decorations are returned by `SpatialIndex.getAttributesInRect()` in **spatial bucket order**, which can interleave new seps between existing bgs as new decorations are added. Items are rendered in **flat data order** (slice of `flatItems`), so new items don't interleave with existing items in the React tree.

Future scenarios where items could also be affected: custom layouts with dynamic grouping, spatial-order rendering optimization, or section reordering. Using universal tag-based lookup protects against all of these.

### Why tag identity is Fabric's most fundamental guarantee

`children[i]->getTag()` and `UIView.tag` are set by the Fabric runtime when it creates the ShadowNode↔native view pair. They're guaranteed to match for the lifetime of that pair. This is the identity mechanism used by event dispatch, accessibility, and every Fabric component — if it broke, all of React Native would break, not just our component.

---

## Mutation API

### Flat data mode (`data` prop)

Use the imperative `handle` + `RiffHandle` API:

```ts
const ref = useRef<RiffHandle<MyItem>>(null);
<Riff handle={ref} onDataChange={setData} data={data} ... />

// To mutate:
const snap = ref.current.snapshot();
snap.appendItems(newItems);
ref.current.apply(snap, /* animated */ true);
```

`apply()` triggers: diff engine → evict stale heights → LayoutAnimation → `startTransition` → calls `onDataChange(newData)`.

### Sectioned mode (`sections` prop)

No snapshot API. Mutations are plain state updates:

```ts
const [sections, setSections] = useState(initialSections);
// Insert items into section 0:
setSections(prev => [{
  ...prev[0],
  data: [...newItems, ...prev[0].data],
}, ...prev.slice(1)]);
```

`maintainVisibleContentPosition` toggle is a prop on `<CollectionView>` — L5 work.

---

## scrollToItem / scrollToOffset

Exposed via `RiffHandle` (useImperativeHandle):

```typescript
const ref = useRef<RiffHandle<MyItem>>(null);
<Riff handle={ref} ... />

ref.current?.scrollToItem('sectionKey:itemId', { position: 'top' | 'center' | 'bottom' | 'nearest' | 'start' | 'end', animated: true });
ref.current?.scrollToOffset({ x: 400 });   // horizontal — y defaults to 0
ref.current?.scrollToOffset({ y: 400 });   // vertical — x defaults to 0
```

**Key format:** Same stable key used by the layout cache — `"sectionKey:itemId"` (e.g. `"cell-animation:s1-17"`). This is the concatenation of `SectionConfig.key` and the item key from `keyExtractor`. No index needed.

**Horizontal support:** `scrollToItem` detects `effectiveLayout.horizontal` and switches axis: reads `frame.x`/`frame.width`, uses `viewportWidthRef`/`layoutContentSizeRef` for clamping, calls `nativeMod.scrollTo(id, targetX, 0, animated)`. Position values `'start'`/`'end'` are direction-agnostic aliases for `'top'`/`'bottom'`. Both `x` and `y` in `ScrollToOffsetOptions` are optional (default 0).

**`contentHeightRef` / `layoutContentSizeRef` pattern:** `useImperativeHandle` doesn't include these in its deps array — adding them would recreate the handle on every layout pass (O(cells) re-render). Refs mirror the live values and are read in the closure without triggering re-creation. `layoutContentSizeRef` is synced in the same `useLayoutEffect` that syncs `contentHeightRef`.

**Dispatch:** JS computes target offset → calls `nativeMod.scrollTo(layoutCacheId, x, y, animated)` → C++ looks up the registered scroll handler for this `layoutCacheId` → calls `_scrollToX:y:animated:` on the `UIScrollView`.

---

## Key Type Locations

| Type | File | ~Line |
|---|---|---|
| `SectionConfig<T>` | `CollectionView.tsx` | 146 |
| `RiffProps<T>` | `CollectionView.tsx` | 201 |
| `RiffHandle<T>` (incl. `scrollToItem`/`scrollToOffset`) | `CollectionView.tsx` | 179 |
| `SectionedRenderItemInfo<T>` | `CollectionView.tsx` | 161 |
| `CollectionViewLayout` | `src/types/protocol.ts` | — |
| `LayoutContext` | `src/types/protocol.ts` | — |
| `ListLayoutDelegate` (incl. `separator`, `sectionBackground`, `sectionSpacing`) | `src/types/protocol.ts` | — |
| `GridLayoutDelegate`, `MasonryLayoutDelegate`, `FlowLayoutDelegate` | `src/types/protocol.ts` | — |

---

## RULE: Stable Key Consistency (CRITICAL — read before touching ANY layout engine)

**Every key used to store a LayoutAttributes entry in C++ LayoutCache MUST be the same key used to read it in TS, AND the same key passed as `cacheKey` to the ShadowNode.**

**`propKeyExtractor` is called ONCE per item**, in `layoutContext.sections[s].itemKeys`. All other code reads from that array. See "Key Identity: Single Source of Truth" section below for the full explanation and the `sectionedKeyExtractorCb` refactor that enforces this.

There is exactly ONE key per item. It flows through the entire pipeline:

```
keyExtractor(item)
  → layoutContext.sections[s].itemKeys[i]          (CollectionView.tsx)
  → TS layout engine prepare() passes as keys[]    ({type}.ts)
  → C++ stores LayoutAttributes under keys[i]      ({Type}Layout.cpp)
  → TS attributesForItem() looks up using same key  ({type}.ts)
  → renderCell derives cacheKey = same key          (CollectionView.tsx)
  → ShadowNode receives cacheKey, writes measurement back under same key
```

**If any link in this chain uses a different key, the entire measurement feedback loop breaks silently.**

### How to implement in every TS layout engine (`{type}.ts`)

1. **Store section keys in `prepare()`:**
   ```typescript
   private lastSectionKeys: (readonly string[])[] = [];
   prepare(context: LayoutContext): void {
     this.lastSectionKeys = context.sections.map(s => s.itemKeys ?? []);
     // ... build keys array: use sec.itemKeys when available, else positional fallback ...
   }
   ```

2. **Use stored keys in `attributesForItem()`:**
   ```typescript
   attributesForItem(index: number, section: number): LayoutAttributes | null {
     const sectionKeys = this.lastSectionKeys[section];
     const key = sectionKeys?.[index] ?? `${this.type}-${section}-${index}`;
     return nativeMod.layoutCache.getAttributes(key);
   }
   ```

3. **Pass identity keys to C++ when available (never hardcode positional-only):**
   ```typescript
   const keys = sec.itemKeys
     ? Array.from(sec.itemKeys)
     : Array.from({ length: sec.itemCount }, (_, i) => `${type}-${sectionIndex}-${i}`);
   ```

4. **Default key format MUST be `{type}-{section}-{index}`** (section-aware). Single-section engines must still include section index 0. This matches CollectionView.tsx's cacheKey fallback: `${effectiveLayout.type}-${sk}-${ik}`.

### Verification checklist per engine

| Check | Command |
|---|---|
| C++ uses `keys[i]` when provided | grep for key construction in `{Type}Layout.cpp` |
| TS `prepare()` stores `lastSectionKeys` | grep `lastSectionKeys` in `{type}.ts` |
| TS `attributesForItem` uses stored keys | read the method — must NOT hardcode a key format |
| TS passes `sec.itemKeys` to C++ | grep `itemKeys` in `{type}.ts` prepare() |
| Default key format is `{type}-{section}-{index}` | check both C++ prefix and TS fallback |

### Current compliance (2026-04-03)

| Engine | Compliant? | Issue |
|---|---|---|
| List | YES | Reference implementation |
| Grid | YES | `lastSectionKeys` added; identity keys flow end-to-end |
| Masonry | NO | Keys are `masonry-{i}` (no section index), identity keys never passed — fix when multi-section masonry is implemented |
| Flow | NO | Keys are `flow-{i}` (no section index), identity keys never passed — fix when multi-section flow is implemented |

---

## Layout-Type-Agnostic Rendering Checklist (PRIVATE — remove before release)

CollectionView.tsx bridges LayoutCache → React elements. The C++ layout engines compute correct positions for every layout type. Rendering bugs arise when the bridge code assumes a specific layout's key format or delegate shape. This section catalogues every site that must be layout-generic.

### Key format contract

Each C++ layout engine writes LayoutAttributes with its own key prefix:
- ListLayout: `item-{section}-{index}`, `item-{section}-header`, `item-{section}-footer`
- GridLayout: `grid-{section}-{index}`, `grid-{section}-header`, `grid-{section}-footer`
- MasonryLayout: `masonry-{section}-{index}`, etc.
- When `keyExtractor` is provided: both engines use the stable key from `layoutContext.sections[s].itemKeys` (format: `sectionKey:itemId`)

**Rule:** CollectionView.tsx must NEVER hardcode a key prefix. Always go through the layout protocol:
- Item attrs: `effectiveLayout.attributesForItem(index, section)`
- Supplementary attrs: `effectiveLayout.attributesForSupplementary('header'/'footer', section)`
- Decoration attrs: `attributesForElements(rect).filter(a => a.isDecoration)` (already generic)

### Sites that must be layout-generic

| # | Location | What it does | How to keep generic |
|---|---|---|---|
| 1 | `flattenSections` → `keyToFlatIndex` | Maps cache key → flat index for render-range lookup | Use `attrToFlatIndex()` helper (section+index math) instead of key string lookup |
| 2 | `renderCell` → cacheKey | Derives the React key / ShadowNode measurement key | Use `effectiveLayout.attributesForSupplementary(...).key` for headers/footers; `sectionKeys[ik]` or `${type}-${s}-${i}` fallback for items |
| 3 | `renderCell` → attr lookup | Gets LayoutAttributes for positioning | Use `effectiveLayout.attributesForSupplementary(...)` for headers/footers |
| 4 | `stickyConfigMap` → attr lookup | Gets natural position for sticky computation | Same as #3 |
| 5 | Boundary Y/X lookups | Push-mode boundary for sticky headers/footers | Same as #3 |
| 6 | Separator color / `hasSeparators` | Gates separator rendering and reads color | Read from `(effectiveLayout as any).delegate?.separator`, not `listDelegate` |
| 7 | Stable key insertion block | Re-registers `sectionKey:itemId` in `keyToFlatIndex` | Unnecessary after `attrToFlatIndex()` — remove |

### Grep audit commands

Run these after adding any new layout type to find remaining assumptions:

```bash
# Hardcoded key prefixes
rg "'item-" example/components/CollectionView.tsx
rg '"item-' example/components/CollectionView.tsx

# List-specific delegate access
rg 'listDelegate' example/components/CollectionView.tsx

# Layout type checks
rg "type === 'list'" example/components/CollectionView.tsx
rg "type !== 'list'" example/components/CollectionView.tsx

# Direct cache access bypassing layout protocol
rg 'getAttributes\(' example/components/CollectionView.tsx
```

---

## Horizontal Grid — Adaptive Cross-Axis

### H-grid is always adaptive

All H-grids measure item cross-axis (height) via Yoga and self-determine container height. This is not an opt-in flag; it is the only mode. Item heights are best-effort estimates; Yoga is always the authority. No `adaptiveCrossAxis` prop exists on `GridLayoutDelegate`.

**C++ signal:** `_horizontal == true` in `GridLayout.cpp`. `contentDeterminedDimension()` returns `Both` for H-grid, telling the ShadowNode to collect both width and height deltas.

**`_maxCrossAxisHeight`:** Global tracker across all sections. Initialized from `estimatedCrossAxisHeight` on the very first `computeSections()` call only. Preserved (not reset) on subsequent calls, e.g. after insert/delete. Updated upward by `applyMeasurements()` after Yoga measures items.

**Container height:** JS reads `effectiveLayout.contentSize().height` from `onContentSizeChange` and stores it in `containerH` state. The container `<View style={{ height: containerH }}>` wraps the native component.

### `shouldInvalidate` must return `false` for H-grid

H-grid cross-axis height is OUTPUT (content-determined), not INPUT. Returning `true` on viewport height change causes an oscillation loop:

```
containerH changes → ScrollView height changes → shouldInvalidate(height changed) returns true
  → prepare() resets _maxCrossAxisHeight → applyMeasurements recalculates → content height changes
  → containerH changes → loop
```

`GridLayoutEngine.shouldInvalidate()` always returns `false` for H-grid. For V-grid it returns `true` only when viewport width changes (which changes column widths).

### `applyMeasurements` for H-grid — measure-then-reflow

A linear `aggregateShift` cascade breaks H-grid because items in the same column-group (same `rowStartPrimary`) get different X values: each row's shift delta contaminates the next row's starting position.

The H-grid `applyMeasurements` path uses a 3-phase approach:

1. **Write measured dimensions into cache** — classify each delta as width or height by matching `d.oldValue` against `existing->frame.width` / `existing->frame.height`. Update `sizingState = Measured`.
2. **Compute global max cross height** — iterate all non-decoration, non-supplementary items in the entire cache; update `_maxCrossAxisHeight`.
3. **Full reflow via `computeSectionFromCache`** — re-runs the column-group placement logic for every section, using the updated `_maxCrossAxisHeight`. This correctly aligns all items in the same column-group to the same X.

The linear cascade is only used for V-grid and H-list (primary-axis-only deltas).

### Cell height locking for supplementaries only

For H-grid, item cells are NEVER height-locked — Yoga measures natural content height. Only supplementary (header/footer) cells are height-locked: their `frame.height` is the computed cross extent from the engine (typically `_maxCrossAxisHeight * cols + spacing + insets`). Without the lock, Yoga would re-measure the supplementary content (~100px) and ShadowNode Phase 2 would overwrite the cached cross extent.

```tsx
const isHorizSupplementary = isHorizLayout &&
    (fiDesc?._kind === 'header' || fiDesc?._kind === 'footer');
const containerStyle = [{
  position: 'absolute', left, top,
  ...(viewportWidth > 0 ? { width: cellWidth } : {}),
  ...(isHorizSupplementary && attr && attr.frame.height > 0 ? { height: attr.frame.height } : {}),
}];
```

### MVC limitation for multi-column H-grids

MVC anchor tracks primary-axis (X) correction only. Inserting at index 0 in a 2-row H-grid pushes an item from row 0 to row 1 (cross-axis shift), which MVC cannot compensate. Same limitation exists in UICollectionView. Recommendation: use `scrollTo` after insert for multi-column H-grids.

---

## `onContentSizeChange` Synthesis

`topContentSizeChange` is NOT a registered Fabric event. In standard RN, `onContentSizeChange` was always synthesized JS-side from content view frame changes, never fired as a native event. Attempting to add it to a codegen spec causes a runtime crash:

```
Error: Unsupported top level event type "topContentSizeChange" dispatched
```

**Implementation:** Native fires `onScroll` from `updateState:` whenever `_scrollView.contentSize` changes. `CollectionView.tsx` detects size changes in the `onScroll` handler:

```tsx
const prevContentSizeRef = useRef({ width: 0, height: 0 });

// inside onScroll handler, before forwarding to scrollViewProps.onScroll:
if (scrollViewProps?.onContentSizeChange) {
  const cs = e.nativeEvent.contentSize;
  const prev = prevContentSizeRef.current;
  if (Math.abs(cs.width - prev.width) > 0.5 || Math.abs(cs.height - prev.height) > 0.5) {
    prevContentSizeRef.current = { width: cs.width, height: cs.height };
    scrollViewProps.onContentSizeChange(cs.width, cs.height);
  }
}
```

The `0.5pt` threshold avoids spurious calls from floating-point rounding.

**Do not add `onContentSizeChange` to the codegen spec.** The comment in `RNCollectionViewContainerNativeComponent.ts` documents this explicitly.

---

## Scroll Events

The native `RNCollectionViewContainerView` emits all standard RN ScrollView scroll events:

| Event | When | Throttling |
|---|---|---|
| `onScroll` | Every scroll frame + whenever content size changes | `scrollEventThrottle` prop (native-side throttle) |
| `onScrollBeginDrag` | User begins dragging | None (discrete, fires once per gesture) |
| `onScrollEndDrag` | User releases drag | None |
| `onMomentumScrollBegin` | Deceleration begins (after drag release) | None |
| `onMomentumScrollEnd` | Deceleration stops | None |

All five are declared as `DirectEventHandler<OnScrollEvent>` in the codegen spec. Fabric coalesces `DirectEventHandler` events automatically when multiple fire before a JS batch is processed. `scrollEventThrottle` controls native throttling for `onScroll` only (the other four are too infrequent to need throttling).

These map to `UIScrollViewDelegate` methods in native:
- `scrollViewDidScroll:` → `onScroll`
- `scrollViewWillBeginDragging:` → `onScrollBeginDrag`
- `scrollViewDidEndDragging:willDecelerate:` → `onScrollEndDrag`
- `scrollViewWillBeginDecelerating:` → `onMomentumScrollBegin`
- `scrollViewDidEndDecelerating:` → `onMomentumScrollEnd`

`CollectionView.tsx` forwards these to `scrollViewProps.onScroll{*}` handlers so the component is a drop-in for standard `ScrollView` prop consumers.

---

## Dimension-Estimate Invariant

**All consumer-provided dimensions are estimates. Actual dimensions always come from Yoga via the LayoutCache.**

This applies universally to every sizing API across all four layout engines:

| Layout | Consumer APIs | All estimates? |
|--------|--------------|----------------|
| List | `itemHeight`, `estimatedItemHeight`, `heightForItem(i,s,w)` | ✅ |
| Grid | `rowHeight`, `heightForItem(i,s,w)` | ✅ |
| Masonry | `heightForItem(i,s,w)` | ✅ |
| Flow | `sizeForItem(i,s,w)` (both width & height) | ✅ |
| All | `headerHeight`, `footerHeight`, `estimatedHeaderHeight`, `estimatedFooterHeight` | ⚠️ Not measured by Yoga (declared heights) — correct for now |

Every layout engine uses the same priority chain in `prepare()`:

```
Actual (Yoga-measured via measuredHeightForItem)
  → Delegate callback (heightForItem / sizeForItem)
    → Prop value (itemHeight / rowHeight)
      → Estimated prop (estimatedItemHeight)
        → Hardcoded fallback (44)
```

The ShadowNode's `correctChildPositionsIfNeeded()` (Phase 2) diffs Yoga-measured dimensions against cache entries and calls `engine->applyMeasurements()` to cascade position corrections. This is the mechanism that makes estimates converge to reality in a single frame.

**Rule**: No code path should assume consumer-provided dimensions are final. Any gate or optimization that relies on "sizes won't change" must use cache version or measurement state — never prop names.

---

## `isVariableHeight` — What It Actually Means

```typescript
const isVariableHeight = estimatedItemHeight !== undefined;  // ~line 1051
```

This flag means **"the consumer used the `estimatedItemHeight` API."** It does NOT mean:
- Heights are fixed when `false`
- It is safe to skip measurement when `false`
- Layout positions won't change when `false`

All consumer dimensions are estimates regardless of which prop was used (see Dimension-Estimate Invariant above).

**Current usages** (as of 2026-04-09):

| Location | Usage | Correct? |
|----------|-------|----------|
| L1076-1077 | Default layout factory: `itemHeight` vs `estimatedItemHeight` delegation | ✅ Controls which list() delegate field is populated — legitimate |
| L1269, L1554 | `measureAheadMult` to processScroll: `isVariableHeight && measureAhead > 0` | ❌ Should be `measureAhead > 0` — measure-ahead should be gated by its own prop |
| L1285, L1575 | Measure-range state update: `if (isVariableHeight && measureAhead > 0)` | ❌ Same fix |
| L2048 | Render path: `!isVariableHeight \|\| measureRange.last < measureRange.first` | ❌ Should be just `measureRange.last < measureRange.first` |

**Fix**: Decouple `measureAhead` from `isVariableHeight`. The variable itself stays (it controls default layout delegation), but it should never be used as a proxy for "safe to skip measurement" or "sizes won't change."

---

## Scroll Path Ownership

### Current scroll data flow (before cleanup)

```
Native UIScrollView scrolls
  → scrollViewDidScroll: writes offset to LayoutCache (UI thread, every tick)     ← NATIVE OWNS
  → scrollViewDidScroll: emits throttled onScroll event to JS                     ← SIGNAL
  → JS reads contentOffset from event                                              ← REDUNDANT
  → JS computes velocity = Δoffset / Δt using Date.now()                          ← WRONG OWNER
  → JS calls processScroll(scrollOffset, ..., velocity) via JSI                    ← ROUND-TRIP
  → C++ processScroll uses scrollOffset + velocity for range computation           ← WORK
```

### Target scroll data flow (after cleanup)

```
Native UIScrollView scrolls
  → scrollViewDidScroll: writes offset + timestamp to LayoutCache (UI thread)     ← NATIVE OWNS
    [LayoutCache derives velocity internally using CACurrentMediaTime]
  → scrollViewDidScroll: emits throttled onScroll event to JS                     ← SIGNAL
  → JS calls processScroll(vpPrimary, vpCross, ...) — NO offset, NO velocity      ← LEAN
  → C++ processScroll reads offset + velocity from LayoutCache                     ← ZERO ROUND-TRIP
  → C++ early-return if scroll within stable band (±¼ viewport)                   ← OPT 6
  → C++ runs spatial queries only when ranges actually need recomputation          ← WORK
```

### Why velocity belongs in LayoutCache, not JS

1. **`setScrollOffset()` already fires on every UI-thread tick** (not throttled) — it has the highest-frequency, most accurate offset data available.
2. **`CACurrentMediaTime()`** is the same timing source CoreAnimation uses — strictly more accurate than JS `Date.now()` for frame-aligned work.
3. **Velocity is consumed only by C++ `processScroll`** for padding computation — JS never uses it for anything else.
4. **Eliminates 2 JSI args** from `processScroll` (scrollPrimary, velocity) — simpler interface.

### Why pull (not push) for range updates

**Question**: If native owns everything, should native push range updates to JS instead of JS pulling via `processScroll`?

**Answer: Pull wins.** Three reasons:

1. **Threading**: Running spatial queries in `scrollViewDidScroll:` (UI thread) would contend with `ShadowNode::layout()` (Fabric BG thread) on `LayoutCache._mutex`. The ShadowNode holds the mutex for 50-500μs during `correctChildPositionsIfNeeded` + `applyMeasurements`. Main-thread blocking = scroll jank.

2. **Cost**: With the C++ early return (Opt 6), when ranges don't change the total JS cost is ~1-2μs (JSI hop + band check + return). That's 0.01% of a 16ms frame budget.

3. **Custom layouts**: Push from native would bypass JS custom layouts that compute their own positions. The pull model keeps JS as the orchestrator.

**Escape hatch**: If profiling later shows event delivery is a bottleneck, suppress onScroll from native when the offset is within the stable band. Single `if` in `scrollViewDidScroll:`, no architectural change.

See `PERF-PLAN.md` → "Scroll Path Ownership" for the full analysis.

---

## Cell Recycling and Incremental Render Loop (Opt 4 + Opt 7)

### Identity model: slotKey vs dataKey vs cacheKey

Three distinct identities flow through the pooling system. Confusing them causes subtle bugs.

| Identity | Value | Created by | Provided by consumer? | Purpose |
|----------|-------|------------|----------------------|---------|
| `slotKey` | `"slot_0"`, `"slot_1"`, ... | SlotManager (auto-increments a counter) | No — internal to SlotManager | React `key` prop — stable for the life of the slot. Lets the Fiber survive recycling. |
| `dataKey` | `keyExtractor(item, index)` or `String(index)` | SlotManager calls `getDataKey(i)` which calls `keyExtractor` | **Yes** — consumer provides `keyExtractor` (optional; defaults to `String(index)`) | Which data item occupies this slot right now. Changes when a slot is recycled. Used to detect when an item's slot has been taken over by a different item. |
| `cacheKey` | `"item-0-3"`, `"grid-1-7"`, etc. | `computeCacheKey(index)` inside CollectionView — derived from layout engine key format | No — internal, derived from layout engine | LayoutCache lookup key. Passed as `cacheKey` prop to `RNMeasuredCell`. Tells the C++ ShadowNode which position entry to apply. Changes when a slot is recycled. |

**Flow of keyExtractor**: Consumer passes `keyExtractor?: (item: T, index: number) => string` as a prop. CollectionView wraps it as `(i) => keyExtractor ? keyExtractor(data[i], i) : String(i)` and passes this to `SlotManager.sync()`. SlotManager stores the result as `slot.dataKey`. The consumer never sees `slotKey` or `cacheKey` — only `keyExtractor` is their contract.

Before Opt 4: React `key` = `dataKey` (keyExtractor result). Each scroll-out/in triggers Fiber DELETE+CREATE.
After Opt 4: React `key` = `slotKey`. Scroll-out/in triggers prop UPDATE. Fiber survives.

### Why sticky cells are excluded from the slot pool

Sticky cells are still children of `_contentView` (the scroll content view) — they are NOT outside the scroll view. `RNScrollCoordinatedView` uses KVO on `contentOffset` and applies `CATransform3D` to float the cell at the viewport edge. Being in the scroll content is required for the transform origin to be correct.

They are excluded from SlotManager for practical reasons:
1. They use a different native component (`RNScrollCoordinatedView` vs `RNMeasuredCell`). A slot cannot be recycled between these two types — different Fiber type forces a remount anyway.
2. The sticky pool is tiny (≤4 cells at once, managed by `STICKY_BUFFER_BEFORE/AFTER`). Recycling benefit is near-zero.
3. Sticky cells have their own windowing loop (`activeSlot ± buffer`) above the `scrollContent` IIFE. They are skipped in the main loop via `mountedStickySet`, so they never enter the slot path.

### Element cache (Opt 7) — what it skips and what it must not skip

`elementCacheRef` maps `slotKey → { element, gen, dataKey, cacheKey, measureOnly, item }`.

An element is reused if ALL of:
- `gen === renderGen` — no global rendering dep changed (`extraData`, `stickyConfigMap`, `effectiveLayout`, `viewportWidth`)
- `dataKey === prev.dataKey` — same item identity (slot not recycled)
- `cacheKey === prev.cacheKey` — same LayoutCache position key
- `measureOnly === prev.measureOnly` — visibility unchanged
- `item === prev.item` — same item object reference (content unchanged)

**The `item` reference check is critical.** Without it, if a consumer mutates an item's content while keeping the same ID (e.g. updating a counter), the `dataKey` stays the same, the cache says "unchanged", and the update is silently dropped — `MemoizedCellContent` never sees the new props.

### Consumer mutation contract

The element cache uses **reference equality** on the item object (`item === prev.item`). This means:

**Required**: When item content changes, produce a new object:
```typescript
// ✅ Correct — new object reference, cache misses, cell re-renders
setItems(prev => prev.map(it => it.id === 'x' ? { ...it, count: it.count + 1 } : it));

// ❌ Wrong — mutating in place, same reference, cache hits, update dropped
items[3].count++;
setItems([...items]);
```

**Escape hatch for content that can't be tracked by reference**: pass `extraData`. When `extraData` changes, `renderGen` bumps and all elements in the cache are invalidated, forcing a full re-render. Use this for shared state (e.g. selection map, theme) that affects many cells but isn't in the item objects themselves.

**Decision on `itemHasChanged` prop**: **Not added. Reference equality only.**

Rationale:
- FlatList and FlashList don't have `rowHasChanged` — consumers are already trained to produce new item objects on change. This is idiomatic React.
- An `itemHasChanged` prop introduces API surface, risk of slow/incorrect equality functions (e.g. deep equals on large objects every scroll frame), and the mental overhead of "is my equality function correct?" for consumers.
- The `extraData` escape hatch covers the main use case where referential comparison isn't enough: shared state that isn't in item objects (selection maps, theme, global counters).
- If a consumer mutates in place and forgets `extraData`, they get a silent no-update — the same behavior they'd get from `React.memo` with a broken comparator. This is a known, diagnosable failure mode, not a silent corruption.

**This decision is final.** Do not add `itemHasChanged`.

### renderGen — global element cache invalidation

`renderGen` is a monotonically increasing counter. When it bumps, every element in `elementCacheRef` is stale and must be re-created on the next render. It bumps when any of these change:

| Dep | Why it requires full invalidation |
|-----|-----------------------------------|
| `extraData` | Passed to `MemoizedCellContent` — affects all cells' rendered output |
| `stickyConfigMap` | Determines whether a cell is wrapped in `RNScrollCoordinatedView` vs `RNMeasuredCell` |
| `effectiveLayout` | Affects `computeCacheKey()` format and cell width computation |
| `viewportWidth` | Affects cell width prop on all cells |

When `renderGen` is stable, only slots whose individual state changed are re-rendered. This is the O(delta) property.

`renderGen` does NOT bump on scroll — that would defeat the purpose. Scroll changes `renderRange`, which changes which slots are active, but the per-slot check handles that via `dataKey`/`item` comparison.

---

## Key Identity: Single Source of Truth

### The Problem We Solved

When implementing the key pipeline, canonical keys (`sectionKey:rawKey`) were independently constructed in multiple places. Each construction site had to know the prefix format, and when one site drifted from the others — through a rewrite, an optimization pass, or a simple oversight — the mismatch was silent. The layout system kept running, but every LayoutCache lookup in `measuredHeightForItem` returned nothing, so every `prepare()` call fell back to estimated heights for all items.

The specific regression: `measuredHeightForItem` was correctly fixed in commit `089188f` to use `${sec.key}:${propKeyExtractor(item, index)}`. The Opt 4+7 rewrite reverted it to raw `propKeyExtractor(item, index)`. Nobody noticed because there was no single authoritative source the function could just READ from.

### The Rule (enforced since Opt 4+7 fix)

**`propKeyExtractor` is called exactly ONCE per item, in `layoutContext.sections[s].itemKeys` (CollectionView.tsx line ~1148):**

```typescript
itemKeys: propKeyExtractor
  ? s.data.map((item, ii) => `${s.key}:${propKeyExtractor!(item, ii)}`)
  : undefined,
```

Every other site READS from this pre-computed array. No other site invokes `propKeyExtractor`.

| Site | Pattern | Rule |
|------|---------|------|
| `layoutContext.itemKeys` | `${s.key}:${propKeyExtractor(item, ii)}` | **Only construction site** |
| `computeCacheKey()` | `layoutContext.sections[sk].itemKeys[ik]` | Read (model for all other sites) |
| `measuredHeightForItem` | `layoutContext?.sections[section]?.itemKeys[index]` | Read (was broken, now fixed) |
| `sectionedKeyExtractorCb` | `layoutContextRef.current?.sections[si]?.itemKeys[ii]` | Read via ref (was duplicating construction) |
| `apply()` reloadedKeys | map rawKey → canonical via layoutContextRef.current | Normalize caller-supplied keys |
| C++ `computeSectionFromCache` | receives keys[] from `list.ts params.keys` | Pass-through, no construction |

**Why `sectionedKeyExtractorCb` uses a ref**: It's a `useCallback` defined before `layoutContext` is computed. A `layoutContextRef` is kept in sync with `layoutContext` each render (assigned immediately after the `layoutContext` useMemo). The ref pattern lets the callback read the latest `itemKeys` without being in the `useCallback` dependency array.

**Verification rule**: After any significant refactor, grep for `propKeyExtractor` — it should appear only at the prop destructure and at the single `itemKeys` construction site. Any other call site is a violation.

### Key Format Reference

| Context | Format | Example |
|---------|--------|---------|
| Consumer's `keyExtractor` return value | Raw, consumer-defined | `"item-42"`, `"abc123"` |
| `layoutContext.itemKeys[i]` (sectioned) | `"${sectionKey}:${raw}"` | `"s0:item-42"` |
| `layoutContext.itemKeys[i]` (flat) | `undefined` (no itemKeys; positional keys used) | — |
| LayoutCache item entry | Same as itemKeys when provided; else `"${type}-${section}-${index}"` | `"s0:item-42"` or `"item-0-3"` |
| LayoutCache header/footer | `"item-${section}-header"` / `"item-${section}-footer"` | `"item-0-header"` |

---

## Height Stash API (survive fingerprint-triggered cache clear)

### The Problem

The list layout fingerprint includes `itemCount` per section. Any insert/delete → itemCount changes → fingerprint mismatch → `layoutCache.clear()`. This wipes all Yoga-measured heights. On the next `prepare()`, `computeSectionFromCache` falls back to `p.itemHeight` (the estimated height, e.g. 56px) for all items.

The MVC correction reads: `computeCorrection() = newAnchorY − snapshotAnchorY`. If the anchor was at Yoga-measured Y=4500 but after the clear it's placed at estimate-based Y=3200, the correction is −1300px — the user's view jumps 1300px upward. Same problem affects `scrollToItem` and `contentSize`.

### Why we can't just remove itemCount from the fingerprint

1. **Orphan item entries** — deleted items remain in the spatial index at stale positions. `processScroll` has no clamping on flat indices from spatial queries — orphans corrupt the render window range.
2. **Orphan separator entries** — after section shrinks, old `separator-0-22` etc. remain at stale Y positions that now overlap with S1's content.
3. **Index-based key collision** — `item-0-5` refers to a different data item after insert at 0. Without clear, `computeSections` reads the OLD item's measured height for the NEW item.
4. **apply() key mismatch** — without the clear, stale orphan entries accumulate (the `removeAttributes` calls in `apply()` were previously dead code due to key format mismatch).

### The Solution: Stash → Clear → Compute → ClearStash

Measured heights survive the clear via a temporary stash. The clear still happens (orphan cleanup), but heights are preserved.

**C++ API (LayoutCache):**
```cpp
void stashHeights();          // save {key → primary-axis size} for all Measured entries
double getStashedHeight(const std::string& key) const;  // returns -1 if not found
void clearStash();            // release stash memory
```

**JS call sequence (list.ts prepare()):**
```javascript
if (fp !== this._lastFingerprint) {
  nativeMod.layoutCache.stashHeights();  // save before clear
  nativeMod.layoutCache.clear();         // clean orphans
  this._lastFingerprint = fp;
}
nativeMod.listLayout.computeSections(sectionParams);
nativeMod.layoutCache.clearStash();      // release after compute
```

**C++ lookup sequence (ListLayout::computeSectionFromCache):**
```cpp
auto existing = _cache->getAttributes(key);
double sz;
if (existing) {
    sz = H ? existing->frame.width : existing->frame.height;
} else {
    double stashed = _cache->getStashedHeight(key);  // ← new fallback
    sz = (stashed > 0.0) ? stashed : p.itemHeight;
}
```

**Thread safety note**: The stash is only accessed from the JS thread, synchronously across `stashHeights() → clear() → computeSections() → clearStash()`. No mutex needed for the stash itself.

**Rotation / container-size change**: These also change the fingerprint (width/height included). The stash correctly preserves the measured heights from before the reflow. `computeSections` will use the stashed heights as starting positions and Yoga will re-measure cells that changed size.

---

## Layout & Measurement Pipeline — Step-by-Step Walkthrough

This section traces how heights flow through the system across three lifecycle phases. Read this before touching any part of the MVC correction, height stash, or layout engine paths.

### Phase 1: Initial Render (no measured heights yet)

```
React renders CollectionView
  └─ layoutContext useMemo fires (viewportWidth, sections, data.length deps)
       └─ prepare useMemo fires
            ├─ list.ts prepare():
            │     fingerprint = containerWidth × containerHeight | itemCount per section
            │     fingerprint differs from "" → stashHeights() [nothing to stash]
            │                                 → clear() [nothing to clear]
            │     sectionParams.itemHeights[] = [] (no cache entries → measuredHeightForItem returns undefined)
            │     computeSections(sectionParams) → computeSectionFromCache() per section
            │       item loop fallback chain: cache miss → stash miss → p.itemHeights miss → p.itemHeight (SCALAR ESTIMATE)
            │       All items placed at estimated heights (e.g. every item = 56px)
            └─ nativeMod.layoutCache.clearStash()

Fabric commit → ShadowNode.layout()
  └─ Phase 1: reads positions from LayoutCache (estimate-based)
  └─ Phase 2: Yoga measures each cell's actual height
              deltas = [(key, estimatedH, yogaH), ...]   ← almost always non-empty
  └─ Phase 3: snapshotAnchorIfNeeded() → NO-OP (_correctionConsumed=false but _mvcEnabled=false on first render)
              engine->applyMeasurements(deltas, *cache)
              → ListLayout::applyMeasurements sorts all items by Y, accumulates delta shift
              → writes corrected positions back to LayoutCache
              → native updateState: fires → JS onScroll fires → processScroll recomputes render window
```

**Key point**: After the first layout, ALL items in the render+measure range have Yoga-measured heights in the LayoutCache (`sizingState=Measured`). Items outside that range still have `sizingState=Placeholder` with estimate heights.

### Phase 2: Scroll

```
UIScrollViewDelegate.scrollViewDidScroll:
  └─ cache->setScrollOffset(x, y, timestamp) [UI thread, no JS involved]

onScroll event → JS
  └─ nativeWindowController.processScroll(scrollY, contentH, ...) [JSI, UI thread]
       └─ updates renderFirst/renderLast (O(1) arithmetic)
  └─ if renderRange changed → setState → React re-render
       └─ SlotManager.sync() → slots update
       └─ prepare useMemo fires IFF layoutContext changed (usually NOT — data didn't change)
```

**Key point**: Scroll DOES NOT re-run `prepare()` unless the viewport dimensions change. The LayoutCache persists across scroll events. New cells entering the render window are rendered with `Activity=hidden` in the measure range first, then Yoga measures them → `applyMeasurements` cascades → positions update.

### Phase 3: Data Mutation (insert/delete)

```
App calls CollectionView insert/delete
  └─ data changes → React re-render
       └─ layoutContext useMemo fires (data.length in deps)
            └─ prepare useMemo fires
                 ├─ MVC: snapshotAnchor()
                 │    ← finds first item at or below scrollY in old cache
                 │    ← stores {anchorKey, anchorY}
                 │    ← resets _correctionConsumed = false (new transaction)
                 │
                 └─ list.ts prepare():
                      sectionParams.itemHeights[] built from measuredHeightForItemRef
                        → reads from LayoutCache by key → EMPTY (cache was just cleared)
                        → returns undefined for all items → itemHeights stays []

                      fingerprint changed (itemCount changed) → stashHeights() + clear()
                        ← stashHeights() saves {key → measured height} for all Measured entries
                        ← clear() wipes the cache (orphan cleanup)

                      computeSections(sectionParams)
                        → computeSectionFromCache() per section (FIXED: was computeSection)
                           item loop:
                             cache miss (just cleared)
                             → stash hit → uses MEASURED height  ✓  ← KEY FIX
                             → (if no stash) p.itemHeights[i]   (estimate, from JS)
                             → (if no itemHeights) p.itemHeight  (scalar estimate)

                      clearStash()

Fabric commit → ShadowNode.layout()
  └─ applyMeasurements: deltas for cells in render range (Yoga re-measures)
  └─ snapshotAnchorIfNeeded():
       _hasAnchor=true (JS already snapshotted) → SKIP
  └─ cache positions updated → native updateState:
       └─ computeCorrection()
            newAnchorY = cache.getAttributes(anchorKey).frame.y  (from stash-based layout)
            correction = newAnchorY - snapshotAnchorY
            ← with stash fix: newAnchorY ≈ snapshotAnchorY → correction ≈ 0  ✓
            ← without fix: newAnchorY was estimate-based → large wrong correction
            _correctionConsumed = true  (prevents re-arming during scrollTo)

       └─ layoutSubviews: applies _pendingMVCCorrection to contentOffset
```

---

## MVC Correction Bugs — Root Causes & Fixes

### Bug A: Delete → small shift (computeSections used wrong path)

**Root cause**: `computeSections()` was calling `computeSection()` (fresh path) which ignores the stash entirely. After `cache.clear()`, all item heights reverted to scalar estimates. The MVC correction was `newEstimateY - oldMeasuredY` → non-zero → visible shift.

**Fix** (`cpp/layouts/ListLayout.cpp`):
```cpp
// computeSections() now calls computeSectionFromCache() for every section.
// Fallback chain: cache hit → stash hit → p.itemHeights[i] → p.itemHeight
// computeSection() (fresh path) is no longer called from computeSections().
primary = computeSectionFromCache(sections[s], s, primary);  // ← was computeSection
```

**Why computeSectionFromCache is safe for first layout**: On first layout there's no cache AND no stash, so all three fallbacks miss → falls through to `p.itemHeight` (scalar). Same result as `computeSection`. No regression.

### Bug B: Insert → scrollToTop doesn't reach y=0 (MVC re-arming during animation)

**Root cause**: After the insert correction, `_hasAnchor = false` (consumed). During the scrollTo animation, new cells entered the render range → Yoga measured them → deltas in ShadowNode → `snapshotAnchorIfNeeded()` re-armed (hasAnchor=false, mvcEnabled=true) → `applyMeasurements` cascaded → `computeCorrection()` fired → `setContentOffset:animated:NO` cancelled the ongoing scrollTo animation.

**Fix** (`cpp/LayoutCache.h` + `.cpp`):
```cpp
// _correctionConsumed = true after computeCorrection().
// snapshotAnchorIfNeeded() checks it and skips → no re-arm during scrollTo.
// snapshotAnchor() resets it (new transaction).
bool _correctionConsumed = false;
```

**Why this is correct**: The correction is conceptually one-shot per data mutation. The `snapshotAnchor()` call in the JS prepare useMemo marks the start of each mutation transaction and resets the flag. Re-arming during an animated scroll is always wrong — the anchor position at the START of the mutation is what matters for offset preservation.

---

## MVC Trace Logging

Three flags enable verbose MVC lifecycle tracing. All default off:

**JS (`CollectionView.tsx`):**
```typescript
const RNCV_MVC_TRACE = false;  // logs: snapshotAnchor call
```

**JS (`src/layouts/list.ts`):**
```typescript
const RNCV_MVC_TRACE_LAYOUT = false;  // logs: fingerprint change, stash/clear, first 5 heights per section
```

**C++ (`LayoutCache.cpp`, `ListLayout.cpp`, `CollectionViewContainerShadowNode.cpp`):**
```
RNCV_ENABLE_MVC_TRACE = 0  // logs: stashHeights count, cache.clear count,
                            //       snapshotAnchor found/not-found,
                            //       snapshotAnchorIfNeeded skip reason,
                            //       computeCorrection delta + consumed,
                            //       computeSectionFromCache height source per item,
                            //       applyMeasurements delta count
```

**ObjC (`RNCollectionViewContainerView.mm`):**
```
RNCV_ENABLE_MVC_TRACE = 0  // logs: updateState computeCorrection value,
                            //       layoutSubviews pendingMVCCorrection,
                            //       scrollTo target coordinates
```

To enable all trace: set all four flags to `true`/`1` and clean-build. Expected log sequence for a delete:
```
[MVC-TRACE] prepare: calling snapshotAnchor() (MVC enabled, correctionConsumed reset)
[MVC-TRACE] snapshotAnchor: correctionConsumed reset, hasAnchor was=NO mvcEnabled=YES
[MVC-TRACE] snapshotAnchor: FOUND key=item-0-5 pos=280.0 scrollOffset=280.0
[MVC-TRACE] prepare: fingerprintChanged=true sections=1 totalItems=97
[MVC-TRACE] prepare: stashHeights + clear (fingerprint changed)
[MVC-TRACE] stashHeights: 52 entries stashed (of 60 total)
[MVC-TRACE] cache.clear: removing 60 entries
[MVC-TRACE] computeSections begin: 1 sections horizontal=0
[MVC-TRACE] computeSectionFromCache s[0][0] key=item-0-0 source=stash sz=62.0
[MVC-TRACE] computeSectionFromCache s[0][1] key=item-0-1 source=stash sz=56.0
...
[MVC-TRACE] snapshotAnchorIfNeeded: SKIP hasAnchor=YES
[MVC-TRACE] applyMeasurements: 3 deltas first={key=item-0-2 old=56.0 new=62.0}
[MVC-TRACE] computeCorrection: key=item-0-5 oldPos=280.0 newPos=280.0 correction=0.0 → correctionConsumed=YES
[MVC-TRACE] updateState: computeCorrection=0.0 pendingMVCBefore=0.0
[MVC-TRACE] layoutSubviews: pendingMVCCorrection=0.0 offset=(0.0,280.0)
```

---

## Unit Tests for Layout Calculation + MVC

Located in `packages/rn-collection-view/cpp/tests/`. Pure C++ tests, no native module required.

### Layout Calculation Parity (`ListLayoutTest.cpp`)

Tests that verify all three layout paths produce consistent results for identical inputs:

| Test | Verifies |
|------|---------|
| `FreshAndCacheIdentical` | `computeSection` and `computeSectionFromCache` produce identical Y positions given same item heights |
| `StashFallback_UsesStashedHeight` | After `stashHeights()` + `clear()`, `computeSectionFromCache` uses stashed heights, not estimates |
| `FallbackChain_Cache_Stash_ItemHeights_Scalar` | Tests each level: cache hit → stash hit → itemHeights[i] → scalar |
| `InsertAtStart_PositionsShift` | Insert 3 items at index 0 → items 3+ shift by exactly 3 × (itemHeight + spacing) |
| `DeleteAtStart_PositionsShiftUp` | Delete 3 items from index 0 → items below shift up by correct amount |
| `InsertInMiddle_PreservedBefore_ShiftedAfter` | Items before insertion point: positions unchanged; items after: shifted |

### MVC Correction Math (`MVCCorrectionTest.cpp`)

| Test | Verifies |
|------|---------|
| `SnapshotThenCorrection_ZeroIfUnchanged` | snapshotAnchor → no position change → computeCorrection returns 0 |
| `SnapshotThenCorrection_DeltaOnShift` | snapshotAnchor → positions shift by D → computeCorrection returns D |
| `CorrectionConsumed_PreventsRearm` | After computeCorrection, _correctionConsumed=true → snapshotAnchorIfNeeded no-ops |
| `SnapshotAnchor_ResetsCorrectionConsumed` | snapshotAnchor() resets _correctionConsumed → subsequent snapshotAnchorIfNeeded can fire |
| `AnchorDeleted_ReturnsZero` | Anchor key deleted before computeCorrection → returns 0 (no crash) |
| `MVCDisabled_SnapshotAnchorIfNeeded_NoOp` | _mvcEnabled=false → snapshotAnchorIfNeeded always skips |

### applyMeasurements Cascade (`ApplyMeasurementsTest.cpp`)

| Test | Verifies |
|------|---------|
| `SingleDelta_ShiftsBelow` | One item height change → all items below shift by exact delta, items above unchanged |
| `MultipleDelta_AggregateShift` | Multiple items change → aggregate shift accumulates from top to bottom correctly |
| `ItemAboveFirstDelta_Unchanged` | Items before the first delta: position untouched |

### JS Unit Tests (`SlotManagerTest.ts`, `LayoutKeyTest.ts`)

Run with Jest (no native module; cache methods are mocked).

| Test | Verifies |
|------|---------|
| `SlotManager_Phase3CaseB_NoDuplicateRender` | Phase 3 Case B guard prevents `dataKeyToSlot` corruption on insert→delete in same render |
| `SlotManager_Recycle_CorrectType` | Slots only recycled within same itemType pool |
| `SectionedKeyExtractor_FlowsFromLayoutContext` | `sectionedKeyExtractorCb` reads `layoutContextRef.current.itemKeys`, not reconstructs |

---



The library is NOT in `node_modules`. Auto-linking and codegen are driven by:

- `example/react-native.config.js` — declares `riff` dependency with `root: path.resolve(__dirname, '../')`
- `use_native_modules!` in Podfile reads this and finds `RNCollectionView.podspec`
- Codegen finds `codegenConfig` in `packages/rn-collection-view/package.json` and generates `RNCollectionViewSpec` headers

If you remove or break `react-native.config.js`, pod install will print `Removing RNCollectionView` and the TurboModule won't register at runtime.
