# Working Plan — Riff List Demo + Phase 5

## Status Summary

| Phase | Status |
|---|---|
| L1 – Re-verify ShadowNode (insets, spacing, multi-section, sticky) | ✅ Done |
| L2 – ListDemo: sticky identity, cell animation, insets+spacing, mutations | ✅ Done |
| MVC – insert/delete scroll correction | ✅ Done |
| MVC – size-change scroll correction | ✅ Done |
| L5 – Mutation buttons + MVC toggle in ListDemo | ✅ Done (wired in LayoutsTab.tsx) |
| L4 – ScrollToItem | 🔄 Next (branch: `cur-scrollto`) |
| L3 – Proper Decoration Views | ⬜ After L4 |
| 5g – Extend ShadowNode to grid/masonry/flow | ⬜ After L3 |
| 5j – Remove JS cell wrapper positioning | ⬜ After 5g |

---

## Execution Order

```
L4 (scrollTo) → L3 (decoration views) → 5g (other layouts) → 5j (remove JS wrapper)
```

---

## L4 — ScrollToItem (current work)

**Branch:** `cur-scrollto`

**API:**
```typescript
collectionViewRef.scrollToItem(key: string, options?: {
  animated?: boolean;                               // default true
  position?: 'top' | 'center' | 'bottom' | 'nearest'; // default 'top'
});
collectionViewRef.scrollToOffset(options: { x?: number; y: number; animated?: boolean });
```

**Implementation layers:**
1. **Native** (`RNCollectionViewContainerView.mm`): `scrollToOffset:animated:` → `[_scrollView setContentOffset:animated:]`. Reuse `_applyingCorrection` guard from MVC.
2. **C++ JSI** (`CollectionViewModule.cpp`): Add `scrollTo(layoutCacheId, x, y, animated)` binding.
3. **JS** (`CollectionView.tsx`): `scrollToItem(key)` → sync `nativeLayoutCache.getAttributes(key)` → compute targetY → call `nativeMod.scrollTo(...)`.

**Target offset computation:**
```
top:     attrs.frame.y
center:  attrs.frame.y - (viewportHeight - attrs.frame.height) / 2
bottom:  attrs.frame.y - viewportHeight + attrs.frame.height
nearest: no-op if visible; else top or bottom by direction
```
Clamp to `[0, contentHeight - viewportHeight]`.

**Dynamic size note:** `computeSections()` runs over all items upfront, so LayoutCache always has a position for every item. Unseen items use `estimatedItemHeight` — same behavior as UICollectionView with `estimatedItemSize`. No settling loop for POC; acceptable for demo.

**Demo wiring:** Enable the currently-disabled "→ Top", "→ #42", "→ Bot" buttons in `LayoutsTab.tsx` controls bar.

**Files:**
| File | Change |
|---|---|
| `cpp/CollectionViewModule.h/.cpp` | `scrollTo(id, x, y, animated)` JSI binding |
| `ios/CollectionViewModule.mm` | Forward to container view |
| `ios/RNCollectionViewContainerView.h/.mm` | `scrollToOffset:animated:` |
| `example/components/CollectionView.tsx` | `scrollToItem` / `scrollToOffset` imperative API |
| `example/screens/comparison/LayoutsTab.tsx` | Enable scroll-to buttons; fix "MVC not wired" info text |

---

## L3 — Proper Decoration Views

**Branch:** `cur-decorative-views` (create after L4 is merged)

Replaces the JS-workaround `renderSectionBackground` (not windowed, manually positioned) with proper layout-driven decoration views.

**Design:**
- Layout engine emits decoration `LayoutAttributes` — no data, just frame + kind + sectionIndex
- Same position pipeline as cells (`applyPositionsFromState`, `applyMeasurements()` cascade)
- Windowed like cells (render range)
- Z-ordered: `zIndex: -1` for backgrounds, `zIndex: 0` for separators

**Consumer API:**
```typescript
// Separators: simple props (built-in renderer)
separatorEnabled={true}
separatorColor="#ccc"
separatorInsetLeading={16}
separatorInsetTrailing={0}

// Section backgrounds + custom kinds: provide renderer
decorationRenderers={{
  sectionBackground: (sectionIndex, frame) => <View style={...} />,
}}
```

**Implementation steps:**
- L3.1: `LayoutAttributes`: add `isDecoration: bool`, `decorationKind: string`
- L3.2: `ListLayout::computeSection()`: emit `sectionBackground` (full section rect) and `separator` (between items) entries when opted-in
- L3.3: `CollectionView.tsx`: read decorations from LayoutCache, render before cells, consumer API
- L3.4: Deprecate `renderSectionBackground` (map to `decorationRenderers.sectionBackground` internally)

**Tricky parts:**
- Z-ordering: backgrounds behind cells — ensure insertion order or native `zPosition`
- Windowing: section backgrounds span full section height — partially visible when start is off-screen
- Lifecycle: decorations created/destroyed by layout engine output, not data changes

**Files:**
| File | Change |
|---|---|
| `cpp/LayoutCache.h` | `isDecoration`, `decorationKind` on `LayoutAttributes` |
| `cpp/LayoutCache.cpp` | JSI serialization for new fields |
| `cpp/layouts/ListLayout.h/.cpp` | Emit decoration attrs in `computeSection()` |
| `cpp/CollectionViewContainerShadowNode.cpp` | Handle decoration children in position pipeline |
| `example/components/CollectionView.tsx` | Render decorations, consumer API, deprecate old prop |

---

## 5g — Extend ShadowNode to All Layout Types

After L3. One layout type at a time:

1. **Horizontal list** — same as vertical list but flip axis
2. **Grid (vertical + horizontal)** — reads `frame.x` (column), `frame.width` from cache
3. **Flow (vertical + horizontal)** — two-pass: Yoga measures widths → cache → FlowLayout recomputes
4. **Masonry** — items not Y-sorted by index; use `getAttributesInRect()` for range queries

Non-frame attributes (`zIndex`, `alpha`, `transform3D`, `isHidden`) applied from LayoutCache by native view.

---

## 5j — Remove JS Cell Wrapper Positioning

After 5g. Remove `position: 'absolute'`, `left`, `top`, `width`, `height` from cell wrapper style. Cell wrapper becomes `{ flex: 1 }`. Remove `computedPositions` useMemo and `itemPositionsRef` from `CollectionView.tsx`.

---

## FlashList Differentiators

| Capability | Riff | FlashList |
|---|---|---|
| Sticky footer | ✅ | ❌ |
| Sticky push (UIKit-correct) | ✅ | ❌ basic only |
| View identity preservation (timer proof) | ✅ | ❌ recycles = re-creates |
| Cell animation state in window | ✅ Activity=hidden | ❌ lost on recycle |
| Dynamic height, zero layout shift | ✅ ShadowNode same commit | ❌ JS correction loop |
| Insert/delete with scroll stability | ✅ MVC prop | ❌ no per-mutation control |
| Size-change with scroll stability | ✅ snapshotAnchorIfNeeded | ❌ |
| Decoration views (arbitrary kinds) | planned L3 | ❌ |
| Separators (layout-driven) | planned L3 | basic, not layout-driven |
| scrollToItem by stable key | planned L4 | index only |
| Custom layouts (carousel, radial) | ✅ | ❌ list only |
| C++ window controller on UI thread | ✅ | ❌ JS |
| Memory pressure adaptation | ✅ | ❌ |

---

## Key Files

| File | Purpose |
|---|---|
| `example/screens/comparison/LayoutsTab.tsx` | ListDemo (L2 demo lives here) |
| `example/components/CollectionView.tsx` | Main component |
| `cpp/layouts/ListLayout.h/.cpp` | C++ list layout |
| `cpp/LayoutCache.h/.cpp` | Cache + LayoutAttributes |
| `cpp/CollectionViewContainerShadowNode.cpp` | ShadowNode positioning |
| `cpp/CollectionViewModule.h/.cpp` | TurboModule + JSI bindings |
| `ios/RNCollectionViewContainerView.mm` | Native scroll container |
| `ios/RNScrollCoordinatedViewView.mm` | Sticky view KVO |
