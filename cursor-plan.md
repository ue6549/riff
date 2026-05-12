# Cursor Plan — `feat/h1-and-comp-lab`

> Living plan for the H-section perf arc + Compositional functional lab + Documentation rollout.
> Owner: Cursor agent + @rajatgupta. Date opened: 2026-05-12.

---

## State of the world (snapshot at plan open)

- Branch: `feat/h1-and-comp-lab` — branched from `perf/cpp-hot-path-opts`, carries 1 prior compositional commit (`746e866`) on top of `main`, plus uncommitted WIP across cpp/ios/example/src.
- Recently completed: P6.2 device measurement on iPhone 15 Pro. Riff dominates Search Results (Avg FPS +16%, Min FPS +75%, Memory 4.3x better, Active Mounts 6x fewer). Wins on Min FPS / p5 FPS / Active Mounts on Homepage and Storefront. Storefront memory is the one inversion (Flash 30% better) — investigate later.
- Sequencing direction from user: **perf → functionality → documentation**. Single feature branch for the whole arc. Bench manually via PerfHood "bench" button (slow/fast/fling auto-scroll, JSON share-sheet export).

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

### Tier H-2 — Native frame application via custom orthogonal ShadowNode

**Effort**: 1.5 days. **Risk**: Medium (touches shared infrastructure).

**Problem**: H cells use CSS `position: absolute; left; top` set in JSX. Yoga lays them out, React diffs styles per render, slower than V cells which go through `applyPositionsFromState:`.

**Solution**: Make `RNOrthogonalSectionView`'s contentView a custom ShadowNode that mirrors `CollectionViewContainerShadowNode` — reads its section's slice of LayoutCache, writes positions to children via Yoga `setPosition`, packs `positions[] + tags[]` into its own state, native applies frames by tag map. Drop CSS-absolute styles from JS render.

**Touched files**:
| File | Change |
|---|---|
| `packages/rn-collection-view/cpp/RNOrthogonalContentShadowNode.{h,cpp}` (new) | Custom ShadowNode mirroring container pattern |
| `packages/rn-collection-view/cpp/CollectionViewModule.cpp` | Register new ShadowNode |
| `packages/rn-collection-view/cpp/LayoutCache.{h,cpp}` | Add `getAttributesForSection(sectionIndex)` if missing |
| `packages/rn-collection-view/ios/RNOrthogonalSectionView.{h,mm}` | `updateState:` + `applyPositionsFromState:` for grandchildren |
| Spec + wrapper for orthogonal section | If signature changes |
| `packages/rn-collection-view/example/components/CollectionView.tsx` | Drop CSS-absolute styles for H cells |

Build: new `.cpp` files → `pod install`, then clean Xcode build, Metro reset.

**Exit criteria**: Same functional smoke as H-1. No V-scroll regression. **Bench checkpoint after this tier.**

### Tier H-3 — H scroll velocity into C++

**Effort**: 0.5 day. **Risk**: Low.

**Solution**: `RNOrthogonalSectionView::scrollViewDidScroll:` calls `cache->setHSectionScrollOffset(sectionIndex, x, ts)`. C++ derives velocity per H section. `processHScroll` applies the same velocity-adaptive lead boost as `processScroll`.

### Tier H-4 — H stable-band skip

**Effort**: 0.25 day. **Risk**: Low. **Depends on H-3.**

**Solution**: Track per-section last result + last cacheVersion + last offset in C++. If unchanged-and-stable, early-return without spatial query. Mirrors Opt 6 for H. Saves the per-tick cost when V scroll triggers spurious orthogonal `scrollViewDidScroll` before directional lock kicks in.

### Tier H-5 — Move H windowing off React state

**Effort**: 0.5 day. **Risk**: Medium-low. **Depends on H-1+H-2.**

**Problem**: `setHRangeVersion(v => v + 1)` triggers a full React re-render on every H scroll tick. After H-1+H-2 remove the per-cell work, this React churn becomes the new bottleneck.

**Solution**: Write H window changes to a ref + targeted subscription. Only re-render if the H exclusion change actually causes a V-mounted cell to mount/unmount (rare).

**Bench checkpoint after this tier (final H bench).**

### Deferred — Tier H-6 (snap behaviors)

UIKit-style `orthogonalScrollingBehavior` modes (paging, groupPaging, groupPagingCentered). This is a **feature**, not perf. Tracked here as future work; separate decision after the arc completes.

---

## Stage 2 — CompositionalLab (full manual scope)

**Effort**: ~1.5 days.

**Goal**: Functional spec / stress-test page exercising all leaf types × all mutation classes × MVC × sticky combinations. Replaces the simple `compose` tab in `RiffDemo`.

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

## Inspection points

I (Cursor) stop and hand back to user at:

1. **After H-1** — functional smoke check
2. **After H-2** — functional smoke check + **Bench 1**
3. **After H-5** — functional smoke check + **Bench 2** (final H bench)
4. **After CompositionalLab** — walkthrough together
5. **After each docs phase**

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
| Stage 3 — Documentation | ~3d |
| **Total** | **~8.25d** |
