#include "SpatialIndex.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

namespace rncv {

// ─── Construction ─────────────────────────────────────────────────────────────

SpatialIndex::SpatialIndex(double bucketHeight)
    : _bucketHeight(bucketHeight > 0.0 ? bucketHeight : 200.0) {}

// ─── Private helpers ──────────────────────────────────────────────────────────

int SpatialIndex::bucketOf(double y) const {
  return static_cast<int>(std::floor(y / _bucketHeight));
}

std::pair<int, int> SpatialIndex::bucketRange(const Rect& frame) const {
  return { bucketOf(frame.y), bucketOf(frame.y + frame.height) };
}

// ─── Mutation ─────────────────────────────────────────────────────────────────

void SpatialIndex::insert(const std::string& key, const Rect& frame) {
  auto [first, last] = bucketRange(frame);
  std::vector<int> occupied;
  occupied.reserve(last - first + 1);
  for (int b = first; b <= last; ++b) {
    _buckets[b].push_back(key);
    occupied.push_back(b);
  }
  _keyToBuckets[key] = std::move(occupied);
}

void SpatialIndex::remove(const std::string& key, const Rect& /*frame*/) {
  auto kit = _keyToBuckets.find(key);
  if (kit == _keyToBuckets.end()) return;

  for (int b : kit->second) {
    auto bit = _buckets.find(b);
    if (bit == _buckets.end()) continue;
    auto& vec = bit->second;
    vec.erase(std::remove(vec.begin(), vec.end(), key), vec.end());
    if (vec.empty()) _buckets.erase(bit);
  }
  _keyToBuckets.erase(kit);
}

void SpatialIndex::update(const std::string& key,
                           const Rect& oldFrame,
                           const Rect& newFrame) {
  remove(key, oldFrame);
  insert(key, newFrame);
}

void SpatialIndex::clear() {
  _buckets.clear();
  _keyToBuckets.clear();
}

// ─── Query ────────────────────────────────────────────────────────────────────

std::vector<std::string> SpatialIndex::candidatesInRect(const Rect& rect) const {
  int first = bucketOf(rect.y);
  int last  = bucketOf(rect.y + rect.height);

  // Fast path: single bucket — no deduplication needed.
  if (first == last) {
    auto it = _buckets.find(first);
    return it != _buckets.end() ? it->second : std::vector<std::string>{};
  }

  // Multi-bucket: collect from all overlapping buckets, dedup items that
  // span bucket boundaries (tall items registered in multiple buckets).
  std::vector<std::string> result;
  std::unordered_set<std::string> seen;

  for (int b = first; b <= last; ++b) {
    auto it = _buckets.find(b);
    if (it == _buckets.end()) continue;
    for (const auto& key : it->second) {
      if (seen.insert(key).second) {
        result.push_back(key);
      }
    }
  }
  return result;
}

} // namespace rncv
