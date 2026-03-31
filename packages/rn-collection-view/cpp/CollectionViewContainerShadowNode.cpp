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

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
  #ifdef __APPLE__
    #include <os/log.h>
    #define RNCV_SN_LOG(fmt, ...) os_log_info(os_log_create("com.rncv", "shadownode"), "[RNCV-SN] " fmt, ##__VA_ARGS__)
  #else
    #include <android/log.h>
    #define RNCV_SN_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-SN", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_SN_LOG(fmt, ...) ((void)0)
#endif

namespace facebook::react {

// Must match the string used in codegenNativeComponent('RNCollectionViewContainer').
const char CollectionViewContainerComponentName[] = "RNCollectionViewContainer";

void CollectionViewContainerShadowNode::layout(LayoutContext layoutContext) {
  RNCV_SN_LOG("layout() BEGIN");

  // Step 1: Call parent layout — Yoga computes child dimensions.
  ConcreteViewShadowNode::layout(layoutContext);

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
    return;
  }

  const auto renderRangeStart = props.renderRangeStart;
  const auto estimatedItemHeight = props.estimatedItemHeight;
  const auto containerWidth = getLayoutMetrics().frame.size.width;

  // Look up the shared LayoutCache and LayoutEngine via static registry.
  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);

  // Determine layout type string from the enum prop.
  // codegen generates: 0=list, 1=grid, 2=masonry, 3=flow
  std::string layoutType = "list";
  switch (props.layoutType) {
    case RNCollectionViewContainerLayoutType::Grid:    layoutType = "grid";    break;
    case RNCollectionViewContainerLayoutType::Masonry: layoutType = "masonry"; break;
    case RNCollectionViewContainerLayoutType::Flow:    layoutType = "flow";    break;
    default: break;
  }

  auto engine = CollectionViewModule::getLayoutEngineForId(
      props.layoutCacheId, layoutType);

  // Key prefix: must match what the JS layout engine wrote to cache.
  std::string keyPrefix = "item-0-";
  if (layoutType == "grid")    keyPrefix = "grid-";
  else if (layoutType == "masonry") keyPrefix = "masonry-";
  else if (layoutType == "flow")    keyPrefix = "flow-";

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

  // ── Phase 1: Read positions from cache for each mounted child ──────────
  //
  // The layout engine has already written complete LayoutAttributes to the cache.
  // ShadowNode is layout-agnostic — it reads whatever the cache has.
  // Fallback to estimatedItemHeight only when cache has no entry.

  correctedPositions_.clear();
  correctedPositions_.reserve(children.size() * 4);

  for (size_t i = 0; i < children.size(); ++i) {
    // Read the cache key from the child's props (same logic as Phase 2).
    // This is critical for headers/footers whose keys are "item-{section}-header",
    // not "item-{section}-{dataIndex}".
    std::string key;
    std::string propType;
    std::string propKind;
    int32_t propIndex = -1;
    std::string propCacheKey;
    std::string component = "unknown";
    std::string fallbackKey;
    if (auto measuredProps = std::dynamic_pointer_cast<const RNMeasuredCellProps>(children[i]->getProps())) {
      const auto& p = *measuredProps;
      component = "RNMeasuredCell";
      propType = p.type;
      propKind = p.kind;
      propIndex = p.index;
      propCacheKey = p.cacheKey;
      warnOnMissingSupplementaryKey(p.type, p.kind, p.index, p.cacheKey);
      warnOnUnexpectedType(p.type, p.kind, p.index, p.cacheKey);
      key = p.cacheKey;
      if (key.empty()) {
        fallbackKey = keyPrefix + std::to_string(p.index >= 0 ? p.index : (renderRangeStart + static_cast<int32_t>(i)));
        key = fallbackKey;
      }
    } else if (auto scrollProps = std::dynamic_pointer_cast<const RNScrollCoordinatedViewProps>(children[i]->getProps())) {
      const auto& p = *scrollProps;
      component = "RNScrollCoordinatedView";
      propType = p.type;
      propKind = p.kind;
      propIndex = p.index;
      propCacheKey = p.cacheKey;
      warnOnMissingSupplementaryKey(p.type, p.kind, p.index, p.cacheKey);
      warnOnUnexpectedType(p.type, p.kind, p.index, p.cacheKey);
      key = p.cacheKey;
      if (key.empty()) {
        fallbackKey = keyPrefix + std::to_string(p.index >= 0 ? p.index : (renderRangeStart + static_cast<int32_t>(i)));
        key = fallbackKey;
      }
    } else {
      // Unknown child type — use positional fallback
      const auto dataIndex = renderRangeStart + static_cast<int32_t>(i);
      fallbackKey = keyPrefix + std::to_string(dataIndex);
      key = fallbackKey;
    }

    Float effectiveX = 0;
    Float effectiveY = 0;
    Float effectiveWidth = containerWidth;
    Float effectiveHeight = estimatedItemHeight;

    bool cacheHit = false;
    if (cache) {
      auto cached = cache->getAttributes(key);
      if (cached) {
        cacheHit = true;
        effectiveX = static_cast<Float>(cached->frame.x);
        effectiveY = static_cast<Float>(cached->frame.y);
        if (cached->frame.width > 0) {
          effectiveWidth = static_cast<Float>(cached->frame.width);
        }
        if (cached->frame.height > 0) {
          effectiveHeight = static_cast<Float>(cached->frame.height);
        }
      }
    }

    correctedPositions_.push_back(effectiveX);
    correctedPositions_.push_back(effectiveY);
    correctedPositions_.push_back(effectiveWidth);
    correctedPositions_.push_back(effectiveHeight);

    // Log first 5 children: cache position vs what we'll store
    if (i < 8 || propKind == "header" || key.find("header") != std::string::npos) {
      const auto& childMetrics = children[i]->getLayoutMetrics();
      RNCV_SN_LOG("  child[%zu] component=%s type=%s kind=%s index=%d propCacheKey=%s fallbackKey=%s finalKey=%s cacheHit=%s cache=(%.1f,%.1f,%.1f,%.1f) yoga=(%.1f,%.1f,%.1f,%.1f)",
                  i, component.c_str(), propType.c_str(), propKind.c_str(), propIndex,
                  propCacheKey.c_str(), fallbackKey.c_str(), key.c_str(), cacheHit ? "YES" : "NO",
                  effectiveX, effectiveY, effectiveWidth, effectiveHeight,
                  childMetrics.frame.origin.x, childMetrics.frame.origin.y,
                  childMetrics.frame.size.width, childMetrics.frame.size.height);
    }
  }

  // ── Phase 2: Diff Yoga measurements vs cache, build deltas ─────────────
  //
  // After Yoga runs, compare Yoga-measured content-determined dimensions
  // against what the cache had. Collect deltas for the layout engine.

  auto contentDim = engine
      ? engine->contentDeterminedDimension()
      : rncv::ContentDimension::Height;

  std::vector<rncv::MeasurementDelta> deltas;

  for (size_t i = 0; i < children.size(); ++i) {
    std::string key;
    std::string type;
    std::string kind;
    int32_t dataIndex = -1;

    if (auto measuredProps = std::dynamic_pointer_cast<const RNMeasuredCellProps>(children[i]->getProps())) {
      const auto& p = *measuredProps;
      type = p.type;
      kind = p.kind;
      dataIndex = p.index;
      warnOnMissingSupplementaryKey(type, kind, dataIndex, p.cacheKey);
      warnOnUnexpectedType(type, kind, dataIndex, p.cacheKey);
      key = p.cacheKey.empty() ? (keyPrefix + std::to_string(dataIndex)) : p.cacheKey;
    } else if (auto scrollProps = std::dynamic_pointer_cast<const RNScrollCoordinatedViewProps>(children[i]->getProps())) {
      const auto& p = *scrollProps;
      type = p.type;
      kind = p.kind;
      dataIndex = p.index;
      warnOnMissingSupplementaryKey(type, kind, dataIndex, p.cacheKey);
      warnOnUnexpectedType(type, kind, dataIndex, p.cacheKey);
      key = p.cacheKey.empty() ? (keyPrefix + std::to_string(dataIndex)) : p.cacheKey;
    } else {
      RNCV_SN_LOG("child[%zu] is neither RNMeasuredCell nor RNScrollCoordinatedView, skipping", i);
      continue;
    }
    
    // No legacy key remap: preserve canonical cache keys end-to-end.
    const std::string keyBeforeRemap = key;
    if (i < 8 || kind == "header" || key.find("header") != std::string::npos) {
      RNCV_SN_LOG("  remap[%zu] type=%s kind=%s index=%d keyBefore=%s keyAfter=%s",
                  i, type.c_str(), kind.c_str(), dataIndex, keyBeforeRemap.c_str(), key.c_str());
    }

    const auto& childMetrics = children[i]->getLayoutMetrics();
    const auto yogaHeight = childMetrics.frame.size.height;
    const auto yogaWidth = childMetrics.frame.size.width;

    // Check height delta (for Height and Both).
    if (contentDim == rncv::ContentDimension::Height ||
        contentDim == rncv::ContentDimension::Both) {
      Float cachedHeight = correctedPositions_[i * 4 + 3];
      if (yogaHeight > 0 && std::abs(yogaHeight - cachedHeight) > 0.5f) {
        deltas.push_back({key, dataIndex, cachedHeight, yogaHeight});
        // Update our local positions immediately with Yoga measurement.
        correctedPositions_[i * 4 + 3] = yogaHeight;
      }
    }

    // TODO: Check width delta for Flow layout (ContentDimension::Both/Width).
    // For now, width deltas are deferred — flow layout handles them via
    // applyMeasurements full re-layout.
  }

  // ── Phase 3: Apply deltas via layout engine ────────────────────────────
  //
  // If there are deltas, ask the layout engine to cascade position changes.
  // The engine updates the cache in-place. We re-read affected positions.

  if (!deltas.empty() && engine && cache) {
    const auto cacheVersionBeforeApply = cache->version();
    RNCV_SN_LOG("applyMeasurements: %zu deltas (first: key=%s old=%.1f new=%.1f)",
                deltas.size(), deltas[0].key.c_str(), deltas[0].oldValue, deltas[0].newValue);
    bool handled = engine->applyMeasurements(deltas, *cache);
    RNCV_SN_LOG("applyMeasurements handled=%s cacheVersionBefore=%llu cacheVersionAfter=%llu",
                handled ? "YES" : "NO",
                static_cast<unsigned long long>(cacheVersionBeforeApply),
                static_cast<unsigned long long>(cache->version()));

    if (handled) {
      // Re-read all positions from cache (engine may have cascaded changes).
      for (size_t i = 0; i < children.size(); ++i) {
        std::string key;
        std::string type;
        std::string kind;
        int32_t dataIndex = -1;

        if (auto measuredProps = std::dynamic_pointer_cast<const RNMeasuredCellProps>(children[i]->getProps())) {
          const auto& p = *measuredProps;
          type = p.type;
          kind = p.kind;
          dataIndex = p.index;
          warnOnMissingSupplementaryKey(type, kind, dataIndex, p.cacheKey);
          warnOnUnexpectedType(type, kind, dataIndex, p.cacheKey);
          key = p.cacheKey.empty() ? (keyPrefix + std::to_string(dataIndex)) : p.cacheKey;
        } else if (auto scrollProps = std::dynamic_pointer_cast<const RNScrollCoordinatedViewProps>(children[i]->getProps())) {
          const auto& p = *scrollProps;
          type = p.type;
          kind = p.kind;
          dataIndex = p.index;
          warnOnMissingSupplementaryKey(type, kind, dataIndex, p.cacheKey);
          warnOnUnexpectedType(type, kind, dataIndex, p.cacheKey);
          key = p.cacheKey.empty() ? (keyPrefix + std::to_string(dataIndex)) : p.cacheKey;
        } else {
          continue;
        }
        
        // No legacy key remap: preserve canonical cache keys end-to-end.
        const std::string keyBeforeRemap = key;
        if (i < 8 || kind == "header" || key.find("header") != std::string::npos) {
          RNCV_SN_LOG("  reread[%zu] type=%s kind=%s index=%d keyBefore=%s keyAfter=%s",
                      i, type.c_str(), kind.c_str(), dataIndex, keyBeforeRemap.c_str(), key.c_str());
        }

        auto cached = cache->getAttributes(key);
        if (cached) {
          correctedPositions_[i * 4 + 0] = static_cast<Float>(cached->frame.x);
          correctedPositions_[i * 4 + 1] = static_cast<Float>(cached->frame.y);
          correctedPositions_[i * 4 + 2] = static_cast<Float>(cached->frame.width);
          correctedPositions_[i * 4 + 3] = static_cast<Float>(cached->frame.height);
          if (i < 8 || kind == "header" || key.find("header") != std::string::npos) {
            RNCV_SN_LOG("  rereadHit[%zu] key=%s frame=(%.1f,%.1f,%.1f,%.1f)",
                        i, key.c_str(), cached->frame.x, cached->frame.y,
                        cached->frame.width, cached->frame.height);
          }
        }
      }
    }
    // If !handled (JS custom layout), we keep the stale Y positions for one frame.
    // The JS layout will recompute on the next tick.
  } else if (!deltas.empty() && cache) {
    // No engine available — just write Yoga measurements back to cache directly.
    for (const auto& d : deltas) {
      auto cached = cache->getAttributes(d.key);
      if (cached) {
        auto updated = *cached;
        updated.frame.height = d.newValue;
        updated.sizingState = rncv::SizingState::Measured;
        cache->setAttributes(updated);
      }
    }
  }

  // ── Phase 4: Compute content height from cache ─────────────────────────

  if (cache) {
    auto contentSize = cache->getTotalContentSize();
    correctedContentHeight_ = static_cast<Float>(contentSize.height);
  } else {
    // Fallback: compute from positions.
    Float maxBottom = 0;
    for (size_t i = 0; i < children.size(); ++i) {
      Float bottom = correctedPositions_[i * 4 + 1] + correctedPositions_[i * 4 + 3];
      if (bottom > maxBottom) maxBottom = bottom;
    }
    correctedContentHeight_ = maxBottom;
  }
}


void CollectionViewContainerShadowNode::updateStateIfNeeded() {
  auto state = getStateData();

  const auto containerWidth = getLayoutMetrics().frame.size.width;
  auto contentSize = Size{containerWidth, correctedContentHeight_};

  // Compute content bounding rect from corrected positions.
  auto contentBoundingRect = Rect{};
  const auto childCount = correctedPositions_.size() / 4;
  for (size_t i = 0; i < childCount; ++i) {
    auto x = correctedPositions_[i * 4];
    auto y = correctedPositions_[i * 4 + 1];
    auto w = correctedPositions_[i * 4 + 2];
    auto h = correctedPositions_[i * 4 + 3];
    contentBoundingRect.unionInPlace(Rect{Point{x, y}, Size{w, h}});
  }

  bool changed = false;

  if (state.contentSize != contentSize) {
    state.contentSize = contentSize;
    changed = true;
  }

  if (state.contentBoundingRect != contentBoundingRect) {
    state.contentBoundingRect = contentBoundingRect;
    changed = true;
  }

  if (state.positions != correctedPositions_) {
    // Offset correction is now handled entirely by JS + LayoutCache
    // (snapshotAnchor → computeCorrection → consumePendingCorrection).
    // The ShadowNode just forwards positions; the native view reads the
    // pending correction directly from LayoutCache in updateState:.
    state.positions = correctedPositions_;
    state.layoutRevision++;
    changed = true;
  }

  if (changed) {
    setStateData(std::move(state));
  }
}

} // namespace facebook::react
