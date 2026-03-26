#pragma once

#include "Geometry.h"
#include <string>
#include <vector>
#include <unordered_map>

namespace rncv {

/**
 * 1D bucket-based spatial index for layout attributes.
 *
 * Divides the Y axis into fixed-height buckets. Each item is registered in
 * every bucket whose Y range overlaps the item's frame. A rect query collects
 * candidates from the overlapping buckets in O(buckets_spanned + k), then the
 * caller performs an exact rectsIntersect check.
 *
 * For a 844px viewport and 200px buckets: ~5 buckets scanned, O(5 + k).
 * For 10 000 list items at avg 175px height: ~1 item/bucket → query touches
 * ~5–6 items total before exact filtering. Far under 0.05ms on device.
 *
 * Interface is Rect-based so v2 can swap the backing structure (R-tree, grid
 * bucket) without changing any callers.
 *
 * Thread safety: NOT thread-safe. LayoutCache acquires its own mutex before
 * every call into this class.
 */
class SpatialIndex {
public:
  explicit SpatialIndex(double bucketHeight = 200.0);

  // ── Mutation ──────────────────────────────────────────────────────────────

  void insert(const std::string& key, const Rect& frame);
  void remove(const std::string& key, const Rect& frame);

  /** Remove old frame, insert new frame. O(buckets_spanned × item_count_per_bucket). */
  void update(const std::string& key, const Rect& oldFrame, const Rect& newFrame);

  void clear();

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Returns candidate keys whose frames MAY intersect rect.
   * Result is a superset — caller must exact-check with rectsIntersect().
   * Duplicates are removed (items spanning multiple buckets appear once).
   */
  std::vector<std::string> candidatesInRect(const Rect& rect) const;

private:
  double _bucketHeight;

  // bucket_index → insertion-ordered list of keys in that bucket
  std::unordered_map<int, std::vector<std::string>> _buckets;

  // key → bucket indices occupied (needed for O(1) bucket lookup on remove)
  std::unordered_map<std::string, std::vector<int>> _keyToBuckets;

  int bucketOf(double y) const;
  std::pair<int, int> bucketRange(const Rect& frame) const;
};

} // namespace rncv
