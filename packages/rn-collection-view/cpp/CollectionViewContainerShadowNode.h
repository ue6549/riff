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
#include <react/renderer/core/LayoutContext.h>
#include <yoga/node/Node.h>

// Codegen-generated props and event emitter.
#include <react/renderer/components/RNCollectionViewSpec/Props.h>
#include <react/renderer/components/RNCollectionViewSpec/EventEmitters.h>

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
   * 1. Calls parent layout() — Yoga computes child dimensions.
   * 2. Reads cache positions, diffs Yoga measurements, asks layout engine
   *    to cascade deltas, re-reads cache for final positions.
   * 3. Updates state (contentSize, positions, offset correction).
   */
  void layout(LayoutContext layoutContext) override;

 private:
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
  Float correctedContentHeight_ = 0;
};

} // namespace facebook::react
