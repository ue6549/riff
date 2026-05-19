#pragma once

#include "../LayoutCache.h"
#include "../LayoutEngine.h"
#include "ListLayout.h"
#include "GridLayout.h"
#include "FlowLayout.h"
#include "MasonryLayout.h"
#include <jsi/jsi.h>
#include <memory>
#include <string>
#include <variant>
#include <vector>

namespace rncv {

/**
 * Tagged union of per-section layout params.
 * `layoutType` identifies which sub-engine handles this section.
 * `horizontal` = true enables orthogonal (H-axis) layout for this section.
 * H-sections produce a "h-section-wrapper-{sIdx}" LayoutCache entry that
 * lets CollectionViewContainerShadowNode position RNOrthogonalSectionView.
 */
struct CompositionalSectionInfo {
  std::string layoutType; // "list" | "grid" | "flow" | "masonry"
  bool horizontal = false; // Phase 2: orthogonal (horizontal) sections
  std::variant<ListLayoutParams,
               GridLayoutParams,
               FlowLayoutParams,
               MasonryLayoutParams> params;

  // Level 1 (compositional-owned) supplementary info.
  // Headers/footers are positioned in V-coordinates by the compositional engine,
  // independent of the leaf sub-engine's coordinate space.
  float headerHeight = 0;
  float footerHeight = 0;
  int   headerFlatIndex = -1;
  int   footerFlatIndex = -1;
  bool  emitSectionBackground = false;
  float sectionSpacing = 0;
};

/**
 * CompositionalLayout — orchestrates multiple sub-engines across sections.
 *
 * Allows each section to use a different layout type (list, grid, flow, masonry)
 * within a single CollectionView. One scroll axis (vertical only in Phase 1).
 *
 * Contract:
 *   nativeMod.compositionalLayout.computeSections(sections[])
 *   nativeMod.compositionalLayout.invalidateSectionsFrom(n, sections[])
 *
 * Each section object in the JS array must have:
 *   layoutType: "list" | "grid" | "flow" | "masonry"
 *   + all fields required by that sub-layout's params struct.
 *
 * Cache clearing: done once at the start of computeSections().
 * Sub-engine computeSection() methods write to the shared cache without clearing.
 * The TS layer should call layoutCache.stashHeights() before computeSections()
 * when re-laying out with Yoga-measured heights to preserve, then clearStash() after.
 *
 * Key prefixes (per sub-engine, no collision across sections):
 *   list   → "item-{section}-{index}"
 *   grid   → "grid-{section}-{index}"
 *   flow   → "flow-{section}-{index}"
 *   masonry → "masonry-{section}-{index}"
 */
class CompositionalLayout : public LayoutEngine {
public:
  CompositionalLayout(
      std::shared_ptr<LayoutCache> cache,
      std::shared_ptr<ListLayout>   listLayout,
      std::shared_ptr<GridLayout>   gridLayout,
      std::shared_ptr<FlowLayout>   flowLayout,
      std::shared_ptr<MasonryLayout> masonryLayout);

  /**
   * Full layout pass. Clears the cache, then computes each section in order,
   * chaining the primary-axis cursor so sections stack correctly.
   */
  void computeSections(const std::vector<CompositionalSectionInfo>& sections);

  /**
   * Partial re-layout from fromSection onward. Does NOT clear the cache.
   * Reads existing measured heights from the cache for the first affected section;
   * uses stored params for subsequent sections.
   */
  void invalidateSectionsFrom(int fromSection,
                               const std::vector<CompositionalSectionInfo>& sections);

  // ── LayoutEngine protocol ──────────────────────────────────────────────────

  /**
   * Called by the ShadowNode when Yoga measures item dimensions.
   * Writes new sizes to the cache and reflowes affected sections.
   */
  bool applyMeasurements(
      const std::vector<MeasurementDelta>& deltas,
      LayoutCache& cache) override;

  /**
   * Re-derives h-section-wrapper-{sectionIndex}.frame.height from the current
   * state of item frames in the cache.  Called by the sub-container ShadowNode
   * after applyMeasurements so the wrapper stays in sync with real Yoga heights
   * even when applyMeasurements' thresholds suppressed a full recompute.
   *
   * Early-returns if the wrapper key is absent (non-compositional sub-containers
   * — radial/spiral/carousel3D — carry their size via props, not this key).
   */
  static void refreshHSectionWrapperHeight(LayoutCache& cache, int sectionIndex);

  ContentDimension contentDeterminedDimension() const override {
    // Phase 1: vertical-only. Sub-engines may determine height or both.
    // Return Both to be safe: the ShadowNode sends the most useful deltas.
    return ContentDimension::Both;
  }

  void installJSIBindings(facebook::jsi::Runtime& rt,
                           facebook::jsi::Object& target);

private:
  std::shared_ptr<LayoutCache>    _cache;
  std::shared_ptr<ListLayout>     _listLayout;
  std::shared_ptr<GridLayout>     _gridLayout;
  std::shared_ptr<FlowLayout>     _flowLayout;
  std::shared_ptr<MasonryLayout>  _masonryLayout;

  // Stored for invalidateSectionsFrom / applyMeasurements reflow.
  std::vector<CompositionalSectionInfo> _sectionInfos;
  // Primary-axis cursor at the start of each section (before the header).
  std::vector<double> _sectionStartPrimaries;

  // Compute one section including Level 1 supplementaries (header/footer/background)
  // and Level 2 leaf content. Returns the primary-axis cursor at the end.
  double computeOneSection(const CompositionalSectionInfo& info,
                            int sectionIndex, double startPrimary);

  // Like computeOneSection but reads item sizes from cache (preserves Yoga measurements).
  double computeOneSectionFromCache(const CompositionalSectionInfo& info,
                                     int sectionIndex, double startPrimary);

  // Dispatch to the correct sub-engine for leaf content only.
  double dispatchLeafCompute(const CompositionalSectionInfo& info,
                              int sectionIndex, double startPrimary);
  double dispatchLeafComputeFromCache(const CompositionalSectionInfo& info,
                                       int sectionIndex, double startPrimary);

  // H-section finalization: Y-shift items, write wrapper + cw entries.
  // Returns the actual V-height of the H-section (max cross extent or estimate).
  float finalizeHSection(const CompositionalSectionInfo& info,
                          int sectionIndex, double contentCursorY,
                          double hContentEnd);

  // JSI parsing helpers.
  static CompositionalSectionInfo sectionInfoFromJSI(
      facebook::jsi::Runtime& rt,
      const facebook::jsi::Object& obj);
  static std::vector<CompositionalSectionInfo> sectionsFromJSI(
      facebook::jsi::Runtime& rt,
      const facebook::jsi::Array& arr);
};

} // namespace rncv
