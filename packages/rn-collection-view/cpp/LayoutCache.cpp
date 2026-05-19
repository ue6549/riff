#include "LayoutCache.h"

#include <algorithm>
#include <limits>
#include <stdexcept>

#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

// Set RNCV_ENABLE_MVC_TRACE=1 to enable verbose MVC lifecycle tracing.
// Covers: stashHeights, cache.clear, snapshotAnchor, snapshotAnchorIfNeeded,
// computeCorrection, and height source in computeSectionFromCache.
// Keep 0 in normal development; enable only to debug insert/delete/correction bugs.
#ifndef RNCV_ENABLE_MVC_TRACE
#define RNCV_ENABLE_MVC_TRACE 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
  #ifdef __APPLE__
    #include <os/log.h>
    #define RNCV_MVC_LOG(fmt, ...) os_log_info(os_log_create("com.rncv", "mvc"), "[RNCV-MVC] " fmt, ##__VA_ARGS__)
  #else
    #include <android/log.h>
    #define RNCV_MVC_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-MVC", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_MVC_LOG(fmt, ...) ((void)0)
#endif

#if DEBUG && RNCV_ENABLE_MVC_TRACE
  #ifdef __APPLE__
    #ifndef RNCV_MVC_LOG_HEADER_INCLUDED
    #define RNCV_MVC_LOG_HEADER_INCLUDED
    #include <os/log.h>
    #endif
    #define RNCV_MVC_TRACE(fmt, ...) os_log_info(os_log_create("com.rncv", "mvc-trace"), "[MVC-TRACE] " fmt, ##__VA_ARGS__)
  #else
    #include <android/log.h>
    #define RNCV_MVC_TRACE(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "MVC-TRACE", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_MVC_TRACE(fmt, ...) ((void)0)
#endif

namespace rncv {

using namespace facebook;
using namespace facebook::jsi;

// ─── Core CRUD ───────────────────────────────────────────────────────────────

void LayoutCache::setAttributes(const LayoutAttributes& attrs) {
  std::lock_guard<std::mutex> lock(_mutex);
  _setAttributesLocked(attrs);
}

void LayoutCache::setAttributesBatch(
    const std::vector<LayoutAttributes>& batch) {
  if (batch.empty()) return;
  std::lock_guard<std::mutex> lock(_mutex);
  // Batch mode: coalesce all writes into a single version bump.
  _batchDepth++;
  for (const auto& attrs : batch) {
    _setAttributesLocked(attrs);
  }
  _batchDepth--;
  if (_batchDepth == 0 && _batchDirty) {
    ++_version;
    _batchDirty = false;
  }
}

void LayoutCache::beginBatch() {
  // Caller must hold _mutex (or call from a path that already holds it).
  // Public callers go through the ShadowNode which holds its own lock;
  // the mutex is acquired here for safety.
  std::lock_guard<std::mutex> lock(_mutex);
  _batchDepth++;
}

void LayoutCache::endBatch() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (_batchDepth > 0) _batchDepth--;
  if (_batchDepth == 0 && _batchDirty) {
    ++_version;
    _batchDirty = false;
  }
}

void LayoutCache::_setAttributesLocked(const LayoutAttributes& attrs) {
  auto it = _map.find(attrs.key);
  if (it == _map.end()) {
    // New entry — always bump version (or mark dirty in batch mode).
    _insertionOrder.push_back(attrs.key);
    _index.insert(attrs.key, attrs.frame);
    _map[attrs.key] = attrs;
    if (_batchDepth > 0) _batchDirty = true; else ++_version;
    _sortedDirty = true;
  } else {
    // Existing entry — only bump version if frame changed.
    // Non-frame fields (sizingState, alpha, zIndex) are still updated but don't
    // affect visibility ranges, scroll behavior, or the stable-band skip.
    const auto& oldFrame = it->second.frame;
    bool frameChanged = oldFrame.x != attrs.frame.x ||
                        oldFrame.y != attrs.frame.y ||
                        oldFrame.width != attrs.frame.width ||
                        oldFrame.height != attrs.frame.height;
    if (frameChanged) {
      _index.update(attrs.key, it->second.frame, attrs.frame);
      if (_batchDepth > 0) _batchDirty = true; else ++_version;
      _sortedDirty = true;
    }
    it->second = attrs;
  }

  // Opt C: maintain flatIndex → key secondary index.
  if (attrs.flatIndex >= 0) {
    const auto fi = static_cast<size_t>(attrs.flatIndex);
    if (fi >= _flatIndexToKey.size()) {
      _flatIndexToKey.resize(fi + 1);
    }
    _flatIndexToKey[fi] = attrs.key;
  }

  // (section, item) → key reverse index for O(1) scrollToIndexPath.
  if (!attrs.isSupplementary && !attrs.isDecoration && attrs.index >= 0) {
    const uint64_t ip = (uint64_t(uint32_t(attrs.section)) << 32) | uint32_t(attrs.index);
    _indexPathToKey[ip] = attrs.key;
  }
  // section → header key for O(1) scrollToSection.
  if (attrs.isSupplementary && attrs.supplementaryKind == "header") {
    _sectionHeaderKey[attrs.section] = attrs.key;
  }
}

std::optional<LayoutAttributes> LayoutCache::getAttributes(
    const std::string& key) const {
  std::lock_guard<std::mutex> lock(_mutex);
  auto it = _map.find(key);
  if (it == _map.end()) return std::nullopt;
  return it->second;
}

void LayoutCache::removeAttributes(const std::string& key) {
  std::lock_guard<std::mutex> lock(_mutex);
  auto it = _map.find(key);
  if (it != _map.end()) {
    const auto& attrs = it->second;
    // Clean up reverse index maps.
    if (!attrs.isSupplementary && !attrs.isDecoration && attrs.index >= 0) {
      const uint64_t ip = (uint64_t(uint32_t(attrs.section)) << 32) | uint32_t(attrs.index);
      _indexPathToKey.erase(ip);
    }
    if (attrs.isSupplementary && attrs.supplementaryKind == "header") {
      _sectionHeaderKey.erase(attrs.section);
    }
    _index.remove(key, attrs.frame);
    _map.erase(it);
    _insertionOrder.erase(
        std::remove(_insertionOrder.begin(), _insertionOrder.end(), key),
        _insertionOrder.end());
    ++_version;
    _sortedDirty = true;
  }
}

void LayoutCache::clear() {
  std::lock_guard<std::mutex> lock(_mutex);
  RNCV_MVC_TRACE("cache.clear: removing %zu entries", _map.size());
  _map.clear();
  _insertionOrder.clear();
  _index.clear();
  _sorted.clear();
  _sortedDirty = true;
  _flatIndexToKey.clear();
  _indexPathToKey.clear();
  _sectionHeaderKey.clear();
  ++_version;
}

// ── Height stash ──────────────────────────────────────────────────────────────

void LayoutCache::stashHeights() {
  // No mutex needed: stash is only accessed from the JS thread, sequentially
  // with clear() and computeSections(). Never accessed from native threads.
  std::lock_guard<std::mutex> lock(_mutex);
  _heightStash.clear();
  _measuredSizeStash.clear();
  for (const auto& kv : _map) {
    if (kv.second.sizingState == SizingState::Measured) {
      const double sz = _horizontal ? kv.second.frame.width : kv.second.frame.height;
      _heightStash[kv.first] = sz;
      _measuredSizeStash[kv.first] = { kv.second.frame.width, kv.second.frame.height };
    }
  }
  RNCV_MVC_TRACE("stashHeights: %zu entries stashed (of %zu total)",
                  _heightStash.size(), _map.size());
}

double LayoutCache::getStashedHeight(const std::string& key) const {
  auto it = _heightStash.find(key);
  return it != _heightStash.end() ? it->second : -1.0;
}

void LayoutCache::stashMeasuredSizes() {
  // No mutex needed: stash is only accessed from the JS thread, sequentially
  // with clear() and computeSections(). Never accessed from native threads.
  std::lock_guard<std::mutex> lock(_mutex);
  _measuredSizeStash.clear();
  for (const auto& kv : _map) {
    if (kv.second.sizingState == SizingState::Measured) {
      _measuredSizeStash[kv.first] = { kv.second.frame.width, kv.second.frame.height };
    }
  }
}

std::optional<Size> LayoutCache::getStashedMeasuredSize(const std::string& key) const {
  auto it = _measuredSizeStash.find(key);
  if (it == _measuredSizeStash.end()) return std::nullopt;
  return it->second;
}

void LayoutCache::clearStash() {
  _heightStash.clear();
  _measuredSizeStash.clear();
}

// ─── Bulk access ─────────────────────────────────────────────────────────────

std::vector<LayoutAttributes> LayoutCache::getAll() const {
  std::lock_guard<std::mutex> lock(_mutex);
  std::vector<LayoutAttributes> result;
  result.reserve(_insertionOrder.size());
  for (const auto& key : _insertionOrder) {
    auto it = _map.find(key);
    if (it != _map.end()) result.push_back(it->second);
  }
  return result;
}

std::vector<LayoutAttributes> LayoutCache::getAttributesInRect(
    const Rect& rect) const {
  std::lock_guard<std::mutex> lock(_mutex);
  // M1.4: use spatial index — O(buckets_spanned + k) instead of O(n).
  auto candidates = _index.candidatesInRect(rect);
  std::vector<LayoutAttributes> result;
  result.reserve(candidates.size());
  for (const auto& key : candidates) {
    auto it = _map.find(key);
    if (it != _map.end() && rectsIntersect(it->second.frame, rect)) {
      result.push_back(it->second);
    }
  }
  return result;
}

// ─── Binary search for sorted layouts ────────────────────────────────────────

LayoutCache::PrimaryRange LayoutCache::findRangeByPrimary(
    double lo, double hi, bool horizontal) const {
  std::lock_guard<std::mutex> lock(_mutex);

  // Lazy-rebuild sorted index if dirty or axis changed.
  if (_sortedDirty || _sortedHorizontal != horizontal) {
    _sorted.clear();
    _sorted.reserve(_insertionOrder.size());
    for (const auto& key : _insertionOrder) {
      auto it = _map.find(key);
      if (it == _map.end()) continue;
      const auto& a = it->second;
      // Skip decorations — they don't have flat indices and shouldn't
      // affect render/visible range computation.
      if (a.isDecoration) continue;
      double pos  = horizontal ? a.frame.x : a.frame.y;
      double size = horizontal ? a.frame.width : a.frame.height;
      SortedEntry entry;
      entry.pos = pos;
      entry.size = size;
      entry.key = key;
      _sorted.push_back(entry);
    }
    std::sort(_sorted.begin(), _sorted.end(),
              [](const SortedEntry& a, const SortedEntry& b) { return a.pos < b.pos; });
    _sortedDirty = false;
    _sortedHorizontal = horizontal;
  }

  PrimaryRange result;
  if (_sorted.empty()) return result;

  // Binary search: first entry whose (pos + size) > lo  (i.e., extends past lo).
  int firstMatch = -1;
  {
    int left = 0, right = static_cast<int>(_sorted.size()) - 1;
    while (left <= right) {
      int mid = left + (right - left) / 2;
      if (_sorted[mid].pos + _sorted[mid].size > lo) {
        firstMatch = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
  }
  if (firstMatch < 0) return result; // all items are before lo

  // Binary search: last entry whose pos < hi  (i.e., starts before hi).
  int lastMatch = -1;
  {
    int left = 0, right = static_cast<int>(_sorted.size()) - 1;
    while (left <= right) {
      int mid = left + (right - left) / 2;
      if (_sorted[mid].pos < hi) {
        lastMatch = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
  }
  if (lastMatch < 0 || lastMatch < firstMatch) return result;

  // Look up flat indices from the map for first and last items.
  auto firstIt = _map.find(_sorted[firstMatch].key);
  auto lastIt  = _map.find(_sorted[lastMatch].key);
  if (firstIt == _map.end() || lastIt == _map.end()) return result;

  // Find min/max flat index across the range (items may not be in flat-index order
  // if supplementaries are interleaved, so scan the range).
  int minFI = std::numeric_limits<int>::max();
  int maxFI = std::numeric_limits<int>::min();
  for (int i = firstMatch; i <= lastMatch; ++i) {
    auto it = _map.find(_sorted[i].key);
    if (it == _map.end()) continue;
    int fi = it->second.flatIndex;
    if (fi < 0) continue; // supplementary/decoration without flatIndex
    if (fi < minFI) minFI = fi;
    if (fi > maxFI) maxFI = fi;
  }

  if (minFI > maxFI) return result; // no valid flat indices found

  result.firstIdx  = minFI;
  result.lastIdx   = maxFI;
  result.firstPos  = _sorted[firstMatch].pos;
  result.firstSize = _sorted[firstMatch].size;
  result.lastPos   = _sorted[lastMatch].pos;
  result.lastSize  = _sorted[lastMatch].size;
  return result;
}

// ─── Frame bulk read (Change C — eliminate per-cell JSI in renderCell) ───────

std::vector<double> LayoutCache::getFramesForFlatRange(int firstFlat, int lastFlat) const {
  if (firstFlat > lastFlat) return {};
  const int count = lastFlat - firstFlat + 1;
  std::vector<double> result(static_cast<size_t>(count) * 4, 0.0);
  std::lock_guard<std::mutex> lock(_mutex);

  // Opt C: use flatIndex secondary index for O(range) instead of O(cache_size).
  if (!_flatIndexToKey.empty()) {
    for (int fi = firstFlat; fi <= lastFlat; ++fi) {
      if (fi < 0 || fi >= static_cast<int>(_flatIndexToKey.size())) continue;
      const auto& key = _flatIndexToKey[static_cast<size_t>(fi)];
      if (key.empty()) continue;
      auto it = _map.find(key);
      if (it == _map.end()) continue;
      size_t off = static_cast<size_t>(fi - firstFlat) * 4;
      result[off + 0] = it->second.frame.x;
      result[off + 1] = it->second.frame.y;
      result[off + 2] = it->second.frame.width;
      result[off + 3] = it->second.frame.height;
    }
  } else {
    // Fallback: scan all entries (before any layout engine has set flatIndex).
    for (const auto& [key, attrs] : _map) {
      int fi = attrs.flatIndex;
      if (fi < firstFlat || fi > lastFlat) continue;
      size_t off = static_cast<size_t>(fi - firstFlat) * 4;
      result[off + 0] = attrs.frame.x;
      result[off + 1] = attrs.frame.y;
      result[off + 2] = attrs.frame.width;
      result[off + 3] = attrs.frame.height;
    }
  }
  return result;
}

// ─── Opt B: Bulk frame read by key (ShadowNode hot path) ────────────────────

BulkFrameResult LayoutCache::getFramesForKeys(const std::vector<std::string>& keys) const {
  BulkFrameResult result;
  result.frames.resize(keys.size() * 4, 0.0);
  result.found.resize(keys.size(), false);
  std::lock_guard<std::mutex> lock(_mutex);
  for (size_t i = 0; i < keys.size(); ++i) {
    auto it = _map.find(keys[i]);
    if (it != _map.end()) {
      result.found[i] = true;
      result.frames[i * 4 + 0] = it->second.frame.x;
      result.frames[i * 4 + 1] = it->second.frame.y;
      result.frames[i * 4 + 2] = it->second.frame.width;
      result.frames[i * 4 + 3] = it->second.frame.height;
    }
  }
  return result;
}

// ─── Item heights (bulk read) ────────────────────────────────────────────────

std::vector<double> LayoutCache::getItemHeights(int section, int count) const {
  std::lock_guard<std::mutex> lock(_mutex);
  std::vector<double> heights(count, 0.0);
  for (int i = 0; i < count; ++i) {
    auto key = "item-" + std::to_string(section) + "-" + std::to_string(i);
    auto it = _map.find(key);
    if (it != _map.end()) {
      heights[i] = it->second.frame.height;
    }
  }
  return heights;
}

std::vector<double> LayoutCache::getItemHeightsByKeys(const std::vector<std::string>& keys) const {
  std::lock_guard<std::mutex> lock(_mutex);
  const int count = static_cast<int>(keys.size());
  std::vector<double> heights(count, 0.0);
  for (int i = 0; i < count; ++i) {
    auto it = _map.find(keys[i]);
    if (it != _map.end()) {
      heights[i] = it->second.frame.height;
    }
  }
  return heights;
}

// ─── Aggregate queries ────────────────────────────────────────────────────────

Size LayoutCache::getTotalContentSize() const {
  std::lock_guard<std::mutex> lock(_mutex);
  double maxX = 0;
  double maxY = 0;
  for (const auto& [key, attrs] : _map) {
    maxX = std::max(maxX, attrs.frame.x + attrs.frame.width);
    maxY = std::max(maxY, attrs.frame.y + attrs.frame.height);
  }
  return { maxX, maxY };
}

std::optional<std::string> LayoutCache::getKeyForIndexPath(int section, int item) const {
  std::lock_guard<std::mutex> lock(_mutex);
  const uint64_t ip = (uint64_t(uint32_t(section)) << 32) | uint32_t(item);
  auto it = _indexPathToKey.find(ip);
  if (it == _indexPathToKey.end()) return std::nullopt;
  return it->second;
}

std::optional<std::string> LayoutCache::getHeaderKeyForSection(int section) const {
  std::lock_guard<std::mutex> lock(_mutex);
  auto it = _sectionHeaderKey.find(section);
  if (it == _sectionHeaderKey.end()) return std::nullopt;
  return it->second;
}

std::vector<double> LayoutCache::getSectionOffsets() const {
  std::lock_guard<std::mutex> lock(_mutex);
  std::vector<double> offsets;
  int currentSection = -1;
  // _insertionOrder is in layout order. Skip supplementary views (headers/
  // footers) so the offset reflects the first regular item's Y, not the
  // header's Y.
  for (const auto& key : _insertionOrder) {
    auto it = _map.find(key);
    if (it == _map.end()) continue;
    const auto& attrs = it->second;
    if (attrs.isSupplementary || attrs.isDecoration) continue;
    if (attrs.section != currentSection) {
      currentSection = attrs.section;
      // Fill any gaps (sparse sections)
      while (static_cast<int>(offsets.size()) <= currentSection) {
        offsets.push_back(attrs.frame.y);
      }
    }
  }
  return offsets;
}

uint64_t LayoutCache::version() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return _version;
}

void LayoutCache::setScrollOffset(double x, double y, double timestampMs) {
  std::lock_guard<std::mutex> lock(_mutex);
  // Derive velocity from consecutive offset/timestamp pairs.
  // timestampMs comes from CACurrentMediaTime() * 1000 on iOS (native scroll handler).
  if (timestampMs > 0) {
    const double primary = _horizontal ? x : y;
    const double dt = timestampMs - _prevScrollTimestamp;
    if (dt > 0 && dt <= 100.0) {
      // Within 100ms gap — reasonable consecutive scroll events.
      _currentVelocity = (primary - _prevScrollPrimary) / dt;
    } else if (dt > 100.0) {
      // Too long between events — user stopped scrolling or new gesture.
      _currentVelocity = 0.0;
    }
    _prevScrollPrimary = primary;
    _prevScrollTimestamp = timestampMs;
  }
  _scrollOffset = {x, y};
}

Point LayoutCache::getScrollOffset() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return _scrollOffset;
}

double LayoutCache::getVelocity() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return _currentVelocity;
}

LayoutCache::ScrollSnapshot LayoutCache::getScrollOffsetAndVelocity() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return {_scrollOffset, _currentVelocity};
}

// ─── Opt D: Combined queries (reduce mutex acquisitions in processScroll) ────

LayoutCache::ScrollSnapshotV LayoutCache::getScrollSnapshotWithVersion() const {
  std::lock_guard<std::mutex> lock(_mutex);
  return {_scrollOffset, _currentVelocity, _version};
}

LayoutCache::DualRange LayoutCache::findDualRangeByPrimary(
    double renderLo, double renderHi,
    double visibleLo, double visibleHi,
    bool horizontal) const {
  std::lock_guard<std::mutex> lock(_mutex);

  // Lazy-rebuild sorted index if dirty or axis changed (same as findRangeByPrimary).
  if (_sortedDirty || _sortedHorizontal != horizontal) {
    _sorted.clear();
    _sorted.reserve(_insertionOrder.size());
    for (const auto& key : _insertionOrder) {
      auto it = _map.find(key);
      if (it == _map.end()) continue;
      const auto& a = it->second;
      if (a.isDecoration) continue;
      double pos  = horizontal ? a.frame.x : a.frame.y;
      double size = horizontal ? a.frame.width : a.frame.height;
      SortedEntry entry;
      entry.pos = pos;
      entry.size = size;
      entry.key = key;
      _sorted.push_back(entry);
    }
    std::sort(_sorted.begin(), _sorted.end(),
              [](const SortedEntry& a, const SortedEntry& b) { return a.pos < b.pos; });
    _sortedDirty = false;
    _sortedHorizontal = horizontal;
  }

  DualRange result;
  if (_sorted.empty()) return result;

  // Helper lambda: binary-search for a PrimaryRange within [lo, hi].
  auto searchRange = [&](double lo, double hi) -> PrimaryRange {
    PrimaryRange pr;

    // First entry whose (pos + size) > lo
    int firstMatch = -1;
    {
      int left = 0, right = static_cast<int>(_sorted.size()) - 1;
      while (left <= right) {
        int mid = left + (right - left) / 2;
        if (_sorted[mid].pos + _sorted[mid].size > lo) {
          firstMatch = mid;
          right = mid - 1;
        } else {
          left = mid + 1;
        }
      }
    }
    if (firstMatch < 0) return pr;

    // Last entry whose pos < hi
    int lastMatch = -1;
    {
      int left = 0, right = static_cast<int>(_sorted.size()) - 1;
      while (left <= right) {
        int mid = left + (right - left) / 2;
        if (_sorted[mid].pos < hi) {
          lastMatch = mid;
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
    }
    if (lastMatch < 0 || lastMatch < firstMatch) return pr;

    // Scan for min/max flat indices in range.
    int minFI = std::numeric_limits<int>::max();
    int maxFI = std::numeric_limits<int>::min();
    for (int i = firstMatch; i <= lastMatch; ++i) {
      auto it = _map.find(_sorted[i].key);
      if (it == _map.end()) continue;
      int fi = it->second.flatIndex;
      if (fi < 0) continue;
      if (fi < minFI) minFI = fi;
      if (fi > maxFI) maxFI = fi;
    }
    if (minFI > maxFI) return pr;

    pr.firstIdx  = minFI;
    pr.lastIdx   = maxFI;
    pr.firstPos  = _sorted[firstMatch].pos;
    pr.firstSize = _sorted[firstMatch].size;
    pr.lastPos   = _sorted[lastMatch].pos;
    pr.lastSize  = _sorted[lastMatch].size;
    return pr;
  };

  result.render  = searchRange(renderLo, renderHi);
  result.visible = searchRange(visibleLo, visibleHi);
  return result;
}

LayoutCache::FramesWithVersion LayoutCache::getFramesForFlatRangeWithVersion(
    int firstFlat, int lastFlat) const {
  FramesWithVersion result;
  if (firstFlat > lastFlat) {
    result.version = 0;
    return result;
  }
  const int count = lastFlat - firstFlat + 1;
  result.frames.resize(static_cast<size_t>(count) * 4, 0.0);
  std::lock_guard<std::mutex> lock(_mutex);
  result.version = _version;

  if (!_flatIndexToKey.empty()) {
    for (int fi = firstFlat; fi <= lastFlat; ++fi) {
      if (fi < 0 || fi >= static_cast<int>(_flatIndexToKey.size())) continue;
      const auto& key = _flatIndexToKey[static_cast<size_t>(fi)];
      if (key.empty()) continue;
      auto it = _map.find(key);
      if (it == _map.end()) continue;
      size_t off = static_cast<size_t>(fi - firstFlat) * 4;
      result.frames[off + 0] = it->second.frame.x;
      result.frames[off + 1] = it->second.frame.y;
      result.frames[off + 2] = it->second.frame.width;
      result.frames[off + 3] = it->second.frame.height;
    }
  } else {
    for (const auto& [key, attrs] : _map) {
      int fi = attrs.flatIndex;
      if (fi < firstFlat || fi > lastFlat) continue;
      size_t off = static_cast<size_t>(fi - firstFlat) * 4;
      result.frames[off + 0] = attrs.frame.x;
      result.frames[off + 1] = attrs.frame.y;
      result.frames[off + 2] = attrs.frame.width;
      result.frames[off + 3] = attrs.frame.height;
    }
  }
  return result;
}

// ─── MVC correction ──────────────────────────────────────────────────────────

void LayoutCache::_snapshotAnchorLocked() {
  // Caller must already hold _mutex.
  // For vertical: anchor = smallest Y at-or-below scrollOffset.y.
  // For horizontal: anchor = smallest X at-or-below scrollOffset.x.
  const double scrollPrimary = _horizontal ? _scrollOffset.x : _scrollOffset.y;
  std::string bestKey;
  double bestPrimary = std::numeric_limits<double>::max();
  bool found = false;
  for (const auto& [key, attrs] : _map) {
    if (attrs.isDecoration) continue;
    const double pos = _horizontal ? attrs.frame.x : attrs.frame.y;
    if (pos >= scrollPrimary && pos < bestPrimary) {
      bestKey = key; bestPrimary = pos; found = true;
    }
  }
  if (!found) {
    // Fallback: first item partially visible (trailing edge > scroll position)
    for (const auto& [key, attrs] : _map) {
      if (attrs.isDecoration) continue;
      const double pos = _horizontal ? attrs.frame.x : attrs.frame.y;
      const double trailing = pos + (_horizontal ? attrs.frame.width : attrs.frame.height);
      if (trailing > scrollPrimary && pos < bestPrimary) {
        bestKey = key; bestPrimary = pos; found = true;
      }
    }
  }
  if (found) {
    _anchorKey             = std::move(bestKey);
    _anchorY               = bestPrimary;  // always stored in _anchorY for simplicity
    _anchorX               = bestPrimary;  // same value; caller uses _horizontal to pick
    _snapshotScrollPrimary = scrollPrimary; // saved so correction can compute absolute target
    _hasAnchor             = true;
    RNCV_MVC_LOG("snapshotAnchor: key=%s oldY=%.1f scrollOffset=%.1f",
                 _anchorKey.c_str(), bestPrimary, scrollPrimary);
    RNCV_MVC_TRACE("snapshotAnchor: FOUND key=%s pos=%.1f scrollOffset=%.1f",
                   _anchorKey.c_str(), bestPrimary, scrollPrimary);
  } else {
    _hasAnchor = false;
    RNCV_MVC_LOG("snapshotAnchor: no anchor found (scrollOffset=%.1f mapSize=%zu)",
                 scrollPrimary, _map.size());
    RNCV_MVC_TRACE("snapshotAnchor: NOT FOUND scrollOffset=%.1f mapSize=%zu",
                   scrollPrimary, _map.size());
  }
}

void LayoutCache::snapshotAnchor() {
  std::lock_guard<std::mutex> lock(_mutex);
  RNCV_MVC_TRACE("snapshotAnchor: hasAnchor was=%s mvcEnabled=%s",
                  _hasAnchor ? "YES" : "NO", _mvcEnabled ? "YES" : "NO");
  _snapshotAnchorLocked();
}

void LayoutCache::setMVCEnabled(bool enabled) {
  std::lock_guard<std::mutex> lock(_mutex);
  _mvcEnabled = enabled;
}

void LayoutCache::setHorizontal(bool horizontal) {
  std::lock_guard<std::mutex> lock(_mutex);
  _horizontal = horizontal;
}

void LayoutCache::snapshotAnchorIfNeeded() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (_hasAnchor) {
    RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SKIP hasAnchor=YES");
    return;   // JS already snapshotted before prepare()
  }
  if (!_mvcEnabled) {
    RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SKIP mvcEnabled=NO");
    return;   // MVC disabled — don't auto-snapshot
  }
  if (_programmaticScrollActive) {
    RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SKIP programmaticScrollActive=YES (prevents re-arm during animated scrollTo)");
    return;   // animated scrollTo in flight — re-arming would cancel the animation
  }
  RNCV_MVC_TRACE("snapshotAnchorIfNeeded: SNAPSHOTTING (size-change path)");
  _snapshotAnchorLocked();
}

double LayoutCache::computeCorrection() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_hasAnchor) return 0;
  _hasAnchor = false;          // one-shot
  auto it = _map.find(_anchorKey);
  if (it == _map.end()) {
    // Anchor was deleted — no correction
    return 0;
  }
  const double newPos     = _horizontal ? it->second.frame.x : it->second.frame.y;
  const double oldPos     = _horizontal ? _anchorX : _anchorY;
  const double correction = newPos - oldPos;
  // Absolute target: use the scroll at snapshot time, not the current scroll.
  // This prevents double-correction when UIKit auto-clamps contentOffset on
  // contentSize shrink (e.g. delete at bottom of list).
  const double scrollTarget = _snapshotScrollPrimary + correction;
  RNCV_MVC_LOG("computeCorrection: key=%s oldY=%.1f newY=%.1f correction=%.1f scrollTarget=%.1f",
               _anchorKey.c_str(), oldPos, newPos, correction, scrollTarget);
  RNCV_MVC_TRACE("computeCorrection: key=%s oldPos=%.1f newPos=%.1f correction=%.1f scrollTarget=%.1f",
                  _anchorKey.c_str(), oldPos, newPos, correction, scrollTarget);
  _pendingCorrectionY   = correction;
  _pendingScrollTarget  = scrollTarget;
  _hasPendingCorrection = true;
  return correction;
}

void LayoutCache::setProgrammaticScrollActive(bool active) {
  std::lock_guard<std::mutex> lock(_mutex);
  RNCV_MVC_TRACE("setProgrammaticScrollActive: %s", active ? "YES" : "NO");
  _programmaticScrollActive = active;
}

double LayoutCache::consumePendingCorrection() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_hasPendingCorrection) return 0;
  const double correction = _pendingCorrectionY;
  _pendingCorrectionY   = 0;
  _pendingScrollTarget  = 0;
  _hasPendingCorrection = false;
  return correction;
}

double LayoutCache::consumePendingScrollTarget() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_hasPendingCorrection) return 0;
  const double target   = _pendingScrollTarget;
  _pendingCorrectionY   = 0;
  _pendingScrollTarget  = 0;
  _hasPendingCorrection = false;
  return target;
}

// ─── H-section MVC ───────────────────────────────────────────────────────────

void LayoutCache::snapshotHAnchor(int sectionIndex, double scrollX) {
  std::lock_guard<std::mutex> lock(_mutex);
  std::string bestKey;
  double bestX = std::numeric_limits<double>::max();
  bool found = false;
  for (const auto& [key, attrs] : _map) {
    if (attrs.section != sectionIndex) continue;
    if (attrs.isSupplementary || attrs.isDecoration) continue;
    if (attrs.frame.x >= scrollX && attrs.frame.x < bestX) {
      bestKey = key; bestX = attrs.frame.x; found = true;
    }
  }
  if (found) {
    _hAnchorKeys[sectionIndex] = bestKey;
    _hAnchorXs[sectionIndex]   = bestX;
    RNCV_MVC_TRACE("snapshotHAnchor: s=%d key=%s x=%.1f scrollX=%.1f",
                   sectionIndex, bestKey.c_str(), bestX, scrollX);
  } else {
    _hAnchorKeys.erase(sectionIndex);
    _hAnchorXs.erase(sectionIndex);
    RNCV_MVC_TRACE("snapshotHAnchor: s=%d NOT FOUND scrollX=%.1f", sectionIndex, scrollX);
  }
}

double LayoutCache::computeHCorrection(int sectionIndex) {
  std::lock_guard<std::mutex> lock(_mutex);
  auto kit = _hAnchorKeys.find(sectionIndex);
  if (kit == _hAnchorKeys.end()) return 0.0;

  const std::string anchorKey = kit->second;
  double oldX = 0.0;
  auto xit = _hAnchorXs.find(sectionIndex);
  if (xit != _hAnchorXs.end()) oldX = xit->second;

  _hAnchorKeys.erase(sectionIndex);
  _hAnchorXs.erase(sectionIndex);

  auto it = _map.find(anchorKey);
  if (it == _map.end()) return 0.0;

  const double newX = it->second.frame.x;
  const double correction = newX - oldX;
  RNCV_MVC_TRACE("computeHCorrection: s=%d key=%s oldX=%.1f newX=%.1f correction=%.1f",
                  sectionIndex, anchorKey.c_str(), oldX, newX, correction);
  return correction;
}

// ─── JSI conversion helpers ───────────────────────────────────────────────────

static std::string stringFromJSI(Runtime& rt, const Value& val) {
  return val.getString(rt).utf8(rt);
}

static double doubleFromObj(Runtime& rt, const Object& obj, const char* key, double def = 0.0) {
  Value v = obj.getProperty(rt, key);
  if (v.isNumber()) return v.getNumber();
  return def;
}

static bool boolFromObj(Runtime& rt, const Object& obj, const char* key, bool def = false) {
  Value v = obj.getProperty(rt, key);
  if (v.isBool()) return v.getBool();
  return def;
}

static std::string stringFromObj(Runtime& rt, const Object& obj, const char* key, const std::string& def = "") {
  Value v = obj.getProperty(rt, key);
  if (v.isString()) return v.getString(rt).utf8(rt);
  return def;
}

Rect LayoutCache::rectFromJSI(Runtime& rt, const Object& obj) {
  return {
    doubleFromObj(rt, obj, "x"),
    doubleFromObj(rt, obj, "y"),
    doubleFromObj(rt, obj, "width"),
    doubleFromObj(rt, obj, "height")
  };
}

static SizingState sizingStateFromString(const std::string& s) {
  if (s == "measured") return SizingState::Measured;
  if (s == "dirty")    return SizingState::Dirty;
  return SizingState::Placeholder;
}

static WindowTier tierFromString(const std::string& s) {
  if (s == "visible")  return WindowTier::Visible;
  if (s == "render")   return WindowTier::Render;
  if (s == "layout")   return WindowTier::Layout;
  if (s == "data")     return WindowTier::Data;
  return WindowTier::Outside;
}

static const char* sizingStateToString(SizingState s) {
  switch (s) {
    case SizingState::Measured:    return "measured";
    case SizingState::Dirty:       return "dirty";
    default:                       return "placeholder";
  }
}

static const char* tierToString(WindowTier t) {
  switch (t) {
    case WindowTier::Visible:  return "visible";
    case WindowTier::Render:   return "render";
    case WindowTier::Layout:   return "layout";
    case WindowTier::Data:     return "data";
    default:                   return "outside";
  }
}

LayoutAttributes LayoutCache::attrsFromJSI(Runtime& rt, const Object& obj) {
  LayoutAttributes a;
  a.key    = stringFromObj(rt, obj, "key");
  a.section = static_cast<int>(doubleFromObj(rt, obj, "section"));
  a.index   = static_cast<int>(doubleFromObj(rt, obj, "index", -1));

  Value frameVal = obj.getProperty(rt, "frame");
  if (frameVal.isObject()) {
    a.frame = rectFromJSI(rt, frameVal.getObject(rt));
  }

  a.zIndex          = static_cast<int>(doubleFromObj(rt, obj, "zIndex"));
  a.alpha           = doubleFromObj(rt, obj, "alpha", 1.0);
  a.isHidden        = boolFromObj(rt, obj, "isHidden");

  // transform3D: 16-element array (column-major 4x4 matrix), optional
  Value t3dVal = obj.getProperty(rt, "transform3D");
  if (t3dVal.isObject()) {
    auto t3dArr = t3dVal.getObject(rt).getArray(rt);
    size_t len = std::min(static_cast<size_t>(t3dArr.size(rt)), size_t(16));
    for (size_t i = 0; i < len; ++i) {
      a.transform3D[i] = t3dArr.getValueAtIndex(rt, i).getNumber();
    }
  }

  a.isSupplementary = boolFromObj(rt, obj, "isSupplementary");
  a.supplementaryKind = stringFromObj(rt, obj, "supplementaryKind");
  a.sizingState     = sizingStateFromString(stringFromObj(rt, obj, "sizingState", "placeholder"));
  a.isDirty         = boolFromObj(rt, obj, "isDirty");
  a.tier            = tierFromString(stringFromObj(rt, obj, "tier", "outside"));
  a.isSticky        = boolFromObj(rt, obj, "isSticky");
  a.isAnimating     = boolFromObj(rt, obj, "isAnimating");
  a.isDecoration    = boolFromObj(rt, obj, "isDecoration");
  a.decorationKind  = stringFromObj(rt, obj, "decorationKind");

  // extras: arbitrary key-value pairs
  Value extrasVal = obj.getProperty(rt, "extras");
  if (extrasVal.isObject()) {
    auto extrasObj = extrasVal.getObject(rt);
    auto names = extrasObj.getPropertyNames(rt);
    size_t count = names.size(rt);
    for (size_t i = 0; i < count; ++i) {
      auto name = names.getValueAtIndex(rt, i).getString(rt).utf8(rt);
      Value v = extrasObj.getProperty(rt, name.c_str());
      if (v.isNumber()) {
        a.extras[name] = v.getNumber();
      }
    }
  }

  return a;
}

Object LayoutCache::attrsToJSI(Runtime& rt, const LayoutAttributes& a) {
  Object obj(rt);

  obj.setProperty(rt, "key", String::createFromUtf8(rt, a.key));
  obj.setProperty(rt, "section", Value(a.section));
  obj.setProperty(rt, "index", Value(a.index));

  Object frame(rt);
  frame.setProperty(rt, "x",      Value(a.frame.x));
  frame.setProperty(rt, "y",      Value(a.frame.y));
  frame.setProperty(rt, "width",  Value(a.frame.width));
  frame.setProperty(rt, "height", Value(a.frame.height));
  obj.setProperty(rt, "frame", std::move(frame));

  obj.setProperty(rt, "zIndex",           Value(a.zIndex));
  obj.setProperty(rt, "alpha",            Value(a.alpha));
  obj.setProperty(rt, "isHidden",         Value(a.isHidden));

  // Only serialize transform3D if non-identity (avoid overhead for common case).
  if (a.transform3D != kIdentityTransform3D) {
    auto t3dArr = Array(rt, 16);
    for (size_t i = 0; i < 16; ++i) {
      t3dArr.setValueAtIndex(rt, i, Value(a.transform3D[i]));
    }
    obj.setProperty(rt, "transform3D", std::move(t3dArr));
  }

  obj.setProperty(rt, "isSupplementary",  Value(a.isSupplementary));
  obj.setProperty(rt, "supplementaryKind",
      String::createFromUtf8(rt, a.supplementaryKind));
  obj.setProperty(rt, "sizingState",
      String::createFromAscii(rt, sizingStateToString(a.sizingState)));
  obj.setProperty(rt, "isDirty",      Value(a.isDirty));
  obj.setProperty(rt, "tier",
      String::createFromAscii(rt, tierToString(a.tier)));
  obj.setProperty(rt, "isSticky",     Value(a.isSticky));
  obj.setProperty(rt, "isAnimating",  Value(a.isAnimating));
  obj.setProperty(rt, "isDecoration",  Value(a.isDecoration));
  obj.setProperty(rt, "decorationKind",
      String::createFromUtf8(rt, a.decorationKind));

  // Only serialize extras if non-empty.
  if (!a.extras.empty()) {
    Object extrasObj(rt);
    for (const auto& [k, v] : a.extras) {
      extrasObj.setProperty(rt, k.c_str(), Value(v));
    }
    obj.setProperty(rt, "extras", std::move(extrasObj));
  }

  return obj;
}

// ─── JSI bindings ─────────────────────────────────────────────────────────────

void LayoutCache::installJSIBindings(Runtime& rt, Object& target) {
  // setAttributes(attrsObject) → undefined
  target.setProperty(rt, "setAttributes",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "setAttributes"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        setAttributes(attrsFromJSI(rt, args[0].getObject(rt)));
        return Value::undefined();
      }));

  // setAttributesBatch(attrsObject[]) → undefined
  // Applies all updates under a single mutex acquisition; saves N-1 JSI
  // round-trips for scroll-driven layouts that update many items per tick.
  target.setProperty(rt, "setAttributesBatch",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "setAttributesBatch"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        auto arr = args[0].getObject(rt).asArray(rt);
        const size_t n = arr.size(rt);
        std::vector<LayoutAttributes> batch;
        batch.reserve(n);
        for (size_t i = 0; i < n; ++i) {
          auto v = arr.getValueAtIndex(rt, i);
          if (v.isObject()) {
            batch.push_back(attrsFromJSI(rt, v.getObject(rt)));
          }
        }
        setAttributesBatch(batch);
        return Value::undefined();
      }));

  // getAttributes(key) → attrsObject | null
  target.setProperty(rt, "getAttributes",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getAttributes"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isString()) return Value::null();
        auto result = getAttributes(args[0].getString(rt).utf8(rt));
        if (!result) return Value::null();
        return Value(rt, attrsToJSI(rt, *result));
      }));

  // removeAttributes(key) → undefined
  target.setProperty(rt, "removeAttributes",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "removeAttributes"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count >= 1 && args[0].isString()) {
          removeAttributes(args[0].getString(rt).utf8(rt));
        }
        return Value::undefined();
      }));

  // getAll() → attrsObject[]
  target.setProperty(rt, "getAll",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getAll"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        auto all = getAll();
        auto arr = Array(rt, all.size());
        for (size_t i = 0; i < all.size(); ++i) {
          arr.setValueAtIndex(rt, i, attrsToJSI(rt, all[i]));
        }
        return Value(rt, arr);
      }));

  // getAttributesInRect(rect) → attrsObject[]
  target.setProperty(rt, "getAttributesInRect",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getAttributesInRect"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value(rt, Array(rt, 0));
        Rect rect = rectFromJSI(rt, args[0].getObject(rt));
        auto items = getAttributesInRect(rect);
        auto arr = Array(rt, items.size());
        for (size_t i = 0; i < items.size(); ++i) {
          arr.setValueAtIndex(rt, i, attrsToJSI(rt, items[i]));
        }
        return Value(rt, arr);
      }));

  // getTotalContentSize() → { width, height }
  target.setProperty(rt, "getTotalContentSize",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getTotalContentSize"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        auto s = getTotalContentSize();
        Object obj(rt);
        obj.setProperty(rt, "width",  Value(s.width));
        obj.setProperty(rt, "height", Value(s.height));
        return Value(rt, obj);
      }));

  // getSectionOffsets() → number[]
  target.setProperty(rt, "getSectionOffsets",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getSectionOffsets"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        auto offsets = getSectionOffsets();
        auto arr = Array(rt, offsets.size());
        for (size_t i = 0; i < offsets.size(); ++i) {
          arr.setValueAtIndex(rt, i, Value(offsets[i]));
        }
        return Value(rt, arr);
      }));

  // getItemHeights(section, count) → number[]
  target.setProperty(rt, "getItemHeights",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getItemHeights"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        int section = count >= 1 ? static_cast<int>(args[0].getNumber()) : 0;
        int itemCount = count >= 2 ? static_cast<int>(args[1].getNumber()) : 0;
        auto heights = getItemHeights(section, itemCount);
        auto arr = Array(rt, heights.size());
        for (size_t i = 0; i < heights.size(); ++i) {
          arr.setValueAtIndex(rt, i, Value(heights[i]));
        }
        return Value(rt, arr);
      }));

  // getItemHeightsByKeys(keys: string[]) → number[]
  target.setProperty(rt, "getItemHeightsByKeys",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "getItemHeightsByKeys"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value(rt, Array(rt, 0));
        auto keysArr = args[0].getObject(rt).asArray(rt);
        size_t len = keysArr.size(rt);
        std::vector<std::string> keys;
        keys.reserve(len);
        for (size_t i = 0; i < len; ++i) {
          keys.push_back(keysArr.getValueAtIndex(rt, i).getString(rt).utf8(rt));
        }
        auto heights = getItemHeightsByKeys(keys);
        auto arr = Array(rt, heights.size());
        for (size_t i = 0; i < heights.size(); ++i) {
          arr.setValueAtIndex(rt, i, Value(heights[i]));
        }
        return Value(rt, arr);
      }));

  // clear() → undefined
  target.setProperty(rt, "clear",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "clear"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        clear();
        return Value::undefined();
      }));

  // stashHeights() → undefined
  // Call BEFORE clear() to preserve Yoga-measured heights across fingerprint clears.
  target.setProperty(rt, "stashHeights",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "stashHeights"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        stashHeights();
        return Value::undefined();
      }));

  // stashMeasuredSizes() → undefined
  // Call BEFORE clear() to preserve Yoga-measured width+height across cache clears.
  target.setProperty(rt, "stashMeasuredSizes",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "stashMeasuredSizes"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        stashMeasuredSizes();
        return Value::undefined();
      }));

  // clearStash() → undefined
  // Call AFTER computeSections() to release stash memory.
  target.setProperty(rt, "clearStash",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "clearStash"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        clearStash();
        return Value::undefined();
      }));

  // version() → number
  target.setProperty(rt, "version",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "version"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return Value(static_cast<double>(version()));
      }));

  // setMVCEnabled(bool) → undefined
  target.setProperty(rt, "setMVCEnabled",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "setMVCEnabled"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count > 0) {
          setMVCEnabled(args[0].getBool());
        }
        return Value::undefined();
      }));

  // setHorizontal(bool) → undefined
  target.setProperty(rt, "setHorizontal",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "setHorizontal"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count > 0) {
          setHorizontal(args[0].isBool() ? args[0].getBool() : false);
        }
        return Value::undefined();
      }));

  // snapshotAnchor() → undefined
  target.setProperty(rt, "snapshotAnchor",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "snapshotAnchor"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        snapshotAnchor();
        return Value::undefined();
      }));

  // computeCorrection() → number
  target.setProperty(rt, "computeCorrection",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeCorrection"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return Value(computeCorrection());
      }));

  // consumePendingCorrection() → number
  target.setProperty(rt, "consumePendingCorrection",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "consumePendingCorrection"), 0,
      [this](Runtime& rt, const Value&, const Value*, size_t) -> Value {
        return Value(consumePendingCorrection());
      }));

  // snapshotHAnchor(sectionIndex, scrollX) → undefined
  target.setProperty(rt, "snapshotHAnchor",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "snapshotHAnchor"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count >= 2) {
          snapshotHAnchor(static_cast<int>(args[0].getNumber()),
                          args[1].getNumber());
        }
        return Value::undefined();
      }));
}

} // namespace rncv
