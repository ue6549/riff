#pragma once

/**
 * LayoutEngine — abstract protocol for all layout types.
 *
 * Layout engines compute positions for all items and write complete
 * LayoutAttributes to the shared LayoutCache. The ShadowNode is
 * layout-agnostic — it reads the cache, lets Yoga measure, then asks
 * the layout engine to cascade any measurement deltas.
 *
 * Built-in implementations: ListLayout, GridLayout, MasonryLayout, FlowLayout.
 * JS custom layouts return false from applyMeasurements() — ShadowNode
 * accepts a one-frame delay for the JS layout to recompute.
 */

#include "LayoutCache.h"
#include <string>
#include <vector>

namespace rncv {

enum class MeasurementAxis {
  Unknown,
  Width,
  Height,
};

/// A single Yoga measurement that differs from the cache.
struct MeasurementDelta {
  std::string key;        // cache key of the measured item
  int         index;      // data index
  double      oldValue;   // value in cache before Yoga
  double      newValue;   // Yoga-measured value
  MeasurementAxis axis = MeasurementAxis::Unknown;
};

/// Which dimensions are determined by cell content (Yoga measures these).
/// The layout governs all other dimensions.
enum class ContentDimension {
  None,    // Layout governs everything (circular, radial)
  Height,  // Vertical list/grid/masonry: Yoga measures height
  Width,   // Horizontal list: Yoga measures width
  Both,    // Flow: Yoga measures both width and height
};

/// Optional context for scroll-driven layouts. Layouts use this to know
/// the current viewport size, scroll offset, and section the scroll applies
/// to (when running inside a sub-container).
struct ScrollLayoutContext {
  double containerWidth  = 0;
  double containerHeight = 0;
  double offsetX         = 0;
  double offsetY         = 0;
  int    section         = -1;  // -1 for layouts not bound to a single section
};

class LayoutEngine {
public:
  virtual ~LayoutEngine() = default;

  // ── computeSections contract ──────────────────────────────────────────────
  //
  // Each concrete engine exposes a type-specific computeSections(params) method.
  // _cache->clear() is called by the JSI binding lambda BEFORE invoking
  // computeSections(), so the method itself is a pure layout function.
  //
  // Internal per-section helpers (e.g. ListLayout::computeSectionFromCache,
  // called by CompositionalLayout) must NOT call _cache->clear() — they operate
  // on a cache that is already cleared and partially populated by the caller.

  /**
   * Apply Yoga measurement deltas and recompute cascading positions.
   *
   * Called by ShadowNode after Yoga runs, when measured dimensions differ
   * from cache values. The engine should:
   *   1. Update the affected items' frames in cache
   *   2. Recompute positions of all items affected by the cascade
   *
   * Returns true if the cascade was handled (C++ layouts).
   * Returns false if it couldn't be handled (JS custom layouts) —
   * ShadowNode accepts stale positions for one frame.
   */
  virtual bool applyMeasurements(
      const std::vector<MeasurementDelta>& deltas,
      LayoutCache& cache) = 0;

  /**
   * Which dimensions are content-determined (Yoga should measure these).
   * ShadowNode uses this to know which Yoga results to write back to cache.
   */
  virtual ContentDimension contentDeterminedDimension() const = 0;

  /**
   * Optional scroll-driven layout hook.
   *
   * Sub-container layouts (radial, spiral, carousel3D, ...) override this to
   * recompute positions / transforms / opacity per scroll tick directly into
   * the cache. Static layouts (list, grid, masonry, flow) leave it as a no-op.
   *
   * When this returns true, the sub-container ShadowNode skips its Yoga
   * cascade and trusts the cache entirely.
   *
   * Default: no-op, returns false (so static layouts retain their behaviour).
   */
  virtual bool processScroll(LayoutCache& /*cache*/,
                             const ScrollLayoutContext& /*ctx*/) {
    return false;
  }

  /**
   * Whether this layout writes non-default LayoutAttributes — alpha, zIndex,
   * and/or transform3D — into the LayoutCache.
   *
   * Default false (static layouts: list / grid / masonry / flow /
   * compositional with all-static sub-sections). When false, the native side
   * gates off the per-cell visual-attrs read/write in
   * RNCollectionViewContainerView::applyPositionsFromState and in
   * CollectionSubContainerShadowNode::correctChildPositionsIfNeeded —
   * avoiding N mutex-locked cache lookups + N layer-property writes per
   * commit.
   *
   * Override and return true for scroll-driven layouts that animate
   * per-cell transforms (radial, carousel3D, spiral, …).
   */
  virtual bool writesVisualAttributes() const { return false; }
};

} // namespace rncv
