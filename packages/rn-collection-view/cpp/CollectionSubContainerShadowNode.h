#pragma once

/**
 * CollectionSubContainerShadowNode — generic Fabric ShadowNode for a single
 * section of a CollectionView (orthogonal H sections, radial, spiral,
 * carousel3D, hex, and any future custom layouts).
 *
 * Mirrors the main CollectionViewContainerShadowNode pattern, but scoped to
 * a single section's items. Reads positions, transforms, opacity, and zIndex
 * from the shared LayoutCache (populated by the per-section layout engine —
 * compositional, or any custom TS/C++ layout), lets Yoga measure
 * content-determined dimensions, then asks the layout engine to cascade any
 * measurement deltas.
 *
 * The state object carries rich ChildVisualState (frame + transform + opacity
 * + zIndex) per child so that scroll-driven layouts can natively apply visual
 * updates without any JS round-trip.
 */

#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/YogaLayoutableShadowNode.h>
#include <react/renderer/core/LayoutContext.h>

// Codegen-generated props and event emitter for RNCollectionSubContainer.
#include <react/renderer/components/RiffSpec/Props.h>
#include <react/renderer/components/RiffSpec/EventEmitters.h>

#include "CollectionSubContainerState.h"
#include "LayoutCache.h"

namespace facebook::react {

// Component name constant — must match the JS spec's component name.
JSI_EXPORT extern const char CollectionSubContainerComponentName[];

class CollectionSubContainerShadowNode final
    : public ConcreteViewShadowNode<
          CollectionSubContainerComponentName,
          RNCollectionSubContainerProps,
          RNCollectionSubContainerEventEmitter,
          CollectionSubContainerState> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  /// Clone constructor — propagates skip-correction tracking state from the
  /// source shadow node across Fabric clones. The base class's clone path
  /// (called for every Fabric commit) does NOT use the C++ default copy
  /// constructor; it uses this specific (source, fragment) signature, which
  /// the base class implements but only copies base-class members. Without
  /// an explicit override here, every clone resets lastCacheVersion_,
  /// lastHMvcVersion_, lastLayoutCacheVersion_, lastChildCount_,
  /// lastChildTagsHash_, lastYogaHeightHash_ to their declared defaults —
  /// causing shouldSkipCorrection() to fail on every check, every commit,
  /// for every sub-container instance. (Skip rate diag confirmed 0% with
  /// lcv=-1→… ver=0→… hMvc=0→… N=0→… on every sample.)
  CollectionSubContainerShadowNode(
      const ShadowNode& sourceShadowNode,
      const ShadowNodeFragment& fragment);

  static CollectionSubContainerState initialStateData(
      const Props::Shared& /*props*/,
      const ShadowNodeFamily::Shared& /*family*/,
      const ComponentDescriptor& /*componentDescriptor*/) {
    return CollectionSubContainerState{};
  }

#pragma mark - LayoutableShadowNode

  /**
   * Called after Yoga has computed layout for this view's children.
   *
   * 1. Calls parent layout — Yoga sizes children.
   * 2. Reads cache attributes for direct children, builds Yoga deltas,
   *    asks the layout engine to cascade them.
   * 3. Re-reads cache for final values (frame + transform + opacity + zIndex)
   *    and packs into ChildVisualState entries.
   * 4. Updates state with positions, content size, and bounding rect.
   */
  void layout(LayoutContext layoutContext) override;

 private:
  /**
   * Iterate direct children, extract cacheKeys, bulk-read cache, build deltas
   * (when the layout engine reports a content-determined dimension), apply
   * cascade, re-read final attributes, and populate correctedChildren_.
   */
  void correctChildPositionsIfNeeded();

  /**
   * Update component state with new layout results.
   */
  void updateStateIfNeeded();

  /// H-4b: Short-circuit — skip correctChildPositionsIfNeeded + updateState
  /// when children and cache are unchanged from the previous layout pass.
  /// Fabric clones ShadowNodes via copy ctor, so these fields carry forward.
  bool shouldSkipCorrection();
  uint64_t lastCacheVersion_{0};
  uint64_t lastHMvcVersion_{0};
  int      lastLayoutCacheVersion_{-1};
  size_t   lastChildCount_{0};
  size_t   lastChildTagsHash_{0};
  /// Hash of per-child Yoga heights — catches content changes (Resize,
  /// expand/collapse) that change Yoga dimensions without touching tags or cache.
  size_t   lastYogaHeightHash_{0};

  /// Scratch storage — final per-child visual state for this section.
  std::vector<ChildVisualState> correctedChildren_;
  /// Fabric tags parallel to correctedChildren_.
  std::vector<int32_t> childTags_;
  /// Total content size of this section's owned region.
  Size correctedContentSize_{};
  /// Bounding rect of all positioned children.
  Rect correctedBoundingRect_{};
};

} // namespace facebook::react
