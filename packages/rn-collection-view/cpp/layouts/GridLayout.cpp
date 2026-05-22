#include "GridLayout.h"
#include <algorithm>
#include <climits>
#include <limits>

namespace rncv {

using namespace facebook::jsi;


GridLayout::GridLayout(std::shared_ptr<LayoutCache> cache)
    : _cache(std::move(cache)) {}

// ─── JSI helpers ──────────────────────────────────────────────────────────────

static double gdbl(Runtime& rt, const Object& o, const char* k, double def = 0.0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? v.getNumber() : def;
}
static int gi32(Runtime& rt, const Object& o, const char* k, int def = 0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? static_cast<int>(v.getNumber()) : def;
}
static bool gbln(Runtime& rt, const Object& o, const char* k, bool def = false) {
  Value v = o.getProperty(rt, k);
  return v.isBool() ? v.getBool() : def;
}

// ─── compute (legacy single-section) ─────────────────────────────────────────

void GridLayout::compute(const GridLayoutParams& params) {
  _cache->clear();
  _columns        = params.columns > 0 ? params.columns : 1;
  _horizontal     = params.horizontal;
  _viewportHeight = params.viewportHeight;
  if (_horizontal) {
    const double est = params.estimatedCrossAxisHeight > 0 ? params.estimatedCrossAxisHeight : 100.0;
    // Preserve measured value across calls — only initialise from estimate on first use.
    // If already measured, applyMeasurements will correct it; resetting here would oscillate.
    if (_maxCrossAxisHeight <= 0) {
      _maxCrossAxisHeight = est;
    }
  }
  _sectionParams = { params };
  computeSection(params, 0, 0.0);
}

// ─── computeSection ───────────────────────────────────────────────────────────

double GridLayout::computeSection(const GridLayoutParams& p,
                                   int sectionIndex,
                                   double startPrimary) {
  const bool H    = p.horizontal;
  const int  cols = p.columns > 0 ? p.columns : 1;

  const std::string prefix = p.keyPrefix.empty()
      ? "grid-" + std::to_string(sectionIndex) + "-"
      : p.keyPrefix;

  double primary        = startPrimary;
  double bgStartPrimary = startPrimary;

  // ── Axis setup ────────────────────────────────────────────────────────────
  // V: primary=Y, cross=X. Items fill left-to-right per row, rows stack downward.
  //    cols items per row; itemCrossSize = column width derived from viewport.
  //    itemPrimarySize = rowHeight (fixed) or per-item height (dynamic; Yoga measures).
  //
  // H: primary=X, cross=Y. Items fill top-to-bottom per column-group, groups advance right.
  //    cols items per column-group; itemCrossSize = row height derived from viewport.
  //    itemPrimarySize = estimated width (Yoga measures actual widths; applyMeasurements corrects).
  //    itemHeights[] is unused for horizontal — cross-axis size is always derived from column count.
  const double crossStart        = H ? p.sectionInsetTop   : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft  : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;

  const double totalColSpacing = p.columnSpacing * (cols - 1);

  // Cross-axis sizing:
  //   H: itemCrossSize = global max Yoga-measured item height (estimates on first pass,
  //      grows as applyMeasurements receives height deltas). crossContent derived bottom-up.
  //   V: crossContent from viewportWidth; itemCrossSize = column width derived top-down.
  double crossContent, itemCrossSize;
  if (H) {
    itemCrossSize = _maxCrossAxisHeight > 0 ? _maxCrossAxisHeight
                 : (p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 100.0);
    crossContent  = itemCrossSize * cols + totalColSpacing;
  } else {
    const double rawCross = p.viewportWidth - p.sectionInsetLeft - p.sectionInsetRight;
    itemCrossSize = rawCross > 0 ? (rawCross - totalColSpacing) / cols : 0.0;
    crossContent  = rawCross;
  }

  // Primary-axis size per item.
  // V: rowHeight (fixed) or per-item height from p.itemHeights (dynamic).
  // H: rowHeight (fixed primary size) or estimatedCrossAxisHeight (placeholder; Yoga refines).
  const bool   fixedPrimary     = p.rowHeight > 0;
  const double estimatedPrimary = H
      ? (fixedPrimary ? p.rowHeight : p.estimatedCrossAxisHeight)
      : 0.0;  // unused for V (per-item heights used below)

  // ── Header ────────────────────────────────────────────────────────────────
  if (p.headerHeight > 0) {
    LayoutAttributes hdr;
    hdr.key               = prefix + "header";
    hdr.section           = sectionIndex;
    hdr.index             = -1;
    hdr.flatIndex         = p.headerFlatIndex;
    hdr.isSupplementary   = true;
    hdr.supplementaryKind = "header";
    hdr.sizingState       = SizingState::Measured;
    hdr.isDirty           = false;
    hdr.alpha             = 1.0;
    if (H) {
      const double hdrCrossH = p.sectionInsetTop + crossContent + p.sectionInsetBottom;
      hdr.frame = { primary, 0, p.headerHeight, hdrCrossH };
    } else {
      hdr.frame = { crossStart, primary, crossContent, p.headerHeight };
    }
    _cache->setAttributes(hdr);
    primary        += p.headerHeight;
    bgStartPrimary  = primary;
  }

  primary += primaryInsetStart;

  // ── Items in grid ─────────────────────────────────────────────────────────
  struct CellFrame { double x, y, width, height; };
  std::vector<CellFrame> frames(p.itemCount);

  int    col              = 0;
  double rowStartPrimary  = primary;   // primary-axis start of current row/column-group
  double rowMaxPrimary    = 0.0;       // max primary-axis size in current row/column-group
  int    rowStart         = 0;

  for (int i = 0; i < p.itemCount; ++i) {
    double itemPrimary;
    if (H) {
      itemPrimary = estimatedPrimary > 0 ? estimatedPrimary : 200.0;
    } else {
      itemPrimary = fixedPrimary
          ? p.rowHeight
          : (i < static_cast<int>(p.itemHeights.size()) ? p.itemHeights[i] : 44.0);
    }

    const double crossPos = crossStart + col * (itemCrossSize + p.columnSpacing);
    if (H) {
      frames[i] = { rowStartPrimary, crossPos, itemPrimary, itemCrossSize };
    } else {
      frames[i] = { crossPos, rowStartPrimary, itemCrossSize, itemPrimary };
    }

    if (itemPrimary > rowMaxPrimary) rowMaxPrimary = itemPrimary;
    col++;

    if (col >= cols) {
      // V: normalize all items in this row to rowMaxPrimary (= row height)
      // H: no normalization needed — estimated widths are all the same; Yoga refines later
      if (!H && !fixedPrimary) {
        for (int j = rowStart; j <= i; ++j) frames[j].height = rowMaxPrimary;
      }

      // Between-group (row/column-group) separator
      if (p.emitSeparators && i < p.itemCount - 1) {
        LayoutAttributes sep;
        sep.key            = "separator-" + std::to_string(sectionIndex) + "-row-" +
                             std::to_string(rowStart / cols);
        sep.section        = sectionIndex;
        sep.index          = -1;
        sep.isDecoration   = true;
        sep.decorationKind = "separator";
        sep.zIndex         = 0;
        sep.sizingState    = SizingState::Measured;
        sep.isDirty        = false;
        sep.alpha          = 1.0;
        if (H) {
          // Vertical separator line between column-groups
          sep.frame = {
            rowStartPrimary + rowMaxPrimary,
            crossStart + p.separatorInsetLeading,
            p.separatorHeight,
            crossContent - p.separatorInsetLeading - p.separatorInsetTrailing
          };
        } else {
          // Horizontal separator line between rows
          sep.frame = {
            crossStart + p.separatorInsetLeading,
            rowStartPrimary + rowMaxPrimary,
            crossContent - p.separatorInsetLeading - p.separatorInsetTrailing,
            p.separatorHeight
          };
        }
        _cache->setAttributes(sep);
      }

      // Within-group separators (between columns in V, between rows in H)
      if (p.emitSeparators && cols > 1) {
        const int groupIdx = rowStart / cols;
        for (int c = 0; c < cols - 1; ++c) {
          LayoutAttributes colSep;
          colSep.key            = "separator-" + std::to_string(sectionIndex) + "-col-" +
                                  std::to_string(groupIdx) + "-" + std::to_string(c);
          colSep.section        = sectionIndex;
          colSep.index          = -1;
          colSep.isDecoration   = true;
          colSep.decorationKind = "separator";
          colSep.zIndex         = 0;
          colSep.sizingState    = SizingState::Measured;
          colSep.isDirty        = false;
          colSep.alpha          = 1.0;
          const double gap = crossStart +
                             (c + 1) * itemCrossSize + c * p.columnSpacing +
                             (p.columnSpacing - p.separatorHeight) / 2.0;
          if (H) {
            // Horizontal line between rows within a column-group
            colSep.frame = { rowStartPrimary, gap, rowMaxPrimary, p.separatorHeight };
          } else {
            // Vertical line between columns within a row
            colSep.frame = { gap, rowStartPrimary, p.separatorHeight, rowMaxPrimary };
          }
          _cache->setAttributes(colSep);
        }
      }

      rowStartPrimary += rowMaxPrimary + p.rowSpacing;
      col              = 0;
      rowMaxPrimary    = 0.0;
      rowStart         = i + 1;
    }
  }

  // Last partial row/column-group
  if (col > 0 && p.itemCount > 0) {
    if (!H && !fixedPrimary) {
      for (int j = rowStart; j < p.itemCount; ++j) frames[j].height = rowMaxPrimary;
    }
    if (p.emitSeparators && col > 1) {
      const int groupIdx = rowStart / cols;
      for (int c = 0; c < col - 1; ++c) {
        LayoutAttributes colSep;
        colSep.key            = "separator-" + std::to_string(sectionIndex) + "-col-" +
                                std::to_string(groupIdx) + "-" + std::to_string(c);
        colSep.section        = sectionIndex;
        colSep.index          = -1;
        colSep.isDecoration   = true;
        colSep.decorationKind = "separator";
        colSep.zIndex         = 0;
        colSep.sizingState    = SizingState::Measured;
        colSep.isDirty        = false;
        colSep.alpha          = 1.0;
        const double gap = crossStart +
                           (c + 1) * itemCrossSize + c * p.columnSpacing +
                           (p.columnSpacing - p.separatorHeight) / 2.0;
        if (H) {
          colSep.frame = { rowStartPrimary, gap, rowMaxPrimary, p.separatorHeight };
        } else {
          colSep.frame = { gap, rowStartPrimary, p.separatorHeight, rowMaxPrimary };
        }
        _cache->setAttributes(colSep);
      }
    }
    rowStartPrimary += rowMaxPrimary;
  }

  // Write items to cache
  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = (i < static_cast<int>(p.keys.size()))
        ? p.keys[i]
        : prefix + std::to_string(i);
    LayoutAttributes attrs;
    attrs.key         = key;
    attrs.section     = sectionIndex;
    attrs.index       = i;
    attrs.flatIndex   = p.flatIndexBase + i;
    attrs.zIndex      = 0;
    attrs.alpha       = 1.0;
    attrs.frame       = { frames[i].x, frames[i].y, frames[i].width, frames[i].height };
    attrs.sizingState = (H || !fixedPrimary) ? SizingState::Placeholder : SizingState::Measured;
    _cache->setAttributes(attrs);
  }

  primary = rowStartPrimary;
  primary += primaryInsetEnd;

  // ── Section background ────────────────────────────────────────────────────
  // Content insets applied in absolute visual coords.
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
    LayoutAttributes ftr;
    ftr.key               = prefix + "footer";
    ftr.section           = sectionIndex;
    ftr.index             = -1;
    ftr.flatIndex         = p.footerFlatIndex;
    ftr.isSupplementary   = true;
    ftr.supplementaryKind = "footer";
    ftr.sizingState       = SizingState::Measured;
    ftr.isDirty           = false;
    ftr.alpha             = 1.0;
    if (H) {
      const double ftrCrossH = p.sectionInsetTop + crossContent + p.sectionInsetBottom;
      ftr.frame = { primary, 0, p.footerHeight, ftrCrossH };
    } else {
      ftr.frame = { crossStart, primary, crossContent, p.footerHeight };
    }
    _cache->setAttributes(ftr);
    primary += p.footerHeight;
  }

  primary += p.sectionSpacing;
  return primary;
}

// ─── computeSectionFromCache ──────────────────────────────────────────────────
// Like computeSection but reads item heights from the cache instead of params.
// Used by applyMeasurements and invalidateSectionsFrom to preserve Yoga measurements.

double GridLayout::computeSectionFromCache(const GridLayoutParams& p,
                                            int sectionIndex,
                                            double startPrimary) {
  const bool H    = p.horizontal;
  const int  cols = p.columns > 0 ? p.columns : 1;

  const std::string prefix = p.keyPrefix.empty()
      ? "grid-" + std::to_string(sectionIndex) + "-"
      : p.keyPrefix;

  double primary        = startPrimary;
  double bgStartPrimary = startPrimary;

  // Axis setup — mirrors computeSection.
  const double crossStart        = H ? p.sectionInsetTop   : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft  : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;

  const double totalColSpacing = p.columnSpacing * (cols - 1);

  double crossContent, itemCrossSize;
  if (H) {
    itemCrossSize = _maxCrossAxisHeight > 0 ? _maxCrossAxisHeight
                 : (p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 100.0);
    crossContent  = itemCrossSize * cols + totalColSpacing;
  } else {
    const double rawCross = p.viewportWidth - p.sectionInsetLeft - p.sectionInsetRight;
    itemCrossSize = rawCross > 0 ? (rawCross - totalColSpacing) / cols : 0.0;
    crossContent  = rawCross;
  }

  const bool   fixedPrimary     = p.rowHeight > 0;
  const double estimatedPrimary = H
      ? (fixedPrimary ? p.rowHeight : p.estimatedCrossAxisHeight)
      : 0.0;

  // ── Header ────────────────────────────────────────────────────────────────
  if (p.headerHeight > 0) {
    const std::string hdrKey = prefix + "header";
    auto existingHdr = _cache->getAttributes(hdrKey);
    LayoutAttributes hdr;
    hdr.key               = hdrKey;
    hdr.section           = sectionIndex;
    hdr.index             = -1;
    hdr.flatIndex         = p.headerFlatIndex;
    hdr.isSupplementary   = true;
    hdr.supplementaryKind = "header";
    hdr.sizingState       = SizingState::Measured;
    hdr.isDirty           = false;
    hdr.alpha             = 1.0;
    if (H) {
      const double hW = (existingHdr && existingHdr->frame.width > 0)
          ? existingHdr->frame.width
          : p.headerHeight;
      const double hdrCrossH = p.sectionInsetTop + crossContent + p.sectionInsetBottom;
      hdr.frame = { primary, 0, hW, hdrCrossH };
      primary       += hW;
    } else {
      // Preserve measured header height (Yoga may have refined it).
      const double hH = (existingHdr && existingHdr->frame.height > 0)
          ? existingHdr->frame.height
          : p.headerHeight;
      hdr.frame = { crossStart, primary, crossContent, hH };
      primary       += hH;
    }
    _cache->setAttributes(hdr);
    bgStartPrimary = primary;
  }

  primary += primaryInsetStart;

  // ── Read axis sizes from cache ────────────────────────────────────────────
  // V: reads frame.height (Yoga-measured item heights).
  // H: reads frame.width (Yoga-measured primary widths) AND frame.height (Yoga-measured
  //    natural cross heights; items may be shorter than maxCrossH).
  std::vector<double> primarySizes(p.itemCount);
  std::vector<double> crossSizes(p.itemCount); // H only: Yoga-measured natural heights
  std::vector<bool> usedStashedMeasuredSize(p.itemCount, false);
  // H only: true when crossSizes[i] came from an actual measurement (Measured or
  // stash), false when it fell back to the itemCrossSize estimate.
  std::vector<bool> hasMeasuredCross(p.itemCount, false);
  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = (i < static_cast<int>(p.keys.size()))
        ? p.keys[i]
        : prefix + std::to_string(i);
    auto existing = _cache->getAttributes(key);
    auto stashed = _cache->getStashedMeasuredSize(key);
    if (H) {
      primarySizes[i] = (existing && existing->frame.width > 0)
          ? existing->frame.width
          : (stashed && stashed->width > 0)
              ? stashed->width
          : (estimatedPrimary > 0 ? estimatedPrimary : 200.0);
      if (existing && existing->frame.height > 0 && existing->sizingState == SizingState::Measured) {
        crossSizes[i] = existing->frame.height;
        hasMeasuredCross[i] = true;
      } else if (stashed && stashed->height > 0) {
        crossSizes[i] = stashed->height;
        hasMeasuredCross[i] = true;
      } else {
        crossSizes[i] = itemCrossSize; // temporary; overwritten below if measured data found
      }
      usedStashedMeasuredSize[i] = !existing && stashed.has_value();
    } else {
      primarySizes[i] = (existing && existing->frame.height > 0)
          ? existing->frame.height
          : (fixedPrimary ? p.rowHeight : 44.0);
    }
  }

  // For H-grid: derive row spacing from the max of ACTUALLY-MEASURED cross heights
  // only.  Placeholder items default to itemCrossSize (the estimate), so including
  // them in the max would keep row spacing at the estimate even after Yoga measures
  // real heights — causing inflated row Y positions and a wrapper height that never
  // converges (the same B0.1 inflation seen in List H).
  if (H && p.itemCount > 0) {
    double measuredMaxCross = 0;
    for (int i = 0; i < p.itemCount; ++i) {
      if (hasMeasuredCross[i] && crossSizes[i] > measuredMaxCross)
        measuredMaxCross = crossSizes[i];
    }
    if (measuredMaxCross > 0) {
      // Use measured height for row spacing, even if it's smaller than the estimate.
      itemCrossSize = measuredMaxCross;
      crossContent  = itemCrossSize * cols + totalColSpacing;
      // Propagate to Placeholder items so their frame heights are consistent
      // with the spacing used for row Y positions.
      for (int i = 0; i < p.itemCount; ++i) {
        if (!hasMeasuredCross[i]) crossSizes[i] = itemCrossSize;
      }
    }
    // If no measured data yet, itemCrossSize stays at the estimate (initial layout).
  }

  // ── Layout items using cached sizes ──────────────────────────────────────
  struct CellFrame { double x, y, width, height; };
  std::vector<CellFrame> frames(p.itemCount);

  int    col             = 0;
  double rowStartPrimary = primary;
  double rowMaxPrimary   = 0.0;
  int    rowStart        = 0;

  for (int i = 0; i < p.itemCount; ++i) {
    const double sz = primarySizes[i];
    const double crossPos = crossStart + col * (itemCrossSize + p.columnSpacing);
    if (H) {
      // Preserve Yoga-measured natural height. Items may be shorter than maxCrossH;
      // column Y positions are spaced by maxCrossH so items don't overlap.
      frames[i] = { rowStartPrimary, crossPos, sz, crossSizes[i] };
    } else {
      frames[i] = { crossPos, rowStartPrimary, itemCrossSize, sz };
    }
    if (sz > rowMaxPrimary) rowMaxPrimary = sz;
    col++;

    if (col >= cols) {
      // V: normalize to rowMaxPrimary.
      // H: no normalization (widths per item may differ; each has its own measured value).
      if (!H) {
        for (int j = rowStart; j <= i; ++j) frames[j].height = rowMaxPrimary;
      }

      if (p.emitSeparators && i < p.itemCount - 1) {
        LayoutAttributes sep;
        sep.key            = "separator-" + std::to_string(sectionIndex) + "-row-" +
                             std::to_string(rowStart / cols);
        sep.section        = sectionIndex;
        sep.index          = -1;
        sep.isDecoration   = true;
        sep.decorationKind = "separator";
        sep.zIndex         = 0;
        sep.sizingState    = SizingState::Measured;
        sep.isDirty        = false;
        sep.alpha          = 1.0;
        if (H) {
          sep.frame = {
            rowStartPrimary + rowMaxPrimary,
            crossStart + p.separatorInsetLeading,
            p.separatorHeight,
            crossContent - p.separatorInsetLeading - p.separatorInsetTrailing
          };
        } else {
          sep.frame = {
            crossStart + p.separatorInsetLeading,
            rowStartPrimary + rowMaxPrimary,
            crossContent - p.separatorInsetLeading - p.separatorInsetTrailing,
            p.separatorHeight
          };
        }
        _cache->setAttributes(sep);
      }

      if (p.emitSeparators && cols > 1) {
        const int groupIdx = rowStart / cols;
        for (int c = 0; c < cols - 1; ++c) {
          LayoutAttributes colSep;
          colSep.key            = "separator-" + std::to_string(sectionIndex) + "-col-" +
                                  std::to_string(groupIdx) + "-" + std::to_string(c);
          colSep.section        = sectionIndex;
          colSep.index          = -1;
          colSep.isDecoration   = true;
          colSep.decorationKind = "separator";
          colSep.zIndex         = 0;
          colSep.sizingState    = SizingState::Measured;
          colSep.isDirty        = false;
          colSep.alpha          = 1.0;
          const double gap = crossStart +
                             (c + 1) * itemCrossSize + c * p.columnSpacing +
                             (p.columnSpacing - p.separatorHeight) / 2.0;
          if (H) {
            colSep.frame = { rowStartPrimary, gap, rowMaxPrimary, p.separatorHeight };
          } else {
            colSep.frame = { gap, rowStartPrimary, p.separatorHeight, rowMaxPrimary };
          }
          _cache->setAttributes(colSep);
        }
      }

      rowStartPrimary += rowMaxPrimary + p.rowSpacing;
      col              = 0;
      rowMaxPrimary    = 0.0;
      rowStart         = i + 1;
    }
  }

  if (col > 0 && p.itemCount > 0) {
    if (!H) {
      for (int j = rowStart; j < p.itemCount; ++j) frames[j].height = rowMaxPrimary;
    }
    if (p.emitSeparators && col > 1) {
      const int groupIdx = rowStart / cols;
      for (int c = 0; c < col - 1; ++c) {
        LayoutAttributes colSep;
        colSep.key            = "separator-" + std::to_string(sectionIndex) + "-col-" +
                                std::to_string(groupIdx) + "-" + std::to_string(c);
        colSep.section        = sectionIndex;
        colSep.index          = -1;
        colSep.isDecoration   = true;
        colSep.decorationKind = "separator";
        colSep.zIndex         = 0;
        colSep.sizingState    = SizingState::Measured;
        colSep.isDirty        = false;
        colSep.alpha          = 1.0;
        const double gap = crossStart +
                           (c + 1) * itemCrossSize + c * p.columnSpacing +
                           (p.columnSpacing - p.separatorHeight) / 2.0;
        if (H) {
          colSep.frame = { rowStartPrimary, gap, rowMaxPrimary, p.separatorHeight };
        } else {
          colSep.frame = { gap, rowStartPrimary, p.separatorHeight, rowMaxPrimary };
        }
        _cache->setAttributes(colSep);
      }
    }
    rowStartPrimary += rowMaxPrimary;
  }

  // Write updated positions to cache
  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = (i < static_cast<int>(p.keys.size()))
        ? p.keys[i]
        : prefix + std::to_string(i);
    auto existing = _cache->getAttributes(key);
    LayoutAttributes attrs;
    attrs.key         = key;
    attrs.section     = sectionIndex;
    attrs.index       = i;
    attrs.flatIndex   = p.flatIndexBase + i;
    attrs.zIndex      = 0;
    attrs.alpha       = 1.0;
    attrs.frame       = { frames[i].x, frames[i].y, frames[i].width, frames[i].height };
    attrs.sizingState = existing
        ? existing->sizingState
        : (H && usedStashedMeasuredSize[i] ? SizingState::Measured : SizingState::Placeholder);
    _cache->setAttributes(attrs);
  }

  primary = rowStartPrimary;
  primary += primaryInsetEnd;

  // ── Section background ────────────────────────────────────────────────────
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
    const std::string ftrKey = prefix + "footer";
    auto existingFtr = _cache->getAttributes(ftrKey);
    LayoutAttributes ftr;
    ftr.key               = ftrKey;
    ftr.section           = sectionIndex;
    ftr.index             = -1;
    ftr.flatIndex         = p.footerFlatIndex;
    ftr.isSupplementary   = true;
    ftr.supplementaryKind = "footer";
    ftr.sizingState       = SizingState::Measured;
    ftr.isDirty           = false;
    ftr.alpha             = 1.0;
    if (H) {
      const double fW = (existingFtr && existingFtr->frame.width > 0)
          ? existingFtr->frame.width
          : p.footerHeight;
      const double ftrCrossH = p.sectionInsetTop + crossContent + p.sectionInsetBottom;
      ftr.frame = { primary, 0, fW, ftrCrossH };
      primary += fW;
    } else {
      const double fH = (existingFtr && existingFtr->frame.height > 0)
          ? existingFtr->frame.height
          : p.footerHeight;
      ftr.frame = { crossStart, primary, crossContent, fH };
      primary += fH;
    }
    _cache->setAttributes(ftr);
  }

  primary += p.sectionSpacing;
  return primary;
}

// ─── computeSections ──────────────────────────────────────────────────────────

void GridLayout::computeSections(const std::vector<GridLayoutParams>& sections) {
  if (sections.empty()) return;

  _horizontal     = sections[0].horizontal;
  _viewportHeight = sections[0].viewportHeight;
  _columns        = sections[0].columns > 0 ? sections[0].columns : 2;
  if (_horizontal) {
    const double est = sections[0].estimatedCrossAxisHeight > 0 ? sections[0].estimatedCrossAxisHeight : 100.0;
    double stashedMaxCrossH = 0.0;
    int stashedMeasuredCount = 0;
    for (int s = 0; s < static_cast<int>(sections.size()); ++s) {
      const auto& sec = sections[s];
      const std::string prefix = sec.keyPrefix.empty()
          ? "grid-" + std::to_string(s) + "-"
          : sec.keyPrefix;
      for (int i = 0; i < sec.itemCount; ++i) {
        const std::string key = (i < static_cast<int>(sec.keys.size()))
            ? sec.keys[i]
            : prefix + std::to_string(i);
        auto stashed = _cache->getStashedMeasuredSize(key);
        if (stashed && stashed->height > 0) {
          stashedMaxCrossH = std::max(stashedMaxCrossH, stashed->height);
          stashedMeasuredCount++;
        }
      }
    }
    if (stashedMaxCrossH > 0) {
      _maxCrossAxisHeight = stashedMaxCrossH;
    } else if (_maxCrossAxisHeight <= 0) {
      _maxCrossAxisHeight = est;
    }
  }
  _sectionParams = sections;

  double primary = 0.0;
  for (int s = 0; s < static_cast<int>(sections.size()); ++s) {
    primary = _horizontal
        ? computeSectionFromCache(sections[s], s, primary)
        : computeSection(sections[s], s, primary);
  }
}

// ─── invalidateSectionsFrom ───────────────────────────────────────────────────

void GridLayout::invalidateSectionsFrom(int fromSection,
                                         const std::vector<GridLayoutParams>& sections) {
  if (fromSection < 0 || fromSection >= static_cast<int>(sections.size())) return;

  _sectionParams = sections;

  const auto& p0 = sections[fromSection];
  const std::string prefix0 = p0.keyPrefix.empty()
      ? "grid-" + std::to_string(fromSection) + "-"
      : p0.keyPrefix;

  // Determine where this section starts (its leading edge in primary axis).
  // V: primary=Y. H: primary=X.
  const bool H0 = p0.horizontal;
  double startPrimary = 0.0;
  if (p0.headerHeight > 0) {
    auto header = _cache->getAttributes(prefix0 + "header");
    if (header) startPrimary = H0 ? header->frame.x : header->frame.y;
  } else if (p0.itemCount > 0) {
    const std::string firstKey = p0.keys.empty()
        ? prefix0 + "0"
        : p0.keys[0];
    auto firstItem = _cache->getAttributes(firstKey);
    if (firstItem) {
      startPrimary = H0
          ? firstItem->frame.x - p0.sectionInsetLeft
          : firstItem->frame.y - p0.sectionInsetTop;
    }
  }

  double primary = computeSectionFromCache(p0, fromSection, startPrimary);
  for (int s = fromSection + 1; s < static_cast<int>(sections.size()); ++s) {
    primary = computeSection(sections[s], s, primary);
  }
}

// ─── applyMeasurements (LayoutEngine protocol) ──────────────────────────────

bool GridLayout::applyMeasurements(
    const std::vector<MeasurementDelta>& deltas,
    LayoutCache& cache) {
  if (deltas.empty()) return true;

  const bool H = _horizontal;

  // ── Horizontal grid path ──────────────────────────────────────────────────
  //
  // contentDeterminedDimension() = Both → ShadowNode sends width AND height deltas.
  //
  // A linear "cascade" does NOT work for H-grid: items in the same column-group
  // share the same starting X, so processing them one-by-one with an accumulating
  // shift gives different X values to rows within the same group.
  //
  // Correct approach — measure then reflow:
  //   Phase 1: Write Yoga-measured widths and heights into the cache.
  //            For H-grid, trust the explicit measurement axis from ShadowNode.
  //            Fallback matching remains only as a defensive path for older callers.
  //   Phase 2: Update _maxCrossAxisHeight from all items (always — both width and height
  //            deltas may arrive together).
  //   Phase 3: Full reflow via computeSectionFromCache for every section.
  //            computeSectionFromCache groups items into column-groups, tracks rowMaxPrimary
  //            (= max width in group), gives ALL items in a group the same X, and advances
  //            by rowMaxPrimary + rowSpacing — which is the correct column-group cascade.
  if (H) {
    // Phase 1: Write measured dimensions into cache.
    for (const auto& d : deltas) {
      auto existing = cache.getAttributes(d.key);
      if (!existing) continue;
      if (existing->isDecoration && existing->decorationKind == "sectionBackground") continue;

      auto updated = *existing;
      const bool matchesH = std::abs(existing->frame.height - d.oldValue) < 1.0;
      const bool matchesW = std::abs(existing->frame.width  - d.oldValue) < 1.0;
      bool changed = false;

      if (d.axis == MeasurementAxis::Height) {
        if (std::abs(d.newValue - updated.frame.height) > 0.01) {
          updated.frame.height = d.newValue;
          changed = true;
        }
      } else if (d.axis == MeasurementAxis::Width) {
        if (std::abs(d.newValue - updated.frame.width) > 0.01) {
          updated.frame.width = d.newValue;
          changed = true;
        }
      } else if (matchesH && !matchesW) {
        if (std::abs(d.newValue - updated.frame.height) > 0.01) {
          updated.frame.height = d.newValue;
          changed = true;
        }
      } else if (matchesW && !matchesH) {
        if (std::abs(d.newValue - updated.frame.width) > 0.01) {
          updated.frame.width = d.newValue;
          changed = true;
        }
      }


      if (changed) {
        if (updated.sizingState != SizingState::Measured) {
          updated.sizingState = SizingState::Measured;
        }
        cache.setAttributes(updated);
      }
    }

    // Phase 2: Update global max cross height from all item frames in cache.
    {
      double globalMaxH = 0.0;
      auto allNow = cache.getAll();
      for (const auto& attr : allNow) {
        if (!attr.isDecoration && !attr.isSupplementary && attr.frame.height > 0 && attr.sizingState == SizingState::Measured) {
          globalMaxH = std::max(globalMaxH, attr.frame.height);
        }
      }
      if (globalMaxH > 0) {
        // Recompute from current measured items so horizontal grid can shrink after
        // delete/resize-down. Masonry uses the same "measured max then full reflow"
        // model without needing a sticky historical max.
        _maxCrossAxisHeight = globalMaxH;
      }
    }

    // Phase 3: Full reflow — computeSectionFromCache handles column-group X alignment.
    if (!_sectionParams.empty()) {
      double primary = 0.0;
      for (int s = 0; s < static_cast<int>(_sectionParams.size()); ++s) {
        primary = computeSectionFromCache(_sectionParams[s], s, primary);
      }
    }

    return true;
  }

  // ── Fixed H-grid / Vertical grid path ────────────────────────────────────
  //
  // Section backgrounds are layout-determined (height = primary - bgStartPrimary).
  // Writing Yoga's measurement to a section background would corrupt its height
  // because the ShadowNode sees items+separators as siblings; its Yoga tree does
  // not know which height belongs to the "background of section N". Instead:
  //   - Don't write Yoga height to sectionBackground decorations.
  //   - Trigger firstChangedSection so computeSectionFromCache restores the
  //     correct height from the item positions.
  //
  // Separators: height is also layout-determined but stable (0.5 or rowMaxH).
  // Writing Yoga's measurement is fine for separators; they are small enough that
  // any rounding error won't cause visible corruption. We still skip them for
  // firstChangedSection because a separator delta alone doesn't shift item positions.
  // For horizontal grid: Yoga measures item WIDTHS (primary axis) → write to frame.width.
  // For vertical grid: Yoga measures item HEIGHTS → write to frame.height (existing behavior).

  int firstChangedSection = INT_MAX;
  for (const auto& d : deltas) {
    auto attrs = cache.getAttributes(d.key);
    if (attrs) {
      const bool isSectionBg = attrs->isDecoration &&
                               attrs->decorationKind == "sectionBackground";
      if (!isSectionBg) {
        auto updated = *attrs;
        if (H) {
          updated.frame.width = d.newValue;  // primary axis for horizontal
        } else {
          updated.frame.height = d.newValue; // primary axis for vertical
        }
        updated.sizingState  = SizingState::Measured;
        cache.setAttributes(updated);
      }
      if (!attrs->isDecoration && !attrs->isSupplementary) {
        firstChangedSection = std::min(firstChangedSection, attrs->section);
      } else if (isSectionBg) {
        firstChangedSection = std::min(firstChangedSection, attrs->section);
      }
    }
  }

  if (firstChangedSection == INT_MAX) return true;

  if (_sectionParams.empty()) {
    // Legacy single-section path: re-layout from scratch using updated heights.
    // Reconstruct a single-section params with heights from cache.
    // We can't reflow perfectly without knowing rowSpacing; use computeSectionFromCache
    // with whatever _sectionParams[0] we have (set in compute()).
    return true; // heights already applied; positions approximate until next prepare()
  }

  if (firstChangedSection >= static_cast<int>(_sectionParams.size())) return true;

  const auto& p0     = _sectionParams[firstChangedSection];
  const std::string prefix0 = p0.keyPrefix.empty()
      ? "grid-" + std::to_string(firstChangedSection) + "-"
      : p0.keyPrefix;

  // Determine where the changed section starts. V: primary=Y. H: primary=X.
  double startPrimary = 0.0;
  if (p0.headerHeight > 0) {
    auto header = _cache->getAttributes(prefix0 + "header");
    if (header) startPrimary = H ? header->frame.x : header->frame.y;
  } else if (p0.itemCount > 0) {
    const std::string firstKey = p0.keys.empty() ? prefix0 + "0" : p0.keys[0];
    auto firstItem = _cache->getAttributes(firstKey);
    if (firstItem) {
      startPrimary = H
          ? firstItem->frame.x - p0.sectionInsetLeft
          : firstItem->frame.y - p0.sectionInsetTop;
    }
  }

  // Reflow from the changed section, then full-recompute all subsequent sections
  double primary = computeSectionFromCache(p0, firstChangedSection, startPrimary);
  for (int s = firstChangedSection + 1; s < static_cast<int>(_sectionParams.size()); ++s) {
    primary = computeSection(_sectionParams[s], s, primary);
  }

  return true;
}

// ─── JSI parameter extraction ──────────────────────────────────────────────────

GridLayoutParams GridLayout::paramsFromJSI(Runtime& rt, const Object& obj) {
  GridLayoutParams p;

  p.itemCount       = gi32(rt, obj, "itemCount", 0);
  p.columns         = gi32(rt, obj, "columns", 2);
  p.columnSpacing   = gdbl(rt, obj, "columnSpacing", 0.0);
  p.rowSpacing      = gdbl(rt, obj, "rowSpacing", 0.0);
  p.viewportWidth   = gdbl(rt, obj, "viewportWidth", 390.0);
  p.viewportHeight  = gdbl(rt, obj, "viewportHeight", 0.0);
  p.sectionInsetTop    = gdbl(rt, obj, "sectionInsetTop", 0);
  p.sectionInsetBottom = gdbl(rt, obj, "sectionInsetBottom", 0);
  p.sectionInsetLeft   = gdbl(rt, obj, "sectionInsetLeft", 0);
  p.sectionInsetRight  = gdbl(rt, obj, "sectionInsetRight", 0);
  p.rowHeight       = gdbl(rt, obj, "rowHeight", 0.0);

  p.headerHeight          = gdbl(rt, obj, "headerHeight", 0.0);
  p.footerHeight          = gdbl(rt, obj, "footerHeight", 0.0);
  p.emitSectionBackground = gbln(rt, obj, "emitSectionBackground", false);
  p.emitSeparators        = gbln(rt, obj, "emitSeparators", false);
  p.separatorHeight       = gdbl(rt, obj, "separatorHeight", 0.5);
  p.separatorInsetLeading  = gdbl(rt, obj, "separatorInsetLeading", 0.0);
  p.separatorInsetTrailing = gdbl(rt, obj, "separatorInsetTrailing", 0.0);
  p.sectionSpacing        = gdbl(rt, obj, "sectionSpacing", 0.0);

  p.horizontal               = gbln(rt, obj, "horizontal", false);
  p.estimatedCrossAxisHeight = gdbl(rt, obj, "estimatedCrossAxisHeight", 200.0);

  p.sectionBackgroundInsetTop    = gdbl(rt, obj, "sectionBackgroundInsetTop",    0.0);
  p.sectionBackgroundInsetBottom = gdbl(rt, obj, "sectionBackgroundInsetBottom", 0.0);
  p.sectionBackgroundInsetLeft   = gdbl(rt, obj, "sectionBackgroundInsetLeft",   0.0);
  p.sectionBackgroundInsetRight  = gdbl(rt, obj, "sectionBackgroundInsetRight",  0.0);

  // Flat index mapping for processScroll binary search
  p.flatIndexBase   = gi32(rt, obj, "flatIndexBase", 0);
  p.headerFlatIndex = gi32(rt, obj, "headerFlatIndex", -1);
  p.footerFlatIndex = gi32(rt, obj, "footerFlatIndex", -1);

  // itemHeights: number[]
  auto hv = obj.getProperty(rt, "itemHeights");
  if (hv.isObject()) {
    auto arr = hv.asObject(rt).asArray(rt);
    size_t len = arr.length(rt);
    p.itemHeights.resize(len);
    for (size_t i = 0; i < len; ++i) {
      p.itemHeights[i] = arr.getValueAtIndex(rt, i).getNumber();
    }
  }

  // keys: string[]
  auto kv = obj.getProperty(rt, "keys");
  if (kv.isObject()) {
    auto arr = kv.asObject(rt).asArray(rt);
    size_t len = arr.length(rt);
    p.keys.resize(len);
    for (size_t i = 0; i < len; ++i) {
      p.keys[i] = arr.getValueAtIndex(rt, i).asString(rt).utf8(rt);
    }
  }

  auto kp = obj.getProperty(rt, "keyPrefix");
  if (kp.isString()) p.keyPrefix = kp.asString(rt).utf8(rt);

  return p;
}

std::vector<GridLayoutParams> GridLayout::sectionsFromJSI(Runtime& rt, const Array& arr) {
  size_t len = arr.size(rt);
  std::vector<GridLayoutParams> sections;
  sections.reserve(len);
  for (size_t i = 0; i < len; ++i) {
    Value v = arr.getValueAtIndex(rt, i);
    if (!v.isObject()) continue;
    GridLayoutParams p = paramsFromJSI(rt, v.getObject(rt));
    p.section = static_cast<int>(i); // section index = position in array
    sections.push_back(std::move(p));
  }
  return sections;
}

// ─── JSI bindings ──────────────────────────────────────────────────────────────

void GridLayout::installJSIBindings(Runtime& rt, Object& target) {
  // ── Legacy single-section method (kept for compatibility) ──────────────────
  // computeGridLayout(params) → { positions: number[], contentHeight: number }
  target.setProperty(rt, "computeGridLayout",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeGridLayout"), 1,
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

  // ── Standard contract: computeSections(sections: object[]) → undefined ─────
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

  // ── Standard contract: invalidateSectionsFrom(fromSection, sections[]) ─────
  target.setProperty(rt, "invalidateSectionsFrom",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "invalidateSectionsFrom"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2 || !args[0].isNumber() || !args[1].isObject()) return Value::undefined();
        int fromSection = static_cast<int>(args[0].getNumber());
        auto arr = args[1].getObject(rt).asArray(rt);
        invalidateSectionsFrom(fromSection, sectionsFromJSI(rt, arr));
        return Value::undefined();
      }));
}

} // namespace rncv
