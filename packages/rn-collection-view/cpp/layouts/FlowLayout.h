#pragma once

#include "../LayoutCache.h"
#include "../LayoutEngine.h"
#include <jsi/jsi.h>
#include <memory>
#include <string>
#include <vector>

namespace rncv {

struct FlowLayoutParams {
  int itemCount = 0;
  double itemSpacing = 0.0;   // gap between items within a row (V) or column (H)
  double lineSpacing = 0.0;   // gap between rows (V) or columns (H)
  double viewportWidth  = 390.0;
  double viewportHeight = 0.0; // cross-axis viewport for horizontal mode
  double sectionInsetTop    = 0;
  double sectionInsetBottom = 0;
  double sectionInsetLeft   = 0;
  double sectionInsetRight  = 0;
  std::vector<double> itemWidths;   // per-item widths (required)
  std::vector<double> itemHeights;  // per-item heights (required)
  std::vector<std::string> keys;    // per-item identity keys
  std::string keyPrefix;            // fallback key prefix: "flow-{section}-"

  // Per-section supplementary fields
  int    section               = 0;
  double headerHeight          = 0.0;
  double footerHeight          = 0.0;
  bool   emitSectionBackground = false;
  bool   emitSeparators        = false; // between-row (V) or between-column (H) separators
  double separatorHeight       = 0.5;
  double separatorInsetLeading  = 0.0;
  double separatorInsetTrailing = 0.0;
  double sectionSpacing        = 0.0;

  // Content insets applied to the sectionBackground frame at emission time.
  double sectionBackgroundInsetTop    = 0;
  double sectionBackgroundInsetBottom = 0;
  double sectionBackgroundInsetLeft   = 0;
  double sectionBackgroundInsetRight  = 0;

  // Horizontal mode (primary=X, cross=Y; items pack top→bottom, wrap to next column)
  bool horizontal = false;
};

class FlowLayout : public LayoutEngine {
public:
  explicit FlowLayout(std::shared_ptr<LayoutCache> cache);

  /**
   * Compute flow layout: pack items left-to-right (V) or top-to-bottom (H),
   * wrapping when the next item doesn't fit.
   * Legacy single-section entry point. Use computeSections for multi-section.
   */
  void compute(const FlowLayoutParams& params);

  /**
   * Multi-section layout pass — standard contract (mirrors GridLayout::computeSections).
   * Clears the cache and lays out all sections sequentially.
   */
  void computeSections(const std::vector<FlowLayoutParams>& sections);

  /**
   * Partial re-layout from fromSection onward, preserving measured dimensions.
   * Standard contract (mirrors GridLayout::invalidateSectionsFrom).
   */
  void invalidateSectionsFrom(int fromSection,
                               const std::vector<FlowLayoutParams>& sections);

  // ── LayoutEngine protocol ──────────────────────────────────────────────

  bool applyMeasurements(
      const std::vector<MeasurementDelta>& deltas,
      LayoutCache& cache) override;

  ContentDimension contentDeterminedDimension() const override {
    // Flow always measures both W and H (items are arbitrary-sized).
    return ContentDimension::Both;
  }

  void installJSIBindings(facebook::jsi::Runtime& rt, facebook::jsi::Object& target);

private:
  std::shared_ptr<LayoutCache> _cache;
  bool _horizontal = false;
  std::vector<FlowLayoutParams> _sectionParams; // stored for applyMeasurements

  /** Layout one section from scratch. Returns next section's startPrimary. */
  double computeSection(const FlowLayoutParams& p, int sectionIndex, double startPrimary);

  /** Re-layout one section reading item dimensions from cache. Returns next startPrimary. */
  double computeSectionFromCache(const FlowLayoutParams& p, int sectionIndex, double startPrimary);

  static FlowLayoutParams paramsFromJSI(facebook::jsi::Runtime& rt,
                                        const facebook::jsi::Object& obj);
  static std::vector<FlowLayoutParams> sectionsFromJSI(facebook::jsi::Runtime& rt,
                                                        const facebook::jsi::Array& arr);
};

} // namespace rncv
