#pragma once

#include <string>
#include <vector>

namespace rncv {

/**
 * DiffEngine — F1.1
 *
 * Key-based identity diff. Computes the minimal set of edit operations to
 * transform oldKeys into newKeys. Same key = same item (identity, not value).
 *
 * Complexity:
 *   O(n) for pure insertions/deletions (no moves detected)
 *   O(n log n) when moves are present (LIS-based minimal move set)
 *
 * Stability: items that form the Longest Increasing Subsequence of old indices
 * (as seen in new order) are never reported as moved — guarantees minimal moves.
 */
struct DiffResult {
  struct Move {
    std::string key;
    int fromIndex; // index in oldKeys
    int toIndex;   // index in newKeys
  };

  std::vector<std::string> removed;  // keys present in old, absent in new
  std::vector<std::string> inserted; // keys present in new, absent in old
  std::vector<Move>        moved;    // keys in both but at different relative positions
};

DiffResult diff(const std::vector<std::string>& oldKeys,
                const std::vector<std::string>& newKeys);

} // namespace rncv
