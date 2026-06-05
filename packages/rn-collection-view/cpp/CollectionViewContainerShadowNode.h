#pragma once

/**
 * CollectionViewContainerShadowNode — layout-agnostic Fabric ShadowNode.
 *
 * The ShadowNode reads positions from the LayoutCache (populated by
 * layout engines), lets Yoga measure content-determined dimensions,
 * then asks the layout engine to cascade any measurement deltas.
 *
 * Layout-agnostic: no list/grid/masonry-specific logic here.
 * The LayoutEngine protocol handles layout-type-specific cascading.
 *
 * Positions stored in state for native view application (sealed children
 * prevent setLayoutMetrics on scroll-triggered re-layouts).
 */

#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/YogaLayoutableShadowNode.h>
#include <react/renderer/core/LayoutConstraints.h>
#include <react/renderer/core/LayoutContext.h>
#include <yoga/node/Node.h>

// Codegen-generated props and event emitter.
#include <react/renderer/components/RiffSpec/Props.h>
#include <react/renderer/components/RiffSpec/EventEmitters.h>

// Our custom state.
#include "CollectionViewContainerState.h"

// LayoutCache for three-tier height resolution.
#include "LayoutCache.h"

namespace facebook::react {

// Component name constant — must match the JS spec's component name.
JSI_EXPORT extern const char CollectionViewContainerComponentName[];

class CollectionViewContainerShadowNode final
    : public ConcreteViewShadowNode<
          CollectionViewContainerComponentName,
          RNCollectionViewContainerProps,
          RNCollectionViewContainerEventEmitter,
          CollectionViewContainerState> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  /// Clone constructor — propagates skip-correction tracking state across
  /// Fabric clones. Fabric's clone path uses the (source, fragment)
  /// constructor, NOT the C++ default copy ctor; the base only copies
  /// base-class members. Without this explicit override, every clone
  /// resets lastCacheVersion_, lastChildCount_, lastChildTagsHash_,
  /// lastYogaHeightHash_, lastLayoutCacheVersion_ to their declared
  /// defaults — making shouldSkipCorrection() fail on every check, every
  /// commit. Same fix as CollectionSubContainerShadowNode.
  CollectionViewContainerShadowNode(
      const ShadowNode& sourceShadowNode,
      const ShadowNodeFragment& fragment);

  static CollectionViewContainerState initialStateData(
      const Props::Shared& props,
      const ShadowNodeFamily::Shared& family,
      const ComponentDescriptor& componentDescriptor) {
    return CollectionViewContainerState{};
  }

#pragma mark - LayoutableShadowNode

  /**
   * Called after Yoga has computed layout for all children.
   *
   * 1. Calls parent layout() — reads Yoga-computed child dimensions.
   * 2. Reads cache positions, diffs Yoga measurements, asks layout engine
   *    to cascade deltas, re-reads cache for final positions.
   * 3. Updates state (contentSize, positions, offset correction).
   */
  void layout(LayoutContext layoutContext) override;

 private:
  /**
   * B4.1: Skip correction + state update when children + cache are unchanged.
   * Caches {cacheVersion, childCount, childTagsHash, yogaFrameHash} and returns
   * true when all four match — same short-circuit pattern as H-4b in
   * CollectionSubContainerShadowNode.
   */
  bool shouldSkipCorrection();

  /**
   * Layout-agnostic position correction:
   * - Read positions from LayoutCache
   * - Diff Yoga measurements against cache
   * - Call LayoutEngine::applyMeasurements() for cascading
   * - Store final positions in correctedPositions_ for state
   */
  void correctChildPositionsIfNeeded();

  /**
   * Update component state with new layout results.
   */
  void updateStateIfNeeded();

  // Scratch storage for corrected positions [x,y,w,h,...].
  // Stored in state for native view to apply as child frames.
  std::vector<Float> correctedPositions_;
  // Fabric tags for each child, parallel to correctedPositions_.
  // Enables tag-based (not index-based) lookup in applyPositionsFromState.
  std::vector<int32_t> childTags_;
  Float correctedContentHeight_ = 0;
  Float correctedContentWidth_  = 0;  // populated for horizontal layouts (ContentDimension::Width)
  // Opt F: bounding rect computed in correctChildPositionsIfNeeded, used by updateStateIfNeeded.
  Rect correctedBoundingRect_{};

  // B4.1: short-circuit tracking state (copied on Fabric clone → persists across commits).
  uint64_t lastCacheVersion_      = 0;
  size_t   lastChildCount_        = 0;
  size_t   lastChildTagsHash_     = 0;
  size_t   lastYogaHeightHash_    = 0;
  int      lastLayoutCacheVersion_ = -1;
  // B4.17: V container's own writes bump _vVersion (not _version) — see
  // LayoutCache::endVBatch and ::vVersion. This lets sub-containers ignore
  // V correction's writes while V container still observes its own work
  // to avoid skipping a commit where it just changed cache state.
  uint64_t lastVVersion_          = 0;
};

} // namespace facebook::react
