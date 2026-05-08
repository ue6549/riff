#pragma once

#include "../LayoutCache.h"
#include "../LayoutEngine.h"
#include <jsi/jsi.h>
#include <memory>
#include <string>
#include <vector>

namespace rncv {

struct GridLayoutParams {
  int itemCount = 0;
  int columns = 2;
  double columnSpacing = 0.0;
  double rowSpacing = 0.0;
  double viewportWidth = 390.0;
  double viewportHeight = 0.0;       // cross-axis viewport (for horizontal mode)
  double sectionInsetTop = 0;
  double sectionInsetBottom = 0;
  double sectionInsetLeft = 0;
  double sectionInsetRight = 0;
  double rowHeight = 0.0;            // fixed row height (0 = dynamic)
  std::vector<double> itemHeights;   // per-item heights (for dynamic rows)
  std::vector<std::string> keys;     // per-item identity keys
  std::string keyPrefix;             // fallback key prefix: "grid-N-"

  // Per-section fields (used by computeSections / computeSection)
  int    section               = 0;
  double headerHeight          = 0.0;
  double footerHeight          = 0.0;
  bool   emitSectionBackground = false;
  bool   emitSeparators        = false;  // row separators (between rows)
  double separatorHeight       = 0.5;
  double separatorInsetLeading  = 0.0;
  double separatorInsetTrailing = 0.0;
  double sectionSpacing        = 0.0;

  // Content insets applied to the sectionBackground frame at emission time.
  // Positive shrinks frame inward; negative expands outward.
  // Applied in absolute visual coordinates (top/bottom → Y/height, left/right → X/width).
  double sectionBackgroundInsetTop    = 0;
  double sectionBackgroundInsetBottom = 0;
  double sectionBackgroundInsetLeft   = 0;
  double sectionBackgroundInsetRight  = 0;

  // Flat index mapping (for processScroll binary search)
  int flatIndexBase     = 0;
  int headerFlatIndex   = -1;
  int footerFlatIndex   = -1;

  // Horizontal mode
  bool   horizontal               = false;
  double estimatedCrossAxisHeight = 200.0;
};

class GridLayout : public LayoutEngine {
public:
  explicit GridLayout(std::shared_ptr<LayoutCache> cache);

  /**
   * Compute grid layout: fixed columns, row-aligned heights.
   * Legacy single-section entry point. Use computeSections for multi-section.
   */
  void compute(const GridLayoutParams& params);

  /**
   * Multi-section layout pass — standard contract (mirrors ListLayout::computeSections).
   * Clears the cache and lays out all sections sequentially.
   */
  void computeSections(const std::vector<GridLayoutParams>& sections);

  /**
   * Partial re-layout from fromSection onward, preserving measured heights.
   * Standard contract (mirrors ListLayout::invalidateSectionsFrom).
   */
  void invalidateSectionsFrom(int fromSection,
                               const std::vector<GridLayoutParams>& sections);

  // ── LayoutEngine protocol ──────────────────────────────────────────────

  bool applyMeasurements(
      const std::vector<MeasurementDelta>& deltas,
      LayoutCache& cache) override;

  ContentDimension contentDeterminedDimension() const override {
    // H-grid: Yoga measures both widths (primary) and heights (cross).
    // Engine tracks global max height for uniform column-row Y positioning.
    return _horizontal ? ContentDimension::Both : ContentDimension::Height;
  }

  void installJSIBindings(facebook::jsi::Runtime& rt, facebook::jsi::Object& target);

  // ── Compositional access (used by CompositionalLayout) ─────────────────
  /** Layout one section from scratch. Returns next section's startPrimary. */
  double computeSection(const GridLayoutParams& p, int sectionIndex, double startPrimary);

  /** Re-layout one section reading item heights from cache. Returns next startPrimary. */
  double computeSectionFromCache(const GridLayoutParams& p, int sectionIndex, double startPrimary);

  static GridLayoutParams paramsFromJSI(facebook::jsi::Runtime& rt,
                                        const facebook::jsi::Object& obj);

private:
  std::shared_ptr<LayoutCache> _cache;
  int    _columns            = 2;
  bool   _horizontal         = false;
  double _viewportHeight     = 0.0;     // retained for V-grid (cross=X); unused for H-grid cross-axis
  double _maxCrossAxisHeight = 0.0;     // H-grid: global max Yoga-measured item height
  std::vector<GridLayoutParams> _sectionParams; // stored for applyMeasurements

  static std::vector<GridLayoutParams> sectionsFromJSI(facebook::jsi::Runtime& rt,
                                                        const facebook::jsi::Array& arr);
};

} // namespace rncv
