#pragma once

#include "../LayoutCache.h"
#include <jsi/jsi.h>
#include <memory>
#include <string>

namespace rncv {

// ─── Input params ─────────────────────────────────────────────────────────────

/**
 * Parameters for a single-section list layout.
 * All sizes in points (same coordinate space as UIKit).
 */
struct ListLayoutParams {
  // --- Fixed-height mode (M1.2) ---
  int    itemCount      = 0;
  double itemHeight     = 44.0;   // used when sizingStrategy == "fixed"
  double viewportWidth  = 390.0;
  double sectionInsetTop    = 0;
  double sectionInsetBottom = 0;
  double sectionInsetLeft   = 0;
  double sectionInsetRight  = 0;
  double itemSpacing    = 0;      // vertical gap between items
  int    section        = 0;      // section index written into attributes

  // Key prefix for generated item keys: "{keyPrefix}{index}"
  // Defaults to "item-{section}-"
  std::string keyPrefix;

  // Per-item identity keys (optional).
  // When non-empty, keys[i] is used for item i instead of keyPrefix+i.
  // Allows the layout cache to be keyed by item identity (e.g. keyExtractor
  // output) so cache keys and React reconciliation keys agree, enabling
  // correct incremental invalidation when data reorders.
  std::vector<std::string> keys;

  // --- Estimated-height mode (M1.3) ---
  // When non-empty, itemHeights[i] is used per-item (overrides itemHeight).
  // sizingState is set to Placeholder for each item.
  std::vector<double> itemHeights;

  // --- Multi-section mode (M1.5) ---
  // 0 = no header / footer for this section.
  double headerHeight   = 0;
  double footerHeight   = 0;
};

// ─── ListLayout ───────────────────────────────────────────────────────────────

/**
 * Pure-function list layout engine.
 *
 * Writes computed LayoutAttributes directly into the provided LayoutCache.
 * No retained state — safe to call from any thread (LayoutCache is thread-safe).
 *
 * M1.2: fixed uniform height
 * M1.3: estimated variable heights + invalidateFrom
 * M1.5: multi-section with headers/footers + invalidateSectionsFrom
 */
class ListLayout {
public:
  explicit ListLayout(std::shared_ptr<LayoutCache> cache);

  /**
   * Single-section full layout pass (M1.2/M1.3).
   * Clears existing items in this section and writes new attributes.
   * O(itemCount).
   */
  void compute(const ListLayoutParams& params);

  /**
   * Single-section partial re-layout from a given key onward (M1.3).
   * Items before the key are untouched. O(n) from the invalidation point.
   */
  void invalidateFrom(const std::string& key, const ListLayoutParams& params);

  /**
   * Multi-section full layout pass (M1.5).
   * Lays out all sections in order, stacking them vertically.
   * Writes regular item attrs and supplementary (header/footer) attrs.
   * O(total item count).
   */
  void computeSections(const std::vector<ListLayoutParams>& sections);

  /**
   * Multi-section partial re-layout from a section index onward (M1.5).
   * Sections before fromSection are untouched.
   * Reads the existing cache to find the start Y of fromSection.
   * O(items in sections fromSection..end).
   */
  void invalidateSectionsFrom(int fromSection,
                               const std::vector<ListLayoutParams>& sections);

  // ── JSI ─────────────────────────────────────────────────────────────────

  /**
   * Installs JSI methods onto `target`:
   *   computeListLayout(params: object) → undefined            [M1.2/M1.3]
   *   invalidateListLayoutFrom(key, params) → undefined        [M1.3]
   *   computeSections(sections: object[]) → undefined          [M1.5]
   *   invalidateSectionsFrom(idx, sections: object[]) → undefined [M1.5]
   */
  void installJSIBindings(
      facebook::jsi::Runtime& rt,
      facebook::jsi::Object& target);

private:
  std::shared_ptr<LayoutCache> _cache;

  // Reusable attribute — mutated and copied into cache each iteration.
  // Avoids per-item allocation in the hot loop.
  LayoutAttributes _scratch;

  void computeFixed(const ListLayoutParams& p);
  void computeEstimated(const ListLayoutParams& p);

  // Lays out one section starting at startY. Returns Y where next section starts.
  double computeSection(const ListLayoutParams& p, int sectionIndex, double startY);

  // Like computeSection but reads each item's height from the cache instead of
  // params. Used by invalidateSectionsFrom so that measured heights that were
  // written into the cache before calling invalidate are preserved.
  double computeSectionFromCache(const ListLayoutParams& p, int sectionIndex, double startY);

  static ListLayoutParams paramsFromJSI(
      facebook::jsi::Runtime& rt,
      const facebook::jsi::Object& obj);

  static std::vector<ListLayoutParams> sectionsFromJSI(
      facebook::jsi::Runtime& rt,
      const facebook::jsi::Array& arr);
};

} // namespace rncv
