#include "ListLayout.h"

#include <sstream>
#include <stdexcept>

#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
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

  // For a 1D list layout, changing item heights simply shifts everything below them.
  // Instead of recalculating Y from scratch (which loses section insets and headers),
  // we accumulate a rolling `aggregateShift` and apply it sequentially.

  // 1. Convert deltas to a fast lookup map: key -> delta height.
  // d.newValue is the new height. We need to know (new - old) later.
  std::unordered_map<std::string, double> newHeights;
  for (const auto& d : deltas) {
    newHeights[d.key] = d.newValue;
  }

  auto all = cache.getAll();
  if (all.empty()) return true;

  // Sort by strictly increasing primary position (Y for vertical, X for horizontal).
  if (_horizontal) {
    std::sort(all.begin(), all.end(), [](const LayoutAttributes& a, const LayoutAttributes& b) {
      return a.frame.x < b.frame.x;
    });
  } else {
    std::sort(all.begin(), all.end(), [](const LayoutAttributes& a, const LayoutAttributes& b) {
      return a.frame.y < b.frame.y;
    });
  }

  double aggregateShift = 0.0;

  // Track per-section aggregateShift at entry (first item) and exit (last item).
  // Used in the second pass to shift section backgrounds.
  struct SectionShifts { double entryShift = 0; double exitShift = 0; bool entered = false; };
  std::unordered_map<int, SectionShifts> sectionShifts;

  for (auto& attr : all) {
    if (attr.isDecoration && attr.decorationKind == "sectionBackground") continue;

    bool changed = false;

    // Apply accumulated shift from items before us on the primary axis
    if (aggregateShift != 0.0) {
      if (_horizontal) {
        attr.frame.x += aggregateShift;
      } else {
        attr.frame.y += aggregateShift;
      }
      changed = true;
    }

    if (attr.isDecoration) {
      // Separator — just shifts, no size change.
      if (changed) cache.setAttributes(attr);
      continue;
    }

    // Track entry shift for section background
    if (!attr.isSupplementary) {
      auto& ss = sectionShifts[attr.section];
      if (!ss.entered) {
        ss.entryShift = aggregateShift;
        ss.entered = true;
      }
    }

    // If this item has a new measurement, update it and add to rolling shift
    auto it = newHeights.find(attr.key);
    if (it != newHeights.end()) {
      double newSz = it->second;
      double sizeDiff = _horizontal
          ? (newSz - attr.frame.width)
          : (newSz - attr.frame.height);

      if (sizeDiff != 0.0) {
        if (_horizontal) {
          attr.frame.width = newSz;
        } else {
          attr.frame.height = newSz;
        }
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

    if (changed) {
      cache.setAttributes(attr);
    }
  }

  // Second pass: adjust section background frames using per-section shift deltas.
  for (auto& attr : all) {
    if (!attr.isDecoration || attr.decorationKind != "sectionBackground") continue;
    auto sit = sectionShifts.find(attr.section);
    if (sit == sectionShifts.end() || !sit->second.entered) continue;
    const double shiftPrimary = sit->second.entryShift;
    const double sizeDelta    = sit->second.exitShift - sit->second.entryShift;
    if (std::abs(shiftPrimary) > 0.01 || std::abs(sizeDelta) > 0.01) {
      if (_horizontal) {
        attr.frame.x     += shiftPrimary;
        attr.frame.width += sizeDelta;
      } else {
        attr.frame.y      += shiftPrimary;
        attr.frame.height += sizeDelta;
      }
      cache.setAttributes(attr);
    }
  }

  return true;
}

// ─── invalidateFrom ───────────────────────────────────────────────────────────

void ListLayout::invalidateFrom(
    const std::string& startKey,
    const ListLayoutParams& p) {
  // Find the starting item's current Y so we can reflow from there.
  auto startAttrs = _cache->getAttributes(startKey);
  if (!startAttrs) return;

  const double contentWidth = p.viewportWidth
                              - p.sectionInsetLeft
                              - p.sectionInsetRight;
  const std::string prefix  = p.keyPrefix.empty()
                              ? "item-" + std::to_string(p.section) + "-"
                              : p.keyPrefix;

  // Determine start index from the stored attrs.
  const int startIndex = startAttrs->index;

  _scratch.section     = p.section;
  _scratch.frame.x     = p.sectionInsetLeft;
  _scratch.frame.width = contentWidth;

  double y = startAttrs->frame.y;

  // invalidateFrom always reads heights from the cache — the cache is the
  // single source of truth. The caller updates the corrected item's attrs
  // (via layoutCache.setAttributes) BEFORE calling invalidateFrom, so the
  // new height is already present in the cache at startKey.
  for (int i = startIndex; i < p.itemCount; ++i) {
    const std::string key = itemKey(p, i, prefix);

    auto existing = _cache->getAttributes(key);
    const double h = existing ? existing->frame.height : p.itemHeight;
    _scratch.sizingState  = existing ? existing->sizingState
                                     : SizingState::Placeholder;

    _scratch.key          = key;
    _scratch.index        = i;
    _scratch.frame.y      = y;
    _scratch.frame.height = h;
    _cache->setAttributes(_scratch);
    y += h + p.itemSpacing;
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
  p.horizontal              = bln(rt, obj, "horizontal");
  p.viewportHeight          = dbl(rt, obj, "viewportHeight");

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
  //   primaryInsetStart = sectionInsetTop (gap between header bottom and first item)
  //   primaryInsetEnd   = sectionInsetBottom (gap between last item and footer)
  //
  // For horizontal (H=true): primary axis = X, cross axis = Y.
  //   crossContent = viewport height minus top/bottom insets (item fill height)
  //   crossStart   = sectionInsetTop (item y position)
  //   primaryInsetStart = sectionInsetLeft (gap between header right and first item)
  //   primaryInsetEnd   = sectionInsetRight (gap between last item and footer left)
  //
  // In both cases, "header" and "footer" are strips perpendicular to the primary axis:
  //   Vertical: horizontal strips spanning crossContent, height = headerHeight.
  //   Horizontal: vertical strips spanning full viewportHeight, width = headerHeight.

  const double crossContent = H
      ? (p.viewportHeight - p.sectionInsetTop - p.sectionInsetBottom)
      : (p.viewportWidth  - p.sectionInsetLeft - p.sectionInsetRight);
  const double crossStart = H ? p.sectionInsetTop : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;

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
      // Vertical separator line between items in a horizontal list
      sep.frame.x      = 0;  // updated per-separator
      sep.frame.y      = crossStart;
      sep.frame.width  = p.separatorHeight;  // separator thickness along scroll axis
      sep.frame.height = crossContent;
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
    _scratch.isSupplementary   = true;
    _scratch.supplementaryKind = "header";
    _scratch.sizingState       = SizingState::Measured;
    _scratch.isDirty           = false;
    if (H) {
      // Horizontal: header is a full-height vertical strip at the left of the section
      _scratch.frame = { primary, 0, p.headerHeight, p.viewportHeight };
    } else {
      // Vertical: header is a full-width horizontal strip at the top of the section
      _scratch.frame = { crossStart, primary, crossContent, p.headerHeight };
    }
    _cache->setAttributes(_scratch);
    RNCV_LIST_LOG("write key=%s kind=%s section=%d frame=(%.1f,%.1f,%.1f,%.1f)",
                  _scratch.key.c_str(), _scratch.supplementaryKind.c_str(), _scratch.section,
                  _scratch.frame.x, _scratch.frame.y, _scratch.frame.width, _scratch.frame.height);
    primary += p.headerHeight;
    bgStartPrimary = primary; // bg starts after header so rounded corners are exposed
  }

  // Gap: primary inset start (between header edge and first item edge)
  primary += primaryInsetStart;

  // ── Items ─────────────────────────────────────────────────────────────────
  _scratch.isSupplementary   = false;
  _scratch.supplementaryKind.clear();
  _scratch.section           = sectionIndex;

  if (p.itemHeights.empty()) {
    // Fixed item size along primary axis (itemHeight param)
    _scratch.sizingState = SizingState::Measured;
    for (int i = 0; i < p.itemCount; ++i) {
      _scratch.key   = itemKey(p, i, prefix);
      _scratch.index = i;
      if (H) {
        _scratch.frame = { primary, crossStart, p.itemHeight, crossContent };
      } else {
        _scratch.frame = { crossStart, primary, crossContent, p.itemHeight };
      }
      _cache->setAttributes(_scratch);
      if (i < 5 || i == p.itemCount - 1) {
        RNCV_LIST_LOG("write key=%s kind=item section=%d index=%d frame=(%.1f,%.1f,%.1f,%.1f)",
                      _scratch.key.c_str(), _scratch.section, _scratch.index,
                      _scratch.frame.x, _scratch.frame.y, _scratch.frame.width, _scratch.frame.height);
      }
      primary += p.itemHeight + p.itemSpacing;
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
    // Estimated sizes along primary axis (per-item)
    _scratch.sizingState = SizingState::Placeholder;
    int count = std::min(p.itemCount, static_cast<int>(p.itemHeights.size()));
    for (int i = 0; i < count; ++i) {
      double sz = p.itemHeights[i];
      _scratch.key   = itemKey(p, i, prefix);
      _scratch.index = i;
      if (H) {
        _scratch.frame = { primary, crossStart, sz, crossContent };
      } else {
        _scratch.frame = { crossStart, primary, crossContent, sz };
      }
      _cache->setAttributes(_scratch);
      if (i < 5 || i == count - 1) {
        RNCV_LIST_LOG("write key=%s kind=item section=%d index=%d frame=(%.1f,%.1f,%.1f,%.1f)",
                      _scratch.key.c_str(), _scratch.section, _scratch.index,
                      _scratch.frame.x, _scratch.frame.y, _scratch.frame.width, _scratch.frame.height);
      }
      primary += sz + p.itemSpacing;
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
  if (p.emitSectionBackground) {
    LayoutAttributes bg;
    bg.key            = "decoration-" + std::to_string(sectionIndex) + "-sectionBackground";
    bg.section        = sectionIndex;
    bg.index          = -1;
    if (H) {
      bg.frame = { bgStartPrimary, crossStart, primary - bgStartPrimary, crossContent };
    } else {
      bg.frame = { crossStart, bgStartPrimary, crossContent, primary - bgStartPrimary };
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
  double primary = 0.0;
  RNCV_LIST_LOG("computeSections begin sections=%zu horizontal=%d", sections.size(), (int)_horizontal);
  for (int s = 0; s < static_cast<int>(sections.size()); ++s) {
    primary = computeSection(sections[s], s, primary);
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
      ? (p.viewportHeight - p.sectionInsetTop - p.sectionInsetBottom)
      : (p.viewportWidth  - p.sectionInsetLeft - p.sectionInsetRight);
  const double crossStart = H ? p.sectionInsetTop : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;

  double primary = startPrimary;
  double bgStartPrimary = startPrimary;

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
      sep.frame.height = crossContent;
    } else {
      sep.frame.x      = crossStart + p.separatorInsetLeading;
      sep.frame.y      = 0;
      sep.frame.width  = crossContent - p.separatorInsetLeading - p.separatorInsetTrailing;
      sep.frame.height = p.separatorHeight;
    }
  }

  // ── Header ────────────────────────────────────────────────────────────────
  if (p.headerHeight > 0) {
    _scratch.key               = prefix + "header";
    _scratch.section           = sectionIndex;
    _scratch.index             = -1;
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
    // For horizontal: read cached width; for vertical: read cached height.
    const double sz = existing
        ? (H ? existing->frame.width : existing->frame.height)
        : p.itemHeight;
    _scratch.sizingState = existing ? existing->sizingState : SizingState::Measured;
    _scratch.key         = key;
    _scratch.index       = i;
    if (H) {
      _scratch.frame = { primary, crossStart, sz, crossContent };
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

  // ── Section background ─────────────────────────────────────────────────
  if (p.emitSectionBackground) {
    LayoutAttributes bg;
    bg.key            = "decoration-" + std::to_string(sectionIndex) + "-sectionBackground";
    bg.section        = sectionIndex;
    bg.index          = -1;
    if (H) {
      bg.frame = { bgStartPrimary, crossStart, primary - bgStartPrimary, crossContent };
    } else {
      bg.frame = { crossStart, bgStartPrimary, crossContent, primary - bgStartPrimary };
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
