# List Layout Demo + Phase 5 Completion — Working Plan

## Context

Phase 5 (JS Integration / ShadowNode) is mostly complete. The remaining work has two tracks:
1. **List layout demo** — expand `ListDemo` in `LayoutsTab.tsx` to showcase all list layout
   capabilities, all in the existing "List" sub-tab of the Layouts tab in the FlashList
   comparison screen. No new files or screens.
2. **Phase 5 remaining** — 5g (all layout types) and 5j (remove JS wrapper positioning),
   done after the list demo is solid.

---

## Phase L1 — Re-verify Core List Layout Under ShadowNode

ShadowNode overrides all child positions via `applyPositionsFromState`. Features that were
JS-computed absolute positions before ShadowNode need auditing.

### L1.1 — Section insets
ListLayout writes `frame.x`, `frame.width` using `sectionInsetLeft/Right`, and starts `y` at
`sectionInsetTop`. ShadowNode reads these frames from LayoutCache.

**Audit:** Verify items in a section with non-zero insets render at the correct x position and
have the correct width (not full container width). Left/right insets affect `frame.x` and
`frame.width`; top/bottom insets affect `frame.y` accumulation.

### L1.2 — Item spacing
ListLayout accumulates `y += itemHeight + itemSpacing`. ShadowNode reads the y directly.

**Audit:** Confirm visible gap between items matches `itemSpacing` value.

### L1.3 — Multi-section with headers + footers
Headers and footers are supplementary views — they appear as mounted children in the ShadowNode's
child list alongside cells. The ShadowNode maps each child by position to a LayoutCache key.

**Most likely breakage point:** The child-to-key mapping must correctly skip supplementary
children (header at start, footer at end) when indexing into the item key space. If the
ShadowNode treats all children as cells indexed 0..N, headers/footers get wrong positions.

**Audit:** Multi-section list with header + items + footer per section. Verify each element
renders at its correct Y. Check that section 2's content starts after section 1's footer.

### L1.4 — Dynamic item heights
Three-tier resolution: Yoga > cache > estimate. Self-sizing cells (M4.3 behavior).

**Audit:** Items with variable subtitle lines should auto-size. After ShadowNode introduction,
verify Yoga-measured heights still write back to LayoutCache and affect subsequent layout passes.
Confirm scroll correction fires when a cell height changes from estimate.

### L1.5 — Sticky headers with push
The native KVO-based sticky view reads `_naturalY` from the ShadowNode state / LayoutCache.
If the ShadowNode's repositioning changes the effective Y of a header, `naturalY` must reflect
the post-repositioned value — otherwise push clamping is computed from a wrong base.

**Audit:** Multi-section sticky headers with push. Verify that header N is pushed up exactly
when header N+1 arrives at the top. If there's an offset error, naturalY is stale.

---

## Phase L2 — Expanded ListDemo: Identity + Animation + Core Features

**Target file:** `LayoutsTab.tsx`, `ListDemo` component only. No new files.

Expand from current (single section, 50 items, minimal header) to 3 sections × ~30 items.

### Section 1 — "Sticky Identity"
- **Header:** Animated shimmer gradient (Animated.loop, LinearGradient-style) + millisecond
  counter (`setInterval` at 100ms, displayed as `ticks × 100 ms`). Sticky.
- **Footer:** Same treatment — shimmer + millisecond counter. Sticky (not just header).
- **Items:** Fixed height, colored left border.
- **What this proves:** The header and footer are the same React component instance,
  repositioned natively. The timer is continuous through all scroll positions. FlashList:
  no sticky footer. Its sticky header behavior is re-rendered on recycle in some paths.

### Section 2 — "Cell Animation Identity"
- **Header:** Timer. Sticky.
- **Items:** Variable heights (1–3 lines of subtitle text — Yoga intrinsic sizing). Some items
  (every 4th) have an animated shimmer `<Animated.View>` as their background.
- **What this proves:** Scroll section 2 cells completely out of the render window (Activity=hidden
  eviction), then scroll back. The shimmer on animated cells continues from where it left off —
  not from frame 0. FlashList: recycled cell gets a fresh mount, animation restarts.
- **Callout:** "Shimmer on item #N restarted?" — label each animated cell with a mount counter
  incremented in `useEffect` (mount count should stay at 1 within the render window).

### Section 3 — "Insets + Spacing"
- **Larger insets:** `top: 24, bottom: 24, left: 16, right: 16` — visually obvious
- **Larger item spacing:** 16px — visually obvious
- **Items:** Simple cells with a visible inset ruler annotation (thin lines showing the inset region)
- **What this proves:** Section insets and item spacing are C++ layout engine outputs applied by
  ShadowNode — not JS-computed.

### Controls Bar (above the CollectionView, within ListDemo)

**Scroll-to-item buttons:**
- "→ Top" → `scrollToItem('list-0', { animated: true, position: 'top' })`
- "→ #42"  → `scrollToItem('list-42', { animated: true, position: 'nearest' })`
- "→ Bot"  → `scrollToItem(lastKey, { animated: true, position: 'bottom' })`

**Mutation buttons:**
- "+Insert" → insert 3 items at start of section 1 (above viewport if scrolled down)
- "×Delete" → delete first 3 items from section 1
- "↕Resize" → toggle item 10's subtitle between 1 line and 4 lines (triggers height change)
- Toggle: `[MVC: ON] / [MVC: OFF]` — maintainVisibleContentPosition

**Demonstration flow for MVC:** Scroll to item 30+. Toggle MVC. Insert or delete above viewport.
- MVC ON: scroll position corrects, viewport stays on same items. No jump.
- MVC OFF: viewport position is naive, content shifts under the user.

### Updated callout bullets for List sub-tab

```
🟢 FlashList: Core use case — FlatList replacement. Sticky headers (basic, no push on some paths).
🔴 FlashList: No sticky footer support.
🔴 FlashList: Animation state lost on recycle — shimmer restarts, mount counter increments on scroll.
🔴 FlashList: No scrollToItem by stable key; no per-mutation scroll position control.
🔵 Riff: Sticky header + footer — same view instance repositioned natively (timer is proof).
🔵 Riff: Cell animation state preserved via Activity=hidden within render window.
🔵 Riff: Section insets + item spacing — C++ layout engine, sub-ms. ShadowNode applies from cache.
🔵 Riff: scrollToItem(key, position). Insert/delete/resize with maintainVisibleContentPosition toggle.
```

---

## Phase L3 — Proper Decoration Views

**Research added to PLAN.md (R1.12).** Summary:

Current `renderSectionBackground` is an ad-hoc workaround — consumer injects absolute-positioned
Views into the ScrollView slot. True UICollectionView decoration views are:
- Registered on the **layout** (`layout.registerDecoration(kind, Component)`)
- Layout emits `LayoutAttributes` for them (key: `deco-<kind>-<section>`)
- Windowed by framework like cells
- Z-ordered by `zIndex` field (typically behind cells)
- Arbitrary kinds: `sectionBackground`, `separator`, custom

**Built-in ListLayout kinds:**
- `sectionBackground` — full section rect (header top → footer bottom + insets). Opt-in.
- `separator` — hairline between items with configurable `separatorInset`. Opt-in.

**Consumer API:**
```typescript
const listLayout = list({
  showSectionBackground: true,
  showSeparators: true,
  separatorInset: { left: 16, right: 0 },
});

<CollectionView
  decorationRenderers={{
    sectionBackground: (attrs) => <AnimatedShimmerBg />,
    separator:         (attrs) => <View style={separatorStyle} />,
  }}
/>
```

**Demo:** Once implemented, ListDemo section 1 gets animated shimmer `sectionBackground`.
Section 2/3 gets `separator` with varying insets. `DecorationsTab` migrates too.

**Implementation steps (to discuss before starting):**
- L3.1: `LayoutAttributes`: add `isDecoration`, `decorationKind` fields
- L3.2: `ListLayout`: emit `sectionBackground` + `separator` LayoutAttributes when opted-in
- L3.3: `CollectionView.tsx`: read decorations from LayoutCache, render before cells, separate budget
- L3.4: Deprecate `renderSectionBackground`

---

## Phase L4 — Scroll-to-item

**API:** `collectionViewRef.scrollToItem(key: string, options: { animated: boolean, position: 'top' | 'center' | 'bottom' | 'nearest' })`

**Implementation:**
- JSI call: `nativeMod.getItemFrame(layoutCacheId, key)` → `{ x, y, width, height }` (synchronous)
- JS computes `targetOffset`:
  - `top`: `frame.y - sectionInsetTop`
  - `bottom`: `frame.y + frame.height - viewportHeight`
  - `center`: `frame.y + frame.height/2 - viewportHeight/2`
  - `nearest`: if already fully visible → no-op; else whichever of top/bottom requires less scroll
- Native call: `nativeMod.scrollTo(layoutCacheId, { x: 0, y: targetOffset, animated })`
  → `[scrollView setContentOffset:{0, targetOffset} animated:animated]`

---

## Phase L5 — Mutations + maintainVisibleContentPosition

Uses existing Snapshot API (F1.2) for insert/delete and `maintainVisibleContentPosition` prop.

**L5.1:** Wire mutation buttons to snapshot operations on ListDemo data.
**L5.2:** `maintainVisibleContentPosition` toggle — prop already exists on CV. Toggling it
demonstrates the before/after behavior visually with the same mutation applied.

---

## Phase 5 Remaining (after L1–L5)

### 5g — Extend ShadowNode to all layout types

ShadowNode currently handles list layout. Grid, masonry, flow need the same path:
the ShadowNode reads full LayoutAttributes from LayoutCache regardless of layout type —
no layout-specific logic in ShadowNode.

**5g.1 Grid:** Reads `frame.x` (column position), `frame.width` (column width) from cache.
ShadowNode logic: same as list — iterate children, apply full frame from cache.

**5g.2 Masonry:** Items are NOT y-sorted by index (shortest-column fills). LayoutCache has
full frames from `MasonryLayout::compute()`. ShadowNode reads complete frame per key.
Range computation: `LayoutCache::getAttributesInRect()` spatial query (already exists).

**5g.3 Flow:** Variable width + height. Two-pass:
  1. Yoga measures cell widths (first pass).
  2. ShadowNode writes measured sizes back to LayoutCache.
  3. FlowLayout recomputes positions with real sizes.
  4. ShadowNode re-reads positions on next commit.

**5g.4 Custom layouts (layout protocol):** Consumer's TS layout writes full `LayoutAttributes`
via JSI. ShadowNode reads them — no change needed.

**5g.5 Non-frame attributes:** `zIndex`, `alpha`, `transform3D`, `isHidden` — applied by native
view from LayoutCache read (not from state). Requires native view to read LayoutCache on layout.

**Verification per layout type:** grid, masonry, flow each have existing test screens.
Run them. Verify correct positions, widths, scrolling, insert/remove.

### 5j — Remove JS cell wrapper positioning

Once ShadowNode reliably provides all frames:
- Remove `position: 'absolute'`, `left`, `top`, `width`, `height` from cell wrapper style
- Cell wrapper becomes `{ flex: 1 }` — fills frame set by ShadowNode
- Remove `computedPositions` useMemo from CollectionView.tsx
- Remove `itemPositionsRef`
- Measure-range cells: ShadowNode assigns off-screen position for them specifically

---

## Active Work: MVC (maintainVisibleContentPosition) Fix

Offset correction (`correctionY`) was always 0 despite visible row jumping. Two root causes
identified and fixed. Build is pending a clean Xcode compile to verify.

### Root Cause 1 (FIXED): scrollY always 0
`LayoutCache::setScrollOffset()` was never called. Fixed by wiring it from
`scrollViewDidScroll:` in the native view before the throttle check, and after applying
offset correction. Uses a thin `layoutCacheForId()` free function to avoid heavy transitive deps.

### Root Cause 2 (FIXED): Wrong anchor in correction search
Children in `correctedPositions_` are in JSX mount order (headers before cells), not Y order.
Old sequential break-on-first search picked a header at y=2219 as "first visible" when scrolled
to y=491. Fixed by scanning ALL children and picking minimum-Y whose bottom > scrollY.
Key-based anchor lookup (by stable cache key) added to handle windowed insert/delete.

### Build error (FIXED): 'CollectionViewModule.h' file not found in ObjC++ context
That header drags in heavy transitive deps that fail in ObjC++. Created `LayoutCacheRegistry.h`
(cpp/ — thin forward-decl header) and a free-function implementation in `CollectionViewModule.cpp`.
The ObjC++ view file now forward-declares `layoutCacheForId` inline (avoids header search path issue).

### Files changed this session
- `cpp/CollectionViewContainerShadowNode.h` — added `correctedKeys_`, updated `computeOffsetCorrection` sig
- `cpp/CollectionViewContainerShadowNode.cpp` — min-Y anchor scan, key-based lookup, pass keys to correction
- `cpp/CollectionViewContainerState.h` — added `std::vector<std::string> keys`
- `cpp/LayoutCacheRegistry.h` — NEW thin header (forward-declares layoutCacheForId)
- `cpp/CollectionViewModule.cpp` — added `layoutCacheForId` free function impl
- `ios/RNCollectionViewContainerView.mm` — cache `_layoutCacheId`, write scrollOffset to LayoutCache,
  inline C++ forward-decl instead of header import
- `src/types/protocol.ts` — added `itemKeys?` to SectionInfo
- `src/layouts/list.ts` — store/use stable item keys per section
- `example/components/CollectionView.tsx` — pass itemKeys via layoutContext, stable cacheKey for renderCell

### Next step: clean build + verify
1. Clean build in Xcode (`Cmd+Shift+K` → `Cmd+B`)
2. Scroll list, trigger insert/resize/delete
3. Check logs for: `applying offset correction=XX.X scrollY=YYY.Y` (non-zero values)
4. Re-silence native logs after verification (`RNCV_ENABLE_NATIVE_LOGS = 0`)

---

## Execution Order

```
L1 (re-verify ShadowNode path: insets, spacing, multi-section, dynamic height, sticky)
  ↓  [fix any breakage found]
L2 (expand ListDemo: 3 sections, shimmer+timer identity, cell animation, controls bar) ✅ DONE
  ↓  [bug fixes also done: childCountChanged guard in C++ + post-prepare rAF cache check]
MVC offset correction fix ✅ DONE (pending build verification)
  ↓
L3 (proper decoration views: LayoutAttributes + ListLayout + CollectionView render)
  ↓
L4 (scrollToItem: JSI frame read + native setContentOffset)
  ↓
L5 (mutation buttons + MVC toggle wired into ListDemo)
  ↓
5g (ShadowNode → all layout types: grid, masonry, flow, custom)
  ↓
5j (remove JS cell wrapper positioning)
```

---

## Key Files

- `packages/rn-collection-view/example/screens/comparison/LayoutsTab.tsx` — ListDemo lives here
- `packages/rn-collection-view/example/components/CollectionView.tsx` — main component
- `packages/rn-collection-view/cpp/layouts/ListLayout.h/.cpp` — C++ list layout
- `packages/rn-collection-view/cpp/LayoutCache.h/.cpp` — cache + LayoutAttributes struct
- `packages/rn-collection-view/cpp/CollectionViewContainerShadowNode.cpp` — ShadowNode positioning
- `packages/rn-collection-view/cpp/CollectionViewModule.h/.cpp` — TurboModule (scroll JSI calls)
- `packages/rn-collection-view/ios/RNCollectionViewContainerView.mm` — native view
- `packages/rn-collection-view/ios/RNScrollCoordinatedViewView.mm` — sticky view KVO

---

## Phase 5 Completion Status (recap)

- [x] 5f Thread Safety Audit
- [x] 5a Wire ShadowNode to LayoutCache
- [x] 5b Replace ScrollView with RNCollectionViewContainer
- [x] 5c Connect Render Range + Simplify JS Scroll Handler
- [x] 5d Connect Measure Range
- [x] 5e Remove Dead Code
- [x] 5h Comprehensive LayoutAttributes + extras map
- [x] 5i State-based position application (adopt reverted — sealed children crash)
- [ ] 5g Extend to all layout types
- [ ] 5j Remove JS cell wrapper positioning

---

## FlashList Differentiators Summary

| Capability | Riff | FlashList |
|---|---|---|
| Sticky footer | ✅ | ❌ none |
| Sticky push (UIKit-correct) | ✅ | ❌ basic only |
| View identity preservation (timer) | ✅ | ❌ recycles = re-creates |
| Cell animation state in window | ✅ Activity=hidden | ❌ lost on recycle |
| Dynamic height, zero layout shift | ✅ ShadowNode same commit | ❌ JS correction loop |
| Decoration views (arbitrary kinds) | planned L3 | ❌ none |
| Separators (layout-driven) | planned L3 | basic, not layout-driven |
| scrollToItem by stable key | planned L4 | index only |
| Insert/delete with scroll stability | ✅ MVC prop | ❌ no per-mutation control |
| Custom layouts (carousel, radial) | ✅ | ❌ list only |
| State bleed | ❌ clean by default | ✅ broken by default |
| C++ window controller on UI thread | ✅ | ❌ JS |
| Memory pressure adaptation | ✅ | ❌ |
