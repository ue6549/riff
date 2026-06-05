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

**Yoga is the only authority for actual dimensions. Every consumer-provided size — from every API, in every layout — is an estimate used for initial positioning only.**

This applies universally across all layout engines and layout types, including JS layouts:

| Layout | Consumer APIs (all estimates) |
|--------|-------------------------------|
| List | `estimatedItemHeight`, `estimatedHeightForItem(i,s,w)` |
| Grid | `estimatedRowHeight`, `estimatedHeightForItem(i,s,w)` |
| Masonry | `estimatedHeightForItem(i,s,w)` |
| Flow | `estimatedSizeForItem(i,s,w)` (width and height) |
| JS layouts (radial, hex, carousel3D, spiral, custom) | `estimatedItemSize`, `estimatedItemLayoutAttributes`, or any size written to LayoutCache in `prepare()` |
| All | `estimatedHeaderHeight`, `estimatedFooterHeight` |

**There are no "fixed size" APIs.** Even when a JS layout writes a specific `frame.width/height` in `prepare()`, those values are estimates that seed the LayoutCache. Yoga measures the actual rendered content and is the ground truth. The layout's pre-computed sizes are an optimization — they let the first frame be positioned correctly without waiting for Yoga's first pass. They are not guarantees.

**API naming rule (ENFORCED):** All layout size/dimension APIs visible to consumers must have the `estimated` prefix. Never expose `itemHeight`, `heightForItem`, `sizeForItem`, or any other unqualified size callback. The prefix communicates the contract: "this is your best guess; Yoga decides."

Every layout engine uses the same priority chain in `prepare()`:

```
Yoga-measured (via measuredHeightForItem / LayoutCache Measured entry)
  → Consumer callback (estimatedHeightForItem / estimatedSizeForItem)
    → Scalar prop (estimatedItemHeight / estimatedRowHeight)
      → Hardcoded fallback (44)
```

The ShadowNode's `correctChildPositionsIfNeeded()` diffs Yoga-measured dimensions against LayoutCache entries and calls `engine->applyMeasurements()` to cascade corrections. This is what makes estimates converge to reality — typically within one frame.

**Rule**: No code path may assume consumer-provided dimensions are final. Any optimization that bypasses re-measurement must use cache version or `sizingState == Measured` — never prop values or layout-provided sizes.

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
| `effectiveLayout` | Affects `computeCacheKey()` format and cell width computation |
| `viewportWidth` | Affects cell width prop on all cells |

**`stickyConfigMap` is intentionally excluded from renderGen deps.** Sticky cells are rendered outside the slot-based element cache loop (prepended separately before the main loop). Including `stickyConfigMap` in renderGen caused a cascade: every Yoga measurement bumped `layoutCacheVersion` → rebuilt `stickyConfigMap` with a new Map reference → bumped `renderGen` → invalidated ALL element cache entries → O(window_size) re-render with ~30 JSI calls on every scroll frame where a measurement occurred. `stickyConfigMap` still depends on `layoutCacheVersion` for correctness (sticky positions must reflect measured item heights); it just no longer triggers `renderGen`.

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
                 │
                 └─ list.ts prepare():
                      sectionParams built (including itemHeights[] from measuredHeightForItemRef)
                        → reads from LIVE LayoutCache by key (cache still populated at this point)
                        → returns measured heights for all visible items  ✓

                      fingerprint changed (itemCount changed) → stashHeights() + clear()
                        ← stashHeights() saves {key → measured height} for all Measured entries
                        ← clear() wipes the cache (orphan cleanup)
                        NOTE: itemHeights[] is populated BEFORE stashHeights()+clear(),
                              so it reads from the live cache, not an empty one.

                      computeSections(sectionParams)
                        → computeSectionFromCache() per section (FIXED: was computeSection)
                           item loop:
                             cache miss (just cleared)
                             → stash hit → uses MEASURED height  ✓  ← KEY FIX
                             → (if no stash) p.itemHeights[i]   (estimate from JS, built above)
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

**Fix** (`ios/RNCollectionViewContainerView.mm` + `cpp/LayoutCache.h/.cpp`):
```objc
// Native view sets _programmaticScrollActive=true when animated scrollTo begins.
// Cleared in all scroll-end delegates (scrollViewDidEndScrollingAnimation:,
// scrollViewDidEndDecelerating:, scrollViewDidEndDragging:willDecelerate: when !decelerate).
// snapshotAnchorIfNeeded() skips when _programmaticScrollActive=true.
```

**Why clearing in all scroll-end delegates**: If the user touches the screen during a scrollTo, UIKit cancels the animation and `scrollViewDidEndScrollingAnimation:` may never fire. Clearing in all scroll-end paths prevents the flag from getting permanently stuck.

**Why not `_correctionConsumed`**: The old flag was permanent — set by `computeCorrection()` and only reset by `snapshotAnchor()`. This caused Bug 1: after the initial render's correction fired, `_correctionConsumed = true` permanently blocked `snapshotAnchorIfNeeded()` for all subsequent size changes (no JS mutation → no `snapshotAnchor()` call → flag never reset). `_programmaticScrollActive` is transient and event-driven — it only blocks during the exact window of an animated scrollTo.

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
[MVC-TRACE] prepare: calling snapshotAnchor() (MVC enabled)
[MVC-TRACE] snapshotAnchor: hasAnchor was=NO mvcEnabled=YES
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
[MVC-TRACE] computeCorrection: key=item-0-5 oldPos=280.0 newPos=280.0 correction=0.0
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

---

## LayoutCache Architecture

### What it is

`LayoutCache` is a C++ in-memory store (hash map + spatial index) that is the **single source of truth** for every cell's position, size, and state. It lives in C++ (`cpp/LayoutCache.h/.cpp`) and is shared between:

- **JS thread** — reads positions (`attributesForItem`, spatial queries) to compute render windows; writes initial estimates during `prepare()`
- **ShadowNode (Fabric BG thread)** — writes corrected heights after Yoga measures cells; reads all positions to diff against Yoga output and cascade corrections
- **Native UI thread (ObjC)** — reads final positions in `updateState:` to set `child.frame` on every cell

Access is guarded by a single mutex. All three threads can be in-flight simultaneously.

### Why it exists (not in React state, not in JS)

Storing positions in React state would mean every position change triggers a React commit. During scroll, positions update constantly — this would serialize everything through the JS thread and block native scrolling. The LayoutCache sits at the C++ JSI boundary: native can write positions without touching React, and JS reads via a thin JSI wrapper with a single mutex acquisition.

### Version counter

Every `setAttributes()` call increments `_version`. Callers use this to detect staleness without comparing attribute contents. `processScroll` returns the current version; JS compares it against `lastCacheVersionRef` and bumps `layoutCacheVersion` state when it changes.

### Spatial index

A bucket-based 2D spatial index (`SpatialIndex`) sits alongside the hash map. When `setAttributes()` is called, the frame is inserted into the appropriate buckets. `getAttributesInRect()` queries only the intersecting buckets — O(buckets_intersected + k) instead of O(n). Used by `processScroll` to find the render and visible windows.

### SizingState enum

Each entry has a `SizingState`:
- `Placeholder` — estimated height, Yoga hasn't measured yet
- `Measured` — Yoga has measured; this height is authoritative
- `Dirty` — previously measured but data changed; re-measure pending

`applyMeasurements` in the ShadowNode only triggers position cascades when a `Measured` height differs from the Yoga output by more than 0.5px.

---

## JS Scroll Hot Path — Architecture and Optimizations

### How a scroll frame works (simplified)

```
User scroll
  │
  ├─ Native: scrollViewDidScroll: (UI thread)
  │    setScrollOffset(x, y, CACurrentMediaTime())   [LayoutCache, writes velocity internally]
  │    emits throttled onScroll event to JS
  │
  └─ JS: onScroll handler
       processScroll(vpH, vpW, isH, renderMult, ...)  [1 JSI call → C++]
         └─ C++: reads scroll offset + velocity from LayoutCache
                 runs spatial query (render rect + visible rect)
                 applies budget
                 computes measure-ahead range
                 computes blank area
                 returns { renderFirst, renderLast, visibleFirst, visibleLast,
                           measureFirst, measureLast, cacheVersion, blankBefore, blankAfter }
       checks cacheVersion → may setLayoutCacheVersion(v+1)
       checks renderRange changed → may setRenderRange(...)
       React commit (if state changed) → scrollContent IIFE re-runs
         └─ SlotManager.sync(first, last) → computes slot assignments O(delta)
            element cache loop → O(delta) cell renders (hits: renderGen unchanged)
```

### Per-scroll JSI call count

| When | JSI calls |
|------|-----------|
| Stable scroll (band skip — cache version unchanged, offset in band) | **1** (processScroll returns cached result immediately in C++) |
| Active scroll (range moving) | **1** processScroll + ~2N sticky JSI calls per re-render (N = sticky items) |
| Measurement flush (new cells Yoga-measured) | **1** processScroll + rebuild: ~2N sticky + ~2S section-height JSI calls (S = sections) |

FlashList comparison: **0** JSI calls per scroll (pure JS binary search returning 2 integers).

### Optimizations implemented (Opt 1–7)

#### Opt 1: C++ spatial query instead of JS spatial marshalling
**Before**: JS called `getAttributesInRect(rect)` which returned ~30 JSI objects each with ~10 properties — ~300 JSI property constructions per scroll tick.
**After**: The spatial query runs entirely inside C++ `processScroll`. Only 4-8 integers cross the JSI boundary.
**How found**: Per-frame cost analysis comparing Riff vs FlashList — this was the #1 JS thread cost.

#### Opt 2: Batched processScroll — one JSI call per scroll tick
**Before**: 4-6 separate JSI calls per scroll: version check, 2× spatial query, budget, measure range, blank area.
**After**: Single `processScroll()` call returns everything.
**How found**: Same analysis — each JSI crossing is ~100ns, but the aggregate was 400-600ns of pure overhead before any useful work.

#### Opt 6: C++ stable-band skip (early return)
**Before**: Every scroll event ran the full spatial query.
**After**: `processScroll` records a ±¼-viewport "stable band". If `cacheVersion` unchanged AND offset within band, returns cached result immediately (~200ns vs 50-200μs for full query).
**How found**: Observation that during momentum scroll most ticks don't change render indices — O(1) check to avoid all O(buckets+k) work.

#### Opt 4: SlotManager cell recycling
**Before**: React key = `keyExtractor` result. Scrolling a cell off-screen → Fiber DELETE. New cell on-screen → Fiber CREATE. Mount cost ~1-5ms per cell.
**After**: React key = `slotKey` (stable: "slot_0", "slot_1"). SlotManager maintains a pool of retired slots. When a new cell is needed, a pooled slot is reclaimed — React sees a prop UPDATE on an existing Fiber, not CREATE/DELETE.
**How found**: Observation that FlashList v2's recycled-key approach means Fiber UPDATE (cheap) not CREATE (expensive). SlotManager.ts is the Riff equivalent.

#### Opt 7: Element cache — O(delta) renders
**Before**: Every scroll re-render rebuilt React elements for all ~30 cells in the window (even unchanged ones). React's reconciler efficiently diffs, but `React.createElement` for 30 cells is still O(window_size) JS work.
**After**: `elementCacheRef` maps `slotKey → ReactElement`. For unchanged slots (same `gen`, `dataKey`, `cacheKey`, `measureOnly`, `item` reference), the exact same `ReactElement` object is reused — React sees referential equality and **skips diffing entirely**, not just skips DOM work.
**How found**: Opt 4 enabled this: stable `slotKey` means the same slot appears in consecutive renders. Cache hit = zero React work for that cell.

**Bug discovered (2026-04-13)**: `stickyConfigMap` was in `renderGen` deps. `stickyConfigMap` useMemo depends on `layoutCacheVersion`. Every Yoga measurement bumped `layoutCacheVersion` → new Map reference → `renderGen++` → all 30 cache entries invalidated → O(window_size) full re-render on every measurement frame. Fix: remove `stickyConfigMap` from `renderGen` deps (sticky cells are rendered outside the element cache loop anyway).

#### Opt 3 (deferred): Transform-based cell positioning
**Why deferred**: Analysis showed `setFrame:` for position-only changes already calls `setCenter:` without triggering `layoutSubviews`. Gain smaller than estimated. Also: `layer.transform` breaks `hitTest:withEvent:` since the view's natural frame is at `(0,0)`. Would need `hitTest:` override in `_contentView`.

#### Opt 5 (deferred): Flat Float64Array from spatial queries
**Why deferred**: Only applies to custom layouts with `needsSpatialQuery: true`. List/grid/masonry already use binary search inside `processScroll`. Low priority.

### Remaining bottleneck (known, not yet fixed)

Every `layoutCacheVersion` bump (Yoga measurement during scroll) triggers a full React re-render that:
1. Rebuilds `stickyConfigMap` useMemo — 2N-5N JSI calls (N = sticky items)
2. Rebuilds `sectionHeights` useMemo — ~2S JSI calls (S = sections)
3. Calls the range `useEffect` — 1 processScroll JSI call
4. Triggers Fabric re-commit via `layoutCacheVersion` native prop

This happens every frame where a new cell enters the render window and gets Yoga-measured. After all cells are measured (stable scroll through already-seen content), version stops bumping and this overhead disappears.

**What this means in practice**: Initial scroll through unseen content (first time): expensive. Repeat scrolling through already-measured content: cheap (stable-band skip + element cache hits).

### Diagnostic: element cache hit counter

Enable with `RNCV_DEBUG_LOGS = true` in CollectionView.tsx. Filter logs by `[RNCV-CACHE]`.

```
[RNCV-CACHE] hits=28 misses=2 total=30 hitRate=93% renderGen=5 lcv=14
```

- **hitRate** — percentage of cells that used cached elements (target: >90% during steady scroll)
- **misses** — cells actually re-rendered (expected: only newly entering/exiting cells)
- **renderGen** — how many times global cache deps changed (should be low)
- **lcv** — layoutCacheVersion (bumps on Yoga measurements; high during initial scroll)

If `hitRate` < 80% during steady scroll, something is causing spurious `renderGen` bumps. If `hitRate` > 90% but FPS is still bad, the bottleneck is the JSI overhead from `stickyConfigMap`/`sectionHeights` rebuilds (not the element creation cost).

### onBlankArea — zero-cost in production

Blank area computation happens inside C++ `processScroll` at zero marginal cost (uses the `renderAttrs` vector already in hand). The JS callback (`onBlankArea` prop) only fires if the consumer provides the prop. Use `onBlankArea` only in debug/profiling builds:

```typescript
onBlankArea={__DEV__ ? myBlankAreaHandler : undefined}
```

---

## Performance Investigation Results (2026-04-12 → 2026-04-16)

### Summary

JS FPS on the Feed tab (vertical list, variable-height items, 1000 items) improved from single-digit/teens to **~60fps**, achieving parity with FlashList v2. The investigation spanned scroll hot path optimization, React render cost reduction, Fabric/Yoga measurement analysis, and window tuning.

### Root Causes Found & Fixes Applied

**1. Element cache invalidation cascade (CRITICAL)**
`stickyConfigMap` was in `renderGen` deps. Every Yoga measurement bumped `layoutCacheVersion` → new `stickyConfigMap` Map reference → `renderGen++` → ALL element cache entries invalidated → O(window_size) re-render on every scroll frame with a measurement. Fix: remove `stickyConfigMap` from `renderGen` deps. Sticky cells are rendered outside the slot-based element cache loop.

**2. PerfHUD causing parent re-renders**
The Feed comparison tab used `useState` for velocity and contentHeight, passed as props to PerfHood. Every scroll event → `setVelocity()` → parent re-render → cascaded into both Riff and FlashList. Fix: moved to refs + getter callbacks. PerfHood reads metrics on its own 500ms timer.

**3. PerfHUD internal rAF loop**
`usePerformanceMetrics()` ran `requestAnimationFrame` on every JS frame plus `setInterval` every 500ms with `setState`. Was measuring performance while degrading it. Fix: added `disabled` parameter that skips all timers.

**4. SlotManager.sync() O(window_size) on every render**
No short-circuit when inputs unchanged. For 78 slots at 60fps = 4680 wasted iterations/sec. Fix: cache previous inputs, return same Map reference in O(1) when first/last/measureFirst/measureLast/dataLength match.

**5. Decoration JSI queries on every render**
`getAttributesInRect(decoRect)` called in the scrollContent IIFE on every render even when nothing changed. Fix: cache by layoutCacheVersion + scroll position.

**6. useLayoutEffect unconditional setRenderRange**
Called `setRenderRange(freshObject)` without range-changed guard → React always treated as state change → forced second re-render per lcv bump. Fix: added `rangeChanged` guard matching the onScroll handler.

**7. setAttributes unconditional version bump**
`_version++` on every `setAttributes()` even if frame unchanged. During applyMeasurements cascade, items that didn't move bumped version, defeating the stable-band skip. Fix: only bump on actual frame change.

**8. measureAhead invisible cell creation cost (CRITICAL)**
`measureAhead=2.0` mounted extra cells beyond the render window with `Activity=hidden`. Activity=hidden suppresses painting but NOT Fabric ShadowNode creation. Each invisible cell's `<Text>` elements triggered full `ParagraphShadowNode` prop parsing (~1ms per Text). This doubled per-frame Fabric cost. Fix: `measureAhead=0` as default. Cells get Yoga-measured when they enter the render range. With recycling (Opt 4), pre-measurement is unnecessary.

**9. Window size too large + velocity-adaptive expansion**
Defaults `mountedWindowSize=5.0`, `renderMultiplier=1.0` → up to 78-83 mounted cells. Velocity-adaptive leadBoost expanded the window up to 5× viewport ahead during fast scroll. Fix: `mountedWindowSize=2.0`, `renderMultiplier=0.5`, velocity cap `min(1.5, speed)`.

**10. Codex debug logging in C++ hot path**
External agent added file I/O logging (`std::ofstream`) in `CollectionViewModule::get()` — every JSI property access wrote to disk. This ran hundreds of times per second during scroll. Fix: removed all debug logging.

### Architectural Decisions

**Binary search for sorted layouts:** `processScroll` now accepts a `sorted` boolean. When true, uses `LayoutCache::findRangeByPrimary()` — O(log n) binary search on a lazy-sorted position index, single mutex acquisition, zero struct copies. Falls back to spatial queries (`getAttributesInRect`) when `sorted=false`. All built-in layouts (list, grid, masonry, flow) use binary search. Only custom layouts with `needsSpatialQuery=true` use spatial queries.

**flatIndex on LayoutAttributes:** Each `LayoutAttributes` now carries a precomputed `flatIndex` set by the layout engine during `prepare()`. Eliminates the `toFlatIdx` lambda in `processScroll` that recomputed section offsets for every item on every scroll frame.

**Window defaults with recycling:** With cell recycling (SlotManager, Opt 4), large buffers are counterproductive — each cell entering the window still costs renderCell + Fabric creation. Smaller windows (2× viewport) with fast recycling achieve better FPS than large windows (5×) without recycling.

**Cells-first JSX order reverted:** Attempted rendering cells before decorations to prevent Yoga height starvation. This broke sticky header/footer initialization (RNScrollCoordinatedView needs to be in the Fabric tree before cells for KVO setup). Reverted to original order: `{decorationElements}{stickyHeaderCells}{stickyFooterCells}{cells}`.

### Instruments Profiler Findings

Time Profiler on Feed tab fast scroll showed:
- `ParagraphShadowNode::cloneProps` (757ms / 2.5%) — Fabric text prop parsing for `<Text>` elements. Framework code, not ours.
- `createNode` (1.75s / 5.8%) — creating new ShadowNodes when cells enter the window.
- `Hermes interpretFunction` (4.52s self-time / 15.1%) — JS bytecode execution (React reconciliation, component function, hooks).
- The dominant cost during scroll is React/Fabric framework overhead per cell, not our C++ code.

### Known Issues

**Horizontal list cross-axis height bounce:** Without a fixed container height, horizontal list oscillates between content-determined and full-screen height. `_maxSectionCrossHeight` (never-shrink) and fingerprint exclusion of `containerHeight` for horizontal don't fully resolve it. The layout loop is: measure cells → cross-axis height changes → container resizes → layoutContext changes → re-render → re-measure. Needs dedicated investigation.

### Change C — Eliminate per-cell JSI in renderCell (DONE, 2026-04-16)

`processScroll` now returns a flat `number[]` of `[x, y, w, h]` per item alongside the indices. `renderCell` reads `cellWidth` and `attrHeight` from this array (`frameDataRef`) with plain JS array indexing — zero JSI. Falls back to JSI for indices outside the range (sticky cells) or when frame data is stale (see below).

**`frameDataRef.gen` guard (insert/delete bug fix, 2026-04-16):** `frameDataRef` carries a `gen` field equal to the `renderGen` when the data was written. `renderCell` skips the frame data cache if `fd.gen !== renderGen`. Without this, stale frame data (e.g. footer at flat index 19 from before an insert) bleeds into items that shift into those flat indices after the insert, giving them full-section width instead of column width. The JSI fallback reads from the freshly-recomputed LayoutCache and is always correct.

### Change F — Defer prefetch/evict off scroll hot path (DONE, 2026-04-16)

Prefetch/evict loops now run in a `setImmediate` with coalescing (`pendingPrefetchRef`). The synchronous scroll handler only updates `prevPrefetchRangeRef` eagerly; the actual keyExtractor iteration is deferred off the hot path.

---

## Cell Resize Patterns

### The problem

When a cell changes size — either because item data changed or because internal component state changed — Riff needs to:
1. Clear the stale measured height from LayoutCache for that key
2. Bump `layoutCacheVersion` so Fabric clones the container ShadowNode
3. Let Yoga re-measure the cell at its new natural height
4. Cascade the position delta to all downstream items

Without step 1+2, the cell stays at its old height until it is scrolled out of the render window and back in.

### Why local `setState` inside a cell is not enough

When a cell calls `setState` internally (e.g. an expand/collapse toggle in `renderItem`), Fabric processes the update within that cell's fiber subtree. `CollectionViewContainerShadowNode` is **not** re-cloned — the container's structural output (its children array) is unchanged. This means `layout()` on the container never fires, `correctChildPositionsIfNeeded()` never runs, and the stale measured height stays in LayoutCache. The cell renders at the new height visually, but the layout engine still sees the old height for scroll offset corrections.

This parallels UIKit: `UICollectionViewLayout` is also decoupled from cell content changes. Apps must call `invalidateLayout()` explicitly. Riff's equivalent is `ref.current.invalidateKeys(keys)`.

### The correct pattern: `invalidateKeys` + data mutation

```tsx
const cvRef = useRef<RiffHandle<MyItem>>(null);

const toggleExpand = useCallback((id: string) => {
  // 1. Update item data (triggers estimatedHeightForItem to return new size)
  setItems(prev => prev.map(item =>
    item.id === id ? { ...item, expanded: !item.expanded } : item));
  // 2. Clear LayoutCache entry + bump layoutCacheVersion → forces ShadowNode layout()
  cvRef.current?.invalidateKeys([id]);
}, []);
```

Both state updates are batched by React 19 into one commit. On the next Fabric pass:
- `layout()` fires on `CollectionViewContainerShadowNode`
- Yoga re-measures the cell (item data already updated → correct natural height)
- `correctChildPositionsIfNeeded()` detects the height delta
- Layout engine cascades the delta to all downstream items

The key passed to `invalidateKeys` must match the value returned by `keyExtractor` for that item — the same key used throughout the LayoutCache.

### `invalidateAt` for index-based invalidation

If you only have an index (not the key), use `ref.current.invalidateAt([index])`. It translates indices to keys via `keyExtractor` and calls the same LayoutCache eviction + version bump.

### Why `extraData` is the nuclear option

Changing `extraData` forces a re-render of ALL visible cells — regardless of what changed. Every cell passes through `MemoizedCellContent`'s memo check; since `extraData` is in props, all cells re-render. `invalidateKeys` is precise: only the named keys are evicted from LayoutCache, and only those cells trigger a Yoga re-measurement.

`extraData` is kept for compatibility but is `@deprecated` in favor of `invalidateKeys`.

### Why `remeasureOnItemChange` is `@unstable`

`remeasureOnItemChange` only bumps `layoutCacheVersion` — it does NOT call `nativeLayoutCache.removeAttributes`. If the LayoutCache still holds a stale measured height for the key, the layout pass sees the cached height and may not re-measure. This makes the resize conditional on LayoutCache state and can silently fail. Use `invalidateKeys` explicitly for reliable resize.

---

## Perf investigations for compositional layout (2026-06-05)

A series of investigations targeting CPU/FPS regressions observed on compositional-layout pages — particularly storefront (all sections share one widget type) where Riff trailed FlashList on percentile CPU (p75/p90) despite winning on memory, min FPS, and active component count. The root causes turned out to be several distinct issues in the shouldSkipCorrection machinery, all of which silently increased per-commit work. Each was isolated, fixed, and verified with a dedicated C++ diagnostic. Documented here so future maintainers don't re-discover the same patterns.

### The bench setup

- Device: iPhone 15 Pro, iOS Low Power Mode ON (deliberate memory/CPU pressure for stress testing)
- App: example workspace with three pages (storefront, homepage, search-results) — each can run either engine (Riff or FlashList) via toggle
- Benchmark: 6 scroll scenarios (slow ↓/↑ @ 20pt/frame, fast ↓/↑ @ 100pt/frame, fling ↓/↑) × 5 rounds, sampled at 200ms with synchronous CPU + memory + FPS readings
- Compositional layouts: storefront has 8 mixed sections (V list, V grid, V masonry, V flow, H list, H grid) all using one product-card type; homepage has 7 sections of varied widget types (banner, product card, category chip, etc.); search has ~7 sections mostly product cards

### Issue 1: Visual-attributes pipeline running on every commit, regardless of layout type

**Surfaced when:** a commit added per-cell visual-attribute application (alpha, zIndex, transform3D) into `applyPositionsFromState:` to support scroll-driven layouts (radial, carousel3D). The path ran for every cell on every commit, even for layouts whose values would always be identity.

**Cost shape:** per cell per commit — NSString → UTF8 cacheKey conversion, `layoutCacheForId` registry lookup, mutex-locked single-key `cache->getAttributes`, three CALayer property writes (alpha / zPosition / transform) even when values are at identity. Multiplied by active cell count × commit frequency = measurable CPU on H-heavy pages.

**Fix:** gate the block on a `layoutWritesVisualAttributes` codegen prop derived from the JS layout's `writesVisualAttributes` flag. Static layouts (list / grid / masonry / flow / compositional with all-static sub-sections) skip the block entirely. Dynamic layouts (radial, carousel3D, spiral, hex, custom) keep the path. Files: `ios/RNCollectionViewContainerView.mm`, `cpp/CollectionSubContainerShadowNode.cpp`, JS layout sources.

### Issue 2: JS-side `layoutCacheVersion` redundantly invalidating sub-container skip checks

**Surfaced when:** even after issue 1's fix, sub-container `shouldSkipCorrection` skip rate stayed near 0% on bench. C++ instrumentation showed the LCV check at the top of `shouldSkipCorrection` was failing on every commit.

**Cause:** JS-side `layoutCacheVersion` (a React state in CollectionView.tsx that triggers Fabric re-commits) is bumped from 8 sites. Five are *passive* — JS observing a C++ cache version change via double-RAF poll or scroll handler. Three are *active* — JS-initiated invalidation (`invalidateItem`, `snapshot.apply`, `remeasureOnItemChange`). Sub-containers were treating every LCV bump as a reason to re-run correction, but passive bumps are redundant with the C++ `cache->version()` check that sub-containers also perform.

**Fix:** in `CollectionSubContainerShadowNode::shouldSkipCorrection`, record the new LCV value but do NOT early-return on a mismatch. Fall through to the authoritative C++ checks (cache version, hMvc version, child count, tag/Yoga hash). The C++ side catches every real reason to re-run; LCV is a redundant trigger. Active LCV bumps still work because they accompany other observable signals — `invalidateItem` bumps `renderGen` which forces window cells to re-render, which produces Yoga measurement changes the hash check catches. Files: `cpp/CollectionSubContainerShadowNode.cpp`.

### Issue 3: Missing clone constructor — silent skip-state reset

**Surfaced when:** even after issue 2's fix, skip rate stayed at 0%. Refined diagnostic emitted per-call detail showing `lastCacheVersion_=0, lastHMvcVersion_=0, lastLayoutCacheVersion_=-1, lastChildCount_=0` on every single sub-container layout() call — the declared default initializers, every time.

**Cause:** Fabric clones ShadowNodes on every commit. The clone path uses a *specific* constructor signature `(sourceShadowNode, fragment)` — NOT the C++ default copy constructor (which is explicitly `= delete`'d on the base `ShadowNode` class). The base class clone copies base-class state but knows nothing about derived-class members. The common shortcut `using ConcreteViewShadowNode::ConcreteViewShadowNode;` inherits constructors into the overload set but does not propagate derived-class fields — they get default-initialized on every clone.

So every Fabric commit produced a fresh sub-container clone with `lastXxx_` fields at their declared defaults. The skip check compared "current values" against "defaults" — always failed.

**Fix:** declare and implement an explicit clone constructor in both `CollectionSubContainerShadowNode` and `CollectionViewContainerShadowNode`:

```cpp
CollectionSubContainerShadowNode(
    const ShadowNode& sourceShadowNode,
    const ShadowNodeFragment& fragment)
    : ConcreteViewShadowNode(sourceShadowNode, fragment) {
  const auto& source =
      static_cast<const CollectionSubContainerShadowNode&>(sourceShadowNode);
  lastCacheVersion_       = source.lastCacheVersion_;
  lastHMvcVersion_        = source.lastHMvcVersion_;
  lastLayoutCacheVersion_ = source.lastLayoutCacheVersion_;
  lastChildCount_         = source.lastChildCount_;
  lastChildTagsHash_      = source.lastChildTagsHash_;
  lastYogaHeightHash_     = source.lastYogaHeightHash_;
}
```

The `static_cast` is safe because Fabric guarantees the source has the same dynamic type. The explicit constructor overrides the using-declaration's version for the `(source, fragment)` signature.

**Lesson for any future custom ShadowNode subclass:** if you add member fields intended to survive across commits, you MUST also define this constructor explicitly. Treat the field declaration and the clone-ctor propagation as a single unit.

Files: `cpp/CollectionSubContainerShadowNode.h/.cpp`, `cpp/CollectionViewContainerShadowNode.h/.cpp`. Skip rate jumped from 0% to ~30% with this fix.

### Issue 4: Cross-talk between V container and sub-container via shared `_version`

**Surfaced when:** after issue 3, sub-container skip rate stabilised at ~30%. C++ diag broke down the remaining 70% by failure cause: `fail.ver = 66%` dominated. The V container's `correctChildPositionsIfNeeded` was calling `applyMeasurements` ~64% of commits (cells streaming in during V scroll) — each call bumped `cache->version()` via `endBatch()`. Every active sub-container observed that bump and failed its skip check.

Measured 1:1 correlation: V `applyMeas` count × average active sub-container count = sub-container `fail.ver` count, accurate to 0.2%.

**Why it was wrong:** sub-containers read positions of their own children (H cells inside them), keyed by their own cache entries. V container writes positions of V cells (and the wrapper view position). These are non-overlapping. V's writes should not invalidate sub-containers.

**Fix:** add a third version counter `_vVersion` to LayoutCache, paralleling the existing `_hMvcVersion`. V container's `correctChildPositionsIfNeeded` calls `cache->endVBatch()` (new) instead of `cache->endBatch()` — bumps `_vVersion` only. Sub-containers continue checking `cache->version()` (cross-cutting) and `cache->hMvcVersion()` (their own H writes) — they do NOT observe `_vVersion`. V container observes `_version` AND `_vVersion` (to detect its own writes).

| Counter | Bumped by | Observed by |
|---|---|---|
| `_version` | JS mutations, prepare, fallback paths | V container, all sub-containers |
| `_hMvcVersion` | H sub-container's `applyMeasurements` (`endHBatch`) | H sub-containers only |
| **`_vVersion`** (new) | V container's `applyMeasurements` (`endVBatch`) | V container only |

Files: `cpp/LayoutCache.h`, `cpp/LayoutCache.cpp`, `cpp/CollectionViewContainerShadowNode.h/.cpp`. Sub-container `fail.ver` dropped from 1127 → 54 (–95%). Skip rate jumped from ~30% to ~80%.

### Diagnostic methodology

Two C++ compile-time diagnostic blocks, gated by `RNCV_HSUB_SKIP_DIAG` (in `CollectionSubContainerShadowNode.cpp`) and `RNCV_V_SKIP_DIAG` (in `CollectionViewContainerShadowNode.cpp`). Each defaults to `0`; flip to `1` to enable.

**Sub-container diag** emits `[RNCV-HSUB-DIAG]` every 50 sub-container layout() invocations with a per-reason breakdown:
```
commits=N skips=M skipRate=X% fail{lcv=A noCache=B ver=C hMvc=D cnt=E hash=F}
```
Also emits `[RNCV-HSUB-CNTCHG]` every 10th cnt-change event and `[RNCV-HSUB-SAMPLE]` every 100th call with full state snapshot.

**V container diag** emits `[RNCV-V-DIAG]` every 50 V container layout() invocations:
```
commits=N skips=M skipRate=X% applyMeas=K avgDeltas=D
```

Both diags are zero-cost in release (macros expand to `((void)0)`). Re-enable for any future investigation into skip-correction behaviour.

### Bench progression (storefront, X-Recycle ON, steady-state)

| | Pre-investigation | Post-issue-1 | Post-issue-3 | Post-issue-4 |
|---|---|---|---|---|
| Sub-container skip rate | broken | 0% | ~30% | ~80% |
| Sub-container fail.ver (% of commits) | n/a | ~100% | ~66% | ~4% |
| Storefront Avg CPU | ~22% | ~22% | ~22% | ~21% |
| Storefront p75 CPU | 34-36% | 34-36% | 32-36% | 32% |
| Storefront p90 CPU | 38-42% | 38-42% | 38-42% | 37% |
| Storefront Min FPS | 35-45 | 35-45 | 38-43 | 45 |

The headline insight: even though the diag showed dramatic improvement from issue 4 (sub-container skip rate 30% → 80%), the absolute CPU impact on storefront was modest (~1-2% Avg CPU, larger gains at the p90 tail and on Min FPS). The cascade was correct to fix, but each sub-container correction was a small slice of total per-commit work. The dominant cost on storefront is the V container's own correction work (which is genuine — measuring cells streaming in during V scroll).

Homepage, with its lighter V correction load (multiple widget types, fewer cells per commit), showed cleaner gains — p90 CPU dropped from 32-34% → 28%.

### Cross-section recycling toggle

In parallel with the skip-correction fixes, added a `crossSectionRecycling` prop on `Riff` (default `true`). When `false`, SlotManager keys its pool by `(sectionIndex, itemType)` instead of just `itemType` — each section gets its own private pool. Useful for diagnosis; not a default win.

**Bench finding on storefront:** X-Recycle OFF made memory significantly worse (peak ~2× higher, since each section retains its own pool of warm cells) with no CPU win. Cross-section reclamation IS valuable on single-widget-type-dominant pages because it spreads pool capacity across sections that share the same widget type. The toggle stays the right default ON.

The toggle is wired to the PerfHood overlay (X-Recycle button) for runtime experimentation. `SlotManager.setCrossSectionRecycling(value)` migrates the existing pools to the new keying without destroying slots — React Fibers, state, and in-flight animations are preserved across the toggle.

### Remaining items in backlog (not pursued this round)

- **B4.18** Tighter `applyMeasurements` thresholds in V container — would catch sub-pixel Yoga jitter, but most current writes are real cell measurements; expected impact <2%
- **B4.19** Coalesce all cache writes within a Fabric commit into one batch — would reduce version bumps when multiple writers contribute per commit; not currently observed as a frequent scenario
- **B4.20** Defer non-critical measurements (measure-band cells that aren't in render range) — only meaningful with `measureAhead > 0`, which is disabled in current bench
- **B4.21** Defer V correction during high-velocity scroll, catch up at scroll-end / idle — most aggressive remaining lever for storefront; carries real risk of visible-cell staleness during fast scroll; needs scroll-velocity awareness + catch-up mechanism; significant architectural change
- **B-hsection-private-pools** Per-H-section private slot pools — alternative pool architecture for single-widget-type pages; could help further but storefront's bench numbers don't strongly motivate it

### Key files

- `cpp/LayoutCache.h/.cpp` — `_version`, `_hMvcVersion`, `_vVersion`, batch + `endBatch` / `endHBatch` / `endVBatch`
- `cpp/CollectionViewContainerShadowNode.h/.cpp` — V container's clone constructor, `shouldSkipCorrection` (checks `version` AND `vVersion`), `correctChildPositionsIfNeeded` (calls `endVBatch`)
- `cpp/CollectionSubContainerShadowNode.h/.cpp` — sub-container's clone constructor, `shouldSkipCorrection` (checks `version`, `hMvcVersion`, `cnt`, `hash` — does NOT observe `vVersion`)
- `src/components/SlotManager.ts` — `crossSectionRecycling`, `setCrossSectionRecycling()` non-destructive migration
- `src/components/CollectionView.tsx` — `crossSectionRecycling` prop wiring, useEffect propagation
- `src/types/protocol.ts` — `writesVisualAttributes` and `crossSectionRecycling` documented on `RiffLayout`
- `example/components/PerfHood.tsx` — X-Recycle toggle button + dev counters

