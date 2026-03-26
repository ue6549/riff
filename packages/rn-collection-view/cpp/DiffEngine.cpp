#include "DiffEngine.h"

#include <algorithm>
#include <unordered_map>

namespace rncv {

DiffResult diff(const std::vector<std::string>& oldKeys,
                const std::vector<std::string>& newKeys) {
  DiffResult result;

  const int oldSize = (int)oldKeys.size();
  const int newSize = (int)newKeys.size();

  if (oldSize == 0 && newSize == 0) return result;

  // ── Step 1: index maps  O(n) ─────────────────────────────────────────────────

  std::unordered_map<std::string, int> oldMap, newMap;
  oldMap.reserve(oldSize);
  newMap.reserve(newSize);

  for (int i = 0; i < oldSize; ++i) oldMap[oldKeys[i]] = i;
  for (int i = 0; i < newSize; ++i) newMap[newKeys[i]] = i;

  // ── Step 2: removed (in old, not in new)  O(n) ───────────────────────────────

  for (int i = 0; i < oldSize; ++i) {
    if (newMap.find(oldKeys[i]) == newMap.end()) {
      result.removed.push_back(oldKeys[i]);
    }
  }

  // ── Step 3: inserted (in new, not in old)  O(n) ──────────────────────────────

  for (int i = 0; i < newSize; ++i) {
    if (oldMap.find(newKeys[i]) == oldMap.end()) {
      result.inserted.push_back(newKeys[i]);
    }
  }

  // ── Step 4: moved — LIS on old indices in new order  O(n log n) ──────────────
  //
  // For items present in both arrays, list their old indices in the order they
  // appear in newKeys. The Longest Increasing Subsequence (LIS) of this sequence
  // identifies items whose relative order is already correct — they need no move.
  // Every item outside the LIS must be explicitly repositioned.
  //
  // LIS algorithm: patience sort variant with predecessor tracking so we can
  // reconstruct exactly which elements are in the LIS.

  struct CommonItem { int newIdx; int oldIdx; };
  std::vector<CommonItem> common;
  common.reserve((size_t)std::min(oldSize, newSize));

  for (int ni = 0; ni < newSize; ++ni) {
    auto it = oldMap.find(newKeys[ni]);
    if (it != oldMap.end()) {
      common.push_back({ ni, it->second });
    }
  }

  const int n = (int)common.size();
  if (n == 0) return result; // nothing in common — all inserted/removed, no moves

  // tails[k]    = smallest oldIdx of any increasing subsequence of length k+1
  // tailPos[k]  = index into common[] for that element
  // pred[i]     = index into common[] of predecessor of common[i] in the LIS
  std::vector<int> tails;
  std::vector<int> tailPos;
  std::vector<int> pred(n, -1);
  tails.reserve(n);
  tailPos.reserve(n);

  for (int i = 0; i < n; ++i) {
    const int val = common[i].oldIdx;

    // Binary search: first position in tails where tails[pos] >= val
    const int pos = (int)(std::lower_bound(tails.begin(), tails.end(), val)
                          - tails.begin());

    if (pos == (int)tails.size()) {
      tails.push_back(val);
      tailPos.push_back(i);
    } else {
      tails[pos] = val;
      tailPos[pos] = i;
    }

    if (pos > 0) pred[i] = tailPos[pos - 1];
  }

  // Backtrack from the tail of the longest IS to mark which elements are in it.
  std::vector<bool> inLIS(n, false);
  {
    int cur = tailPos.back();
    while (cur != -1) {
      inLIS[cur] = true;
      cur = pred[cur];
    }
  }

  // Items not in the LIS must move.
  for (int i = 0; i < n; ++i) {
    if (!inLIS[i]) {
      result.moved.push_back({
        newKeys[common[i].newIdx],
        common[i].oldIdx,
        common[i].newIdx,
      });
    }
  }

  return result;
}

} // namespace rncv
