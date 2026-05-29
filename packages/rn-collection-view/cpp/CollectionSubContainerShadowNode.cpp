#include "CollectionSubContainerShadowNode.h"
#include "CollectionViewModule.h"
#include "LayoutEngine.h"
#include "layouts/CompositionalLayout.h"

#include <algorithm>
#include <cmath>
#include <yoga/YGNode.h>

// Cross-platform debug logging for the sub-container ShadowNode.
// Active only in DEBUG builds; no-op in release.
#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
  #ifdef __APPLE__
    #include <cstdio>
    #define RNCV_SUB_LOG(fmt, ...) do { fprintf(stderr, "[RNCV-SUB] " fmt "\n", ##__VA_ARGS__); fflush(stderr); } while(0)
  #else
    #include <android/log.h>
    #define RNCV_SUB_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-SUB", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_SUB_LOG(fmt, ...) ((void)0)
#endif

// Targeted H sub-container scroll diagnostics. Independent from the broader
// RNCV_ENABLE_NATIVE_LOGS so we can crank these up without re-enabling every
// generic native log site in the codebase.
//
// Flip to 1 to enable. Sister flags:
//   - example/components/CollectionView.tsx          → RNCV_HSUB_LOGS
//   - cpp/CollectionViewModule.cpp                   → RNCV_ENABLE_HSUB_LOGS
//   - ios/RNCollectionSubContainerView.mm            → RNCV_ENABLE_HSUB_LOGS
//
// Filterable tags emitted from this file:
//   RNCV-HSUB-CPP-LAYOUT   per-layout child cv.x/y/w/h, ySectionShift, cache hit/miss
//   RNCV-HSUB-CPP-STATE    correctedContentSize → state.contentSize transitions,
//                          defensive retain decisions, childTags hash
#ifndef RNCV_ENABLE_HSUB_LOGS
#define RNCV_ENABLE_HSUB_LOGS 0
#endif

// Intentionally NOT gated on DEBUG — the flag is opt-in (default 0). Some
// Pods are built without DEBUG defined even in dev configurations, and
// requiring both gates silently swallows the user's flag flip.
#if RNCV_ENABLE_HSUB_LOGS
  #ifdef __APPLE__
    #include <cstdio>
    #define RNCV_HSUB_LOG(fmt, ...) do { fprintf(stderr, "[RNCV-HSUB-CPP] " fmt "\n", ##__VA_ARGS__); fflush(stderr); } while(0)
  #else
    #include <android/log.h>
    #define RNCV_HSUB_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-HSUB-CPP", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_HSUB_LOG(fmt, ...) ((void)0)
#endif

namespace facebook::react {

// Must match the string used in codegenNativeComponent('RNCollectionSubContainer').
const char CollectionSubContainerComponentName[] = "RNCollectionSubContainer";

// ── H-4b: Short-circuit check ──────────────────────────────────────────────
// When the main container relayouts (V scroll cell churn), Yoga re-runs on
// every sub-container as a side-effect even if their children + cache are
// unchanged. This check avoids the expensive 4-phase correction + state
// update in that common case.
bool CollectionSubContainerShadowNode::shouldSkipCorrection() {
  const auto& props =
      *std::static_pointer_cast<const RNCollectionSubContainerProps>(getProps());

  const int curLCV = props.layoutCacheVersion;
  if (curLCV != lastLayoutCacheVersion_) {
    lastLayoutCacheVersion_ = curLCV;
    return false;
  }

  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);
  if (!cache) return false;

  uint64_t cv = cache->version();
  if (cv != lastCacheVersion_) return false;

  // H sub-containers also invalidate on H-only cache writes. These are batched
  // via endHBatch() — they bump _hMvcVersion but NOT _version, so the check
  // above passes. Without this, an H sub-container that just wrote its own
  // measurement deltas would silently skip re-reading the updated positions.
  // V containers (main container) intentionally don't check _hMvcVersion —
  // they have no interest in H item position changes.
  const bool isH =
      (props.scrollDirection == RNCollectionSubContainerScrollDirection::Horizontal);
  if (isH && cache->hMvcVersion() != lastHMvcVersion_) return false;

  auto children = getLayoutableChildNodes();
  size_t N = children.size();
  if (N != lastChildCount_) return false;
  if (N == 0) return true; // empty → nothing to correct

  // Boost-style hash combine of child Fabric tags AND full Yoga frame.
  //
  // The tag hash guards against child identity changes (add/remove cells).
  // The Yoga frame hash guards against content-only changes (Resize,
  // expand/collapse) where tags/count/cacheVersion are all unchanged but
  // actual Yoga-measured dimensions differ. Without this check,
  // shouldSkipCorrection returns true after Resize and nobody calls
  // applyMeasurements — the main container skips grandchild cascade for
  // H-2 sub-containers (ownsGrandchildCascade=true), so stale wrapper
  // height persists until the next scroll event.
  //
  // All four frame fields (origin + size) are hashed so width changes
  // (future custom cell widths, orientation changes) are also caught.
  // Comparison uses != not > so the hash is correct even if it wraps.
  // 2-decimal precision (×100 → round) captures real layout changes while
  // filtering sub-pixel Yoga jitter (< 0.01pt pass-to-pass).
  size_t tagHash   = N;
  size_t yogaHash  = N;
  for (size_t i = 0; i < N; ++i) {
    auto tag = static_cast<size_t>(children[i]->getTag());
    tagHash ^= std::hash<size_t>{}(tag) + 0x9e3779b9 + (tagHash << 6) + (tagHash >> 2);

    const auto& f = children[i]->getLayoutMetrics().frame;
    const size_t vals[4] = {
      static_cast<size_t>(std::lround(f.origin.x      * 100.0f)),
      static_cast<size_t>(std::lround(f.origin.y      * 100.0f)),
      static_cast<size_t>(std::lround(f.size.width    * 100.0f)),
      static_cast<size_t>(std::lround(f.size.height   * 100.0f)),
    };
    for (size_t v : vals) {
      yogaHash ^= v + 0x9e3779b9 + (yogaHash << 6) + (yogaHash >> 2);
    }
  }
  if (tagHash != lastChildTagsHash_) return false;

  // Log only on mismatch — the interesting case where content changed.
  if (yogaHash != lastYogaHeightHash_) {
    RNCV_HSUB_LOG("SKIP-CHECK sIdx=%d yogaFrame mismatch: %zu → %zu (running correction)",
                  props.sectionIndex, lastYogaHeightHash_, yogaHash);
    return false;
  }

  RNCV_HSUB_LOG("SKIP-DECISION sIdx=%d SKIP cv=%llu N=%zu",
                props.sectionIndex,
                (unsigned long long)cache->version(),
                N);
  return true;
}

void CollectionSubContainerShadowNode::layout(LayoutContext layoutContext) {
  RNCV_SUB_LOG("layout() BEGIN");

  // Step 1: Yoga sizes children.
  ConcreteViewShadowNode::layout(layoutContext);

  // H-4b: Skip correction + state update when children + cache are unchanged.
  // The state from the previous commit (carried forward by Fabric clone) is
  // already correct — no need to re-read cache, compute deltas, or diff state.
  if (shouldSkipCorrection()) {
    RNCV_SUB_LOG("layout() SKIP — children + cache unchanged");
    RNCV_HSUB_LOG("LAYOUT-SKIP (H-4b confirmed)");
    return;
  }

  // Step 2: Read final visual state from cache, cascade Yoga deltas if any.
  correctChildPositionsIfNeeded();

  // Step 3: Update component state for the iOS view to consume.
  updateStateIfNeeded();

  RNCV_SUB_LOG("layout() END children=%zu contentW=%.1f contentH=%.1f",
               correctedChildren_.size(),
               correctedContentSize_.width,
               correctedContentSize_.height);
}

void CollectionSubContainerShadowNode::correctChildPositionsIfNeeded() {
  const auto& props =
      *std::static_pointer_cast<const RNCollectionSubContainerProps>(getProps());
  const auto children = getLayoutableChildNodes();

  correctedChildren_.clear();
  childTags_.clear();
  correctedBoundingRect_ = Rect{};

  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);
  const bool isH = (props.scrollDirection == RNCollectionSubContainerScrollDirection::Horizontal);

  // ── Read section size from cache (H-2.1 round-trip cut) ──────────────────
  //
  // Compositional H sections write two cache entries from
  // `CompositionalLayout::finalizeHSection`:
  //   - `h-section-wrapper-{N}` → frame { 0, contentCursorY, vpW, sectionH }
  //                                (Y-position + cross-axis section height)
  //   - `h-section-cw-{N}`      → frame { 0, 0, totalContentW, 0 }
  //                                (full content extent on the scroll axis)
  //
  // BEFORE H-2.1, this ShadowNode read section size from props
  // (`props.contentWidth` / `props.contentHeight`), which JS populated by
  // reading these same cache entries via `compositional.hSectionInfo()` and
  // forwarding them as Fabric props. That JS round-trip created a feedback
  // loop:
  //   cell measures (Yoga) → cache write → finalizeHSection updates section
  //   size → JS reads cache → JS re-renders <RNCollectionSubContainer> with
  //   new contentHeight prop → Fabric commits the new prop → wrapper view
  //   bounds change → Yoga re-runs on subtree → cell measures again →
  //   pixel-grid rounding lands differently → goto step 1.
  // Symptoms: unnatural slow-decay bounce, gestures wedged after edge bounce,
  // JS render storm during deceleration (lcv climbing 20-30× per bounce).
  //
  // FIX: read section size directly from the cache here. The C++ ShadowNode
  // already reads `h-section-wrapper-{N}` for ySectionShift below, so it has
  // everything it needs without going through JS. Standalone consumers (e.g.
  // CollectionSubContainer.tsx for radial / spiral / carousel3D demos) still
  // pass props.contentWidth/Height — they have no compositional cache entry,
  // so the props serve as the standalone fallback.
  Float ySectionShift = 0;
  Size cacheSectionSize{0, 0};
  if (cache) {
    auto wrapperKey = std::string("h-section-wrapper-") +
                      std::to_string(props.sectionIndex);
    auto wrapperAttrs = cache->getAttributes(wrapperKey);
    if (wrapperAttrs) {
      ySectionShift           = static_cast<Float>(wrapperAttrs->frame.y);
      cacheSectionSize.height = static_cast<Float>(wrapperAttrs->frame.height);
    }
    RNCV_HSUB_LOG("INIT-CACHE sIdx=%d wrapperFound=%s ySectionShift=%.1f "
                  "cacheSectionH=%.1f cacheVersion=%llu",
                  props.sectionIndex,
                  wrapperAttrs ? "YES" : "NO",
                  (float)ySectionShift,
                  (float)cacheSectionSize.height,
                  (unsigned long long)cache->version());
    auto cwKey = std::string("h-section-cw-") +
                 std::to_string(props.sectionIndex);
    auto cwAttrs = cache->getAttributes(cwKey);
    if (cwAttrs) {
      cacheSectionSize.width = static_cast<Float>(cwAttrs->frame.width);
    }
  }

  // Helper: pick cache size when present, else props (standalone path).
  auto resolveContentSize = [&]() -> Size {
    if (cacheSectionSize.width > 0 || cacheSectionSize.height > 0) {
      return cacheSectionSize;
    }
    return Size{
      props.contentWidth  > 0 ? props.contentWidth  : 0,
      props.contentHeight > 0 ? props.contentHeight : 0,
    };
  };

  if (children.empty()) {
    // Initial layout pass before cells mount: use cache (compositional) or
    // props (standalone). The defensive retain in updateStateIfNeeded covers
    // any axis still zero. We deliberately do NOT collapse to Size{} —
    // that would tear down the scrollview's bounds before the next valid
    // layout pass arrives.
    correctedContentSize_ = resolveContentSize();
    return;
  }

  // Sub-containers in compositional layouts use the compositional engine for
  // measurement cascade — it knows how to dispatch deltas to the per-section
  // sub-layout. Standalone sub-containers can override this in future via a
  // new prop (e.g. sectionLayoutType) when needed.
  auto engine = CollectionViewModule::getLayoutEngineForId(
      props.layoutCacheId, "compositional");

  const size_t N = children.size();
  correctedChildren_.reserve(N);
  childTags_.reserve(N);

  // ── Phase 1: Extract cacheKeys from RNMeasuredCellProps ──────────────────
  // Direct children of a sub-container are RNMeasuredCell instances (cells).
  // Each cell carries its own cacheKey prop — we use that as the lookup key.
  std::vector<std::string> keys(N);
  std::vector<int32_t>     indices(N, -1);
  for (size_t i = 0; i < N; ++i) {
    if (auto p = std::dynamic_pointer_cast<const RNMeasuredCellProps>(
            children[i]->getProps())) {
      keys[i]    = p->cacheKey;
      indices[i] = p->index;
    }
  }

  // ── Phase 2: Bulk-read frames from cache ─────────────────────────────────
  rncv::BulkFrameResult bulkFrames;
  if (cache) {
    bulkFrames = cache->getFramesForKeys(keys);
  }

  // ── Phase 2b: Y-shift for compositional H-sections (already resolved) ────
  // ySectionShift was computed above alongside the section size lookup.
  // Standalone sub-containers (RiffDemo H-2 tabs) have no compositional
  // wrapper entry → ySectionShift stays 0 → cache positions are used as-is
  // (those layouts already write section-local positions).

#if RNCV_ENABLE_HSUB_LOGS
  {
    int hits = 0, misses = 0;
    for (size_t i = 0; i < N; ++i) {
      if (i < bulkFrames.found.size() && bulkFrames.found[i]) hits++;
      else misses++;
    }
    RNCV_HSUB_LOG(
      "LAYOUT s=%d N=%zu cacheHits=%d cacheMisses=%d ySectionShift=%.1f "
      "cacheCS=(%.1fx%.1f) propCS=(%.1fx%.1f) scrollDir=%d",
      props.sectionIndex, N, hits, misses, ySectionShift,
      cacheSectionSize.width, cacheSectionSize.height,
      props.contentWidth, props.contentHeight,
      static_cast<int>(props.scrollDirection));
  }
#endif

  // ── Phase 3: Initialize correctedChildren_ from cache + Yoga deltas ──────
  // For dimensions that are content-determined (Yoga measures), build deltas
  // and apply via the layout engine. For layouts that govern all dimensions
  // (radial, spiral, hex), no deltas are needed.
  auto contentDim = engine
      ? engine->contentDeterminedDimension()
      : rncv::ContentDimension::Height;

  std::vector<rncv::MeasurementDelta> deltas;

  for (size_t i = 0; i < N; ++i) {
    ChildVisualState cv;

    // Initialize from cache. Subtract section Y so cells land inside the
    // sub-container's local coordinate space (origin at section top-left).
    if (cache && i < bulkFrames.found.size() && bulkFrames.found[i]) {
      cv.x = static_cast<Float>(bulkFrames.frames[i * 4 + 0]);
      cv.y = static_cast<Float>(bulkFrames.frames[i * 4 + 1]) - ySectionShift;
      cv.w = static_cast<Float>(bulkFrames.frames[i * 4 + 2]);
      cv.h = static_cast<Float>(bulkFrames.frames[i * 4 + 3]);
    }

    // Pull richer attributes (transform/opacity/zIndex) from cache when present.
    // These are written by scroll-driven layouts (radial, spiral, carousel3D)
    // via setAttributesBatch.
    if (cache && !keys[i].empty()) {
      auto attrs = cache->getAttributes(keys[i]);
      if (attrs) {
        cv.opacity = static_cast<Float>(attrs->alpha);
        cv.zIndex  = static_cast<Float>(attrs->zIndex);
        if (attrs->transform3D != rncv::kIdentityTransform3D) {
          for (size_t k = 0; k < 16; ++k) {
            cv.transform[k] = static_cast<Float>(attrs->transform3D[k]);
          }
          cv.hasTransform = true;
        }
      }
    }

    // Compare Yoga measurement against cache for content-determined axes.
    //
    // The 0.5pt threshold filters writing essentially-the-same-value back to
    // the cache on every commit (sub-pixel jitter from text rendering / image
    // sizing rounding accumulates differently pass-to-pass). Above 0.5pt is
    // a real measurement signal worth cascading.
    //
    // Note: an earlier iteration applied std::ceil to yoga values + a 1.5pt
    // threshold to dampen a feedback loop (cache change → JS render → Fabric
    // commit → Yoga re-run → goto). That loop was a symptom of round-tripping
    // section size through JS as a Fabric prop. H-2.1 cuts the round-trip at
    // its source — section size now flows cache → C++ ShadowNode → state →
    // iOS view, with no JS in between. Cell measurements can drift sub-pixel
    // freely; the wrapper view's bounds update natively without re-rendering
    // the React tree, so there's no loop to dampen.
    const auto& childMetrics = children[i]->getLayoutMetrics();
    const auto yogaWidth  = childMetrics.frame.size.width;
    const auto yogaHeight = childMetrics.frame.size.height;
    // Activity=hidden collapses the cell's Yoga height to 0. The Activity
    // ancestor receives display:none but its OWN displayType stays Inline on
    // the cell's LayoutMetrics — only the parent Activity node is None, so
    // displayType is not a reliable signal here. yogaHeight == 0 is the
    // practical proxy: H-list cells always have cross-axis height > 0 when
    // rendered; only Activity=hidden produces exactly 0.
    const bool cellIsHidden = (yogaHeight == 0.0f);

    static constexpr Float kCellMVCThresholdPt = 0.5f;

    if ((contentDim == rncv::ContentDimension::Height ||
         contentDim == rncv::ContentDimension::Both) &&
        !cellIsHidden &&
        yogaHeight > 0 &&
        std::abs(yogaHeight - cv.h) > kCellMVCThresholdPt &&
        !keys[i].empty()) {
      deltas.push_back({
        keys[i],
        indices[i],
        cv.h,
        yogaHeight,
        rncv::MeasurementAxis::Height,
      });
      cv.h = yogaHeight;
    }

    // Skip when Activity=hidden: Yoga resets width to the estimated value,
    // oscillating the H-list content size on every bounce. The cache retains
    // the last real measurement so content size stays stable off-screen.
    if ((contentDim == rncv::ContentDimension::Width ||
         contentDim == rncv::ContentDimension::Both) &&
        !cellIsHidden &&
        yogaWidth > 0 &&
        std::abs(yogaWidth - cv.w) > kCellMVCThresholdPt &&
        !keys[i].empty()) {
      deltas.push_back({
        keys[i],
        indices[i],
        cv.w,
        yogaWidth,
        rncv::MeasurementAxis::Width,
      });
      cv.w = yogaWidth;
    }

    correctedChildren_.push_back(cv);
    childTags_.push_back(static_cast<int32_t>(children[i]->getTag()));

#if RNCV_ENABLE_HSUB_LOGS
    RNCV_HSUB_LOG(
      "LAYOUT-CHILD s=%d i=%zu key='%s' idx=%d tag=%d "
      "cv=(x=%.1f y=%.1f w=%.1f h=%.1f) yoga=(w=%.1f h=%.1f) "
      "found=%d",
      props.sectionIndex, i, keys[i].c_str(), indices[i],
      static_cast<int32_t>(children[i]->getTag()),
      cv.x, cv.y, cv.w, cv.h, yogaWidth, yogaHeight,
      (i < bulkFrames.found.size() && bulkFrames.found[i]) ? 1 : 0);
#endif
  }

  // ── Phase 4: Apply cascade and re-read final attributes ──────────────────
  RNCV_HSUB_LOG("PHASE4 sIdx=%d deltas=%zu engine=%s cache=%s",
                props.sectionIndex, deltas.size(),
                engine ? "YES" : "NO", cache ? "YES" : "NO");
#if RNCV_ENABLE_HSUB_LOGS
  for (const auto& d : deltas) {
    RNCV_HSUB_LOG("DELTA sIdx=%d key='%s' axis=%s old=%.2f new=%.2f diff=%.2f",
                  props.sectionIndex, d.key.c_str(),
                  d.axis == rncv::MeasurementAxis::Width ? "W" : "H",
                  d.oldValue, d.newValue, d.newValue - d.oldValue);
  }
#endif
  if (!deltas.empty() && engine && cache) {
    cache->snapshotAnchorIfNeeded();
    // Batch mode: coalesce all position writes into a single version bump.
    // H sub-containers use endHBatch() so their writes bump _hMvcVersion
    // instead of _version — V sub-containers won't see H writes as version
    // changes and won't re-run shouldSkipCorrection unnecessarily.
    cache->beginBatch();
    bool handled = engine->applyMeasurements(deltas, *cache);
    if (isH) cache->endHBatch(); else cache->endBatch();
    RNCV_SUB_LOG("applyMeasurements deltas=%zu handled=%s",
                 deltas.size(), handled ? "YES" : "NO");

    if (handled) {
      // Re-read after cascade to pick up new positions for items downstream
      // of the deltas (later items shifted by height/width changes).
      // Apply the same V-absolute → section-local Y shift as the initial read.
      auto reread = cache->getFramesForKeys(keys);
      for (size_t i = 0; i < N; ++i) {
        if (i >= reread.found.size() || !reread.found[i]) continue;
        correctedChildren_[i].x = static_cast<Float>(reread.frames[i * 4 + 0]);
        correctedChildren_[i].y = static_cast<Float>(reread.frames[i * 4 + 1]) - ySectionShift;
        correctedChildren_[i].w = static_cast<Float>(reread.frames[i * 4 + 2]);
        correctedChildren_[i].h = static_cast<Float>(reread.frames[i * 4 + 3]);
      }
    }

    // Refresh h-section-wrapper-{N} height directly from current item frames.
    // applyMeasurements' 0.5pt threshold and finalizeHSection's 2pt hysteresis
    // can both suppress the wrapper rewrite when deltas are below-threshold or
    // when _sectionInfos hasn't converged yet. The helper scans cached item
    // frames and updates only frame.height — no reflow, no cascade overhead.
    // Phase 4.5 below then re-reads the updated value into cacheSectionSize.
    // NOTE: always endBatch() — wrapper height is V-space metadata (consumed by
    // the main V container's shouldSkipCorrection). Using endHBatch() here would
    // prevent the main container from seeing the updated wrapper height.
    cache->beginBatch();
    rncv::CompositionalLayout::refreshHSectionWrapperHeight(*cache, props.sectionIndex);
    cache->endBatch();

  } else if (!deltas.empty() && cache) {
    // No engine — write Yoga measurements back to cache directly.
    cache->beginBatch();
    for (const auto& d : deltas) {
      auto cached = cache->getAttributes(d.key);
      if (cached) {
        auto updated = *cached;
        if (d.axis == rncv::MeasurementAxis::Height) {
          updated.frame.height = d.newValue;
        } else if (d.axis == rncv::MeasurementAxis::Width) {
          updated.frame.width = d.newValue;
        }
        updated.sizingState = rncv::SizingState::Measured;
        cache->setAttributes(updated);
      }
    }
    cache->endBatch();
  }

  // ── Phase 4.5: Re-read section size into cacheSectionSize ───────────────
  //
  // cacheSectionSize was captured at the top of this function before any
  // measurement processing. refreshHSectionWrapperHeight (above) has now
  // written the correct cross-axis height to h-section-wrapper-{N}. Re-read
  // it here so resolveContentSize() returns the correct value this commit.
  if (!deltas.empty() && cache) {
    const auto wrapperKey = std::string("h-section-wrapper-") +
                            std::to_string(props.sectionIndex);
    if (const auto wa = cache->getAttributes(wrapperKey)) {
      ySectionShift           = static_cast<Float>(wa->frame.y);
      cacheSectionSize.height = static_cast<Float>(wa->frame.height);
    }
    const auto cwKey = std::string("h-section-cw-") +
                       std::to_string(props.sectionIndex);
    if (const auto ca = cache->getAttributes(cwKey)) {
      cacheSectionSize.width = static_cast<Float>(ca->frame.width);
    }
    RNCV_HSUB_LOG("PHASE4.5 sIdx=%d cacheSectionH=%.1f cacheSectionW=%.1f",
                  props.sectionIndex,
                  (float)cacheSectionSize.height,
                  (float)cacheSectionSize.width);
  }

  // ── Phase 5: Compute content size + bounding rect ────────────────────────
  //
  // Content size MUST be the layout-declared total extent — the section's
  // full size as the layout engine computed it — NOT a max() of the windowed
  // children's bounds.
  //
  // Why: correctedChildren_ contains ONLY the items currently inside the H
  // render window. If we let `maxRight` track the rightmost windowed child's
  // edge, the computed contentSize fluctuates as the window slides;
  // UIScrollView re-clamps `contentOffset` to the new bounds on every state
  // commit, which surfaces as snap/cut during bounce-back and gesture fight
  // when the user H-scrolls fast (H-3 amplifies via velocity-adaptive width;
  // H-3.5 amplifies further by mounting more cells).
  //
  // Source of truth — picked up-top via `resolveContentSize`:
  //   - Compositional H section: cache `h-section-cw-{N}.frame.width` (total
  //     scroll-axis extent) + `h-section-wrapper-{N}.frame.height` (cross-axis
  //     section size). Written by CompositionalLayout::finalizeHSection.
  //   - Standalone sub-container (radial / spiral / carousel3D demos):
  //     props.contentWidth / contentHeight, set by the JS layout engine.
  //
  // If both signals are still zero (very first layout pass before sections
  // are sized), fall back to the children bounding rect so the scrollview
  // is at least functional. This is a degenerate edge case.
  Size resolved = resolveContentSize();
  if (resolved.width > 0 || resolved.height > 0) {
    correctedContentSize_ = resolved;
  } else {
    Float maxRight = 0, maxBottom = 0;
    for (size_t i = 0; i < N; ++i) {
      const auto& cv = correctedChildren_[i];
      Float right  = cv.x + cv.w;
      Float bottom = cv.y + cv.h;
      if (right  > maxRight)  maxRight  = right;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    correctedContentSize_ = Size{maxRight, maxBottom};
  }

  // Bounding rect (debug / hit-test) is still the union of child frames —
  // independent of contentSize and not surfaced to UIScrollView.
  for (size_t i = 0; i < N; ++i) {
    const auto& cv = correctedChildren_[i];
    correctedBoundingRect_.unionInPlace(Rect{
      Point{cv.x, cv.y},
      Size{cv.w, cv.h},
    });
  }

  // ── H-4b: Update tracking state for next layout's short-circuit check ────
  lastChildCount_ = N;
  {
    size_t tagHash  = N;
    size_t yogaHash = N;
    for (size_t i = 0; i < N; ++i) {
      auto tag = static_cast<size_t>(children[i]->getTag());
      tagHash ^= std::hash<size_t>{}(tag) + 0x9e3779b9 + (tagHash << 6) + (tagHash >> 2);

      const auto& f = children[i]->getLayoutMetrics().frame;
      const size_t vals[4] = {
        static_cast<size_t>(std::lround(f.origin.x    * 100.0f)),
        static_cast<size_t>(std::lround(f.origin.y    * 100.0f)),
        static_cast<size_t>(std::lround(f.size.width  * 100.0f)),
        static_cast<size_t>(std::lround(f.size.height * 100.0f)),
      };
      for (size_t v : vals) {
        yogaHash ^= v + 0x9e3779b9 + (yogaHash << 6) + (yogaHash >> 2);
      }
    }
    lastChildTagsHash_  = tagHash;
    lastYogaHeightHash_ = yogaHash;
  }
  if (cache) {
    lastCacheVersion_ = cache->version();
    lastHMvcVersion_  = cache->hMvcVersion();
  }
}

void CollectionSubContainerShadowNode::updateStateIfNeeded() {
  auto state = getStateData();

  bool changed = false;

  // Defensive contentSize: never collapse a previously-valid axis to zero.
  //
  // Symptoms this prevents:
  //   - H bounce snap at the right edge: contentSize.width briefly shrinks ->
  //     UIScrollView re-clamps contentOffset to (newWidth - vpWidth) ->
  //     bounce-back animation snaps to the new (smaller) target.
  //   - H gesture-stuck after right-edge bounce: contentSize.width <= vpWidth
  //     -> UIScrollView disables horizontal scroll entirely on that axis.
  //
  // Why a zero might still appear: cache `h-section-wrapper-{N}` /
  // `h-section-cw-{N}` haven't been populated yet on the very first layout
  // pass (compositional path), or the children-empty early return wrote
  // Size{}. We trust state.contentSize as the running source of truth — a
  // zero value means "no signal this pass", not "set the scrollview to zero".
  Size targetSize = correctedContentSize_;
  bool retainedW = false, retainedH = false;
  if (targetSize.width  <= 0 && state.contentSize.width  > 0) {
    targetSize.width = state.contentSize.width;
    retainedW = true;
  }
  if (targetSize.height <= 0 && state.contentSize.height > 0) {
    targetSize.height = state.contentSize.height;
    retainedH = true;
  }

#if RNCV_ENABLE_HSUB_LOGS
  {
    const auto &props =
        *std::static_pointer_cast<const RNCollectionSubContainerProps>(getProps());
    RNCV_HSUB_LOG(
      "STATE s=%d corrected=(%.1fx%.1f) targetAfterRetain=(%.1fx%.1f) "
      "prevState=(%.1fx%.1f) retainedW=%d retainedH=%d "
      "childCount=%zu prevChildCount=%zu rev=%d",
      props.sectionIndex,
      correctedContentSize_.width, correctedContentSize_.height,
      targetSize.width, targetSize.height,
      state.contentSize.width, state.contentSize.height,
      retainedW ? 1 : 0, retainedH ? 1 : 0,
      correctedChildren_.size(), state.children.size(),
      state.layoutRevision);
  }
#endif

  if (state.contentSize != targetSize) {
    state.contentSize = targetSize;
    changed = true;
  }

  if (state.contentBoundingRect != correctedBoundingRect_) {
    state.contentBoundingRect = correctedBoundingRect_;
    changed = true;
  }

  // Compare child arrays element-wise via ChildVisualState's operator!=.
  bool childrenChanged = (state.children.size() != correctedChildren_.size());
  if (!childrenChanged) {
    for (size_t i = 0; i < correctedChildren_.size(); ++i) {
      if (state.children[i] != correctedChildren_[i]) {
        childrenChanged = true;
        break;
      }
    }
  }

  if (childrenChanged || state.childTags != childTags_) {
    state.children   = correctedChildren_;
    state.childTags  = childTags_;
    state.layoutRevision++;
    changed = true;
  }

  if (changed) {
    setStateData(std::move(state));
  }
}

} // namespace facebook::react
