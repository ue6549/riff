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

The resulting map `stickyConfigMap` maps flatIndex → `{ naturalY, boundaryY, sizeHeight, kind }`.

### Sticky wrapping (~lines 1530-1552)

At render time, if a cell's flat index is in `stickyConfigMap` AND it's not measure-only, it is wrapped in `<RNScrollCoordinatedView>` instead of the normal `<RNMeasuredCell>`:

```tsx
<RNScrollCoordinatedView
  behavior={stickyMode}       // ← 'push' or 'sticky'
  naturalY={stickyConfig.naturalY}
  boundaryY={stickyConfig.boundaryY}
  headerHeight={stickyConfig.sizeHeight}
  enabled={true}
  type="supplementary"
  kind={stickyConfig.kind}    // 'header' or 'footer'
  ...
>
  {cellContent}
</RNScrollCoordinatedView>
```

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
- Separators: flat `<View>` with `backgroundColor` from `listDelegate.separator.color`. Width is `frame.width - insetLeading - insetTrailing`.
- Section backgrounds: consumer-provided render function via `decorationRenderers.sectionBackground(sectionIndex, frame)` or legacy `renderSectionBackground` prop.
- Custom decoration kinds: `decorationRenderers[decorationKind](sectionIndex, frame)` for extensibility.

**Frame semantics:** The section background frame covers the items area only — from `sectionInsetTop` below the header to `sectionInsetBottom` above the footer. This matches `NSCollectionLayoutDecorationItem.background` in `UICollectionViewCompositionalLayout`. Headers/footers float above the background in Z and sit outside the bg rect.

**applyMeasurements:** Decoration entries are skipped in the primary item-shift loop. A second pass updates bg frames using `entryShift` / `exitShift` per section (cumulative shift before/after each section's items). This preserves inset padding in the bg frame after Yoga measurement corrections.

**MVC anchor exclusion:** `_snapshotAnchorLocked()` in `LayoutCache.cpp` skips entries where `isDecoration == true`. Without this, a section background (large frame, low Y) would be selected as the MVC anchor, causing incorrect scroll offset corrections on insert/delete.

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

ref.current?.scrollToItem('sectionKey:itemId', { position: 'top' | 'center' | 'bottom' | 'nearest', animated: true });
ref.current?.scrollToOffset({ x: 0, y: 400 }, { animated: true });
```

**Key format:** Same stable key used by the layout cache — `"sectionKey:itemId"` (e.g. `"cell-animation:s1-17"`). This is the concatenation of `SectionConfig.key` and the item key from `keyExtractor`. No index needed.

**`contentHeightRef` pattern:** `useImperativeHandle` doesn't include `contentHeight` in its deps array — adding it would recreate the handle on every layout pass (O(cells) re-render). Instead, a `contentHeightRef` ref mirrors the `contentHeight` state value. The scroll offset clamping reads `contentHeightRef.current`, not the stale closure. Same pattern as `viewportHeightRef`.

**Dispatch:** JS computes target offset → calls `nativeMod.scrollTo({ x, y, animated })` → C++ looks up the registered scroll handler for this `layoutCacheId` → calls `_scrollToX:y:animated:` on the `UIScrollView`.

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

## Codegen Setup (for native pod install)

The library is NOT in `node_modules`. Auto-linking and codegen are driven by:

- `example/react-native.config.js` — declares `riff` dependency with `root: path.resolve(__dirname, '../')`
- `use_native_modules!` in Podfile reads this and finds `RNCollectionView.podspec`
- Codegen finds `codegenConfig` in `packages/rn-collection-view/package.json` and generates `RNCollectionViewSpec` headers

If you remove or break `react-native.config.js`, pod install will print `Removing RNCollectionView` and the TurboModule won't register at runtime.
