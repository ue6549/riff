# Cursor Plan — `feat/h1-and-comp-lab`

> Living plan for the H-section perf arc + Compositional functional lab + Documentation rollout.
> Owner: Cursor agent + @rajatgupta. Date opened: 2026-05-12.

---

## State of the world (snapshot at plan open)

- Branch: `feat/h1-and-comp-lab` — branched from `perf/cpp-hot-path-opts`, carries 1 prior compositional commit (`746e866`) on top of `main`, plus uncommitted WIP across cpp/ios/example/src.
- Recently completed: P6.2 device measurement on iPhone 15 Pro. Riff dominates Search Results (Avg FPS +16%, Min FPS +75%, Memory 4.3x better, Active Mounts 6x fewer). Wins on Min FPS / p5 FPS / Active Mounts on Homepage and Storefront. Storefront memory is the one inversion (Flash 30% better) — investigate later.
- Sequencing direction from user: **perf → functionality → documentation**. Single feature branch for the whole arc. Bench manually via PerfHood "bench" button (slow/fast/fling auto-scroll, JSON share-sheet export).

### Stage 1 progress

- **H-1**: ✅ done. Per-cell H JSI removed; section-local Y staleness latent bug also fixed. Smoke passed on Storefront/Homepage/SearchResults. An intermittent "H scroll gesture missing after boundary" issue was investigated extensively (`RNCV-H-GEST` + `RNCV-H-DIAG` debug logging); root cause looked like simulator throttling rather than H-1 implementation. Logs left in place but **switched off** (`RNCV_HGEST_LOGS=0`, `RNCV_HGEST_DIAG=false`) for future debugging. **Bonus on-device finding**: the intermittent H gesture issue is GONE on device after H-2 — confirms it was simulator-only.
- **H-2**: ✅ done and verified on device (2026-05-13). Initial smoke build had blank H sections from a regression — main container ShadowNode + iOS view didn't recognize the new `RNCollectionSubContainer` wrapper class, so the wrapper was placed at (0, 0, vpW, ~80px) and inner cells placed at V-absolute Y instead of section-local Y. Three-line fix (RTTI branch in `CollectionViewContainerShadowNode`, class check in `RNCollectionViewContainerView::applyPositionsFromState:`, V→section-local Y shift in `CollectionSubContainerShadowNode::correctChildPositionsIfNeeded`). H sections now render cleanly on device. Ready for **Bench 1** (post-H-2 baseline).
- **H-3**: ✨ next up — directly addresses the user-observed "H windowing too tight, no velocity-aware expansion." Today `processHScroll` uses `pad = renderMult * vpWidth` (fixed). H-3 adds H-axis velocity tracking + lead-boost so H windows expand toward the direction of fling, mirroring V's `WindowController::computeRange` formula (`leadBoost = min(1.5, speed) * renderMult`).
- **H-3.5**: ✨ paired with H-3 — decouple V/H windowing multipliers and add per-section overrides. Today every windowing knob (`renderMultiplier`, `mountedWindowSize`, `measureAhead`) is a single top-level CollectionView prop applied uniformly to both V and H paths, with no per-section escape hatch. Storefront sets `renderMultiplier={0.25}` for V efficiency and that collapses H windows too, which is part of why H feels tight on that screen. H-3.5 adds `hRenderMultiplier?` (top-level) and `renderMultiplier?` / `mountedWindowSize?` / `measureAhead?` on `SectionConfig`, with documented precedence.
- **H-4 / H-5**: pending after H-3 + Bench 1.

### Bench 1 results — 2026-05-13, on device, post-H-2 (Storefront)

Two runs, averaged. Riff renderMultiplier on Storefront is `0.25` (set by screen author for V efficiency, inherited by H — this matters for H-3 + H-3.5).

| Scenario | Avg FPS Riff/Flash | Min FPS Riff/Flash | p5 FPS Riff/Flash | Active Mounts Riff/Flash |
|---|---|---|---|---|
| Slow ↓ 20 | **59 / 54.5** | **44 / 40.5** | **51.5 / 45.5** | **11 / 30.5** |
| Slow ↑ 20 | **59 / 55**   | **45.5 / 42.5** | **48 / 42.5** | **11 / 28.5** |
| Fast ↓ 100 | 55.5 / 55.5  | **49.5 / 46**   | **49.5 / 46**  | **11.5 / 37** |
| Fast ↑ 100 | **57.5 / 55.5** | **51.5 / 49** | **51.5 / 49**  | **10 / 22** |
| Fling ↓ | **57 / 56** | **48.5 / 43.5** | **48.5 / 43.5** | **11 / 37** |
| Fling ↑ | 58 / **59** | 49 / **53** | 49 / **53** | **8 / 17** |

**Wins:** 5/6 scenarios on min FPS, 5/6 on p5 FPS, 6/6 on active-mount count (2–4× fewer live cells), 4/6 on avg FPS.

**Investigate:** Fling ↑ — Riff 49 min vs Flash 53 min, 58 avg vs 59 avg. Hypothesis: every cell mount/unmount in the main container triggers a Yoga relayout of its siblings, which side-effect-runs `CollectionSubContainerShadowNode::layout()` for each H sibling — even when the H section's own children didn't change. Fast/Fling have constant cell churn → constant sub-container relayout cost. Same story explains Fast scroll CPU (Riff 40–43% vs Flash 29–32%). Fix: **fold a sub-container layout short-circuit into H-4's stable-band skip** — bail out of `correctChildPositionsIfNeeded()` when child set + cache version + props are all unchanged. This is the H-symmetric of the "Opt E ShadowNode short-circuit" already in the research backlog for the main container.

---

## Doc-nugget vault

Running list of insights surfaced during planning that need to land in `docs/HLD.md` and the relevant LLDs in Stage 3. Capture-as-we-go so nothing is lost. Each numbered item maps to a target doc.

1. **Three identities**: `cacheKey` (layout position) vs **Fabric tag** (native view mapping) vs `slotKey` (React reuse pool slot). Different lifetimes, different consumers, different correctness rules. → `lld/Recycling.md`.
2. **Single source of truth model**: `LayoutCache` (C++) is read by ShadowNode + Yoga + native independently — they all agree because they all read the same data. → `lld/LayoutCache.md`, `lld/ShadowNode.md`.
3. **Native `applyPositionsFromState:` is a defensive override** against Fabric's mount-time index-vs-tag reordering bug — not a fight with Fabric. Both paths produce the same frames; the override re-applies via tag map for safety. → `lld/ShadowNode.md`.
4. **C++ owns windowing computation, JS owns windowing state**. C++ does the math (spatial query, velocity, lead boost). JS holds the result in React state to drive mount/unmount. → `lld/ScrollPath.md`.
5. **The 5-layer scroll pipeline with bailouts at each layer**: render fn → React reconciliation → ShadowNode diff → Yoga layout → native mutation. Element cache + SlotManager makes React reconciliation bail out at the *element reference* level for unchanged cells — user's `renderItem` never re-runs during scroll. → `lld/ScrollPath.md`, `lld/Recycling.md`.
6. **ShadowNode diffing is the secondary defense, not the primary one**. The primary win is preventing user components from re-rendering at all via React's referential bailout. → `lld/ScrollPath.md`.
7. **Container state carries positions + tags**: scroll updates flow through container state mutation, not through cell ShadowNode mutation. Cells stay completely uninvolved in scroll geometry. → `lld/ShadowNode.md`.
8. **Stable key generation**: consumer-provided format `${sectionKey}:${rawKey}` everywhere when keyExtractor is given; per-leaf-type fallback prefix (`item-`, `grid-`, `flow-`, `masonry-`) only when no extractor — the prefix prevents collision when sections of different types coexist. → `lld/Compositional.md`, `GLOSSARY.md`.
9. **Two-level supplementary system in compositional**: Level 1 (compositional-owned headers/footers/backgrounds, V-coordinates) vs Level 2 (leaf-engine items, leaf coordinates). `comp-{section}-{kind}` namespace is distinct from item key namespace. → `lld/Compositional.md`.
10. **MVC mechanics**: `snapshotAnchor()` → reflow → `computeCorrection()` → applied in `layoutSubviews`. `_programmaticScrollActive` flag prevents re-arming during animated scroll. Stash hand-off (`stashHeights`/`clearStash`) preserves Yoga measurements across `cache.clear()`. → `lld/MVC.md`.
11. **Element cache invalidation cascade bug** (historical): `stickyConfigMap` in `renderGen` deps caused every Yoga measurement to invalidate the entire element cache. Fix: exclude from deps. → `OPTIMIZATIONS.md`.
12. **`renderGen` discipline**: bumps only on real structural changes (extraData, layout swap, viewport width). Scroll never bumps it. → `lld/Recycling.md`.
13. **Section-local H frames** (post-H-1): H frames stored in section-local Y eliminates desync with `sectionOriginY` changes after MVC reflows V sections — also fixes a latent element-cache staleness bug. → `lld/HSections.md`.
14. **Fabric `last-index` reordering bug** is the reason `childTags[]` exists in container state. Document the bug, the symptom, and the fix. → `lld/ShadowNode.md`.
15. **Tier discipline**: H-tier improvements sequenced H-1 → H-2 → H-3 → H-4 → H-5 because: (a) H-1 is risk-free foundation, (b) H-2 is the architectural shift that must be solid before polish, (c) H-3 unblocks H-4, (d) H-5 depends on H-1+H-2 to be measurable. → `OPTIMIZATIONS.md`.

> Add new entries here as they surface during implementation. Tag with target doc.

---

## Stage 1 — H-tier perf, sequential (all 5 tiers)

**Total effort**: ~3.75 days. Single branch. Bench at two points (after H-2, after H-5).

### Tier H-1 — Frame data fast path

**Effort**: 1 day. **Risk**: Low.

**Problem**: Every horizontal cell calls `attributesForItem(cacheKey)` over JSI per render. With 5 H sections × ~10 visible cards = 50 JSI round-trips per scroll frame.

**Solution**: `processHScroll` returns a packed `Float64Array` of `(x, y_section_local, w, h)` for the section's render range. JS stores per-section in `hFrameDataRef: Map<sectionIndex, FrameData>`. `renderCell` for H cells reads from the map; remove `!isHCellEarly` exception.

**Bonus latent-bug fix**: section-local Y eliminates element-cache staleness when V sections reflow above H sections.

**Touched files**:
| File | Change |
|---|---|
| `packages/rn-collection-view/src/specs/NativeCollectionViewModule.ts` | Add `frames`, `framesFirst` to `processHScroll` return |
| `packages/rn-collection-view/example/components/NativeCollectionViewModule.ts` | Mirror in wrapper (CLAUDE.md import rule) |
| `packages/rn-collection-view/cpp/CollectionViewModule.cpp` | Pack frames as section-local |
| `packages/rn-collection-view/example/components/CollectionView.tsx` | `hFrameDataRef`, consume in `renderCell`, drop `top: frameY - sectionOriginY` (now just `top: frameY`) |

Build: no new files → no `pod install`. Clean Xcode build, Metro reset.

**Exit criteria**: Storefront/Homepage/SearchResults visual smoke passes. H-fling on Homepage feels at least as smooth as before. No JS or Xcode errors.

### Tier H-2 — Generic sub-container framework with native frame/transform application

**Effort**: 2 days actual (extended scope). **Risk**: Medium (new shared infrastructure used by H sections + custom layouts).

**Problem**: Two problems unified by one solution:
1. H cells use CSS `position: absolute; left; top` set in JSX. Yoga lays them out, React diffs styles per render, slower than V cells which go through `applyPositionsFromState:`.
2. Custom layouts (radial, 3D carousel, spiral, etc.) currently bolt onto a `ScrollView` and animate item styles in JS — there is no first-class framework for "section that owns its own layout + applies frames + transforms natively".

**Solution — `RNCollectionSubContainer` generic Fabric component**:

A reusable Fabric component that:
- Holds a section's children inside its own container (optionally wrapped in a `UIScrollView` per `scrollDirection` prop: `vertical | horizontal | none`).
- Has a custom ShadowNode (`CollectionSubContainerShadowNode`) that reads its section's slice of `LayoutCache`, runs the same Yoga measurement → `applyMeasurements` cascade as the main container for content-determined axes, then packs each child's full `ChildVisualState` (`x, y, w, h, opacity, zIndex, transform[16]`) plus its Fabric `tag` into `CollectionSubContainerState`.
- iOS view (`RNCollectionSubContainerView`) reads state on every state update and `layoutSubviews`, builds a `tag → UIView` map, and applies frames + `CATransform3D` + `alpha` + `zPosition` natively with no per-frame JS work.

H sections are now thin wrappers around this component. Custom layouts (radial, carousel3D, spiral, hex) get the same native frame/transform fast path "for free" — they just implement the `CollectionViewLayout` protocol and call `setAttributesBatch(...)` from `prepare()` and (optionally) `processScroll()`.

**Per scroll tick cost for a custom layout**: 1 JSI batch call (`setAttributesBatch`) + 1 native re-apply pass. No per-cell JSI, no React re-render of cells, no Yoga reflow.

**Built (16 sub-tasks)**:
| Layer | Item | Files |
|---|---|---|
| F1 | Fabric spec for `RNCollectionSubContainer` + example wrapper | `src/specs/RNCollectionSubContainerNativeComponent.ts`, `example/components/RNCollectionSubContainerNativeComponent.ts`, `package.json` codegen registration |
| F2 | C++ ShadowNode + State (with `ChildVisualState`) + ComponentDescriptor | `cpp/CollectionSubContainerShadowNode.{h,cpp}`, `cpp/CollectionSubContainerState.h`, `cpp/CollectionSubContainerComponentDescriptor.h` |
| F3 | iOS native view: dynamic ScrollView wrapping, tag→view map, native frame + transform + opacity + zIndex application, `onSubScroll` event throttling | `ios/RNCollectionSubContainerView.{h,mm}` |
| F4 | TS `LayoutAttributes` extended with `transform`, `opacity`, `anchorPoint` (C++ already had `transform3D` + `alpha` + `zIndex`) | `src/types/layout.ts` |
| F5 | Optional `processScroll(offset, ctx)` added to both `LayoutEngine` (C++) and `CollectionViewLayout` (TS) protocols | `cpp/LayoutEngine.h`, `src/types/protocol.ts` |
| F6 | `setAttributesBatch(updates[])` JSI HostFunction on layoutCache | `cpp/LayoutCache.{h,cpp}` |
| F7 | JS `<CollectionSubContainer>` wrapper that calls `prepare()`, forwards scroll to `processScroll()`, mounts cells | `example/components/CollectionSubContainer.tsx` |
| F8/F9 | H sections in `CollectionView.tsx` migrated to `RNCollectionSubContainer`; absolute positioning styles dropped from H-cell `containerStyle`; `frameYIsLocal`/`sectionOriginY` math removed | `example/components/CollectionView.tsx` |
| L1 | `radial(opts)` TS layout — items on a circle, vertical scroll drives rotation, scale + opacity + zIndex per item | `src/layouts/radial.ts` |
| L2 | `carousel3D(opts)` TS layout — horizontal cover-flow with `rotateY` + perspective | `src/layouts/carousel3D.ts` |
| L3 | `spiral(opts)` TS layout — Archimedean spiral, vertical scroll unwinds it | `src/layouts/spiral.ts` |
| L4 | `hex(opts)` TS layout — static honeycomb tiling (`scrollDirection="none"`); C++ port noted as future demo of native custom layout | `src/layouts/hex.ts` |
| D1 | `RiffDemo` — 4 new tabs: `Radial (H-2)`, `Carousel (H-2)`, `Spiral (H-2)`, `Hex (H-2)` | `example/screens/RiffDemo.tsx` |

Build: new `.cpp` + `.mm` files → `pod install`, clean Xcode build (`Cmd+Shift+K`), Metro on port 8082 with `--reset-cache`.

**Exit criteria**:
- Storefront / Homepage / SearchResults: H sections render and scroll correctly through the new `RNCollectionSubContainer` path (no visual regression vs H-1).
- RiffDemo: all 4 H-2 tabs render — radial rotates with vertical scroll, carousel3D cards flip with horizontal scroll, spiral unwinds with vertical scroll, hex shows a static honeycomb.
- No V-scroll regression on any screen.
- **Bench checkpoint after this tier.**

**Doc-nuggets unlocked by H-2** (added to vault below):
16. **`ChildVisualState` is the universal visual contract**: every sub-container child gets the same 6-field bundle (`x,y,w,h`) + (`opacity`, `zIndex`, `transform[16]`). Custom layouts in TS or C++ produce this bundle; the iOS view applies it. → `lld/HSections.md`, `Contributing-Layouts.md`.
17. **Sub-container vs main container symmetry**: both run the same Yoga-measurement → `applyMeasurements` cascade for content-determined axes. The main container is just a fancy sub-container that owns the outer ScrollView. → `lld/ShadowNode.md`.
18. **Custom layouts in TS are first-class**: as long as the layout writes attributes via `setAttributesBatch` and (optionally) implements `processScroll`, it gets the native fast path with zero per-cell JSI cost. C++ layouts get the same path through `LayoutEngine::processScroll`. → `Contributing-Layouts.md`.
19. **`scrollDirection="none"` for static layouts** (e.g. hex): the iOS view skips the ScrollView wrapper entirely — children mount straight into the contentView. → `lld/HSections.md`.
22. **Wrapper-class registration is a contract** (regression learned 2026-05-13): introducing a new wrapper component for H sections requires THREE coordinated registrations — (a) the main container's ShadowNode RTTI dispatch, so the wrapper gets cache key `"h-section-wrapper-{sIdx}"`; (b) the main container's iOS `applyPositionsFromState:` so the wrapper is marked `shadowNodePositioned=YES` and a later Yoga reflow doesn't reset its origin; (c) Y coordinate-space conversion inside the sub-container's ShadowNode so cell positions stored in V-absolute by `CompositionalLayout::finalizeHSection` are placed correctly inside the section-local contentView. Missing any of the three → blank H sections. → `lld/HSections.md`, `lld/ShadowNode.md`.

### Tier H-3 — H scroll velocity-adaptive windowing

**Effort**: 0.5 day. **Risk**: Low.

**Problem (confirmed on device, 2026-05-13)**: H windowing is "too tight." When you fling an H section quickly, items appear blank for a frame or two at the leading edge before they paint, because `processHScroll` uses `pad = renderMult * vpWidth` — a fixed multiplier with **no velocity boost**. Compare to V scroll which uses `leadBoost = min(1.5, speed) * renderMult` so the leading window expands up to ~2.5× during fast flings. The H path has been carrying a `// Tier H-3 will wire H velocity into LayoutCache.` TODO since H-1.

**Solution**:
1. Per-section H velocity tracking in C++. `RNCollectionSubContainerView::scrollViewDidScroll:` (and the legacy `RNOrthogonalSectionView`'s equivalent) call `cache->setHSectionScrollOffset(sectionIndex, x, timestampSeconds)`.
2. `LayoutCache` keeps a small ring buffer per H section: last N (offset, ts) samples → instantaneous H velocity in viewport-widths-per-second.
3. `processHScroll` reads that velocity and applies the same lead-boost formula as `WindowController::computeRange`: `leadBoost = min(1.5, speed) * renderMult; leadMult = renderMult + leadBoost; trailMult = max(minTrail, renderMult - leadBoost * 0.5);` — so a fast right-fling expands the right-side window without bloating the left side.
4. Asymmetric query rect: `queryRect = { scrollX - trailMult*vpW, sectionY, vpW + (leadMult+trailMult)*vpW, sectionH }` (oriented per scroll direction).

**Touched files**:
| File | Change |
|---|---|
| `cpp/LayoutCache.{h,cpp}` | `setHSectionScrollOffset(sectionIndex, x, ts)` + per-section velocity getter |
| `cpp/CollectionViewModule.cpp` | `processHScroll` uses velocity for asymmetric `pad` |
| `ios/RNCollectionSubContainerView.mm` | Call `setHSectionScrollOffset` from `scrollViewDidScroll:` |
| `ios/RNOrthogonalSectionView.mm` | Same call (legacy path stays in sync) |

**Exit criteria**: a fast H fling on Storefront's Trending Now (grid-H) and Homepage's Featured (list-H) shows zero blank lead at the appearing edge. No visible lag. `bench(fling)` H trace shows no JSI re-window storms.

### Tier H-3.5 — Decoupled V/H windowing + per-section windowing overrides

**Effort**: 0.5 day. **Risk**: Low (purely additive props, no native protocol change).

**Problem (confirmed by Bench 1, 2026-05-13)**: All windowing knobs are top-level only and are shared across V and H paths.

```967:969:packages/rn-collection-view/example/components/CollectionView.tsx
  renderMultiplier = 0.5,
  mountedWindowSize = 2.0,
  measureAhead = 0,
```

`SectionConfig` has no windowing fields. Storefront's `renderMultiplier={0.25}` (tuned for V efficiency on a long flow + masonry main column) collapses H windows on every horizontal section to `pad = 0.25 * vpWidth` — a quarter viewport of lead. Combined with H-3's lack of velocity boost, that's why H feels tight on Storefront in particular.

**Solution**:
1. **Decouple V/H multipliers**: add top-level `hRenderMultiplier?: number` (defaults to `renderMultiplier`). The H path (`handleHScroll` → `processHScroll`) reads this; the V path keeps reading `renderMultiplier`.
2. **Per-section overrides**: add optional `renderMultiplier?`, `mountedWindowSize?`, `measureAhead?` on `SectionConfig`. Build a `sectionWindowingOverrides: Map<sectionIndex, {renderMultiplier?, mountedWindowSize?, measureAhead?}>` once at prepare time.
3. **Precedence chain (documented)**:
   - For H sections: `section.renderMultiplier` ?? `hRenderMultiplier` ?? `renderMultiplier` ?? `0.5`.
   - For V sections: `section.renderMultiplier` ?? `renderMultiplier` ?? `0.5`.
   - Same chain for `mountedWindowSize` and `measureAhead` (no H-specific top-level for those — they're cross-axis budgets).
4. **Wiring**: `handleHScroll` looks up `sectionWindowingOverrides.get(sectionIndex)?.renderMultiplier` and passes that to `processHScroll`. The V render loop applies per-section override when iterating that section's flat-index range.

**Touched files**:
| File | Change |
|---|---|
| `packages/rn-collection-view/src/types/protocol.ts` | Add `hRenderMultiplier?` to top-level config; add `renderMultiplier?` / `mountedWindowSize?` / `measureAhead?` to `SectionConfig` |
| `packages/rn-collection-view/example/components/CollectionView.tsx` | Build `sectionWindowingOverrides` map; route per-section values into V loop and `handleHScroll` |
| `packages/rn-collection-view/example/screens/StorefrontDemo.tsx` | Demo: keep `renderMultiplier={0.25}` for V efficiency, set `hRenderMultiplier={1.0}` so H sections breathe |
| `packages/rn-collection-view/example/screens/HomepageDemo.tsx` | Same demonstration if helpful |

**Exit criteria**:
- Storefront H sections show no leading-edge blank during fast horizontal flings even when V `renderMultiplier=0.25`.
- Per-section override demonstrably tightens or loosens just that section's window without affecting siblings (visible via PerfHood's per-section render-range readout).
- All existing CollectionView tests still pass with no breaking change to the top-level prop signature.

**Doc-nuggets unlocked by H-3.5** (added to vault below):
23. **V and H are different axes with different cost profiles** — V windowing computation runs constantly during V scroll; H windowing runs only when an H section is on screen and scrolling horizontally. Sharing a single `renderMultiplier` couples two unrelated tuning decisions. Decoupling lets V be tight (memory-efficient) while H is wide (no leading blank). → `lld/HSections.md`, `lld/ScrollPath.md`.
24. **Per-section windowing overrides are an escape hatch, not a default** — most apps will use top-level defaults; the override exists for the few sections that have wildly different cost profiles (large hero with images, dense H carousel of small chips, off-screen-by-default sections that don't need pre-warming). → `lld/Compositional.md`.

### Tier H-4 — H stable-band skip + sub-container layout short-circuit

**Effort**: 0.5 day. **Risk**: Low. **Depends on H-3.**

**Two coordinated short-circuits, same theme — skip work when nothing changed:**

1. **C++ `processHScroll` stable-band skip** (the original H-4 plan). Track per-section last (rangeStart, rangeEnd, cacheVersion, offset) in `LayoutCache`. If unchanged-and-stable on this call, early-return without re-running the spatial query. Mirrors Opt 6 for V. Saves the per-tick cost when V scroll triggers spurious orthogonal `scrollViewDidScroll` before iOS directional-lock kicks in.

2. **`CollectionSubContainerShadowNode::layout()` short-circuit** (added 2026-05-13 from Bench 1 finding). Yoga lays out the sub-container as a side effect of every main-container relayout, even when the sub-container's own children + cache haven't changed. On fast V scrolls / flings the main container relayouts constantly (cells mount/unmount) → sub-container `correctChildPositionsIfNeeded()` runs constantly. Hypothesis explains both Bench 1 findings: Fling ↑ Riff 49 vs Flash 53 min FPS, and Fast scroll Riff 40-43% vs Flash 29-32% CPU. Fix: cache the last-applied (childTags-hash, cacheVersion, sectionScrollOffset) in `CollectionSubContainerShadowNode`. If all three match the previous layout call AND no `MeasurementDelta` would fire, skip the entire correctChildPositionsIfNeeded path and reuse the previous state.

**Bench checkpoint:** re-run Bench 1 (slow + fast + fling on Storefront) and verify Fling ↑ min FPS recovers to ≥ Flash's 53 and Fast ↑/↓ CPU drops back into the 25-30% band.

### Tier H-5 — Move H windowing off React state

**Effort**: 0.5 day. **Risk**: Medium-low. **Depends on H-1+H-2.**

**Problem**: `setHRangeVersion(v => v + 1)` triggers a full React re-render on every H scroll tick. After H-1+H-2 remove the per-cell work, this React churn becomes the new bottleneck.

**Solution**: Write H window changes to a ref + targeted subscription. Only re-render if the H exclusion change actually causes a V-mounted cell to mount/unmount (rare).

**Bench checkpoint after this tier (final H bench).**

### Deferred — Tier H-6 (snap behaviors)

UIKit-style `orthogonalScrollingBehavior` modes (paging, groupPaging, groupPagingCentered). This is a **feature**, not perf. Tracked here as future work; separate decision after the arc completes.

### Tier H-2.1 — Cut the section-size round-trip (architectural fix for compositional H bounce)

**Effort**: ~0.5 day. **Risk**: Low (two-file change, layout-engine agnostic). **Lands before H-3.**

**Status**: ✅ implemented (2026-05-14, all 6 file edits + defenses reverted), ⬜ awaiting device verification.

**Implementation summary**:
| Layer | File | Change |
|---|---|---|
| Spec | `src/specs/RNCollectionSubContainerNativeComponent.ts` | JSDoc updated; `contentWidth`/`contentHeight` clearly marked STANDALONE-ONLY (still optional in spec for the radial / spiral / carousel3D consumers in `CollectionSubContainer.tsx`) |
| C++ | `cpp/CollectionSubContainerShadowNode.cpp` | Hoisted cache lookup of `h-section-wrapper-{N}` + `h-section-cw-{N}` to top of `correctChildPositionsIfNeeded`. Both `ySectionShift` and section size read from cache; props are now standalone fallback. New `resolveContentSize()` helper picks cache when present, falls back to props. Reverted: cell-level `std::ceil` on Yoga heights and `kCellMVCThresholdPt` 1.5 → 0.5. Updated long comment block to explain the architectural fix instead of the threshold workaround. |
| C++ | `cpp/CollectionViewModule.cpp` | Removed `kVelocityDeadZonePxMs` dead-zone branch in `processHScroll`. Asymmetric lead/trail formula always runs; dead-zone comment replaced with H-2.1 reference explaining why the boundary-cell flicker is now harmless. |
| C++ | `cpp/layouts/CompositionalLayout.cpp` | Updated `finalizeHSection` comment to reference H-2.1 (kept the `std::ceil` itself as a defensive normalize). |
| iOS | `ios/RNCollectionSubContainerView.mm` | Restored `_scrollView.autoresizingMask = FlexibleWidth \| FlexibleHeight`. Removed the IDLE/animating two-mode scroll-view-frame filter from `layoutSubviews` — `_scrollView` now follows `self.bounds` via standard autoresize. |
| JS | `example/components/CollectionView.tsx` | Dropped `contentWidth={cw}` and `contentHeight={ch}` from the `<RNCollectionSubContainer>` JSX. Removed the now-dead `cw`/`ch` derivation. Replaced their values in the dev log with a clarifying note. Long comment block at the wrapper documents the round-trip-cut rationale. |

**What was kept** (deliberately, scope-limited):
- iOS `_contentView.autoresizingMask = None` (separate concern: prevents collapse during transient parent V relayout; pre-dates this work).
- iOS `updateProps` / `updateState` cross-axis contentSize filters (defensive; harmless now since props are no longer set in compositional path; still useful for standalone path with sub-pixel callbacks).
- C++ `finalizeHSection` `std::ceil` on `maxCrossExtent` (defensive normalize; cheap and gives stable integer-point wrapper height even with raw sub-pixel cell measurements).

**Pre-existing typecheck errors confirmed unaffected** by the change (10+ errors elsewhere in `example/`, none in the edited JSX block at lines 2933–2982 or referencing `RNCollectionSubContainer` props).



**Problem**: When a compositional H section's cells are intrinsically measured by Yoga, the section's outer size takes a 6-step round-trip on every commit:
1. C++ leaf engine writes per-cell `(w, h)` to `LayoutCache`.
2. C++ `finalizeHSection` writes section size to `h-section-wrapper-{N}` cache entry.
3. JS reads it via `compositional.hSectionInfo()`.
4. JS re-renders `<RNCollectionSubContainer contentWidth={w} contentHeight={h}>` with the new value as a **prop**.
5. Fabric commits the new prop on the wrapper view.
6. The wrapper's bounds change as a result of the prop commit → triggers Yoga on the subtree → cells re-measure → produces a slightly different value due to pixel-grid rounding → goto step 1.

Steps 3–5 are dead weight — the C++ shadow node already has the cache and already reads `h-section-wrapper-{N}` for `ySectionShift` (see `CollectionSubContainerShadowNode.cpp:147-154`). The JS round-trip exists only because `contentWidth` / `contentHeight` were modeled as props in the original H-2 spec.

This loop is the root cause of: unnatural bounce on compositional H sections, gestures freezing after edge bounce, JS render storm during deceleration (`lcv` climbing 20-30x in a single bounce), and `propContentHeight` flipping 343↔344 in logs.

**Solution**:
1. Drop `contentWidth` / `contentHeight` as Fabric props on `RNCollectionSubContainer` (or keep them as optional fallback for non-compositional consumers that don't have a cache).
2. `CollectionSubContainerShadowNode::correctChildPositionsIfNeeded` reads `h-section-wrapper-{N}.frame.width/height` from the cache and writes to `correctedContentSize_` directly. Replace the `props.contentWidth/Height` read at lines 354-355.
3. JS no longer needs to read `meta.sectionWidth/Height` and forward as props. `<RNCollectionSubContainer>` JSX in `CollectionView.tsx` (lines ~2957-2969) loses the two props.

After this change: cell measurements can drift, cache updates, next state push updates wrapper bounds natively. No JS render. No Fabric prop commit. No bounce interruption.

**Touched files**:
| File | Change |
|---|---|
| `packages/rn-collection-view/src/specs/RNCollectionSubContainerNativeComponent.ts` | Make `contentWidth` / `contentHeight` optional or remove |
| `packages/rn-collection-view/example/components/RNCollectionSubContainerNativeComponent.ts` | Mirror in wrapper |
| `packages/rn-collection-view/cpp/CollectionSubContainerShadowNode.cpp` | Read section size from cache wrapper-key (extend existing `ySectionShift` lookup); replace prop-derived `correctedContentSize_` |
| `packages/rn-collection-view/example/components/CollectionView.tsx` | Drop `contentWidth` / `contentHeight` props from `<RNCollectionSubContainer>` JSX |

**Revert defenses** (no longer needed once the loop is gone):
- `kCellMVCThresholdPt` back to 0.5pt (or remove the threshold knob entirely) in `CollectionSubContainerShadowNode.cpp`.
- `std::ceil` on Yoga heights in the same file.
- `_scrollView.frame` IDLE/animating two-mode filter in `RNCollectionSubContainerView.mm` (`UIViewAutoresizingFlexibleHeight` can come back).
- `kVelocityDeadZonePxMs` in `CompositionalLayout.cpp` `processHScroll`.

These were all dampening symptoms of the round-trip loop; without the loop they're noise.

**Exit criteria**: Storefront H section bounces naturally on both edges with no slow-decay artifact. Gestures stay responsive after bounce. `lcv` stops climbing during a single bounce. Section content size oscillation in `[RNCV-HSUB-CPP] STATE` logs disappears (single value per measurement event, not flipping every commit).

### Tier H-2.1.1 — Tactical fix for residual gesture-cancel during bounce (post H-2.1)

**Effort**: ~0.25 day. **Risk**: Low (two-file change, pure defense). **Lands directly after H-2.1.** **Status**: ✅ implemented (2026-05-14), ⬜ awaiting device verification.

**Problem (residual after H-2.1)**: H-2.1 cut the JS round-trip and the prop-induced bounce disruption. Bounce became natural. But on device, **gestures still stop registering** mid-bounce — the user has to lift their finger and re-tap to scroll again.

Logs confirm:
- `lcv` is stable (JS render storm gone — H-2.1 worked as intended).
- Section height in cache flips 343 ↔ 344 across `finalizeHSection` calls.
- `self.bounds` of the wrapper view follows that flip.
- `_scrollView.frame.size.height` follows `self.bounds` via `FlexibleHeight` autoresize — **mid-gesture**.
- `UIScrollView` ends up in `isDragging=1 isDecel=1 isTracking=0` (UIKit's "pan recognizer cancelled mid-gesture, internal scroll state still latched" wedge state).

**Root cause**: Yoga's intrinsic content measurement for the same React subtree across consecutive Fabric commits is not deterministic at sub-pixel resolution. Cell height reports e.g. `335.3` on one pass, `334.7` on the next; after `std::ceil()` the section's `max(cell heights)` flips between 343 and 344. With `_scrollView` autoresizing to `self.bounds`, that flip becomes a frame-write to the scroll view, which UIKit treats as gesture-cancelling input.

**Solution (two layers, both defensive)**:

| Layer | File | Change |
|---|---|---|
| Source | `cpp/layouts/CompositionalLayout.cpp::finalizeHSection` | Section-level hysteresis. Suppress section-height changes < 2pt vs the previously cached `h-section-wrapper-{N}` value. Yoga sub-pixel jitter is bounded by ~1px on either side of the rounding boundary so 2pt absorbs it; real layout changes (cell insert/remove, content swap, image aspect change) produce ≥ 4pt deltas and propagate immediately. |
| Defense | `ios/RNCollectionSubContainerView.mm` | Drop `_scrollView` autoresize entirely. Manage `_scrollView.frame` explicitly in `-layoutSubviews` with a busy-guard: if `isTracking || isDragging || isDecelerating`, defer the frame target into `_pendingScrollViewFrame` and apply it from `scrollViewDidEndDragging:willDecelerate:` (when no decel) / `scrollViewDidEndDecelerating:` / `scrollViewDidEndScrollingAnimation:`. The cropping mismatch during deferral is bounded by 1-2pt and hidden by `self.clipsToBounds = YES`. |

**Why both?** The hysteresis cuts the flap at its source; the frame guard insulates UIKit's gesture machine from any future source of legitimate self.bounds churn (image load completing, real cell content swap, font scale change) that happens to land mid-gesture.

**Acknowledged trade-off**: This is a tactical fix, not the proper one. The proper fix is L-7 (push measured cell sizes back as explicit dimensions on the cell, FlashList model). Once L-7 lands, the hysteresis becomes a no-op (cells don't intrinsic-remeasure across commits, so `max(cell heights)` is stable) and can be removed. The frame guard stays as defensive engineering.

**Exit criteria**: After bounce-back at either edge of an H section, the next pan gesture is recognized immediately without lifting the finger first. `[RNCV-HSUB-IOS-LAYOUT]` logs no longer show `_scrollView.frame.size.height` flipping during `isDragging=1` or `isDecelerating=1`.

---

## Stage 2 — CompositionalLab (full manual scope) + F3.6 interludes

**Effort**: ~1.5 days lab + ~1.5 days F3.6 = ~3 days.

**Goal**: (a) Functional spec / stress-test page exercising all leaf types × all mutation classes × MVC × sticky combinations. (b) Land F3.6 — `compositional` with intermixed special sections — so the dominant real-world feed pattern is a first-class API instead of a "fragment your data into many tiny sections" workaround.

### Files

```
example/screens/CompositionalLab.tsx           — main screen
example/screens/lab/MutationToolbar.tsx        — chip toolbar
example/screens/lab/LabHUD.tsx                 — extends PerfHood with cold-mount/MVC counters
example/screens/lab/mutations.ts               — pure mutation fns
example/screens/lab/data.ts                    — section seed data (reuse benchmarkShared)
RiffDemo.tsx                                   — wire `compose` tab
```

### Section composition (7 sections, all leaf types, all chrome combos)

| # | Type | Chrome |
|---|---|---|
| S0 | list V | sticky header + footer + section bg |
| S1 | list H | sticky header |
| S2 | grid V 2-col | sticky header + footer + section bg |
| S3 | grid H 2-row | sticky header |
| S4 | masonry V | sticky header + footer + section bg |
| S5 | flow V | sticky header + footer |
| S6 | list V | (none — control case) |

### Toolbar mutations

- **Item**: insert top/middle/bottom/5-random; delete first/middle/last/3-random; resize first; resize-3-random; update first (data only); move 0→3; reverse
- **Section**: add list-V/grid-V/list-H section (top/middle/bottom); remove section N; swap N↔M
- **Sticky**: toggle sticky header/footer for section N; switch push ↔ overlay
- **Layout**: swap S0 list↔grid; toggle S2 columns 2↔4; toggle S2 sectionBackground; container resize 100%↔60%
- **Scroll**: scrollToItem(S2[10]), scrollToItem(S5[20]), scrollToOffset(0), scrollToOffset(end) — all animated

### HUD signals

```
Sections: 7
Items: 158
Scroll Y: 1247.3
Active mounts: 18
Cold mounts (5s window): 0          ← recycling health
MVC corrections (cumulative): 4
Last correction: +12.3px (S2 delete)
H render ranges: S1[3-9] S3[2-7]
```

Two key validators:
- **Cold mounts (5s) = 0** in steady state — proves recycling is healthy after every mutation
- **MVC scroll-Y delta < 1px** during inserts/deletes — proves anchor preservation works

### Build order within the lab

1. Static layout — verify visual without mutations
2. HUD wiring
3. Item mutations one section at a time
4. Section mutations (add/remove/swap)
5. Layout mutations (swap leaf type, change columns)
6. Scroll mutations (verify they don't fight `_programmaticScrollActive`)

**Exit criteria**: All toolbar buttons work without crashes. Cold mount counter returns to 0 within 1s after any mutation. MVC keeps anchor stable on all insert/delete cases. No visual orphans after section remove. Sticky push/overlay both work.

---

## Stage 2.5 — F3.6 Compositional with intermixed special sections

**Effort**: ~1.5 days. **Risk**: Low (no native protocol changes; pure JS splitter on top of existing compositional engine).

**Why this slots between the lab and docs**: the lab proves the existing compositional API at full mutation stress; F3.6 is the API rework that exposes the dominant real-world feed pattern (one primary feed + a few inline interludes) as a first-class shape. The lab also gives F3.6 a ready-made test bed.

**Real-world motivation**: today, an app like Instagram-feed or news-feed has to fragment a stream of 200 posts into 200 single-post sections so it can interleave a story carousel after post 5, a banner after post 14, and an ad grid after post 21. That's 200 + 3 sections, each carrying section-level bookkeeping, sticky configs, and `getItemType` dispatch. The new shape lets them keep the feed as one stream and declare "interludes" by data-key anchor.

**Build order**:
1. **Splitter in `compositional.ts`** — given `{ primary, interludes[] }`, materialize the equivalent `sections[]` array the C++ engine consumes today. Resolve `afterKey` anchors against `primary.data` on every prepare so insert/delete in the primary stream carries interludes correctly.
2. **`atKey: 'top' | 'bottom'`** — convenience anchors for header/footer-like positions. Compose-resolves to `afterIndex: -1` and `afterIndex: primary.data.length - 1`.
3. **Type discrimination** — interlude items get a synthesized `_interludeKey` so the recycling pool can keep them separate from primary items without consumer effort.
4. **Snapshot extensions** — `snap.appendInterludes(...)`, `snap.removeInterludes(keys)`, `snap.moveInterlude(key, { after: anchorKey })`. Same identity-based model as items.
5. **Demo** — extend `CompositionalLab` with an `Interludes` toolbar group: insert H carousel after the currently-stickied section header, insert hero, insert grid, remove by key, swap two interludes' anchors. Verify cold mounts stay 0 and MVC delta < 1px.

**Touched files**:
| File | Change |
|---|---|
| `packages/rn-collection-view/src/layouts/compositional.ts` | New `{ primary, interludes }` opt-in shape; splitter; anchor resolution |
| `packages/rn-collection-view/src/types/protocol.ts` | New `InterludeDescriptor` type; `CompositionalConfig` discriminated union (`{sections}` ∣ `{primary, interludes}`) |
| `packages/rn-collection-view/example/components/CollectionSnapshot.ts` | `appendInterludes` / `removeInterludes` / `moveInterlude` |
| `packages/rn-collection-view/example/screens/CompositionalLab.tsx` | Interludes toolbar group + demo data |
| `PLAN.md` | Already has F3.6 spec (added in this session) — mark ✅ on completion |
| `docs/lld/Compositional.md` | Section on the splitter + anchor stability rules (lands in Stage 3) |

**Exit criteria**:
- Feed of 200 posts (primary list) + 4 interludes renders correctly, each at the right anchor.
- Inserting / deleting primary items shifts `afterKey` interludes correctly; `afterIndex` interludes stay put.
- Sticky on an interlude header sticks at the right Y.
- An H-carousel interlude scrolls horizontally and its scroll position survives parent V-scroll out + back in (uses the H-2 sub-container).
- Per-cell renderItem for primary items never re-runs when an interlude inserts/removes (element cache stays valid).
- Cold mount counter returns to 0 within 1s after any interlude mutation.

**Doc-nuggets unlocked by F3.6** (added to vault below):
20. **Compositional splitter is a JS-side rewrite** — the C++ engine still consumes a flat `sections[]` array; the new shape is sugar that builds that array from a `{primary, interludes}` description. Keeps the native side untouched while exposing the dominant real-world feed pattern as a first-class API. → `lld/Compositional.md`.
21. **Anchor-by-key vs anchor-by-index** — `afterKey` interludes are mutation-resilient (resolve against `primary.data` on every prepare); `afterIndex` interludes are positionally fixed. Different use cases, different correctness profiles. → `lld/Compositional.md`, `GLOSSARY.md`.

---

## Stage 3 — Documentation (humans-first)

**Effort**: ~3 days, splittable.

### Phase 3a — Shareable artifacts (1 day)

```
README.md                      — refresh: 1-page elevator + install + hello world
docs/ARCHITECTURE.md           — refresh: 5-pillar overview with diagrams
docs/BENCHMARKS.md             — P6.2 + post-H1/H5 numbers, methodology, PerfHood workflow
docs/FlashList-Comparison.md   — feature matrix + perf matrix
docs/GLOSSARY.md               — cacheKey, slotKey, dataKey, flatIndex, fingerprint, MVC, etc.
```

### Phase 3b — Deep dives (1.5 days)

```
docs/HLD.md                    — 5 pillars expanded; trade-offs; design rules
docs/lld/LayoutCache.md
docs/lld/ShadowNode.md         — incl. Fabric reordering bug + tag map (vault #3, #14), single source of truth (vault #2)
docs/lld/ScrollPath.md         — incl. 5-layer pipeline (vault #5, #6), C++/JS split (vault #4), renderGen discipline (vault #12)
docs/lld/Recycling.md          — incl. three identities (vault #1), element cache (vault #5)
docs/lld/Compositional.md      — incl. key generation (vault #8), two-level supplementary (vault #9)
docs/lld/MVC.md                — incl. anchor lifecycle, programmaticScroll, stash (vault #10)
docs/lld/HSections.md          — incl. section-local frames (vault #13), current state post-H1/H5
docs/OPTIMIZATIONS.md          — one section per Opt 1-7 + H-1 through H-5 with before/after numbers; cascade bug (vault #11); tier discipline (vault #15)
```

LLD template: **Purpose → Contracts → Data structures → Operation walkthrough → Failure modes → Bug log → File references**. Strict template makes Phase 3c trivial.

### Phase 3c — LLM derivative + contributor doc (0.5 day)

```
docs/Contributing-Layouts.md   — walkthrough to add a new layout
scripts/build-context-pack.ts  — concat with stable section anchors
docs/CONTEXT-PACK.md           — derived
```

`COLLECTIONVIEW_INTERNALS.md` stays as edge-case rules + bug log. LLDs handle design.

---

## Stage 4 — Layout intent cleanup (separate workstream, post-arc)

**Why this is its own stage**: this is a correctness arc on the layout engines themselves, not on H sections or compositional. The bugs predate compositional H and exist in standalone H usage too. None of it blocks the H-2.1 round-trip fix or the rest of the H-tier perf arc — H-2.1 makes the *interaction* between any layout engine and the new sub-container clean; Stage 4 makes the *engines* themselves match the design intent.

**Design intent (the law going forward)** — clarified by user 2026-05-14:

| Layout | Width | Height | Notes |
|---|---|---|---|
| V list | container width (layout-determined; trivially "1 column") | Yoga | as today, OK |
| V grid | `(container - spacing) / cols` (layout-determined) | Yoga | as today, OK |
| V flow | Yoga | Yoga | **today violates** — `sizeForItem.width` is locked from JS |
| V masonry | column-width (layout-determined) | Yoga | as today, OK |
| H list | Yoga | Yoga | **today violates** — `style.width` locked from `estimatedItemHeight` |
| H grid | Yoga | row-derived from container height (cross axis count) | **today violates** — `style.width` locked from `rowHeight`. New rule: width is Yoga-measured AND drives column width — that's what differentiates H grid from H flow. |
| H flow | Yoga | Yoga | (not implemented yet — ignore) |

**Estimates-only guarantee** — `itemHeight`, `estimatedItemHeight`, `rowHeight`, `sizeForItem`, `estimatedCrossAxisHeight`, etc. are first-pass *estimates only*. Real values come from Yoga. The engine cascades real values once measured. Even when the API name suggests "deterministic" (e.g. `itemHeight: 130`), it's still an estimate that Yoga can override.

### Sub-tasks

| # | Item | Where | Effort |
|---|---|---|---|
| L-1 | Drop `style.width` for H list cells everywhere (standalone V CollectionView with `horizontal: true`, and H sections inside compositional). Cells render with no externally-imposed dim. Engine reads Yoga's intrinsic width and cascades cumulative positions. | `CollectionView.tsx` renderCell, `cpp/layouts/ListLayout.cpp` measured-width cascade | ~1 day |
| L-2 | Drop `style.width` for H grid cells. Engine derives column width from `max(measured cell width)` per column, recomputes positions on cascade. Height stays row-derived from container cross-axis. | `CollectionView.tsx` renderCell, `cpp/layouts/GridLayout.cpp` H-mode column-width derivation | ~1 day |
| L-3 | Drop both `style.width` and `style.height` for V flow cells. Cells render naked, Yoga measures both. Engine packs into rows based on measured widths. `sizeForItem` becomes pure estimate (or removed in favor of `estimatedSizeForItem` for clarity). | `CollectionView.tsx` renderCell, `cpp/layouts/FlowLayout.cpp` measured-size cascade for both axes | ~1 day |
| L-4 | Audit all "size config" entry points across layouts and rename / re-document so name reflects "estimate" not "deterministic" (e.g. consider `estimatedItemHeight` everywhere, deprecate `itemHeight: number`). | `src/types/protocol.ts`, `src/layouts/*.ts`, all demo screens | ~0.5 day |
| L-5 | Demo/test updates: add a RiffDemo toggle that exercises H list / H grid container width changes (currently `RESIZE_TABS` only includes V layouts) so the new intrinsic-width path is exercised by smoke tests. | `example/screens/RiffDemo.tsx` | ~0.25 day |
| L-6 | **Deliberate: do leaf engines need supplementary / sectionBackground suppression in compositional?** Today `compositional.ts` (lines 594-602) forces `headerHeight=0`, `footerHeight=0`, `headerFlatIndex=-1`, `footerFlatIndex=-1`, `emitSectionBackground=false`, `sectionSpacing=0` on every leaf section's params, then re-emits these at "Level 1" (compositional-owned). Two-level supplementary system. Question to revisit: is this two-level model genuinely necessary (e.g. for sticky headers spanning the full V coordinate space, or for sectionBackground that wraps the whole section), or is it a workaround for something we could solve more directly? Implications for the `RNCollectionSubContainer` model — H sections currently can't have their own header/footer rendered inside the sub-container; everything is hoisted to the outer V. Worth a fresh look once the round-trip and intent-matrix work is done. | `src/layouts/compositional.ts`, `cpp/layouts/CompositionalLayout.cpp`, `lld/Compositional.md` | TBD (deliberate first) |
| L-7 | **Layout engine pushes measured cell size back as explicit dimension** (FlashList / RecyclerListView / UICollectionViewCompositionalLayout model). After Yoga first measures a cell intrinsically, the engine writes the measured `(w, h)` back to that cell as an explicit Yoga style on subsequent commits. Yoga then **respects** the explicit value instead of re-measuring intrinsically — eliminating the sub-pixel non-determinism that produces commit-to-commit cell-height drift. Drop the explicit dimension on cell-key change / content-version bump so a real content change re-runs intrinsic measurement exactly once. **Subsumes the H-2.1.1 section-level hysteresis hack**: with cells stable, `max(cell heights)` is stable, wrapper height doesn't flip, the hysteresis is a no-op and can be removed. Also subsumes any other place in the codebase that copes with Yoga's intrinsic-measurement non-determinism via `std::ceil` + thresholds. **This is the architecturally correct answer** — not a hack — and it's how every production virtualized list library handles this. | `cpp/CollectionSubContainerShadowNode.cpp` (or `RNMeasuredCellView` push-back), `CollectionView.tsx` cell renderer (apply explicit dim from registry), `cpp/LayoutCache.h` (per-cell content-version tracking), `cpp/layouts/*.cpp` (drop explicit dim on key-change / content-version bump) | ~2 days |

**Pre-existing bugs in `ethereal-seeking-willow.md` items #3 and #4 (H-list cross-axis bounce, H-list S[0] header half height)** are likely subsumed by this cleanup — they trace back to "engine starts from estimate, grows as items measured" which is the cascade path L-1 / L-2 fix.

**L-7 priority**: Higher than L-6 (deliberation) and roughly equal to L-1/L-2/L-3 (correctness work). L-7 is the **proper** fix for the cell-measurement non-determinism that we're currently masking with H-2.1.1's hysteresis + frame guard. As long as H-2.1.1 holds in practice it's not blocking, but the longer it's deferred the more places in the codebase will accumulate `std::ceil` + threshold workarounds for the same root cause.

**Total effort**: ~5.75 days (incl. L-7). Land after Stage 3 docs (so the docs reflect the cleaned-up intent rather than today's violations).

---

## Inspection points

I (Cursor) stop and hand back to user at:

1. **After H-1** — functional smoke check ✅
2. **After H-2** — functional smoke check ✅ (device, 2026-05-13) → **Bench 1** pending
3. **After H-3** — quick smoke check (H fling on Storefront/Homepage)
4. **After H-5** — functional smoke check + **Bench 2** (final H bench)
5. **After CompositionalLab** — walkthrough together
6. **After F3.6** — interludes demo walkthrough together
7. **After each docs phase**

---

## Bench methodology (matching P6.2)

- iPhone 15 Pro, Release build
- PerfHood "bench" button (slow + fast + fling speeds)
- Screens: Search Results, Homepage, Storefront
- Export JSON via share sheet → save as `logs/bench-{tag}-{screen}-{date}.json`
  - tags: `baseline-p62`, `h1`, `h2`, `h5-final`

Compare each bench against the P6.2 baseline numbers below.

### P6.2 baseline (iPhone 15 Pro, completed 2026-05-12)

| Metric | Search (Riff vs Flash) | Homepage (Riff vs Flash) | Storefront (Riff vs Flash) |
|---|---|---|---|
| Avg FPS | 58 vs 50 (+16%) | 59 vs 59 (tie) | 57.5 vs 56 (+3%) |
| Min FPS | 49 vs 28 (+75%) | 51 vs 35 (+46%) | 44.5 vs 41.5 (+7%) |
| p5 FPS | 50 vs 29 (+72%) | 51 vs 37 (+38%) | 48 vs 41.5 (+16%) |
| Memory MB | 8.1 vs 34.5 (4x better) | 62.5 vs 78.8 (21% better) | 72.3 vs 50.2 (Flash wins 30%) |
| Active Mounts | 10 vs 63 (6.3x) | 13 vs 86 (6.6x) | 11 vs 29 (2.6x) |
| Total Mounts | 1841 vs 2775 | 1188 vs 554 | 1068 vs 793 |

---

## End-of-arc checklist

- [ ] Merge `feat/h1-and-comp-lab` to `main`, push, delete branch
- [ ] Update `ethereal-seeking-willow.md` with current status
- [ ] Write fresh handoff in `docs/ContextExchange/` with timestamp
- [ ] Update PLAN.md with completion status for the H-tier + lab milestones

---

## Total time estimate

| Stage | Effort |
|---|---|
| Stage 1 — H-1 → H-5 | ~3.75d |
| Stage 1 benches × 2 | ~1h |
| Stage 2 — CompositionalLab | ~1.5d |
| Stage 2.5 — F3.6 interludes | ~1.5d |
| Stage 3 — Documentation | ~3d |
| **Total** | **~9.75d** |
