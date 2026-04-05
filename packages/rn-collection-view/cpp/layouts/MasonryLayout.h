#pragma once

#include "../LayoutCache.h"
#include "../LayoutEngine.h"
#include <jsi/jsi.h>
#include <memory>
#include <string>
#include <vector>

namespace rncv {

struct MasonryLayoutParams {
  int itemCount = 0;
  int columns = 2;
  double columnSpacing = 8.0;
  double rowSpacing = 8.0;
  double viewportWidth = 390.0;
  double viewportHeight = 0.0;       // cross-axis viewport (for horizontal mode)
  double sectionInsetTop = 0;
  double sectionInsetBottom = 0;
  double sectionInsetLeft = 0;
  double sectionInsetRight = 0;
  std::vector<double> itemHeights; // per-item heights (required for V; Yoga measures for H)
  std::vector<std::string> keys;   // per-item identity keys
  std::string keyPrefix;           // fallback key prefix: "masonry-N-"

  // Per-section fields (used by computeSections / computeSection)
  int    section               = 0;
  double headerHeight          = 0.0;
  double footerHeight          = 0.0;
  bool   emitSectionBackground = false;
  bool   emitSeparators        = false;  // lane-divider separators (between columns V, between rows H)
  double separatorHeight       = 0.5;
  double separatorInsetLeading  = 0.0;
  double separatorInsetTrailing = 0.0;
  double sectionSpacing        = 0.0;

  // Content insets applied to the sectionBackground frame at emission time.
  double sectionBackgroundInsetTop    = 0;
  double sectionBackgroundInsetBottom = 0;
  double sectionBackgroundInsetLeft   = 0;
  double sectionBackgroundInsetRight  = 0;

  // Horizontal mode (primary=X, cross=Y; items placed in shortest row)
  bool   horizontal               = false;
  double estimatedCrossAxisHeight = 200.0;
};

class MasonryLayout : public LayoutEngine {
public:
  explicit MasonryLayout(std::shared_ptr<LayoutCache> cache);

  /**
   * Compute masonry layout: place each item in the shortest lane.
   * Legacy single-section entry point. Use computeSections for multi-section.
   */
  void compute(const MasonryLayoutParams& params);

  /**
   * Multi-section layout pass — standard contract (mirrors GridLayout::computeSections).
   * Clears the cache and lays out all sections sequentially.
   */
  void computeSections(const std::vector<MasonryLayoutParams>& sections);

  /**
   * Partial re-layout from fromSection onward, preserving measured heights.
   * Standard contract (mirrors GridLayout::invalidateSectionsFrom).
   */
  void invalidateSectionsFrom(int fromSection,
                               const std::vector<MasonryLayoutParams>& sections);

  // ── LayoutEngine protocol ──────────────────────────────────────────────

  bool applyMeasurements(
      const std::vector<MeasurementDelta>& deltas,
      LayoutCache& cache) override;

  ContentDimension contentDeterminedDimension() const override {
    // H-masonry: Yoga measures both widths (primary) and heights (cross).
    // V-masonry: Yoga measures heights only.
    return _horizontal ? ContentDimension::Both : ContentDimension::Height;
  }

  void installJSIBindings(facebook::jsi::Runtime& rt, facebook::jsi::Object& target);

private:
  std::shared_ptr<LayoutCache> _cache;
  bool   _horizontal         = false;
  double _viewportHeight     = 0.0;
  double _maxCrossAxisHeight = 0.0;  // H-masonry: global max Yoga-measured item height
  std::vector<MasonryLayoutParams> _sectionParams; // stored for applyMeasurements

  /** Layout one section from scratch. Returns next section's startPrimary. */
  double computeSection(const MasonryLayoutParams& p, int sectionIndex, double startPrimary);

  /** Re-layout one section reading item heights from cache. Returns next startPrimary. */
  double computeSectionFromCache(const MasonryLayoutParams& p, int sectionIndex, double startPrimary);

  static MasonryLayoutParams paramsFromJSI(facebook::jsi::Runtime& rt,
                                            const facebook::jsi::Object& obj);
  static std::vector<MasonryLayoutParams> sectionsFromJSI(facebook::jsi::Runtime& rt,
                                                           const facebook::jsi::Array& arr);
};

} // namespace rncv
