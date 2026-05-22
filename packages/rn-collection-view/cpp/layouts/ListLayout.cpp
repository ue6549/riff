#include "ListLayout.h"

#include <sstream>
#include <stdexcept>

#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

// Set RNCV_ENABLE_MVC_TRACE=1 to log height lookup source in computeSectionFromCache.
// First 5 items per section + any item whose key matches the MVC anchor key.
// Keep 0 in normal development.
#ifndef RNCV_ENABLE_MVC_TRACE
#define RNCV_ENABLE_MVC_TRACE 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
  #ifdef __APPLE__
    #include <os/log.h>
    #define RNCV_LIST_LOG(fmt, ...) os_log_info(os_log_create("com.rncv", "listlayout"), "[RNCV-LIST] " fmt, ##__VA_ARGS__)
  #else
    #include <android/log.h>
    #define RNCV_LIST_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-LIST", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_LIST_LOG(fmt, ...) ((void)0)
#endif

#if DEBUG && RNCV_ENABLE_MVC_TRACE
  #ifdef __APPLE__
    #ifndef RNCV_MVC_TRACE_LIST_OS_INCLUDED
    #define RNCV_MVC_TRACE_LIST_OS_INCLUDED
    #include <os/log.h>
    #endif
    #define RNCV_LIST_TRACE(fmt, ...) os_log_info(os_log_create("com.rncv", "mvc-trace"), "[MVC-TRACE] " fmt, ##__VA_ARGS__)
  #else
    #include <android/log.h>
    #define RNCV_LIST_TRACE(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "MVC-TRACE", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_LIST_TRACE(fmt, ...) ((void)0)
#endif

namespace rncv {

using namespace facebook;
using namespace facebook::jsi;

// ─── Construction ─────────────────────────────────────────────────────────────

ListLayout::ListLayout(std::shared_ptr<LayoutCache> cache)
    : _cache(std::move(cache)) {
  // Pre-fill scratch with non-varying defaults so the hot loop
  // only touches fields that actually change per item.
  _scratch.zIndex          = 0;
  _scratch.isSupplementary = false;
  _scratch.supplementaryKind.clear();
  _scratch.sizingState     = SizingState::Measured; // fixed height = known size
  _scratch.isDirty         = false;
  _scratch.tier            = WindowTier::Outside;   // window controller sets this
  _scratch.isSticky        = false;
  _scratch.alpha           = 1.0;
  _scratch.isAnimating     = false;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

// Returns the cache key for item i in params p.
// Uses p.keys[i] when available (identity-keyed mode), otherwise falls back
// to the positional prefix+index form.
static std::string itemKey(const ListLayoutParams& p,
                            int i,
                            const std::string& prefix) {
  if (!p.keys.empty() && i < static_cast<int>(p.keys.size())) {
    return p.keys[i];
  }
  return prefix + std::to_string(i);
}

// ─── compute ─────────────────────────────────────────────────────────────────

void ListLayout::compute(const ListLayoutParams& p) {
  if (p.itemHeights.empty()) {
    computeFixed(p);
  } else {
    computeEstimated(p);
  }
}

void ListLayout::computeFixed(const ListLayoutParams& p) {
  const double contentWidth = p.viewportWidth
                              - p.sectionInsetLeft
                              - p.sectionInsetRight;
  const double stride       = p.itemHeight + p.itemSpacing;
  const std::string prefix  = p.keyPrefix.empty()
                              ? "item-" + std::to_string(p.section) + "-"
                              : p.keyPrefix;

  _scratch.section          = p.section;
  _scratch.frame.x          = p.sectionInsetLeft;
  _scratch.frame.width      = contentWidth;
  _scratch.frame.height     = p.itemHeight;
  _scratch.sizingState      = SizingState::Measured;

  for (int i = 0; i < p.itemCount; ++i) {
    _scratch.key            = itemKey(p, i, prefix);
    _scratch.index          = i;
    _scratch.flatIndex      = p.flatIndexBase + i;
    _scratch.frame.y        = p.sectionInsetTop + i * stride;
    _cache->setAttributes(_scratch);
  }
}

void ListLayout::computeEstimated(const ListLayoutParams& p) {
  const int count           = static_cast<int>(p.itemHeights.size());
  const double contentWidth = p.viewportWidth
                              - p.sectionInsetLeft
                              - p.sectionInsetRight;
  const std::string prefix  = p.keyPrefix.empty()
                              ? "item-" + std::to_string(p.section) + "-"
                              : p.keyPrefix;

  _scratch.section          = p.section;
  _scratch.frame.x          = p.sectionInsetLeft;
  _scratch.frame.width      = contentWidth;
  _scratch.sizingState      = SizingState::Placeholder; // estimated = not finalised

  double y = p.sectionInsetTop;
  for (int i = 0; i < count; ++i) {
    const double h          = p.itemHeights[i];
    _scratch.key            = itemKey(p, i, prefix);
    _scratch.index          = i;
    _scratch.flatIndex      = p.flatIndexBase + i;
    _scratch.frame.y        = y;
    _scratch.frame.height   = h;
    _cache->setAttributes(_scratch);
    y += h + p.itemSpacing;
  }
}

// ─── applyMeasurements (LayoutEngine protocol) ──────────────────────────────

bool ListLayout::applyMeasurements(
    const std::vector<MeasurementDelta>& deltas,
    LayoutCache& cache) {
  if (deltas.empty()) return true;

  if (_horizontal) {
    // ── Horizontal path ──────────────────────────────────────────────────────
    //
    // ShadowNode sends ContentDimension::Both deltas:
    //   Width deltas  → primary axis → cascade X positions (aggregateShift)
    //   Height deltas → cross axis   → update frame.height per item; NO X cascade
    //
    // After processing, recompute per-section max cross height and update
    // supplementary views (headers, footers) and decorations (backgrounds,
    // separators) to match.

    // Build lookup maps for both delta types.
    // Prefer explicit axis emitted by ShadowNode. Keep oldValue matching only as
    // a defensive fallback for unknown-axis callers.
    std::unordered_map<std::string, double> newWidths;   // primary axis deltas
    std::unordered_map<std::string, double> newCrossH;   // cross axis deltas
    for (const auto& d : deltas) {
      auto existing = cache.getAttributes(d.key);
      if (!existing) continue;
      const bool matchesHeight = std::abs(existing->frame.height - d.oldValue) < 1.0;
      const bool matchesWidth  = std::abs(existing->frame.width  - d.oldValue) < 1.0;
      if (d.axis == MeasurementAxis::Height) {
        newCrossH[d.key] = d.newValue;
      } else if (d.axis == MeasurementAxis::Width) {
        newWidths[d.key] = d.newValue;
      } else if (matchesHeight && !matchesWidth) {
        newCrossH[d.key] = d.newValue;
      } else if (matchesWidth && !matchesHeight) {
        newWidths[d.key] = d.newValue;
      }
      // If neither matches, delta may be stale — skip.
    }

    auto all = cache.getAll();
    if (all.empty()) return true;

    // Sort by X for primary-axis cascade.
    std::sort(all.begin(), all.end(), [](const LayoutAttributes& a, const LayoutAttributes& b) {
      return a.frame.x < b.frame.x;
    });

    double aggregateShift = 0.0;
    struct SectionShifts { double entryShift = 0; double exitShift = 0; bool entered = false; };
    std::unordered_map<int, SectionShifts> sectionShifts;

    // Pass 1: Primary-axis cascade (width deltas → X shifts) + height updates.
    for (auto& attr : all) {
      if (attr.isDecoration && attr.decorationKind == "sectionBackground") continue;
      bool changed = false;

      // Apply accumulated primary-axis shift.
      if (aggregateShift != 0.0) {
        attr.frame.x += aggregateShift;
        changed = true;
      }

      if (attr.isDecoration) {
        // Separators: shift X only.
        if (changed) cache.setAttributes(attr);
        continue;
      }

      if (!attr.isSupplementary) {
        auto& ss = sectionShifts[attr.section];
        if (!ss.entered) { ss.entryShift = aggregateShift; ss.entered = true; }
      }

      // Width delta → primary axis cascade.
      auto wit = newWidths.find(attr.key);
      if (wit != newWidths.end()) {
        const double sizeDiff = wit->second - attr.frame.width;
        if (std::abs(sizeDiff) > 0.01) {
          attr.frame.width = wit->second;
          aggregateShift += sizeDiff;
          changed = true;
        }
      }

      // Height delta → update cross-axis size (no cascade).
      auto hit = newCrossH.find(attr.key);
      if (hit != newCrossH.end()) {
        if (std::abs(hit->second - attr.frame.height) > 0.01) {
          attr.frame.height = hit->second;
          changed = true;
        }
      }

      if ((newWidths.count(attr.key) || newCrossH.count(attr.key)) &&
          attr.sizingState != SizingState::Measured) {
        attr.sizingState = SizingState::Measured;
        changed = true;
      }

      if (!attr.isSupplementary) {
        sectionShifts[attr.section].exitShift = aggregateShift;
      }

      if (changed) cache.setAttributes(attr);
    }

    // Pass 2: Update section bg X positions from primary-axis shifts.
    for (auto& attr : all) {
      if (!attr.isDecoration || attr.decorationKind != "sectionBackground") continue;
      auto sit = sectionShifts.find(attr.section);
      if (sit == sectionShifts.end() || !sit->second.entered) continue;
      const double shiftX   = sit->second.entryShift;
      const double widthDlt = sit->second.exitShift - sit->second.entryShift;
      if (std::abs(shiftX) > 0.01 || std::abs(widthDlt) > 0.01) {
        attr.frame.x     += shiftX;
        attr.frame.width += widthDlt;
        cache.setAttributes(attr);
      }
    }

    // Pass 3: Recompute per-section max cross height from all items (including
    // items that were just updated AND items measured in prior render passes).
    // Then update headers, footers, section backgrounds, and separators.
    if (!newCrossH.empty()) {
      std::unordered_map<int, double> sectionMaxH;  // section → max item height
      auto allNow = cache.getAll();
      for (const auto& attr : allNow) {
        if (attr.isDecoration || attr.isSupplementary) continue;
        auto& mx = sectionMaxH[attr.section];
        mx = std::max(mx, attr.frame.height);
      }
      // Recompute from current measured items. This allows cross-axis shrink when
      // large cells are resized down or deleted.
      _maxSectionCrossHeight.clear();
      for (auto& pair : sectionMaxH) {
        _maxSectionCrossHeight[pair.first] = pair.second;
      }

      // Update supplementaries and decorations.
      // We need section insets to compute header/footer height spans.
      // Read crossStart (sectionInsetTop) from any item in the section.
      std::unordered_map<int, double> sectionCrossStart;
      for (const auto& attr : allNow) {
        if (attr.isDecoration || attr.isSupplementary) continue;
        if (!sectionCrossStart.count(attr.section)) {
          sectionCrossStart[attr.section] = attr.frame.y;  // crossStart = y position of items
        }
      }

      for (auto& attr : allNow) {
        if (!attr.isDecoration && !attr.isSupplementary) continue;
        auto maxIt = sectionMaxH.find(attr.section);
        if (maxIt == sectionMaxH.end()) continue;
        const double maxH      = maxIt->second;
        const double crossStart = sectionCrossStart.count(attr.section) ? sectionCrossStart[attr.section] : 0;

        bool changed = false;
        if (attr.isSupplementary) {
          // Horizontal: supplementary views span the full viewport height.
          // Vertical: supplementary views span crossStart + maxH + crossStart (symmetric insets).
          const double hdrH = (_horizontal && _viewportHeight > 0)
              ? _viewportHeight
              : crossStart + maxH + crossStart;
          if (std::abs(attr.frame.height - hdrH) > 0.01) {
            attr.frame.height = hdrH;
            changed = true;
          }
        } else if (attr.isDecoration && attr.decorationKind == "sectionBackground") {
          if (std::abs(attr.frame.height - maxH) > 0.01) {
            attr.frame.height = maxH;
            changed = true;
          }
        } else if (attr.isDecoration && attr.decorationKind == "separator") {
          if (std::abs(attr.frame.height - maxH) > 0.01) {
            attr.frame.height = maxH;
            changed = true;
          }
        }
        if (changed) cache.setAttributes(attr);
      }
    }

    return true;
  }

  // ── Vertical path (unchanged) ────────────────────────────────────────────────
  //
  // For a 1D list layout, changing item heights simply shifts everything below them.
  // Instead of recalculating Y from scratch (which loses section insets and headers),
  // we accumulate a rolling `aggregateShift` and apply it sequentially.

  std::unordered_map<std::string, double> newHeights;
  for (const auto& d : deltas) {
    newHeights[d.key] = d.newValue;
  }

  auto all = cache.getAll();
  if (all.empty()) return true;

  std::sort(all.begin(), all.end(), [](const LayoutAttributes& a, const LayoutAttributes& b) {
    return a.frame.y < b.frame.y;
  });

  double aggregateShift = 0.0;

  struct SectionShifts { double entryShift = 0; double exitShift = 0; bool entered = false; };
  std::unordered_map<int, SectionShifts> sectionShifts;

  for (auto& attr : all) {
    if (attr.isDecoration && attr.decorationKind == "sectionBackground") continue;

    bool changed = false;

    if (aggregateShift != 0.0) {
      attr.frame.y += aggregateShift;
      changed = true;
    }

    if (attr.isDecoration) {
      if (changed) cache.setAttributes(attr);
      continue;
    }

    if (!attr.isSupplementary) {
      auto& ss = sectionShifts[attr.section];
      if (!ss.entered) {
        ss.entryShift = aggregateShift;
        ss.entered = true;
      }
    }

    auto it = newHeights.find(attr.key);
    if (it != newHeights.end()) {
      double newSz    = it->second;
      double sizeDiff = newSz - attr.frame.height;
      if (sizeDiff != 0.0) {
        attr.frame.height = newSz;
        aggregateShift += sizeDiff;
        changed = true;
      }
      if (attr.sizingState != SizingState::Measured) {
        attr.sizingState = SizingState::Measured;
        changed = true;
      }
    }

    if (!attr.isSupplementary) {
      sectionShifts[attr.section].exitShift = aggregateShift;
    }

    if (changed) cache.setAttributes(attr);
  }

  // Second pass: adjust section background frames.
  for (auto& attr : all) {
    if (!attr.isDecoration || attr.decorationKind != "sectionBackground") continue;
    auto sit = sectionShifts.find(attr.section);
    if (sit == sectionShifts.end() || !sit->second.entered) continue;
    const double shiftPrimary = sit->second.entryShift;
    const double sizeDelta    = sit->second.exitShift - sit->second.entryShift;
    if (std::abs(shiftPrimary) > 0.01 || std::abs(sizeDelta) > 0.01) {
      attr.frame.y      += shiftPrimary;
      attr.frame.height += sizeDelta;
      cache.setAttributes(attr);
    }
  }

  return true;
}

// ─── invalidateFrom ───────────────────────────────────────────────────────────

void ListLayout::invalidateFrom(
    const std::string& startKey,
    const ListLayoutParams& p) {
  // Find the starting item's current position so we can reflow from there.
  auto startAttrs = _cache->getAttributes(startKey);
  if (!startAttrs) return;

  const bool H = _horizontal;
  const std::string prefix = p.keyPrefix.empty()
                             ? "item-" + std::to_string(p.section) + "-"
                             : p.keyPrefix;

  const int startIndex = startAttrs->index;

  _scratch.section = p.section;

  if (H) {
    // Horizontal: primary axis = X. Reflow X positions from startKey onward.
    // Cross axis (height) for each item is read from cache (preserved from Yoga measurement).
    const double crossStart = p.sectionInsetTop;
    _scratch.frame.y = crossStart;

    double x = startAttrs->frame.x;

    for (int i = startIndex; i < p.itemCount; ++i) {
      const std::string key = itemKey(p, i, prefix);
      auto existing = _cache->getAttributes(key);
      const double w    = existing ? existing->frame.width  : p.itemHeight;  // itemHeight = primary estimate
      const double h    = existing ? existing->frame.height : p.estimatedCrossAxisHeight;
      _scratch.sizingState  = existing ? existing->sizingState : SizingState::Placeholder;
      _scratch.key          = key;
      _scratch.index        = i;
      _scratch.frame.x      = x;
      _scratch.frame.width  = w;
      _scratch.frame.height = h;
      _cache->setAttributes(_scratch);
      x += w + p.itemSpacing;
    }
  } else {
    // Vertical: primary axis = Y. Reflow Y positions from startKey onward.
    // invalidateFrom always reads heights from the cache — the cache is the
    // single source of truth. The caller updates the corrected item's attrs
    // (via layoutCache.setAttributes) BEFORE calling invalidateFrom, so the
    // new height is already present in the cache at startKey.
    const double contentWidth = p.viewportWidth - p.sectionInsetLeft - p.sectionInsetRight;
    _scratch.frame.x     = p.sectionInsetLeft;
    _scratch.frame.width = contentWidth;

    double y = startAttrs->frame.y;

    for (int i = startIndex; i < p.itemCount; ++i) {
      const std::string key = itemKey(p, i, prefix);
      auto existing = _cache->getAttributes(key);
      const double h = existing ? existing->frame.height : p.itemHeight;
      _scratch.sizingState  = existing ? existing->sizingState : SizingState::Placeholder;
      _scratch.key          = key;
      _scratch.index        = i;
      _scratch.frame.y      = y;
      _scratch.frame.height = h;
      _cache->setAttributes(_scratch);
      y += h + p.itemSpacing;
    }
  }
}

// ─── JSI helpers ──────────────────────────────────────────────────────────────

static double dbl(Runtime& rt, const Object& o, const char* k, double def = 0.0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? v.getNumber() : def;
}
static int i32(Runtime& rt, const Object& o, const char* k, int def = 0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? static_cast<int>(v.getNumber()) : def;
}
static std::string str(Runtime& rt, const Object& o, const char* k, std::string def = "") {
  Value v = o.getProperty(rt, k);
  return v.isString() ? v.getString(rt).utf8(rt) : def;
}
static bool bln(Runtime& rt, const Object& o, const char* k, bool def = false) {
  Value v = o.getProperty(rt, k);
  return v.isBool() ? v.getBool() : def;
}

ListLayoutParams ListLayout::paramsFromJSI(Runtime& rt, const Object& obj) {
  ListLayoutParams p;
  p.itemCount           = i32(rt, obj, "itemCount");
  p.itemHeight          = dbl(rt, obj, "itemHeight", 44.0);
  p.viewportWidth       = dbl(rt, obj, "viewportWidth", 390.0);
  p.sectionInsetTop     = dbl(rt, obj, "sectionInsetTop");
  p.sectionInsetBottom  = dbl(rt, obj, "sectionInsetBottom");
  p.sectionInsetLeft    = dbl(rt, obj, "sectionInsetLeft");
  p.sectionInsetRight   = dbl(rt, obj, "sectionInsetRight");
  p.itemSpacing         = dbl(rt, obj, "itemSpacing");
  p.section             = i32(rt, obj, "section");
  p.keyPrefix               = str(rt, obj, "keyPrefix");
  p.headerHeight            = dbl(rt, obj, "headerHeight");
  p.footerHeight            = dbl(rt, obj, "footerHeight");
  p.emitSectionBackground   = bln(rt, obj, "emitSectionBackground");
  p.emitSeparators          = bln(rt, obj, "emitSeparators");
  p.separatorHeight         = dbl(rt, obj, "separatorHeight", 0.5);
  p.separatorInsetLeading   = dbl(rt, obj, "separatorInsetLeading");
  p.separatorInsetTrailing  = dbl(rt, obj, "separatorInsetTrailing");
  p.sectionSpacing          = dbl(rt, obj, "sectionSpacing");
  p.horizontal               = bln(rt, obj, "horizontal");
  p.viewportHeight           = dbl(rt, obj, "viewportHeight");
  p.estimatedCrossAxisHeight = dbl(rt, obj, "estimatedCrossAxisHeight", 200.0);

  p.sectionBackgroundInsetTop    = dbl(rt, obj, "sectionBackgroundInsetTop");
  p.sectionBackgroundInsetBottom = dbl(rt, obj, "sectionBackgroundInsetBottom");
  p.sectionBackgroundInsetLeft   = dbl(rt, obj, "sectionBackgroundInsetLeft");
  p.sectionBackgroundInsetRight  = dbl(rt, obj, "sectionBackgroundInsetRight");

  // Flat index mapping for processScroll binary search
  p.flatIndexBase   = i32(rt, obj, "flatIndexBase");
  p.headerFlatIndex = i32(rt, obj, "headerFlatIndex");
  p.footerFlatIndex = i32(rt, obj, "footerFlatIndex");

  // Optional per-item heights array (estimated mode)
  Value heights = obj.getProperty(rt, "itemHeights");
  if (heights.isObject()) {
    auto arr = heights.getObject(rt).asArray(rt);
    size_t len = arr.size(rt);
    p.itemHeights.reserve(len);
    for (size_t i = 0; i < len; ++i) {
      Value h = arr.getValueAtIndex(rt, i);
      p.itemHeights.push_back(h.isNumber() ? h.getNumber() : 44.0);
    }
  }

  // Optional per-item identity keys (cache key = React key alignment)
  Value keysVal = obj.getProperty(rt, "keys");
  if (keysVal.isObject()) {
    auto arr = keysVal.getObject(rt).asArray(rt);
    size_t len = arr.size(rt);
    p.keys.reserve(len);
    for (size_t i = 0; i < len; ++i) {
      Value k = arr.getValueAtIndex(rt, i);
      p.keys.push_back(k.isString() ? k.getString(rt).utf8(rt) : std::to_string(i));
    }
  }

  return p;
}

std::vector<ListLayoutParams> ListLayout::sectionsFromJSI(Runtime& rt, const Array& arr) {
  size_t len = arr.size(rt);
  std::vector<ListLayoutParams> sections;
  sections.reserve(len);
  for (size_t i = 0; i < len; ++i) {
    Value v = arr.getValueAtIndex(rt, i);
    if (!v.isObject()) continue;
    ListLayoutParams p = paramsFromJSI(rt, v.getObject(rt));
    p.section = static_cast<int>(i);  // section index = position in array
    sections.push_back(std::move(p));
  }
  return sections;
}

// ─── computeSection (private) ─────────────────────────────────────────────────

double ListLayout::computeSection(const ListLayoutParams& p,
                                   int sectionIndex,
                                   double startPrimary) {
  const bool H = p.horizontal;
  const std::string prefix = p.keyPrefix.empty()
      ? "item-" + std::to_string(sectionIndex) + "-"
      : p.keyPrefix;

  // ── Axis setup ────────────────────────────────────────────────────────────
  // For vertical (H=false): primary axis = Y, cross axis = X.
  //   crossContent = viewport width minus left/right insets (item fill width)
  //   crossStart   = sectionInsetLeft (item x position)
  //   primaryInsetStart = sectionInsetTop
  //   primaryInsetEnd   = sectionInsetBottom
  //
  // For horizontal (H=true): primary axis = X, cross axis = Y.
  //   crossStart   = sectionInsetTop (item y position)
  //   primaryInsetStart = sectionInsetLeft
  //   primaryInsetEnd   = sectionInsetRight
  //   Item heights = estimatedCrossAxisHeight (Yoga measures final height; applyMeasurements corrects).
  //   Headers/footers height = estimatedCrossAxisHeight + insets (applyMeasurements corrects to max).
  //
  // IMPORTANT: For horizontal, we do NOT use viewportHeight to size items.
  // Items are content-sized (Yoga determines final height). estimatedCrossAxisHeight
  // is only an initial estimate so the cache has a plausible frame before measurement.

  const double crossContent = H
      ? 0  // unused for horizontal item sizing
      : (p.viewportWidth  - p.sectionInsetLeft - p.sectionInsetRight);
  const double crossStart = H ? p.sectionInsetTop : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;

  // For horizontal: estimated cross-axis height for items; headers/footers span full cross extent.
  const double hEstH  = p.estimatedCrossAxisHeight;               // item cross estimate
  const double hHdrH  = hEstH + p.sectionInsetTop + p.sectionInsetBottom; // header/footer cross span

  double primary = startPrimary;
  double bgStartPrimary = startPrimary; // updated to after-header once header is emitted

  // ── Separator prototype ───────────────────────────────────────────────────
  LayoutAttributes sep;
  if (p.emitSeparators) {
    sep.section        = sectionIndex;
    sep.index          = -1;
    sep.isDecoration   = true;
    sep.decorationKind = "separator";
    sep.zIndex         = 0;
    sep.sizingState    = SizingState::Measured;
    sep.isDirty        = false;
    sep.alpha          = 1.0;
    if (H) {
      // Vertical separator line between items in a horizontal list.
      // Height is estimated; applyMeasurements will update to section max height.
      sep.frame.x      = 0;  // updated per-separator
      sep.frame.y      = crossStart;
      sep.frame.width  = p.separatorHeight;  // separator thickness along scroll axis
      sep.frame.height = hEstH;
    } else {
      // Horizontal separator line between items in a vertical list
      sep.frame.x      = crossStart + p.separatorInsetLeading;
      sep.frame.y      = 0;  // updated per-separator
      sep.frame.width  = crossContent - p.separatorInsetLeading - p.separatorInsetTrailing;
      sep.frame.height = p.separatorHeight;
    }
  }

  RNCV_LIST_LOG("computeSection start section=%d prefix=%s itemCount=%d headerH=%.1f footerH=%.1f startPrimary=%.1f H=%d",
                sectionIndex, prefix.c_str(), p.itemCount, p.headerHeight, p.footerHeight, startPrimary, (int)H);

  // ── Header ────────────────────────────────────────────────────────────────
  if (p.headerHeight > 0) {
    _scratch.key               = prefix + "header";
    _scratch.section           = sectionIndex;
    _scratch.index             = -1;
    _scratch.flatIndex         = p.headerFlatIndex;
    _scratch.isSupplementary   = true;
    _scratch.supplementaryKind = "header";
    _scratch.sizingState       = SizingState::Measured;
    _scratch.isDirty           = false;
    if (H) {
      _scratch.frame = { primary, 0, p.headerHeight, p.viewportHeight };
    } else {
      _scratch.frame = { crossStart, primary, crossContent, p.headerHeight };
    }
    _cache->setAttributes(_scratch);
    RNCV_LIST_LOG("write key=%s kind=%s section=%d frame=(%.1f,%.1f,%.1f,%.1f)",
                  _scratch.key.c_str(), _scratch.supplementaryKind.c_str(), _scratch.section,
                  _scratch.frame.x, _scratch.frame.y, _scratch.frame.width, _scratch.frame.height);
    primary += p.headerHeight;
    bgStartPrimary = primary;
  }

  // Gap: primary inset start (between header edge and first item edge)
  primary += primaryInsetStart;

  // ── Items ─────────────────────────────────────────────────────────────────
  _scratch.isSupplementary   = false;
  _scratch.supplementaryKind.clear();
  _scratch.section           = sectionIndex;

  if (p.itemHeights.empty()) {
    // Uniform item size along primary axis (itemHeight param).
    // For horizontal: height is an estimate; Yoga measures final height.
    // For vertical: width = crossContent (full container minus insets); height = itemHeight estimate.
    for (int i = 0; i < p.itemCount; ++i) {
      const std::string key = itemKey(p, i, prefix);
      _scratch.key       = key;
      _scratch.index     = i;
      _scratch.flatIndex = p.flatIndexBase + i;
      if (H) {
        // Preserve previously measured dimensions from stash (survives clear()).
        // "w to w, h to h": stashedSize->width → frame.width (primary), ->height → frame.height (cross).
        auto stashedSize = _cache->getStashedMeasuredSize(key);
        const double itemW = (stashedSize && stashedSize->width  > 0.0) ? stashedSize->width  : p.itemHeight;
        const double itemH = (stashedSize && stashedSize->height > 0.0) ? stashedSize->height : hEstH;
        _scratch.sizingState = (stashedSize && stashedSize->width > 0.0 && stashedSize->height > 0.0)
            ? SizingState::Measured : SizingState::Placeholder;
        _scratch.frame = { primary, crossStart, itemW, itemH };
        primary += itemW + p.itemSpacing;
      } else {
        _scratch.sizingState = SizingState::Measured;
        _scratch.frame = { crossStart, primary, crossContent, p.itemHeight };
        primary += p.itemHeight + p.itemSpacing;
      }
      _cache->setAttributes(_scratch);
      if (i < 5 || i == p.itemCount - 1) {
        RNCV_LIST_LOG("write key=%s kind=item section=%d index=%d frame=(%.1f,%.1f,%.1f,%.1f)",
                      _scratch.key.c_str(), _scratch.section, _scratch.index,
                      _scratch.frame.x, _scratch.frame.y, _scratch.frame.width, _scratch.frame.height);
      }
      if (p.emitSeparators && i < p.itemCount - 1) {
        sep.key = "separator-" + std::to_string(sectionIndex) + "-" + std::to_string(i);
        if (H) {
          sep.frame.x = primary - p.itemSpacing; // item trailing edge (before spacing gap)
        } else {
          sep.frame.y = primary - p.itemSpacing; // item bottom edge (before spacing gap)
        }
        _cache->setAttributes(sep);
      }
    }
  } else {
    // Per-item estimated sizes along primary axis (itemHeights[i] = primary estimate).
    // For horizontal: height is also an estimate (hEstH); Yoga measures both.
    int count = std::min(p.itemCount, static_cast<int>(p.itemHeights.size()));
    for (int i = 0; i < count; ++i) {
      const std::string key = itemKey(p, i, prefix);
      _scratch.key       = key;
      _scratch.index     = i;
      _scratch.flatIndex = p.flatIndexBase + i;
      if (H) {
        // Preserve previously measured dimensions from stash (survives clear()).
        auto stashedSize = _cache->getStashedMeasuredSize(key);
        const double itemW = (stashedSize && stashedSize->width  > 0.0) ? stashedSize->width  : p.itemHeights[i];
        const double itemH = (stashedSize && stashedSize->height > 0.0) ? stashedSize->height : hEstH;
        _scratch.sizingState = (stashedSize && stashedSize->width > 0.0 && stashedSize->height > 0.0)
            ? SizingState::Measured : SizingState::Placeholder;
        _scratch.frame = { primary, crossStart, itemW, itemH };
        primary += itemW + p.itemSpacing;
      } else {
        _scratch.sizingState = SizingState::Placeholder;
        _scratch.frame = { crossStart, primary, crossContent, p.itemHeights[i] };
        primary += p.itemHeights[i] + p.itemSpacing;
      }
      _cache->setAttributes(_scratch);
      if (i < 5 || i == count - 1) {
        RNCV_LIST_LOG("write key=%s kind=item section=%d index=%d frame=(%.1f,%.1f,%.1f,%.1f)",
                      _scratch.key.c_str(), _scratch.section, _scratch.index,
                      _scratch.frame.x, _scratch.frame.y, _scratch.frame.width, _scratch.frame.height);
      }
      if (p.emitSeparators && i < count - 1) {
        sep.key = "separator-" + std::to_string(sectionIndex) + "-" + std::to_string(i);
        if (H) {
          sep.frame.x = primary - p.itemSpacing;
        } else {
          sep.frame.y = primary - p.itemSpacing;
        }
        _cache->setAttributes(sep);
      }
    }
  }

  // Undo trailing itemSpacing after last item (spacing is between items, not after)
  if (p.itemCount > 0) primary -= p.itemSpacing;

  // Primary inset end: gap between last item edge and footer edge
  primary += primaryInsetEnd;

  // ── Section background (decoration) ──────────────────────────────────────
  // Frame covers the items area only (between header and footer).
  // Content insets are applied in absolute visual coords (top/bottom → Y/height,
  // left/right → X/width) so the windowed rect and ShadowNode positions are correct.
  if (p.emitSectionBackground) {
    LayoutAttributes bg;
    bg.key            = "decoration-" + std::to_string(sectionIndex) + "-sectionBackground";
    bg.section        = sectionIndex;
    bg.index          = -1;
    if (H) {
      bg.frame = {
        bgStartPrimary + p.sectionBackgroundInsetLeft,
        crossStart     + p.sectionBackgroundInsetTop,
        primary - bgStartPrimary - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
        crossContent             - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
      };
    } else {
      bg.frame = {
        crossStart     + p.sectionBackgroundInsetLeft,
        bgStartPrimary + p.sectionBackgroundInsetTop,
        crossContent             - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
        primary - bgStartPrimary - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
      };
    }
    bg.isDecoration   = true;
    bg.decorationKind = "sectionBackground";
    bg.zIndex         = -1;
    bg.sizingState    = SizingState::Measured;
    bg.isDirty        = false;
    bg.alpha          = 1.0;
    _cache->setAttributes(bg);
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  if (p.footerHeight > 0) {
    _scratch.key               = prefix + "footer";
    _scratch.section           = sectionIndex;
    _scratch.index             = -1;
    _scratch.flatIndex         = p.footerFlatIndex;
    _scratch.isSupplementary   = true;
    _scratch.supplementaryKind = "footer";
    _scratch.sizingState       = SizingState::Measured;
    _scratch.isDirty           = false;
    if (H) {
      _scratch.frame = { primary, 0, p.footerHeight, p.viewportHeight };
    } else {
      _scratch.frame = { crossStart, primary, crossContent, p.footerHeight };
    }
    _cache->setAttributes(_scratch);
    RNCV_LIST_LOG("write key=%s kind=%s section=%d frame=(%.1f,%.1f,%.1f,%.1f)",
                  _scratch.key.c_str(), _scratch.supplementaryKind.c_str(), _scratch.section,
                  _scratch.frame.x, _scratch.frame.y, _scratch.frame.width, _scratch.frame.height);
    primary += p.footerHeight;
  }

  // Inter-section gap: sits after footer, before the next section's leading strip.
  primary += p.sectionSpacing;

  RNCV_LIST_LOG("computeSection end section=%d endPrimary=%.1f", sectionIndex, primary);
  return primary;
}

// ─── computeSections ──────────────────────────────────────────────────────────

void ListLayout::computeSections(const std::vector<ListLayoutParams>& sections) {
  _horizontal = !sections.empty() && sections[0].horizontal;
  _viewportHeight = !sections.empty() ? sections[0].viewportHeight : 0.0;
  _maxSectionCrossHeight.clear();
  double primary = 0.0;
  RNCV_LIST_LOG("computeSections begin sections=%zu horizontal=%d", sections.size(), (int)_horizontal);
  RNCV_LIST_TRACE("computeSections begin: %zu sections horizontal=%d", sections.size(), (int)_horizontal);
  for (int s = 0; s < static_cast<int>(sections.size()); ++s) {
    RNCV_LIST_TRACE("computeSections section[%d]: itemCount=%d stashSize=%zu",
                    s, sections[s].itemCount, (size_t)0 /* stash size not exposed here */);
    // Use computeSectionFromCache so the height stash is consulted after insert/delete.
    // Fallback chain: cache hit → stash hit → p.itemHeights[i] → p.itemHeight (scalar).
    // computeSection (fresh path) is no longer called here; it remains available for
    // layout engines that explicitly need a cache-independent path (e.g. first layout
    // with no stash — computeSectionFromCache handles that transparently via fallback).
    primary = computeSectionFromCache(sections[s], s, primary);
  }
  RNCV_LIST_LOG("computeSections end totalContentPrimary=%.1f", primary);
}

// ─── computeSectionFromCache ──────────────────────────────────────────────────

double ListLayout::computeSectionFromCache(const ListLayoutParams& p,
                                            int sectionIndex,
                                            double startPrimary) {
  const bool H = p.horizontal;
  const std::string prefix = p.keyPrefix.empty()
      ? "item-" + std::to_string(sectionIndex) + "-"
      : p.keyPrefix;

  const double crossContent = H
      ? 0  // unused for horizontal item sizing
      : (p.viewportWidth  - p.sectionInsetLeft - p.sectionInsetRight);
  const double crossStart = H ? p.sectionInsetTop : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;
  const double hEstH  = p.estimatedCrossAxisHeight;
  const double hHdrH  = hEstH + p.sectionInsetTop + p.sectionInsetBottom;

  double primary = startPrimary;
  double bgStartPrimary = startPrimary;
  double sectionMaxCross = 0.0;

  LayoutAttributes sep;
  if (p.emitSeparators) {
    sep.section        = sectionIndex;
    sep.index          = -1;
    sep.isDecoration   = true;
    sep.decorationKind = "separator";
    sep.zIndex         = 0;
    sep.sizingState    = SizingState::Measured;
    sep.isDirty        = false;
    sep.alpha          = 1.0;
    if (H) {
      sep.frame.x      = 0;
      sep.frame.y      = crossStart;
      sep.frame.width  = p.separatorHeight;
      sep.frame.height = hEstH;  // estimated; applyMeasurements updates
    } else {
      sep.frame.x      = crossStart + p.separatorInsetLeading;
      sep.frame.y      = 0;
      sep.frame.width  = crossContent - p.separatorInsetLeading - p.separatorInsetTrailing;
      sep.frame.height = p.separatorHeight;
    }
  }

  // ── Header ────────────────────────────────────────────────────────────────
  if (p.headerHeight > 0) {
    const std::string hdrKey = prefix + "header";
    auto existingHdr = _cache->getAttributes(hdrKey);
    _scratch.key               = hdrKey;
    _scratch.section           = sectionIndex;
    _scratch.index             = -1;
    _scratch.flatIndex         = p.headerFlatIndex;
    _scratch.isSupplementary   = true;
    _scratch.supplementaryKind = "header";
    _scratch.sizingState       = SizingState::Measured;
    _scratch.isDirty           = false;
    if (H) {
      // Horizontal list supplementaries span full viewport height.
      // Do not persist stale cached estimated heights here.
      const double hH = p.viewportHeight > 0
          ? p.viewportHeight
          : ((existingHdr && existingHdr->frame.height > 0) ? existingHdr->frame.height : hHdrH);
      _scratch.frame = { primary, 0, p.headerHeight, hH };
      if (hH > sectionMaxCross) sectionMaxCross = hH;
    } else {
      _scratch.frame = { crossStart, primary, crossContent, p.headerHeight };
    }
    _cache->setAttributes(_scratch);
    primary += p.headerHeight;
    bgStartPrimary = primary;
  }

  primary += primaryInsetStart;

  // ── Items — read primary-axis sizes from cache ────────────────────────────
  _scratch.isSupplementary   = false;
  _scratch.supplementaryKind.clear();
  _scratch.section           = sectionIndex;

  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = itemKey(p, i, prefix);
    auto existing = _cache->getAttributes(key);
    auto stashedSize = _cache->getStashedMeasuredSize(key);
    // Primary-axis size: cached → stashed → JS per-item heights → scalar estimate.
    double sz;
    const char* heightSource = "unknown";
    if (existing) {
      sz = H ? existing->frame.width : existing->frame.height;
      heightSource = "cache";
    } else {
      if (H && stashedSize && stashedSize->width > 0.0) {
        sz = stashedSize->width;
        heightSource = "stash-size";
      } else {
        const double stashed = _cache->getStashedHeight(key);
        if (stashed > 0.0) {
          sz = stashed;
          heightSource = "stash";
        } else if (!p.itemHeights.empty() && i < static_cast<int>(p.itemHeights.size())) {
          sz = p.itemHeights[i];
          heightSource = "itemHeights";
        } else {
          sz = p.itemHeight;
          heightSource = "scalar";
        }
      }
    }
    // Trace first 5 items per section (enough to catch estimate vs measured discrepancy).
    if (i < 5) {
      RNCV_LIST_TRACE("computeSectionFromCache s[%d][%d] key=%s source=%s sz=%.1f",
                      sectionIndex, i, key.c_str(), heightSource, sz);
    }
    // Cross-axis size: preserve cached height for horizontal, then stashed measured
    // size when cache was cleared, else estimate. Vertical uses crossContent.
    const double crossSz = H
        ? (existing && existing->frame.height > 0
            ? existing->frame.height
            : (stashedSize && stashedSize->height > 0
                ? stashedSize->height
                : hEstH))
        : crossContent;
    if (H && crossSz > sectionMaxCross) sectionMaxCross = crossSz;
    _scratch.sizingState = existing
        ? existing->sizingState
        : (H && stashedSize && stashedSize->width > 0 && stashedSize->height > 0
            ? SizingState::Measured
            : SizingState::Placeholder);
    _scratch.key         = key;
    _scratch.index       = i;
    _scratch.flatIndex   = p.flatIndexBase + i;
    if (H) {
      _scratch.frame = { primary, crossStart, sz, crossSz };
    } else {
      _scratch.frame = { crossStart, primary, crossContent, sz };
    }
    _cache->setAttributes(_scratch);
    primary += sz + p.itemSpacing;
    if (p.emitSeparators && i < p.itemCount - 1) {
      sep.key = "separator-" + std::to_string(sectionIndex) + "-" + std::to_string(i);
      if (H) {
        sep.frame.x = primary - p.itemSpacing;
      } else {
        sep.frame.y = primary - p.itemSpacing;
      }
      _cache->setAttributes(sep);
    }
  }

  if (p.itemCount > 0) primary -= p.itemSpacing;

  primary += primaryInsetEnd;

  if (H) {
    // Preserve best-known section cross extent across cache recomputes.
    auto prev = _maxSectionCrossHeight.find(sectionIndex);
    if (prev != _maxSectionCrossHeight.end() && prev->second > sectionMaxCross) {
      sectionMaxCross = prev->second;
    }
    if (sectionMaxCross <= 0.0) {
      sectionMaxCross = hEstH;
    }
    _maxSectionCrossHeight[sectionIndex] = sectionMaxCross;
  }

  // ── Section background ─────────────────────────────────────────────────
  // Content insets applied in absolute visual coords — same as computeSection.
  if (p.emitSectionBackground) {
    LayoutAttributes bg;
    bg.key            = "decoration-" + std::to_string(sectionIndex) + "-sectionBackground";
    bg.section        = sectionIndex;
    bg.index          = -1;
    if (H) {
      // Horizontal: derive from best-known section cross extent, not stale cache.
      const double bgH = sectionMaxCross > 0 ? sectionMaxCross : hEstH;
      bg.frame = {
        bgStartPrimary + p.sectionBackgroundInsetLeft,
        crossStart     + p.sectionBackgroundInsetTop,
        primary - bgStartPrimary - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
        bgH                      - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
      };
    } else {
      bg.frame = {
        crossStart     + p.sectionBackgroundInsetLeft,
        bgStartPrimary + p.sectionBackgroundInsetTop,
        crossContent             - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
        primary - bgStartPrimary - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
      };
    }
    bg.isDecoration   = true;
    bg.decorationKind = "sectionBackground";
    bg.zIndex         = -1;
    bg.sizingState    = SizingState::Measured;
    bg.isDirty        = false;
    bg.alpha          = 1.0;
    _cache->setAttributes(bg);
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  if (p.footerHeight > 0) {
    _scratch.key               = prefix + "footer";
    _scratch.section           = sectionIndex;
    _scratch.index             = -1;
    _scratch.flatIndex         = p.footerFlatIndex;
    _scratch.isSupplementary   = true;
    _scratch.supplementaryKind = "footer";
    _scratch.sizingState       = SizingState::Measured;
    _scratch.isDirty           = false;
    if (H) {
      const double fH = p.viewportHeight > 0 ? p.viewportHeight : sectionMaxCross;
      _scratch.frame = { primary, 0, p.footerHeight, fH };
      if (fH > sectionMaxCross) sectionMaxCross = fH;
    } else {
      _scratch.frame = { crossStart, primary, crossContent, p.footerHeight };
    }
    _cache->setAttributes(_scratch);
    primary += p.footerHeight;
  }

  primary += p.sectionSpacing;

  return primary;
}

// ─── invalidateSectionsFrom ───────────────────────────────────────────────────

void ListLayout::invalidateSectionsFrom(int fromSection,
                                         const std::vector<ListLayoutParams>& sections) {
  if (fromSection < 0 || fromSection >= static_cast<int>(sections.size())) return;

  // Find the Y where fromSection starts by reading the cache.
  const auto& p0 = sections[fromSection];
  const std::string prefix0 = p0.keyPrefix.empty()
      ? "item-" + std::to_string(fromSection) + "-"
      : p0.keyPrefix;

  const bool H = p0.horizontal;

  double startPrimary = 0.0;
  if (p0.headerHeight > 0) {
    auto header = _cache->getAttributes(prefix0 + "header");
    if (header) startPrimary = H ? header->frame.x : header->frame.y;
  } else {
    auto firstItem = _cache->getAttributes(itemKey(p0, 0, prefix0));
    if (firstItem) {
      // Subtract the primary inset start to get the section's leading edge.
      const double primaryInsetStart = H ? p0.sectionInsetLeft : p0.sectionInsetTop;
      startPrimary = H
          ? (firstItem->frame.x - primaryInsetStart)
          : (firstItem->frame.y - primaryInsetStart);
    }
  }

  // Reflow fromSection reading item sizes from cache, then full-recompute subsequent sections.
  double primary = computeSectionFromCache(p0, fromSection, startPrimary);
  for (int s = fromSection + 1; s < static_cast<int>(sections.size()); ++s) {
    primary = computeSection(sections[s], s, primary);
  }
}

// ─── JSI bindings ─────────────────────────────────────────────────────────────

void ListLayout::installJSIBindings(Runtime& rt, Object& target) {
  // computeListLayout(params) → undefined  [M1.2/M1.3]
  target.setProperty(rt, "computeListLayout",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeListLayout"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        compute(paramsFromJSI(rt, args[0].getObject(rt)));
        return Value::undefined();
      }));

  // invalidateListLayoutFrom(key, params) → undefined  [M1.3]
  target.setProperty(rt, "invalidateListLayoutFrom",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "invalidateListLayoutFrom"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2 || !args[0].isString() || !args[1].isObject()) {
          return Value::undefined();
        }
        std::string key = args[0].getString(rt).utf8(rt);
        invalidateFrom(key, paramsFromJSI(rt, args[1].getObject(rt)));
        return Value::undefined();
      }));

  // computeSections(sections: object[]) → undefined  [M1.5]
  target.setProperty(rt, "computeSections",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeSections"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        auto arr = args[0].getObject(rt).asArray(rt);
        _cache->clear();
        computeSections(sectionsFromJSI(rt, arr));
        return Value::undefined();
      }));

  // invalidateSectionsFrom(sectionIndex: number, sections: object[]) → undefined  [M1.5]
  target.setProperty(rt, "invalidateSectionsFrom",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "invalidateSectionsFrom"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2 || !args[0].isNumber() || !args[1].isObject()) {
          return Value::undefined();
        }
        int fromSection = static_cast<int>(args[0].getNumber());
        auto arr = args[1].getObject(rt).asArray(rt);
        invalidateSectionsFrom(fromSection, sectionsFromJSI(rt, arr));
        return Value::undefined();
      }));
}

} // namespace rncv
