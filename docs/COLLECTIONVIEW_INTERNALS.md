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

## Key Type Locations

| Type | File | ~Line |
|---|---|---|
| `SectionConfig<T>` | `CollectionView.tsx` | 146 |
| `RiffProps<T>` | `CollectionView.tsx` | 201 |
| `RiffHandle<T>` | `CollectionView.tsx` | 179 |
| `SectionedRenderItemInfo<T>` | `CollectionView.tsx` | 161 |
| `CollectionViewLayout` | `src/types/protocol.ts` | — |
| `LayoutContext` | `src/types/protocol.ts` | — |
| `ListLayoutDelegate` | `src/types/protocol.ts` | — |

---

## Codegen Setup (for native pod install)

The library is NOT in `node_modules`. Auto-linking and codegen are driven by:

- `example/react-native.config.js` — declares `riff` dependency with `root: path.resolve(__dirname, '../')`
- `use_native_modules!` in Podfile reads this and finds `RNCollectionView.podspec`
- Codegen finds `codegenConfig` in `packages/rn-collection-view/package.json` and generates `RNCollectionViewSpec` headers

If you remove or break `react-native.config.js`, pod install will print `Removing RNCollectionView` and the TurboModule won't register at runtime.
