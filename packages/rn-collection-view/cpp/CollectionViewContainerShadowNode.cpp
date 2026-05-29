#include "CollectionViewContainerShadowNode.h"
#include "CollectionViewModule.h"
#include "LayoutEngine.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <yoga/YGNode.h>
#include <react/debug/react_native_assert.h>

// Cross-platform logging for ShadowNode (runs on background thread).
// Active only in DEBUG builds; no-op in release.
#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

// Set RNCV_ENABLE_MVC_TRACE=1 to enable verbose MVC lifecycle tracing.
#ifndef RNCV_ENABLE_MVC_TRACE
#define RNCV_ENABLE_MVC_TRACE 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
  #ifdef __APPLE__
    #include <cstdio>
    #define RNCV_SN_LOG(fmt, ...) do { fprintf(stderr, "[RNCV-SN] " fmt "\n", ##__VA_ARGS__); fflush(stderr); } while(0)
  #else
    #include <android/log.h>
    #define RNCV_SN_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-SN", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_SN_LOG(fmt, ...) ((void)0)
#endif

#if DEBUG && RNCV_ENABLE_MVC_TRACE
  #ifdef __APPLE__
    #include <cstdio>
    #define RNCV_SN_MVC_TRACE(fmt, ...) do { fprintf(stderr, "[MVC-TRACE] " fmt "\n", ##__VA_ARGS__); fflush(stderr); } while(0)
  #else
    #include <android/log.h>
    #define RNCV_SN_MVC_TRACE(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "MVC-TRACE", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_SN_MVC_TRACE(fmt, ...) ((void)0)
#endif

namespace facebook::react {

// Must match the string used in codegenNativeComponent('RNCollectionViewContainer').
const char CollectionViewContainerComponentName[] = "RNCollectionViewContainer";

bool CollectionViewContainerShadowNode::shouldSkipCorrection() {
  const auto& props =
      *std::static_pointer_cast<const RNCollectionViewContainerProps>(getProps());

  // Explicit JS-side invalidation signal (invalidateItem / invalidateKeys / invalidateAt).
  // Must check before the cache-version short-circuit: clearing a Placeholder entry and
  // re-writing the same estimated height does NOT bump _cache->version(), so without this
  // check the correction pass would be skipped even though JS asked for a re-measure.
  const int curLCV = props.layoutCacheVersion;
  if (curLCV != lastLayoutCacheVersion_) {
    lastLayoutCacheVersion_ = curLCV;
    return false;
  }

  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);
  if (!cache) return false;

  const uint64_t cv = cache->version();
  if (cv != lastCacheVersion_) return false;

  const auto children = getLayoutableChildNodes();
  const size_t N = children.size();
  if (N != lastChildCount_) return false;
  if (N == 0) return true;

  size_t tagHash  = N;
  size_t yogaHash = N;
  for (size_t i = 0; i < N; ++i) {
    const auto tag = static_cast<size_t>(children[i]->getTag());
    tagHash ^= std::hash<size_t>{}(tag) + 0x9e3779b9 + (tagHash << 6) + (tagHash >> 2);

    const auto& f = children[i]->getLayoutMetrics().frame;
    const size_t vals[4] = {
      static_cast<size_t>(std::lround(f.origin.x      * 100.0f)),
      static_cast<size_t>(std::lround(f.origin.y      * 100.0f)),
      static_cast<size_t>(std::lround(f.size.width    * 100.0f)),
      static_cast<size_t>(std::lround(f.size.height   * 100.0f)),
    };
    for (const size_t v : vals) {
      yogaHash ^= v + 0x9e3779b9 + (yogaHash << 6) + (yogaHash >> 2);
    }
  }
  if (tagHash  != lastChildTagsHash_)  return false;
  if (yogaHash != lastYogaHeightHash_) return false;

  return true;
}

void CollectionViewContainerShadowNode::layout(LayoutContext layoutContext) {
  RNCV_SN_LOG("layout() BEGIN");

  // Step 1: Call parent layout — reads Yoga-computed child dimensions.
  // B1.1 injection already ran in completeClone(), so dirty cells have
  // height:auto and Yoga measured them freely before arriving here.
  ConcreteViewShadowNode::layout(layoutContext);

  // B4.1: Skip correction + state update when children + cache are unchanged.
  // Cloned member state from previous commit is still valid.
  if (shouldSkipCorrection()) {
    RNCV_SN_LOG("layout() SKIP — children + cache unchanged");
    return;
  }

  // Step 2: Read Yoga-computed heights, compute correct positions.
  correctChildPositionsIfNeeded();

  // Step 3: Update state with positions and content size.
  updateStateIfNeeded();

  RNCV_SN_LOG("layout() END children=%zu contentH=%.1f",
              getLayoutableChildNodes().size(), correctedContentHeight_);
}

void CollectionViewContainerShadowNode::correctChildPositionsIfNeeded() {
  const auto& props =
      *std::static_pointer_cast<const RNCollectionViewContainerProps>(getProps());
  const auto children = getLayoutableChildNodes();

  if (children.empty()) {
    correctedContentHeight_ = 0;
    correctedPositions_.clear();
    correctedBoundingRect_ = Rect{};
    return;
  }

  const auto renderRangeStart = props.renderRangeStart;
  const auto estimatedItemHeight = props.estimatedItemHeight;
  const auto containerWidth = getLayoutMetrics().frame.size.width;

  // Look up the shared LayoutCache and LayoutEngine via static registry.
  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);

  // Determine layout type string from the enum prop.
  // codegen generates: 0=list, 1=grid, 2=masonry, 3=flow, 4=compositional
  std::string layoutType = "list";
  switch (props.layoutType) {
    case RNCollectionViewContainerLayoutType::Grid:          layoutType = "grid";          break;
    case RNCollectionViewContainerLayoutType::Masonry:       layoutType = "masonry";       break;
    case RNCollectionViewContainerLayoutType::Flow:          layoutType = "flow";          break;
    case RNCollectionViewContainerLayoutType::Compositional: layoutType = "compositional"; break;
    default: break;
  }

  auto engine = CollectionViewModule::getLayoutEngineForId(
      props.layoutCacheId, layoutType);

  // Key prefix: must match what the JS layout engine wrote to cache.
  // For compositional, each child carries its own cacheKey prop (per-section prefix varies),
  // so the keyPrefix fallback is only used for cells missing a cacheKey.
  std::string keyPrefix = "item-0-";
  if (layoutType == "grid")          keyPrefix = "grid-";
  else if (layoutType == "masonry")  keyPrefix = "masonry-";
  else if (layoutType == "flow")     keyPrefix = "flow-";

  RNCV_SN_LOG("correctPositions cacheId=%d cache=%s engine=%s layout=%s renderStart=%d children=%zu containerW=%.1f",
              props.layoutCacheId, cache ? "YES" : "NO", engine ? "YES" : "NO",
              layoutType.c_str(), renderRangeStart, children.size(), containerWidth);
  RNCV_SN_LOG("keyResolution keyPrefix=%s cacheVersion=%llu", keyPrefix.c_str(),
              static_cast<unsigned long long>(cache ? cache->version() : 0ULL));

  auto warnOnMissingSupplementaryKey = [&](const std::string& type,
                                           const std::string& kind,
                                           int32_t index,
                                           const std::string& cacheKey) {
    if (layoutType == "list" && type == "supplementary" && cacheKey.empty()) {
      RNCV_SN_LOG("WARNING missing cacheKey for list supplementary node (kind=%s index=%d). Falling back to positional key; header/footer placement may drift.",
                  kind.c_str(), index);
    }
  };
  auto warnOnUnexpectedType = [&](const std::string& type,
                                  const std::string& kind,
                                  int32_t index,
                                  const std::string& cacheKey) {
    if (layoutType == "list" && !type.empty() &&
        type != "cell" && type != "supplementary" && type != "decoration") {
      RNCV_SN_LOG("WARNING unexpected child type=%s kind=%s index=%d cacheKey=%s",
                  type.c_str(), kind.c_str(), index, cacheKey.c_str());
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // Opt A: Extract ChildInfo once per child — single RTTI pass.
  // All subsequent phases use infos[i] with zero dynamic_pointer_cast.
  // ══════════════════════════════════════════════════════════════════════════

  struct ChildInfo {
    // OrthogonalSection covers BOTH the legacy RNOrthogonalSectionView and the
    // H-2 RNCollectionSubContainer wrapper. They play the same role from the
    // main container's perspective: an opaque H-section wrapper whose frame
    // lives in the cache under "h-section-wrapper-{sIdx}". The sub-container
    // performs its own internal grandchild measurement cascade — the main
    // container must NOT iterate grandchildren for this kind, regardless of
    // which physical component type the wrapper is.
    enum Kind { MeasuredCell, ScrollCoordinated, OrthogonalSection, Unknown };
    Kind        kind = Unknown;
    std::string key;
    std::string type;
    std::string propKind;
    std::string component;
    std::string propCacheKey;   // original cacheKey from props (logging)
    std::string fallbackKey;    // computed fallback key (logging)
    int32_t     dataIndex = -1;
    int32_t     sectionIndex = -1;
    // True when the wrapper handles its own grandchild measurement cascade
    // (H-2 sub-container). Legacy RNOrthogonalSectionView leaves cascade to
    // the main container's grandchild loop.
    bool        ownsGrandchildCascade = false;
  };

  const size_t N = children.size();
  std::vector<ChildInfo> infos(N);
  std::vector<std::string> keys(N);

  for (size_t i = 0; i < N; ++i) {
    auto& ci = infos[i];
    if (auto p = std::dynamic_pointer_cast<const RNMeasuredCellProps>(children[i]->getProps())) {
      ci.kind = ChildInfo::MeasuredCell;
      ci.component = "RNMeasuredCell";
      ci.type = p->type;
      ci.propKind = p->kind;
      ci.dataIndex = p->index;
      ci.propCacheKey = p->cacheKey;
      warnOnMissingSupplementaryKey(p->type, p->kind, p->index, p->cacheKey);
      warnOnUnexpectedType(p->type, p->kind, p->index, p->cacheKey);
      if (!p->cacheKey.empty()) {
        ci.key = p->cacheKey;
      } else {
        ci.fallbackKey = keyPrefix + std::to_string(p->index >= 0 ? p->index : (renderRangeStart + static_cast<int32_t>(i)));
        ci.key = ci.fallbackKey;
      }
    } else if (auto p = std::dynamic_pointer_cast<const RNScrollCoordinatedViewProps>(children[i]->getProps())) {
      ci.kind = ChildInfo::ScrollCoordinated;
      ci.component = "RNScrollCoordinatedView";
      ci.type = p->type;
      ci.propKind = p->kind;
      ci.dataIndex = p->index;
      ci.propCacheKey = p->cacheKey;
      warnOnMissingSupplementaryKey(p->type, p->kind, p->index, p->cacheKey);
      warnOnUnexpectedType(p->type, p->kind, p->index, p->cacheKey);
      if (!p->cacheKey.empty()) {
        ci.key = p->cacheKey;
      } else {
        ci.fallbackKey = keyPrefix + std::to_string(p->index >= 0 ? p->index : (renderRangeStart + static_cast<int32_t>(i)));
        ci.key = ci.fallbackKey;
      }
    } else if (auto p = std::dynamic_pointer_cast<const RNOrthogonalSectionViewProps>(children[i]->getProps())) {
      ci.kind = ChildInfo::OrthogonalSection;
      ci.component = "RNOrthogonalSectionView";
      ci.sectionIndex = p->sectionIndex;
      ci.fallbackKey = "h-section-wrapper-" + std::to_string(p->sectionIndex);
      ci.key = ci.fallbackKey;
      ci.ownsGrandchildCascade = false;
    } else if (auto p = std::dynamic_pointer_cast<const RNCollectionSubContainerProps>(children[i]->getProps())) {
      // H-2: H section wrapped in the generic sub-container. Same role as
      // RNOrthogonalSectionView for cache lookup ("h-section-wrapper-{sIdx}"),
      // but the sub-container does its own grandchild measurement cascade
      // inside CollectionSubContainerShadowNode, so we skip the main
      // container's grandchild loop for it.
      ci.kind = ChildInfo::OrthogonalSection;
      ci.component = "RNCollectionSubContainer";
      ci.sectionIndex = p->sectionIndex;
      ci.fallbackKey = "h-section-wrapper-" + std::to_string(p->sectionIndex);
      ci.key = ci.fallbackKey;
      ci.ownsGrandchildCascade = true;
    } else {
      ci.kind = ChildInfo::Unknown;
      ci.component = "unknown";
      const auto dataIndex = renderRangeStart + static_cast<int32_t>(i);
      ci.fallbackKey = keyPrefix + std::to_string(dataIndex);
      ci.key = ci.fallbackKey;
    }
    keys[i] = ci.key;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Bulk cache read + build correctedPositions_
  //   Opt B: Single mutex acquisition for all keys (replaces N getAttributes).
  //   Opt F: Bounding rect computed at end of this function.
  // ══════════════════════════════════════════════════════════════════════════

  correctedPositions_.clear();
  correctedPositions_.reserve(N * 4);
  childTags_.clear();
  childTags_.reserve(N);

  // Bulk read: one lock, zero LayoutAttributes copies.
  rncv::BulkFrameResult bulkFrames;
  if (cache) {
    bulkFrames = cache->getFramesForKeys(keys);
  }

  for (size_t i = 0; i < N; ++i) {
    Float effectiveX = 0;
    Float effectiveY = 0;
    Float effectiveWidth = containerWidth;
    Float effectiveHeight = estimatedItemHeight;

    bool cacheHit = false;
    if (cache && i < bulkFrames.found.size() && bulkFrames.found[i]) {
      cacheHit = true;
      effectiveX = static_cast<Float>(bulkFrames.frames[i * 4 + 0]);
      effectiveY = static_cast<Float>(bulkFrames.frames[i * 4 + 1]);
      if (bulkFrames.frames[i * 4 + 2] > 0)
        effectiveWidth = static_cast<Float>(bulkFrames.frames[i * 4 + 2]);
      if (bulkFrames.frames[i * 4 + 3] > 0)
        effectiveHeight = static_cast<Float>(bulkFrames.frames[i * 4 + 3]);
    }

    correctedPositions_.push_back(effectiveX);
    correctedPositions_.push_back(effectiveY);
    correctedPositions_.push_back(effectiveWidth);
    correctedPositions_.push_back(effectiveHeight);
    childTags_.push_back(static_cast<int32_t>(children[i]->getTag()));

    const auto& ci = infos[i];

    // Always log H-section sub-container children (regardless of position in list).
    if (ci.kind == ChildInfo::OrthogonalSection) {
      RNCV_SN_LOG("  [PARENT-P1] H-sub sIdx=%d key=%s cacheHit=%s "
                  "wrapperH=%.1f wrapperY=%.1f cacheVersion=%llu",
                  ci.sectionIndex, ci.key.c_str(), cacheHit ? "YES" : "NO",
                  effectiveHeight, effectiveY,
                  static_cast<unsigned long long>(cache ? cache->version() : 0ULL));
    }

    // Diagnostic logging (first 8 + decorations + headers)
    if (i < 8 || ci.propKind == "header" || ci.key.find("header") != std::string::npos ||
        ci.type == "decoration") {
      const auto& childMetrics = children[i]->getLayoutMetrics();
      RNCV_SN_LOG("  child[%zu] component=%s type=%s kind=%s index=%d propCacheKey=%s fallbackKey=%s finalKey=%s cacheHit=%s cache=(%.1f,%.1f,%.1f,%.1f) yoga=(%.1f,%.1f,%.1f,%.1f)",
                  i, ci.component.c_str(), ci.type.c_str(), ci.propKind.c_str(), ci.dataIndex,
                  ci.propCacheKey.c_str(), ci.fallbackKey.c_str(), ci.key.c_str(), cacheHit ? "YES" : "NO",
                  effectiveX, effectiveY, effectiveWidth, effectiveHeight,
                  childMetrics.frame.origin.x, childMetrics.frame.origin.y,
                  childMetrics.frame.size.width, childMetrics.frame.size.height);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Diff Yoga measurements vs cache, build deltas
  //   Uses infos[i] for key/type dispatch — zero RTTI.
  // ══════════════════════════════════════════════════════════════════════════

  auto contentDim = engine
      ? engine->contentDeterminedDimension()
      : rncv::ContentDimension::Height;

  std::vector<rncv::MeasurementDelta> deltas;

  for (size_t i = 0; i < N; ++i) {
    const auto& ci = infos[i];

    if (ci.kind == ChildInfo::OrthogonalSection) {
      // H-section wrapper: iterate grandchildren (H-cells) to build MVC deltas.
      // H-cells are children of the wrapper, not direct children of the main
      // container, so they're invisible to the main Phase 2 loop.
      //
      // EXCEPTION: H-2 sub-container does its own grandchild cascade inside
      // CollectionSubContainerShadowNode::correctChildPositionsIfNeeded. Doing
      // it again here would race against the sub-container's own state update
      // and cause double-application of the same Yoga delta.
      if (ci.ownsGrandchildCascade) {
        RNCV_SN_LOG("  hSection[%zu] sIdx=%d component=%s — grandchild cascade owned by sub-container, skipping",
                    i, ci.sectionIndex, ci.component.c_str());
        continue;
      }
      const auto& grandchildren = children[i]->getChildren();
      RNCV_SN_LOG("  hSection[%zu] sIdx=%d grandchildren=%zu",
                  i, ci.sectionIndex, grandchildren.size());
      for (size_t g = 0; g < grandchildren.size(); ++g) {
        auto gcProps = std::dynamic_pointer_cast<const RNMeasuredCellProps>(grandchildren[g]->getProps());
        if (!gcProps || gcProps->cacheKey.empty()) continue;

        const std::string& gcKey = gcProps->cacheKey;
        // getChildren() returns ShadowNode::Shared — cast to LayoutableShadowNode
        // to access Yoga-computed layout metrics.
        auto* layoutableGC = dynamic_cast<const LayoutableShadowNode*>(grandchildren[g].get());
        if (!layoutableGC) continue;
        const auto& gcMetrics = layoutableGC->getLayoutMetrics();
        const auto gcYogaHeight = gcMetrics.frame.size.height;
        const auto gcYogaWidth  = gcMetrics.frame.size.width;

        if (!cache) continue;
        auto cached = cache->getAttributes(gcKey);
        if (!cached) continue;

        // Height delta (cross-axis for H-sections — determines section V-height).
        if ((contentDim == rncv::ContentDimension::Height ||
             contentDim == rncv::ContentDimension::Both) &&
            gcYogaHeight > 0 &&
            std::abs(gcYogaHeight - static_cast<Float>(cached->frame.height)) > 0.5f) {
          deltas.push_back({
            gcKey,
            gcProps->index,
            static_cast<Float>(cached->frame.height),
            gcYogaHeight,
            rncv::MeasurementAxis::Height,
          });
          RNCV_SN_LOG("    hCell[%zu] key=%s heightDelta old=%.1f new=%.1f",
                      g, gcKey.c_str(), cached->frame.height, gcYogaHeight);
        }

        // Width delta (primary-axis for H-sections — item width).
        if ((contentDim == rncv::ContentDimension::Width ||
             contentDim == rncv::ContentDimension::Both) &&
            gcYogaWidth > 0 &&
            std::abs(gcYogaWidth - static_cast<Float>(cached->frame.width)) > 0.5f) {
          deltas.push_back({
            gcKey,
            gcProps->index,
            static_cast<Float>(cached->frame.width),
            gcYogaWidth,
            rncv::MeasurementAxis::Width,
          });
          RNCV_SN_LOG("    hCell[%zu] key=%s widthDelta old=%.1f new=%.1f",
                      g, gcKey.c_str(), cached->frame.width, gcYogaWidth);
        }
      }
      continue;
    }

    if (ci.kind == ChildInfo::Unknown) {
      RNCV_SN_LOG("child[%zu] unknown type, skipping", i);
      continue;
    }

    // MeasuredCell or ScrollCoordinated — check Yoga measurement deltas.
    // No legacy key remap: preserve canonical cache keys end-to-end.
    if (i < 8 || ci.propKind == "header" || ci.key.find("header") != std::string::npos) {
      RNCV_SN_LOG("  remap[%zu] type=%s kind=%s index=%d keyBefore=%s keyAfter=%s",
                  i, ci.type.c_str(), ci.propKind.c_str(), ci.dataIndex, ci.key.c_str(), ci.key.c_str());
    }

    const auto& childMetrics = children[i]->getLayoutMetrics();
    const auto yogaHeight = childMetrics.frame.size.height;
    const auto yogaWidth = childMetrics.frame.size.width;
    // Check height delta (for Height and Both).
    if (contentDim == rncv::ContentDimension::Height ||
         contentDim == rncv::ContentDimension::Both) {
      Float cachedHeight = correctedPositions_[i * 4 + 3];
      if (yogaHeight > 0 && std::abs(yogaHeight - cachedHeight) > 0.5f) {
        deltas.push_back({
            ci.key,
            ci.dataIndex,
            cachedHeight,
            yogaHeight,
            rncv::MeasurementAxis::Height,
        });
        // Update our local positions immediately with Yoga measurement.
        correctedPositions_[i * 4 + 3] = yogaHeight;
      }
    }

    // Check width delta (for Width — horizontal list — and Both — flow layout).
    if (contentDim == rncv::ContentDimension::Width ||
         contentDim == rncv::ContentDimension::Both) {
      Float cachedWidth = correctedPositions_[i * 4 + 2];
      if (yogaWidth > 0 && std::abs(yogaWidth - cachedWidth) > 0.5f) {
        deltas.push_back({
            ci.key,
            ci.dataIndex,
            cachedWidth,
            yogaWidth,
            rncv::MeasurementAxis::Width,
        });
        correctedPositions_[i * 4 + 2] = yogaWidth;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: Apply deltas via layout engine
  //   Opt A+B: Re-read uses bulk getFramesForKeys (single mutex, zero RTTI).
  // ══════════════════════════════════════════════════════════════════════════

  if (!deltas.empty() && engine && cache) {
    // Snapshot anchor before cascading positions so MVC correction is available
    // even when prepare() was not re-run (e.g. pure size-change mutations where
    // layoutContext hasn't changed and JS snapshotAnchor() wasn't called).
    cache->snapshotAnchorIfNeeded();
    const auto cacheVersionBeforeApply = cache->version();
    RNCV_SN_LOG("applyMeasurements: %zu deltas (first: key=%s old=%.1f new=%.1f)",
                deltas.size(), deltas[0].key.c_str(), deltas[0].oldValue, deltas[0].newValue);
    RNCV_SN_MVC_TRACE("applyMeasurements: %zu deltas first={key=%s old=%.1f new=%.1f}",
                      deltas.size(), deltas[0].key.c_str(), deltas[0].oldValue, deltas[0].newValue);
    // Batch mode: coalesce all position writes from the cascade into a single
    // version bump. Without this, one Yoga delta cascading through N items
    // produces N version bumps — the root cause of 50-60 JS re-renders/sec.
    cache->beginBatch();
    bool handled = engine->applyMeasurements(deltas, *cache);
    cache->endBatch();
    RNCV_SN_LOG("applyMeasurements handled=%s cacheVersionBefore=%llu cacheVersionAfter=%llu",
                handled ? "YES" : "NO",
                static_cast<unsigned long long>(cacheVersionBeforeApply),
                static_cast<unsigned long long>(cache->version()));

    if (handled) {
      // Opt B: Bulk re-read all positions from cache after engine cascade.
      auto reread = cache->getFramesForKeys(keys);
      for (size_t i = 0; i < N; ++i) {
        if (i >= reread.found.size() || !reread.found[i]) continue;
        correctedPositions_[i * 4 + 0] = static_cast<Float>(reread.frames[i * 4 + 0]);
        correctedPositions_[i * 4 + 1] = static_cast<Float>(reread.frames[i * 4 + 1]);
        correctedPositions_[i * 4 + 2] = static_cast<Float>(reread.frames[i * 4 + 2]);
        correctedPositions_[i * 4 + 3] = static_cast<Float>(reread.frames[i * 4 + 3]);

        const auto& ci = infos[i];

        // Always log H-section sub-container children after re-read.
        if (ci.kind == ChildInfo::OrthogonalSection) {
          RNCV_SN_LOG("  [PARENT-P3-REREAD] H-sub sIdx=%d key=%s wrapperH=%.1f",
                      ci.sectionIndex, ci.key.c_str(), reread.frames[i * 4 + 3]);
        }

        if (i < 8 || ci.propKind == "header" || ci.key.find("header") != std::string::npos ||
            ci.type == "decoration") {
          RNCV_SN_LOG("  reread[%zu] type=%s kind=%s index=%d keyBefore=%s keyAfter=%s",
                      i, ci.type.c_str(), ci.propKind.c_str(), ci.dataIndex, ci.key.c_str(), ci.key.c_str());
          RNCV_SN_LOG("  rereadHit[%zu] key=%s frame=(%.1f,%.1f,%.1f,%.1f)",
                      i, ci.key.c_str(),
                      reread.frames[i * 4 + 0], reread.frames[i * 4 + 1],
                      reread.frames[i * 4 + 2], reread.frames[i * 4 + 3]);
        }
      }
    }
    // If !handled (JS custom layout), we keep the stale Y positions for one frame.
    // The JS layout will recompute on the next tick.
  } else if (!deltas.empty() && cache) {
    // No engine available — just write Yoga measurements back to cache directly.
    cache->beginBatch();
    for (const auto& d : deltas) {
      auto cached = cache->getAttributes(d.key);
      if (cached) {
        auto updated = *cached;
        updated.frame.height = d.newValue;
        updated.sizingState = rncv::SizingState::Measured;
        cache->setAttributes(updated);
      }
    }
    cache->endBatch();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 4: Compute content size from cache
  //   Opt F: Also compute bounding rect here (was in updateStateIfNeeded).
  // ══════════════════════════════════════════════════════════════════════════

  if (cache) {
    auto cs = cache->getTotalContentSize();
    correctedContentHeight_ = static_cast<Float>(cs.height);
    correctedContentWidth_  = static_cast<Float>(cs.width);
  } else {
    // Fallback: compute from positions.
    Float maxRight  = 0;
    Float maxBottom = 0;
    for (size_t i = 0; i < N; ++i) {
      Float right  = correctedPositions_[i * 4 + 0] + correctedPositions_[i * 4 + 2];
      Float bottom = correctedPositions_[i * 4 + 1] + correctedPositions_[i * 4 + 3];
      if (right  > maxRight)  maxRight  = right;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    correctedContentHeight_ = maxBottom;
    correctedContentWidth_  = maxRight;
  }

  // Bounding rect from final corrected positions (after all phases).
  correctedBoundingRect_ = Rect{};
  for (size_t i = 0; i < N; ++i) {
    correctedBoundingRect_.unionInPlace(Rect{
      Point{correctedPositions_[i * 4], correctedPositions_[i * 4 + 1]},
      Size{correctedPositions_[i * 4 + 2], correctedPositions_[i * 4 + 3]}
    });
  }

  // B4.1: Update short-circuit tracking state for next layout's shouldSkipCorrection check.
  lastChildCount_ = N;
  {
    size_t tagHash  = N;
    size_t yogaHash = N;
    for (size_t i = 0; i < N; ++i) {
      const auto tag = static_cast<size_t>(children[i]->getTag());
      tagHash ^= std::hash<size_t>{}(tag) + 0x9e3779b9 + (tagHash << 6) + (tagHash >> 2);

      const auto& f = children[i]->getLayoutMetrics().frame;
      const size_t vals[4] = {
        static_cast<size_t>(std::lround(f.origin.x      * 100.0f)),
        static_cast<size_t>(std::lround(f.origin.y      * 100.0f)),
        static_cast<size_t>(std::lround(f.size.width    * 100.0f)),
        static_cast<size_t>(std::lround(f.size.height   * 100.0f)),
      };
      for (const size_t v : vals) {
        yogaHash ^= v + 0x9e3779b9 + (yogaHash << 6) + (yogaHash >> 2);
      }
    }
    lastChildTagsHash_  = tagHash;
    lastYogaHeightHash_ = yogaHash;
  }
  if (cache) {
    lastCacheVersion_ = cache->version();
  }
}


void CollectionViewContainerShadowNode::updateStateIfNeeded() {
  auto state = getStateData();

  const auto& props =
      *std::static_pointer_cast<const RNCollectionViewContainerProps>(getProps());
  const auto containerWidth  = getLayoutMetrics().frame.size.width;

  // For horizontal layouts, content scrolls along X: width = computed, height = max item height.
  // For vertical layouts, content scrolls along Y: width = viewport, height = computed.
  // Both dimensions come from the LayoutCache for horizontal (content-determined on both axes).
  const bool isHorizontal = props.horizontal;
  auto contentSize = isHorizontal
      ? Size{correctedContentWidth_, correctedContentHeight_}
      : Size{containerWidth, correctedContentHeight_};

  bool changed = false;

  if (state.contentSize != contentSize) {
    state.contentSize = contentSize;
    changed = true;
  }

  // Opt F: use pre-computed bounding rect from correctChildPositionsIfNeeded.
  if (state.contentBoundingRect != correctedBoundingRect_) {
    state.contentBoundingRect = correctedBoundingRect_;
    changed = true;
  }

  if (state.positions != correctedPositions_ || state.childTags != childTags_) {
    // Offset correction is now handled entirely by JS + LayoutCache
    // (snapshotAnchor → computeCorrection → consumePendingCorrection).
    // The ShadowNode just forwards positions; the native view reads the
    // pending correction directly from LayoutCache in updateState:.
    state.positions = correctedPositions_;
    state.childTags = childTags_;
    state.layoutRevision++;
    changed = true;
  }

  if (changed) {
    setStateData(std::move(state));
  }
}

} // namespace facebook::react
