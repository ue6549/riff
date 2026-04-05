#include "FlowLayout.h"
#include <algorithm>
#include <cmath>
#include <limits>

namespace rncv {

using namespace facebook::jsi;

// ─── JSI helpers ──────────────────────────────────────────────────────────────

static double fdbl(Runtime& rt, const Object& o, const char* k, double def = 0.0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? v.getNumber() : def;
}
static int fi32(Runtime& rt, const Object& o, const char* k, int def = 0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? static_cast<int>(v.getNumber()) : def;
}
static bool fbln(Runtime& rt, const Object& o, const char* k, bool def = false) {
  Value v = o.getProperty(rt, k);
  return v.isBool() ? v.getBool() : def;
}

FlowLayout::FlowLayout(std::shared_ptr<LayoutCache> cache)
    : _cache(std::move(cache)) {}

// ─── compute (legacy single-section) ─────────────────────────────────────────

void FlowLayout::compute(const FlowLayoutParams& params) {
  _sectionParams = {params};
  _horizontal = params.horizontal;
  _cache->clear();
  computeSection(params, 0, 0.0);
}

// ─── computeSection ──────────────────────────────────────────────────────────

double FlowLayout::computeSection(const FlowLayoutParams& p, int sectionIndex, double startPrimary) {
  const bool H = p.horizontal;

  // Axis setup:
  //   V: primary=Y (scroll), cross=X (fixed=viewportWidth)
  //   H: primary=X (scroll), cross=Y (fixed=viewportHeight)
  const double crossExtent    = H ? p.viewportHeight : p.viewportWidth;
  const double primaryInsetStart = H ? p.sectionInsetLeft   : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight  : p.sectionInsetBottom;
  const double crossInsetStart   = H ? p.sectionInsetTop    : p.sectionInsetLeft;
  const double crossInsetEnd     = H ? p.sectionInsetBottom : p.sectionInsetRight;
  const double itemGap  = p.itemSpacing;  // between items within a row/column
  const double lineGap  = p.lineSpacing;  // between rows (V) or columns (H)

  const std::string sPrefix = "flow-" + std::to_string(sectionIndex) + "-";

  // ── Header ──────────────────────────────────────────────────────────────────
  double primary = startPrimary;
  if (p.headerHeight > 0) {
    LayoutAttributes hdr;
    hdr.key            = sPrefix + "header";
    hdr.index          = 0;
    hdr.isSupplementary = true;
    hdr.supplementaryKind = "header";
    hdr.section        = sectionIndex;
    if (H) {
      hdr.frame = { primary, 0, p.headerHeight, crossExtent };
    } else {
      hdr.frame = { 0, primary, crossExtent, p.headerHeight };
    }
    hdr.zIndex = 10;
    hdr.sizingState = SizingState::Measured;
    _cache->setAttributes(hdr);
    primary += p.headerHeight;
  }

  // ── Items (bin-packing) ───────────────────────────────────────────────────
  const double availCross = crossExtent - crossInsetStart - crossInsetEnd;
  const double crossStart = crossInsetStart;
  const double itemsStart = primary + primaryInsetStart;

  double crossCursor = crossStart;
  double primaryCursor = itemsStart;

  // Store frames before writing to cache (need to finalize row/col height/width).
  struct ItemFrame { double primary, cross, primarySize, crossSize; };
  std::vector<ItemFrame> frames(p.itemCount);

  double lineMaxCross = 0.0; // max cross-axis size (height for V, width for H) in current row/col
  int lineStart = 0;
  int lineCount = 0; // number of completed lines (for separator keys)

  auto finalizeLineAndAdvance = [&](int from, int to) {
    // Set lineMaxCross for all items in this line.
    for (int j = from; j < to; ++j) {
      frames[j].crossSize = lineMaxCross;
    }

    // Emit between-row/column separator if requested (after line is finalized).
    // Separator is emitted AFTER the line, so it sits between this line and the next.
    // We emit it before advancing, using the current primaryCursor + lineMaxCross as end.
    if (p.emitSeparators && lineCount > 0) {
      // Emit separator BEFORE this line (between previous and current line).
      // Separator is placed at the start of the line gap.
    }

    primaryCursor += lineMaxCross + lineGap;
    lineMaxCross = 0.0;
    lineStart = to;
    lineCount++;
  };

  for (int i = 0; i < p.itemCount; ++i) {
    const double itemCrossSize   = H ? (i < (int)p.itemHeights.size() ? p.itemHeights[i] : 44.0)
                                     : (i < (int)p.itemWidths.size()  ? p.itemWidths[i]  : 80.0);
    double itemPrimarySize = H ? (i < (int)p.itemWidths.size()  ? p.itemWidths[i]  : 80.0)
                               : (i < (int)p.itemHeights.size() ? p.itemHeights[i] : 44.0);

    // Clamp cross size to available cross extent.
    const double clampedCross = std::min(itemCrossSize, availCross);

    // Does this item fit in the current row/column?
    const bool notFirst = (crossCursor > crossStart + 0.01);
    const double needed = notFirst ? crossCursor + itemGap + clampedCross : clampedCross;

    if (needed > availCross + 0.01 && notFirst) {
      // Emit between-line separator (between previous line and this one).
      if (p.emitSeparators && lineCount > 0) {
        const double sepPos = primaryCursor + lineMaxCross;
        LayoutAttributes sep;
        sep.key            = sPrefix + "sep-" + std::to_string(lineCount);
        sep.index          = lineCount;
        sep.isDecoration   = true;
        sep.decorationKind = "separator";
        sep.section        = sectionIndex;
        if (H) {
          // Vertical separator line between columns
          const double sLeading  = crossStart + p.separatorInsetLeading;
          const double sTrailing = crossExtent - crossInsetEnd - p.separatorInsetTrailing;
          sep.frame = { sepPos, sLeading, p.separatorHeight, sTrailing - sLeading };
        } else {
          // Horizontal separator line between rows
          const double sLeading  = crossStart + p.separatorInsetLeading;
          const double sTrailing = crossExtent - crossInsetEnd - p.separatorInsetTrailing;
          sep.frame = { sLeading, sepPos, sTrailing - sLeading, p.separatorHeight };
        }
        sep.zIndex      = 1;
        sep.sizingState = SizingState::Measured;
        _cache->setAttributes(sep);
      }

      finalizeLineAndAdvance(lineStart, i);
      crossCursor = crossStart;
    }

    if (crossCursor > crossStart + 0.01) crossCursor += itemGap;

    if (H) {
      frames[i] = { primaryCursor, crossCursor, itemPrimarySize, clampedCross };
    } else {
      frames[i] = { primaryCursor, crossCursor, clampedCross,    itemPrimarySize };
    }

    if (clampedCross > lineMaxCross) lineMaxCross = clampedCross;
    crossCursor += clampedCross;
  }

  // Finalize last row/column.
  if (p.itemCount > 0) {
    for (int j = lineStart; j < p.itemCount; ++j) {
      frames[j].crossSize = lineMaxCross;
    }
    primaryCursor += lineMaxCross;
  }

  // Write items to cache.
  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = (i < (int)p.keys.size()) ? p.keys[i]
                          : (p.keyPrefix.empty() ? sPrefix + std::to_string(i) : p.keyPrefix + std::to_string(i));
    LayoutAttributes attrs;
    attrs.key     = key;
    attrs.index   = i;
    attrs.section = sectionIndex;
    if (H) {
      attrs.frame = { frames[i].primary, frames[i].cross, frames[i].primarySize, frames[i].crossSize };
    } else {
      attrs.frame = { frames[i].cross, frames[i].primary, frames[i].crossSize, frames[i].primarySize };
    }
    attrs.zIndex      = 0;
    attrs.sizingState = SizingState::Measured;
    _cache->setAttributes(attrs);
  }

  // Content end (after items + trailing inset).
  primaryCursor += primaryInsetEnd;

  // ── Section background ───────────────────────────────────────────────────────
  if (p.emitSectionBackground) {
    const double bgPrimaryStart = startPrimary + p.headerHeight;
    const double bgPrimaryEnd   = primaryCursor;
    const double bgCrossStart   = crossInsetStart;
    const double bgCrossEnd     = crossExtent - crossInsetEnd;

    LayoutAttributes bg;
    bg.key            = sPrefix + "sectionBackground";
    bg.index          = 0;
    bg.isDecoration   = true;
    bg.decorationKind = "sectionBackground";
    bg.section        = sectionIndex;
    if (H) {
      bg.frame = {
        bgPrimaryStart + p.sectionBackgroundInsetLeft,
        bgCrossStart   + p.sectionBackgroundInsetTop,
        (bgPrimaryEnd - bgPrimaryStart) - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
        (bgCrossEnd - bgCrossStart)     - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
      };
    } else {
      bg.frame = {
        bgCrossStart   + p.sectionBackgroundInsetLeft,
        bgPrimaryStart + p.sectionBackgroundInsetTop,
        (bgCrossEnd - bgCrossStart)     - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
        (bgPrimaryEnd - bgPrimaryStart) - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
      };
    }
    bg.zIndex      = -1;
    bg.sizingState = SizingState::Measured;
    _cache->setAttributes(bg);
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  if (p.footerHeight > 0) {
    LayoutAttributes ftr;
    ftr.key            = sPrefix + "footer";
    ftr.index          = 0;
    ftr.isSupplementary = true;
    ftr.supplementaryKind = "footer";
    ftr.section        = sectionIndex;
    if (H) {
      ftr.frame = { primaryCursor, 0, p.footerHeight, crossExtent };
    } else {
      ftr.frame = { 0, primaryCursor, crossExtent, p.footerHeight };
    }
    ftr.zIndex      = 10;
    ftr.sizingState = SizingState::Measured;
    _cache->setAttributes(ftr);
    primaryCursor += p.footerHeight;
  }

  return primaryCursor + p.sectionSpacing;
}

// ─── computeSectionFromCache ──────────────────────────────────────────────────

double FlowLayout::computeSectionFromCache(const FlowLayoutParams& p, int sectionIndex, double startPrimary) {
  const bool H = p.horizontal;

  const double crossExtent    = H ? p.viewportHeight : p.viewportWidth;
  const double primaryInsetStart = H ? p.sectionInsetLeft   : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight  : p.sectionInsetBottom;
  const double crossInsetStart   = H ? p.sectionInsetTop    : p.sectionInsetLeft;
  const double crossInsetEnd     = H ? p.sectionInsetBottom : p.sectionInsetRight;
  const double itemGap  = p.itemSpacing;
  const double lineGap  = p.lineSpacing;

  const std::string sPrefix = "flow-" + std::to_string(sectionIndex) + "-";

  // ── Header ──────────────────────────────────────────────────────────────────
  double primary = startPrimary;
  if (p.headerHeight > 0) {
    auto hdrAttrs = _cache->getAttributes(sPrefix + "header");
    if (hdrAttrs) {
      auto updated = *hdrAttrs;
      if (H) { updated.frame = { primary, 0, p.headerHeight, crossExtent }; }
      else   { updated.frame = { 0, primary, crossExtent, p.headerHeight }; }
      _cache->setAttributes(updated);
    }
    primary += p.headerHeight;
  }

  // ── Items (bin-packing from cache dimensions) ────────────────────────────
  const double availCross = crossExtent - crossInsetStart - crossInsetEnd;
  const double crossStart = crossInsetStart;
  const double itemsStart = primary + primaryInsetStart;

  double crossCursor   = crossStart;
  double primaryCursor = itemsStart;

  struct ItemFrame { double primary, cross, primarySize, crossSize; };
  std::vector<ItemFrame> frames(p.itemCount);

  double lineMaxCross = 0.0;
  int lineStart  = 0;
  int lineCount  = 0;

  auto finalizeAndAdvance = [&](int from, int to) {
    for (int j = from; j < to; ++j) frames[j].crossSize = lineMaxCross;
    primaryCursor += lineMaxCross + lineGap;
    lineMaxCross = 0.0;
    lineStart = to;
    lineCount++;
  };

  // Read item dimensions from cache.
  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = (i < (int)p.keys.size()) ? p.keys[i]
                          : (p.keyPrefix.empty() ? sPrefix + std::to_string(i) : p.keyPrefix + std::to_string(i));
    auto cached = _cache->getAttributes(key);

    // Cross-axis size = width (H) or height (V); primary-axis size = width (H) or height (V)
    double itemCrossSize, itemPrimarySize;
    if (cached) {
      if (H) {
        itemCrossSize   = cached->frame.height;
        itemPrimarySize = cached->frame.width;
      } else {
        itemCrossSize   = cached->frame.width;
        itemPrimarySize = cached->frame.height;
      }
    } else {
      itemCrossSize   = H ? (i < (int)p.itemHeights.size() ? p.itemHeights[i] : 44.0)
                          : (i < (int)p.itemWidths.size()  ? p.itemWidths[i]  : 80.0);
      itemPrimarySize = H ? (i < (int)p.itemWidths.size()  ? p.itemWidths[i]  : 80.0)
                          : (i < (int)p.itemHeights.size() ? p.itemHeights[i] : 44.0);
    }

    const double clampedCross = std::min(itemCrossSize, availCross);

    const bool notFirst = (crossCursor > crossStart + 0.01);
    const double needed = notFirst ? crossCursor + itemGap + clampedCross : clampedCross;

    if (needed > availCross + 0.01 && notFirst) {
      finalizeAndAdvance(lineStart, i);
      crossCursor = crossStart;
    }

    if (crossCursor > crossStart + 0.01) crossCursor += itemGap;

    frames[i] = { primaryCursor, crossCursor, itemPrimarySize, clampedCross };
    if (clampedCross > lineMaxCross) lineMaxCross = clampedCross;
    crossCursor += clampedCross;
  }

  if (p.itemCount > 0) {
    for (int j = lineStart; j < p.itemCount; ++j) frames[j].crossSize = lineMaxCross;
    primaryCursor += lineMaxCross;
  }

  // Write updated positions to cache.
  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = (i < (int)p.keys.size()) ? p.keys[i]
                          : (p.keyPrefix.empty() ? sPrefix + std::to_string(i) : p.keyPrefix + std::to_string(i));
    auto cached = _cache->getAttributes(key);
    if (!cached) continue;
    auto updated = *cached;
    if (H) {
      updated.frame = { frames[i].primary, frames[i].cross, frames[i].primarySize, frames[i].crossSize };
    } else {
      updated.frame = { frames[i].cross, frames[i].primary, frames[i].crossSize, frames[i].primarySize };
    }
    _cache->setAttributes(updated);
  }

  primaryCursor += primaryInsetEnd;

  // ── Section background ───────────────────────────────────────────────────────
  if (p.emitSectionBackground) {
    auto bgCached = _cache->getAttributes(sPrefix + "sectionBackground");
    if (bgCached) {
      auto bg = *bgCached;
      const double bgPrimaryStart = startPrimary + p.headerHeight;
      const double bgPrimaryEnd   = primaryCursor;
      const double bgCrossStart   = crossInsetStart;
      const double bgCrossEnd     = crossExtent - crossInsetEnd;
      if (H) {
        bg.frame = {
          bgPrimaryStart + p.sectionBackgroundInsetLeft,
          bgCrossStart   + p.sectionBackgroundInsetTop,
          (bgPrimaryEnd - bgPrimaryStart) - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
          (bgCrossEnd - bgCrossStart)     - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
        };
      } else {
        bg.frame = {
          bgCrossStart   + p.sectionBackgroundInsetLeft,
          bgPrimaryStart + p.sectionBackgroundInsetTop,
          (bgCrossEnd - bgCrossStart)     - p.sectionBackgroundInsetLeft - p.sectionBackgroundInsetRight,
          (bgPrimaryEnd - bgPrimaryStart) - p.sectionBackgroundInsetTop  - p.sectionBackgroundInsetBottom,
        };
      }
      _cache->setAttributes(bg);
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  if (p.footerHeight > 0) {
    auto ftrAttrs = _cache->getAttributes(sPrefix + "footer");
    if (ftrAttrs) {
      auto updated = *ftrAttrs;
      if (H) { updated.frame = { primaryCursor, 0, p.footerHeight, crossExtent }; }
      else   { updated.frame = { 0, primaryCursor, crossExtent, p.footerHeight }; }
      _cache->setAttributes(updated);
    }
    primaryCursor += p.footerHeight;
  }

  // Re-position separators using the cached lineCount reconstruction.
  // (Separators were emitted in computeSection; reflow just re-positions them)
  // For simplicity, re-emit all separators by scanning for them.
  // This is correct because separator positions are fully determined by item positions.
  // Separators between line gaps:
  if (p.emitSeparators) {
    // Find all separator keys for this section and update their positions.
    // We walk the item frames to find where line breaks occurred.
    double prevLineEnd = itemsStart;
    int prevLineEndIdx = 0;
    for (int i = 1; i < p.itemCount; ++i) {
      // Detect line break: primary position changed from previous item.
      const bool isSameRow = H ? (std::abs(frames[i].primary - frames[i-1].primary) < 0.5)
                               : (std::abs(frames[i].primary - frames[i-1].primary) < 0.5);
      if (!isSameRow) {
        // frames[i-1] is last item in previous line; frames[i] is first item in next line.
        // Separator is in the gap between them.
        const double lineEnd   = frames[i-1].primary + frames[i-1].primarySize;
        const double lineStart2 = frames[i].primary;
        const double sepPos    = lineEnd + (lineStart2 - lineEnd) * 0.5 - p.separatorHeight * 0.5;

        const std::string sepKey = sPrefix + "sep-" + std::to_string(prevLineEndIdx + 1);
        auto sepCached = _cache->getAttributes(sepKey);
        if (sepCached) {
          auto sep = *sepCached;
          if (H) {
            const double sLeading  = crossInsetStart + p.separatorInsetLeading;
            const double sTrailing = crossExtent - crossInsetEnd - p.separatorInsetTrailing;
            sep.frame = { sepPos, sLeading, p.separatorHeight, sTrailing - sLeading };
          } else {
            const double sLeading  = crossInsetStart + p.separatorInsetLeading;
            const double sTrailing = crossExtent - crossInsetEnd - p.separatorInsetTrailing;
            sep.frame = { sLeading, sepPos, sTrailing - sLeading, p.separatorHeight };
          }
          _cache->setAttributes(sep);
        }
        prevLineEndIdx++;
        prevLineEnd = lineStart2;
      }
    }
  }

  return primaryCursor + p.sectionSpacing;
}

// ─── computeSections ─────────────────────────────────────────────────────────

void FlowLayout::computeSections(const std::vector<FlowLayoutParams>& sections) {
  _cache->clear();
  _horizontal = sections.empty() ? false : sections[0].horizontal;
  _sectionParams = sections;

  double primary = 0.0;
  for (int s = 0; s < (int)sections.size(); ++s) {
    primary = computeSection(sections[s], s, primary);
  }
}

// ─── invalidateSectionsFrom ───────────────────────────────────────────────────

void FlowLayout::invalidateSectionsFrom(int fromSection,
                                         const std::vector<FlowLayoutParams>& sections) {
  if (sections.empty()) return;
  _sectionParams = sections;
  _horizontal = sections[0].horizontal;

  // Find the startPrimary for fromSection by reading the header or first item of that section.
  double startPrimary = 0.0;
  if (fromSection > 0) {
    const std::string prevPrefix = "flow-" + std::to_string(fromSection - 1) + "-";
    const FlowLayoutParams& prevP = sections[fromSection - 1];
    if (prevP.footerHeight > 0) {
      auto f = _cache->getAttributes(prevPrefix + "footer");
      if (f) {
        startPrimary = _horizontal ? (f->frame.x + f->frame.width + prevP.sectionSpacing)
                                   : (f->frame.y + f->frame.height + prevP.sectionSpacing);
      }
    } else if (prevP.itemCount > 0) {
      const std::string key0 = prevP.keys.empty() ? prevPrefix + "0" : prevP.keys[prevP.itemCount - 1];
      auto last = _cache->getAttributes(key0);
      if (last) {
        startPrimary = _horizontal ? (last->frame.x + last->frame.width + prevP.sectionSpacing)
                                   : (last->frame.y + last->frame.height + prevP.sectionSpacing);
      }
    }
  }

  // Reflow from fromSection onward.
  double primary = startPrimary;
  for (int s = fromSection; s < (int)sections.size(); ++s) {
    if (s < fromSection) {
      primary = computeSectionFromCache(sections[s], s, primary);
    } else {
      primary = computeSection(sections[s], s, primary);
    }
  }
}

// ─── applyMeasurements ────────────────────────────────────────────────────────

bool FlowLayout::applyMeasurements(
    const std::vector<MeasurementDelta>& deltas,
    LayoutCache& cache) {
  if (deltas.empty()) return true;

  // Flow: any width or height change can cause items to wrap to different rows/columns.
  // Must always do a full reflow across all sections.
  // ContentDimension::Both → ShadowNode sends both width and height deltas.

  for (const auto& d : deltas) {
    auto attrs = cache.getAttributes(d.key);
    if (!attrs) continue;
    auto updated = *attrs;
    // Classify which dimension this delta is for:
    // Match against current frame — oldValue should be close to the estimated dimension.
    const bool matchesWidth  = std::abs(updated.frame.width  - d.oldValue) < 0.5;
    const bool matchesHeight = std::abs(updated.frame.height - d.oldValue) < 0.5;
    if (matchesWidth && !matchesHeight) {
      updated.frame.width  = d.newValue;
    } else if (matchesHeight && !matchesWidth) {
      updated.frame.height = d.newValue;
    } else {
      // Ambiguous — if horizontal, primary axis is X (width); otherwise Y (height).
      if (_horizontal) updated.frame.width  = d.newValue;
      else             updated.frame.height = d.newValue;
    }
    updated.sizingState = SizingState::Measured;
    cache.setAttributes(updated);
  }

  // Full reflow all sections using stored params.
  double primary = 0.0;
  for (int s = 0; s < (int)_sectionParams.size(); ++s) {
    primary = computeSectionFromCache(_sectionParams[s], s, primary);
  }

  return true;
}

// ─── paramsFromJSI ───────────────────────────────────────────────────────────

FlowLayoutParams FlowLayout::paramsFromJSI(Runtime& rt, const Object& obj) {
  FlowLayoutParams p;

  p.itemCount       = fi32(rt, obj, "itemCount",   0);
  p.itemSpacing     = fdbl(rt, obj, "itemSpacing",  0.0);
  p.lineSpacing     = fdbl(rt, obj, "lineSpacing",  0.0);
  p.viewportWidth   = fdbl(rt, obj, "viewportWidth",  390.0);
  p.viewportHeight  = fdbl(rt, obj, "viewportHeight", 0.0);
  p.sectionInsetTop    = fdbl(rt, obj, "sectionInsetTop",    0.0);
  p.sectionInsetBottom = fdbl(rt, obj, "sectionInsetBottom", 0.0);
  p.sectionInsetLeft   = fdbl(rt, obj, "sectionInsetLeft",   0.0);
  p.sectionInsetRight  = fdbl(rt, obj, "sectionInsetRight",  0.0);

  p.section               = fi32(rt,  obj, "section",               0);
  p.headerHeight          = fdbl(rt,  obj, "headerHeight",          0.0);
  p.footerHeight          = fdbl(rt,  obj, "footerHeight",          0.0);
  p.emitSectionBackground = fbln(rt,  obj, "emitSectionBackground", false);
  p.emitSeparators        = fbln(rt,  obj, "emitSeparators",        false);
  p.separatorHeight       = fdbl(rt,  obj, "separatorHeight",       0.5);
  p.separatorInsetLeading  = fdbl(rt, obj, "separatorInsetLeading",  0.0);
  p.separatorInsetTrailing = fdbl(rt, obj, "separatorInsetTrailing", 0.0);
  p.sectionSpacing        = fdbl(rt,  obj, "sectionSpacing",        0.0);

  p.sectionBackgroundInsetTop    = fdbl(rt, obj, "sectionBackgroundInsetTop",    0.0);
  p.sectionBackgroundInsetBottom = fdbl(rt, obj, "sectionBackgroundInsetBottom", 0.0);
  p.sectionBackgroundInsetLeft   = fdbl(rt, obj, "sectionBackgroundInsetLeft",   0.0);
  p.sectionBackgroundInsetRight  = fdbl(rt, obj, "sectionBackgroundInsetRight",  0.0);

  p.horizontal = fbln(rt, obj, "horizontal", false);

  // itemWidths: number[]
  auto wv = obj.getProperty(rt, "itemWidths");
  if (wv.isObject()) {
    auto arr = wv.asObject(rt).asArray(rt);
    const size_t len = arr.length(rt);
    p.itemWidths.resize(len);
    for (size_t i = 0; i < len; ++i) {
      p.itemWidths[i] = arr.getValueAtIndex(rt, i).getNumber();
    }
  }

  // itemHeights: number[]
  auto hv = obj.getProperty(rt, "itemHeights");
  if (hv.isObject()) {
    auto arr = hv.asObject(rt).asArray(rt);
    const size_t len = arr.length(rt);
    p.itemHeights.resize(len);
    for (size_t i = 0; i < len; ++i) {
      p.itemHeights[i] = arr.getValueAtIndex(rt, i).getNumber();
    }
  }

  // keys: string[]
  auto kv = obj.getProperty(rt, "keys");
  if (kv.isObject()) {
    auto arr = kv.asObject(rt).asArray(rt);
    const size_t len = arr.length(rt);
    p.keys.resize(len);
    for (size_t i = 0; i < len; ++i) {
      p.keys[i] = arr.getValueAtIndex(rt, i).asString(rt).utf8(rt);
    }
  }

  auto kp = obj.getProperty(rt, "keyPrefix");
  if (kp.isString()) p.keyPrefix = kp.asString(rt).utf8(rt);

  return p;
}

// ─── sectionsFromJSI ─────────────────────────────────────────────────────────

std::vector<FlowLayoutParams> FlowLayout::sectionsFromJSI(Runtime& rt, const Array& arr) {
  const size_t n = arr.length(rt);
  std::vector<FlowLayoutParams> result(n);
  for (size_t i = 0; i < n; ++i) {
    result[i] = paramsFromJSI(rt, arr.getValueAtIndex(rt, i).asObject(rt));
    result[i].section = static_cast<int>(i);
  }
  return result;
}

// ─── JSI bindings ────────────────────────────────────────────────────────────

void FlowLayout::installJSIBindings(Runtime& rt, Object& target) {
  // Legacy single-section binding.
  target.setProperty(rt, "computeFlowLayout",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeFlowLayout"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        auto params = paramsFromJSI(rt, args[0].getObject(rt));
        compute(params);

        auto all = _cache->getAll();
        Array positions(rt, all.size() * 4);
        for (size_t i = 0; i < all.size(); ++i) {
          positions.setValueAtIndex(rt, i * 4 + 0, Value(all[i].frame.x));
          positions.setValueAtIndex(rt, i * 4 + 1, Value(all[i].frame.y));
          positions.setValueAtIndex(rt, i * 4 + 2, Value(all[i].frame.width));
          positions.setValueAtIndex(rt, i * 4 + 3, Value(all[i].frame.height));
        }
        auto size = _cache->getTotalContentSize();
        Object result(rt);
        result.setProperty(rt, "positions", std::move(positions));
        result.setProperty(rt, "contentHeight", Value(size.height));
        return Value(rt, result);
      }));

  // Multi-section: computeSections(sections[]) → void
  target.setProperty(rt, "computeSections",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeSections"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        auto secs = sectionsFromJSI(rt, args[0].asObject(rt).asArray(rt));
        computeSections(secs);
        return Value::undefined();
      }));

  // Partial re-layout: invalidateSectionsFrom(fromSection, sections[]) → void
  target.setProperty(rt, "invalidateSectionsFrom",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "invalidateSectionsFrom"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2 || !args[1].isObject()) return Value::undefined();
        const int fromSection = args[0].isNumber() ? static_cast<int>(args[0].getNumber()) : 0;
        auto secs = sectionsFromJSI(rt, args[1].asObject(rt).asArray(rt));
        invalidateSectionsFrom(fromSection, secs);
        return Value::undefined();
      }));
}

} // namespace rncv
