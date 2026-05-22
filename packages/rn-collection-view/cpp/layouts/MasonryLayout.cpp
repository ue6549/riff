#include "MasonryLayout.h"
#include <algorithm>
#include <climits>
#include <limits>

namespace rncv {

using namespace facebook::jsi;

// ─── JSI helpers ──────────────────────────────────────────────────────────────

static double mdbl(Runtime& rt, const Object& o, const char* k, double def = 0.0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? v.getNumber() : def;
}
static int mi32(Runtime& rt, const Object& o, const char* k, int def = 0) {
  Value v = o.getProperty(rt, k);
  return v.isNumber() ? static_cast<int>(v.getNumber()) : def;
}
static bool mbln(Runtime& rt, const Object& o, const char* k, bool def = false) {
  Value v = o.getProperty(rt, k);
  return v.isBool() ? v.getBool() : def;
}

MasonryLayout::MasonryLayout(std::shared_ptr<LayoutCache> cache)
    : _cache(std::move(cache)) {}

// ─── compute (legacy single-section) ─────────────────────────────────────────

void MasonryLayout::compute(const MasonryLayoutParams& params) {
  _cache->clear();
  _horizontal = params.horizontal;
  _viewportHeight = params.viewportHeight;
  if (_horizontal) {
    const double est = params.estimatedCrossAxisHeight > 0 ? params.estimatedCrossAxisHeight : 100.0;
    if (_maxCrossAxisHeight <= 0) _maxCrossAxisHeight = est;
  }
  _sectionParams = { params };
  computeSection(params, 0, 0.0);
}

// ─── computeSection ───────────────────────────────────────────────────────────
//
// Masonry layout: each item is placed in the shortest lane (column for V, row for H).
//
// V (vertical scroll, horizontal lanes = columns):
//   primary=Y, cross=X.
//   Lanes are columns. colWidth = (viewportWidth - insets - spacing) / cols.
//   Items have variable heights; placed in the column with lowest accumulated Y.
//   Separators: vertical lane-divider lines between column lanes.
//
// H (horizontal scroll, vertical lanes = rows):
//   primary=X, cross=Y.
//   Lanes are rows with uniform height = _maxCrossAxisHeight.
//   Items have variable widths (Yoga measures); placed in row with lowest accumulated X.
//   Separators: horizontal lane-divider lines between row lanes.

double MasonryLayout::computeSection(const MasonryLayoutParams& p,
                                      int sectionIndex,
                                      double startPrimary) {
  const bool H    = p.horizontal;
  const int  cols = p.columns > 0 ? p.columns : 1;

  const std::string prefix = p.keyPrefix.empty()
      ? "masonry-" + std::to_string(sectionIndex) + "-"
      : p.keyPrefix;

  double primary        = startPrimary;
  double bgStartPrimary = startPrimary;

  // ── Axis setup ────────────────────────────────────────────────────────────
  // V: primary=Y, cross=X.
  // H: primary=X, cross=Y. insets swap roles.
  const double crossStart        = H ? p.sectionInsetTop   : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft  : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;

  const double totalLaneSpacing = p.columnSpacing * (cols - 1);

  // Cross-axis sizing:
  //   H: lane height = _maxCrossAxisHeight (uniform). crossContent derived bottom-up.
  //   V: column width derived from viewport. crossContent = available cross width.
  double crossContent, laneSize;
  if (H) {
    laneSize     = _maxCrossAxisHeight > 0 ? _maxCrossAxisHeight
                 : (p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 100.0);
    crossContent = laneSize * cols + totalLaneSpacing;
  } else {
    const double rawCross = p.viewportWidth - p.sectionInsetLeft - p.sectionInsetRight;
    laneSize     = rawCross > 0 ? (rawCross - totalLaneSpacing) / cols : 0.0;
    crossContent = rawCross;
  }

  // Estimated primary-axis size per item (H only — Yoga refines actual widths).
  const double estimatedPrimary = H
      ? (p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 100.0)
      : 0.0;

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

  // ── Items — shortest-lane placement ───────────────────────────────────────
  // Initialize each lane's accumulated primary coordinate.
  const double laneStart = primary;
  std::vector<double> lanePrimary(cols, laneStart);

  // Row-group tracking for V-masonry render-range accuracy.
  // Records which rank (generation) each item occupies in its lane so that
  // items in the same visual rank can share rowGroupPos/rowExtentHeight.
  const bool needsRowGroup = !H && cols > 1;
  std::vector<LayoutAttributes> itemAttrs;
  std::vector<int> itemRankInLane;
  std::vector<int> laneRank(cols, 0);
  if (needsRowGroup) {
    itemAttrs.reserve(p.itemCount);
    itemRankInLane.resize(p.itemCount, 0);
  }

  for (int i = 0; i < p.itemCount; ++i) {
    // Find the lane with the minimum accumulated primary (shortest lane).
    int shortestLane = 0;
    double minP = lanePrimary[0];
    for (int c = 1; c < cols; ++c) {
      if (lanePrimary[c] < minP) { minP = lanePrimary[c]; shortestLane = c; }
    }

    const double crossPos = crossStart + shortestLane * (laneSize + p.columnSpacing);

    const std::string key = (i < static_cast<int>(p.keys.size()))
        ? p.keys[i]
        : prefix + std::to_string(i);

    // Preserve Yoga-measured size from cache to avoid oscillation.
    // If the cell was already measured (Yoga gave us the real size), reuse it so
    // setAttributes writes an identical frame → no version bump → feedback loop broken.
    const auto cached      = _cache->getAttributes(key);
    const bool wasMeasured = cached && cached->sizingState == SizingState::Measured;

    double itemPrimary;
    double itemCross;
    if (H) {
      itemPrimary = (wasMeasured && cached->frame.width > 0)
          ? cached->frame.width : estimatedPrimary;
      itemCross   = laneSize;
    } else {
      const double est = (i < static_cast<int>(p.itemHeights.size())) ? p.itemHeights[i] : 100.0;
      itemPrimary = (wasMeasured && cached->frame.height > 0)
          ? cached->frame.height : est;
      itemCross   = laneSize;
    }

    LayoutAttributes attrs;
    attrs.key       = key;
    attrs.section   = sectionIndex;
    attrs.index     = i;
    attrs.flatIndex = p.flatIndexBase + i;
    attrs.zIndex    = 0;
    attrs.alpha     = 1.0;
    attrs.isDirty   = false;
    if (H) {
      attrs.frame       = { lanePrimary[shortestLane], crossPos, itemPrimary, itemCross };
      attrs.sizingState = wasMeasured ? SizingState::Measured : SizingState::Placeholder;
    } else {
      attrs.frame       = { crossPos, lanePrimary[shortestLane], itemCross, itemPrimary };
      attrs.sizingState = wasMeasured ? SizingState::Measured : SizingState::Placeholder;
    }
    _cache->setAttributes(attrs);

    if (needsRowGroup) {
      itemRankInLane[i] = laneRank[shortestLane]++;
      itemAttrs.push_back(attrs);
    }

    lanePrimary[shortestLane] += itemPrimary + p.rowSpacing;
  }

  // ── V-masonry row-group back-fill ─────────────────────────────────────────
  // Compute per-rank bounds (min Y, max Y+H) and stamp each item with
  // rowGroupPos + rowExtentHeight so the binary search in LayoutCache treats
  // the whole rank as one unit — all items enter/exit the render range together.
  if (needsRowGroup && !itemAttrs.empty()) {
    int maxRank = 0;
    for (int c = 0; c < cols; ++c) maxRank = std::max(maxRank, laneRank[c]);
    std::vector<double> rankMinY(maxRank, std::numeric_limits<double>::max());
    std::vector<double> rankMaxEnd(maxRank, 0.0);
    for (int i = 0; i < p.itemCount; ++i) {
      const int    rank = itemRankInLane[i];
      const double y    = itemAttrs[i].frame.y;
      const double h    = itemAttrs[i].frame.height;
      if (y < rankMinY[rank])       rankMinY[rank]   = y;
      if (y + h > rankMaxEnd[rank]) rankMaxEnd[rank] = y + h;
    }
    for (int i = 0; i < p.itemCount; ++i) {
      const int rank = itemRankInLane[i];
      if (rankMinY[rank] == std::numeric_limits<double>::max()) continue;
      itemAttrs[i].rowGroupPos     = rankMinY[rank];
      itemAttrs[i].rowExtentHeight = rankMaxEnd[rank] - rankMinY[rank];
    }
    _cache->setAttributesBatch(itemAttrs);
  }

  // Section content end: max over lanes, removing trailing rowSpacing.
  double maxLaneEnd = laneStart;
  if (p.itemCount > 0) {
    for (int c = 0; c < cols; ++c) {
      const double laneEnd = lanePrimary[c] > laneStart
          ? lanePrimary[c] - p.rowSpacing
          : laneStart;
      maxLaneEnd = std::max(maxLaneEnd, laneEnd);
    }
  }
  primary = maxLaneEnd + primaryInsetEnd;

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

  // ── Lane-divider separators ───────────────────────────────────────────────
  // Emit one separator per inter-lane gap, spanning the full section content area.
  // V: vertical lines between columns. H: horizontal lines between rows.
  if (p.emitSeparators && cols > 1) {
    const double bgStart = bgStartPrimary;
    const double bgEnd   = primary; // section end (after primaryInsetEnd)
    const double sepSpan = bgEnd - bgStart
                         - p.separatorInsetLeading - p.separatorInsetTrailing;

    for (int c = 0; c < cols - 1; ++c) {
      const double gapPos = crossStart
                          + (c + 1) * laneSize + c * p.columnSpacing
                          + (p.columnSpacing - p.separatorHeight) / 2.0;

      LayoutAttributes sep;
      sep.key            = "separator-" + std::to_string(sectionIndex) + "-col-" + std::to_string(c);
      sep.section        = sectionIndex;
      sep.index          = -1;
      sep.isDecoration   = true;
      sep.decorationKind = "separator";
      sep.zIndex         = 0;
      sep.sizingState    = SizingState::Measured;
      sep.isDirty        = false;
      sep.alpha          = 1.0;
      if (H) {
        // Horizontal line between row lanes
        sep.frame = { bgStart + p.separatorInsetLeading, gapPos, sepSpan, p.separatorHeight };
      } else {
        // Vertical line between column lanes
        sep.frame = { gapPos, bgStart + p.separatorInsetLeading, p.separatorHeight, sepSpan };
      }
      _cache->setAttributes(sep);
    }
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
// Like computeSection but reads item sizes from the cache (Yoga-measured values).
// Used by applyMeasurements and invalidateSectionsFrom to preserve measurements.

double MasonryLayout::computeSectionFromCache(const MasonryLayoutParams& p,
                                               int sectionIndex,
                                               double startPrimary) {
  const bool H    = p.horizontal;
  const int  cols = p.columns > 0 ? p.columns : 1;

  const std::string prefix = p.keyPrefix.empty()
      ? "masonry-" + std::to_string(sectionIndex) + "-"
      : p.keyPrefix;

  double primary        = startPrimary;
  double bgStartPrimary = startPrimary;

  const double crossStart        = H ? p.sectionInsetTop   : p.sectionInsetLeft;
  const double primaryInsetStart = H ? p.sectionInsetLeft  : p.sectionInsetTop;
  const double primaryInsetEnd   = H ? p.sectionInsetRight : p.sectionInsetBottom;

  const double totalLaneSpacing = p.columnSpacing * (cols - 1);

  double crossContent, laneSize;
  if (H) {
    laneSize     = _maxCrossAxisHeight > 0 ? _maxCrossAxisHeight
                 : (p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 100.0);
    crossContent = laneSize * cols + totalLaneSpacing;
  } else {
    const double rawCross = p.viewportWidth - p.sectionInsetLeft - p.sectionInsetRight;
    laneSize     = rawCross > 0 ? (rawCross - totalLaneSpacing) / cols : 0.0;
    crossContent = rawCross;
  }

  const double estimatedPrimary = H
      ? (p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 100.0)
      : 0.0;

  // ── Header (preserve measured size) ──────────────────────────────────────
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
          ? existingHdr->frame.width : p.headerHeight;
      const double hdrCrossH = p.sectionInsetTop + crossContent + p.sectionInsetBottom;
      hdr.frame = { primary, 0, hW, hdrCrossH };
      primary       += hW;
    } else {
      const double hH = (existingHdr && existingHdr->frame.height > 0)
          ? existingHdr->frame.height : p.headerHeight;
      hdr.frame = { crossStart, primary, crossContent, hH };
      primary       += hH;
    }
    _cache->setAttributes(hdr);
    bgStartPrimary = primary;
  }

  primary += primaryInsetStart;

  // ── Read item sizes from cache ────────────────────────────────────────────
  const double laneStart = primary;
  std::vector<double> lanePrimary(cols, laneStart);

  const bool needsRowGroup = !H && cols > 1;
  std::vector<LayoutAttributes> itemAttrs;
  std::vector<int> itemRankInLane;
  std::vector<int> laneRank(cols, 0);
  if (needsRowGroup) {
    itemAttrs.reserve(p.itemCount);
    itemRankInLane.resize(p.itemCount, 0);
  }

  for (int i = 0; i < p.itemCount; ++i) {
    const std::string key = (i < static_cast<int>(p.keys.size()))
        ? p.keys[i]
        : prefix + std::to_string(i);
    auto existing = _cache->getAttributes(key);

    int shortestLane = 0;
    double minP = lanePrimary[0];
    for (int c = 1; c < cols; ++c) {
      if (lanePrimary[c] < minP) { minP = lanePrimary[c]; shortestLane = c; }
    }

    const double crossPos = crossStart + shortestLane * (laneSize + p.columnSpacing);

    double itemPrimary, itemCross;
    if (H) {
      itemPrimary = (existing && existing->frame.width > 0)
          ? existing->frame.width : estimatedPrimary;
      itemCross = (existing && existing->frame.height > 0)
          ? existing->frame.height : laneSize;
    } else {
      itemPrimary = (existing && existing->frame.height > 0)
          ? existing->frame.height : 100.0;
      itemCross = laneSize;
    }

    LayoutAttributes attrs;
    attrs.key       = key;
    attrs.section   = sectionIndex;
    attrs.index     = i;
    attrs.flatIndex = p.flatIndexBase + i;
    attrs.zIndex    = 0;
    attrs.alpha     = 1.0;
    attrs.isDirty   = false;
    attrs.sizingState = existing ? existing->sizingState : SizingState::Placeholder;
    if (H) {
      attrs.frame = { lanePrimary[shortestLane], crossPos, itemPrimary, itemCross };
    } else {
      attrs.frame = { crossPos, lanePrimary[shortestLane], itemCross, itemPrimary };
    }
    _cache->setAttributes(attrs);

    if (needsRowGroup) {
      itemRankInLane[i] = laneRank[shortestLane]++;
      itemAttrs.push_back(attrs);
    }

    lanePrimary[shortestLane] += itemPrimary + p.rowSpacing;
  }

  // ── V-masonry row-group back-fill ─────────────────────────────────────────
  if (needsRowGroup && !itemAttrs.empty()) {
    int maxRank = 0;
    for (int c = 0; c < cols; ++c) maxRank = std::max(maxRank, laneRank[c]);
    std::vector<double> rankMinY(maxRank, std::numeric_limits<double>::max());
    std::vector<double> rankMaxEnd(maxRank, 0.0);
    for (int i = 0; i < p.itemCount; ++i) {
      const int    rank = itemRankInLane[i];
      const double y    = itemAttrs[i].frame.y;
      const double h    = itemAttrs[i].frame.height;
      if (y < rankMinY[rank])       rankMinY[rank]   = y;
      if (y + h > rankMaxEnd[rank]) rankMaxEnd[rank] = y + h;
    }
    for (int i = 0; i < p.itemCount; ++i) {
      const int rank = itemRankInLane[i];
      if (rankMinY[rank] == std::numeric_limits<double>::max()) continue;
      itemAttrs[i].rowGroupPos     = rankMinY[rank];
      itemAttrs[i].rowExtentHeight = rankMaxEnd[rank] - rankMinY[rank];
    }
    _cache->setAttributesBatch(itemAttrs);
  }

  // Section content end
  double maxLaneEnd = laneStart;
  if (p.itemCount > 0) {
    for (int c = 0; c < cols; ++c) {
      const double laneEnd = lanePrimary[c] > laneStart
          ? lanePrimary[c] - p.rowSpacing
          : laneStart;
      maxLaneEnd = std::max(maxLaneEnd, laneEnd);
    }
  }
  primary = maxLaneEnd + primaryInsetEnd;

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

  // ── Lane-divider separators ───────────────────────────────────────────────
  if (p.emitSeparators && cols > 1) {
    const double bgStart = bgStartPrimary;
    const double bgEnd   = primary;
    const double sepSpan = bgEnd - bgStart
                         - p.separatorInsetLeading - p.separatorInsetTrailing;

    for (int c = 0; c < cols - 1; ++c) {
      const double gapPos = crossStart
                          + (c + 1) * laneSize + c * p.columnSpacing
                          + (p.columnSpacing - p.separatorHeight) / 2.0;

      LayoutAttributes sep;
      sep.key            = "separator-" + std::to_string(sectionIndex) + "-col-" + std::to_string(c);
      sep.section        = sectionIndex;
      sep.index          = -1;
      sep.isDecoration   = true;
      sep.decorationKind = "separator";
      sep.zIndex         = 0;
      sep.sizingState    = SizingState::Measured;
      sep.isDirty        = false;
      sep.alpha          = 1.0;
      if (H) {
        sep.frame = { bgStart + p.separatorInsetLeading, gapPos, sepSpan, p.separatorHeight };
      } else {
        sep.frame = { gapPos, bgStart + p.separatorInsetLeading, p.separatorHeight, sepSpan };
      }
      _cache->setAttributes(sep);
    }
  }

  // ── Footer (preserve measured size) ──────────────────────────────────────
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
          ? existingFtr->frame.width : p.footerHeight;
      const double ftrCrossH = p.sectionInsetTop + crossContent + p.sectionInsetBottom;
      ftr.frame = { primary, 0, fW, ftrCrossH };
      primary += fW;
    } else {
      const double fH = (existingFtr && existingFtr->frame.height > 0)
          ? existingFtr->frame.height : p.footerHeight;
      ftr.frame = { crossStart, primary, crossContent, fH };
      primary += fH;
    }
    _cache->setAttributes(ftr);
  }

  primary += p.sectionSpacing;
  return primary;
}

// ─── computeSections ──────────────────────────────────────────────────────────

void MasonryLayout::computeSections(const std::vector<MasonryLayoutParams>& sections) {
  if (sections.empty()) return;

  _horizontal     = sections[0].horizontal;
  _viewportHeight = sections[0].viewportHeight;
  if (_horizontal) {
    const double est = sections[0].estimatedCrossAxisHeight > 0
        ? sections[0].estimatedCrossAxisHeight : 100.0;
    // Preserve measured value — only initialize on first use to avoid oscillation.
    if (_maxCrossAxisHeight <= 0) _maxCrossAxisHeight = est;
  }
  _sectionParams = sections;

  double primary = 0.0;
  for (int s = 0; s < static_cast<int>(sections.size()); ++s) {
    primary = computeSection(sections[s], s, primary);
  }
}

// ─── invalidateSectionsFrom ───────────────────────────────────────────────────

void MasonryLayout::invalidateSectionsFrom(int fromSection,
                                             const std::vector<MasonryLayoutParams>& sections) {
  if (fromSection < 0 || fromSection >= static_cast<int>(sections.size())) return;

  _sectionParams = sections;

  const auto& p0 = sections[fromSection];
  const bool H0  = p0.horizontal;
  const std::string prefix0 = p0.keyPrefix.empty()
      ? "masonry-" + std::to_string(fromSection) + "-"
      : p0.keyPrefix;

  // Find where this section starts (primary coordinate of its leading edge).
  double startPrimary = 0.0;
  if (p0.headerHeight > 0) {
    auto header = _cache->getAttributes(prefix0 + "header");
    if (header) startPrimary = H0 ? header->frame.x : header->frame.y;
  } else if (p0.itemCount > 0) {
    const std::string firstKey = p0.keys.empty() ? prefix0 + "0" : p0.keys[0];
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

// ─── applyMeasurements ────────────────────────────────────────────────────────

bool MasonryLayout::applyMeasurements(
    const std::vector<MeasurementDelta>& deltas,
    LayoutCache& cache) {
  if (deltas.empty()) return true;

  const bool H = _horizontal;

  // ── Horizontal masonry path ───────────────────────────────────────────────
  // contentDeterminedDimension() = Both → ShadowNode sends width AND height deltas.
  // Phase 1: Write measured dims. Phase 2: Update _maxCrossAxisHeight. Phase 3: Reflow.
  if (H) {
    // Phase 1: Write Yoga-measured widths and heights into cache.
    for (const auto& d : deltas) {
      auto existing = cache.getAttributes(d.key);
      if (!existing) continue;
      if (existing->isDecoration && existing->decorationKind == "sectionBackground") continue;

      auto updated = *existing;
      const bool matchesH = std::abs(existing->frame.height - d.oldValue) < 1.0;
      const bool matchesW = std::abs(existing->frame.width  - d.oldValue) < 1.0;
      bool changed = false;

      if (matchesH && !matchesW) {
        if (std::abs(d.newValue - updated.frame.height) > 0.01) {
          updated.frame.height = d.newValue; changed = true;
        }
      } else if (matchesW && !matchesH) {
        if (std::abs(d.newValue - updated.frame.width) > 0.01) {
          updated.frame.width = d.newValue; changed = true;
        }
      } else if (matchesH && matchesW) {
        if (std::abs(d.newValue - updated.frame.width) > 0.01 ||
            std::abs(d.newValue - updated.frame.height) > 0.01) {
          updated.frame.width  = d.newValue;
          updated.frame.height = d.newValue;
          changed = true;
        }
      }

      if (changed) {
        updated.sizingState = SizingState::Measured;
        cache.setAttributes(updated);
      }
    }

    // Phase 2: Update global max cross height from all item frames.
    {
      double globalMaxH = 0.0;
      auto allNow = cache.getAll();
      for (const auto& attr : allNow) {
        if (!attr.isDecoration && !attr.isSupplementary && attr.frame.height > 0)
          globalMaxH = std::max(globalMaxH, attr.frame.height);
      }
      if (globalMaxH > 0) _maxCrossAxisHeight = globalMaxH;
    }

    // Phase 3: Full reflow.
    if (!_sectionParams.empty()) {
      double primary = 0.0;
      for (int s = 0; s < static_cast<int>(_sectionParams.size()); ++s) {
        primary = computeSectionFromCache(_sectionParams[s], s, primary);
      }
    }
    return true;
  }

  // ── Vertical masonry path ─────────────────────────────────────────────────
  // Write Yoga-measured heights to cache, then reflow from firstChangedSection.
  // Within a section, computeSectionFromCache does a full re-run of the
  // shortest-lane algorithm (correct: any height change can reorder lane assignments).
  int firstChangedSection = INT_MAX;
  for (const auto& d : deltas) {
    auto attrs = cache.getAttributes(d.key);
    if (attrs) {
      const bool isSectionBg = attrs->isDecoration &&
                               attrs->decorationKind == "sectionBackground";
      if (!isSectionBg) {
        auto updated = *attrs;
        updated.frame.height = d.newValue;
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

  if (firstChangedSection == INT_MAX || _sectionParams.empty()) return true;
  if (firstChangedSection >= static_cast<int>(_sectionParams.size())) return true;

  const auto& p0 = _sectionParams[firstChangedSection];
  const std::string prefix0 = p0.keyPrefix.empty()
      ? "masonry-" + std::to_string(firstChangedSection) + "-"
      : p0.keyPrefix;

  double startPrimary = 0.0;
  if (p0.headerHeight > 0) {
    auto header = _cache->getAttributes(prefix0 + "header");
    if (header) startPrimary = header->frame.y;
  } else if (p0.itemCount > 0) {
    const std::string firstKey = p0.keys.empty() ? prefix0 + "0" : p0.keys[0];
    auto firstItem = _cache->getAttributes(firstKey);
    if (firstItem) startPrimary = firstItem->frame.y - p0.sectionInsetTop;
  }

  double primary = computeSectionFromCache(p0, firstChangedSection, startPrimary);
  for (int s = firstChangedSection + 1; s < static_cast<int>(_sectionParams.size()); ++s) {
    primary = computeSection(_sectionParams[s], s, primary);
  }

  return true;
}

// ─── JSI parameter extraction ─────────────────────────────────────────────────

MasonryLayoutParams MasonryLayout::paramsFromJSI(Runtime& rt, const Object& obj) {
  MasonryLayoutParams p;

  p.itemCount       = mi32(rt, obj, "itemCount", 0);
  p.columns         = mi32(rt, obj, "columns", 2);
  p.columnSpacing   = mdbl(rt, obj, "columnSpacing", 8.0);
  p.rowSpacing      = mdbl(rt, obj, "rowSpacing", 8.0);
  p.viewportWidth   = mdbl(rt, obj, "viewportWidth", 390.0);
  p.viewportHeight  = mdbl(rt, obj, "viewportHeight", 0.0);
  p.sectionInsetTop    = mdbl(rt, obj, "sectionInsetTop", 0);
  p.sectionInsetBottom = mdbl(rt, obj, "sectionInsetBottom", 0);
  p.sectionInsetLeft   = mdbl(rt, obj, "sectionInsetLeft", 0);
  p.sectionInsetRight  = mdbl(rt, obj, "sectionInsetRight", 0);

  p.headerHeight          = mdbl(rt, obj, "headerHeight", 0.0);
  p.footerHeight          = mdbl(rt, obj, "footerHeight", 0.0);
  p.emitSectionBackground = mbln(rt, obj, "emitSectionBackground", false);
  p.emitSeparators        = mbln(rt, obj, "emitSeparators", false);
  p.separatorHeight       = mdbl(rt, obj, "separatorHeight", 0.5);
  p.separatorInsetLeading  = mdbl(rt, obj, "separatorInsetLeading", 0.0);
  p.separatorInsetTrailing = mdbl(rt, obj, "separatorInsetTrailing", 0.0);
  p.sectionSpacing        = mdbl(rt, obj, "sectionSpacing", 0.0);

  p.horizontal               = mbln(rt, obj, "horizontal", false);
  p.estimatedCrossAxisHeight = mdbl(rt, obj, "estimatedCrossAxisHeight", 200.0);

  p.sectionBackgroundInsetTop    = mdbl(rt, obj, "sectionBackgroundInsetTop",    0.0);
  p.sectionBackgroundInsetBottom = mdbl(rt, obj, "sectionBackgroundInsetBottom", 0.0);
  p.sectionBackgroundInsetLeft   = mdbl(rt, obj, "sectionBackgroundInsetLeft",   0.0);
  p.sectionBackgroundInsetRight  = mdbl(rt, obj, "sectionBackgroundInsetRight",  0.0);

  // Flat index mapping for processScroll binary search
  p.flatIndexBase   = mi32(rt, obj, "flatIndexBase", 0);
  p.headerFlatIndex = mi32(rt, obj, "headerFlatIndex", -1);
  p.footerFlatIndex = mi32(rt, obj, "footerFlatIndex", -1);

  // itemHeights: number[]
  auto hv = obj.getProperty(rt, "itemHeights");
  if (hv.isObject()) {
    auto arr = hv.asObject(rt).asArray(rt);
    size_t len = arr.length(rt);
    p.itemHeights.resize(len);
    for (size_t i = 0; i < len; ++i)
      p.itemHeights[i] = arr.getValueAtIndex(rt, i).getNumber();
  }

  // keys: string[]
  auto kv = obj.getProperty(rt, "keys");
  if (kv.isObject()) {
    auto arr = kv.asObject(rt).asArray(rt);
    size_t len = arr.length(rt);
    p.keys.resize(len);
    for (size_t i = 0; i < len; ++i)
      p.keys[i] = arr.getValueAtIndex(rt, i).asString(rt).utf8(rt);
  }

  auto kp = obj.getProperty(rt, "keyPrefix");
  if (kp.isString()) p.keyPrefix = kp.asString(rt).utf8(rt);

  return p;
}

std::vector<MasonryLayoutParams> MasonryLayout::sectionsFromJSI(Runtime& rt, const Array& arr) {
  size_t len = arr.size(rt);
  std::vector<MasonryLayoutParams> sections;
  sections.reserve(len);
  for (size_t i = 0; i < len; ++i) {
    Value v = arr.getValueAtIndex(rt, i);
    if (!v.isObject()) continue;
    MasonryLayoutParams p = paramsFromJSI(rt, v.getObject(rt));
    p.section = static_cast<int>(i);
    sections.push_back(std::move(p));
  }
  return sections;
}

// ─── JSI bindings ──────────────────────────────────────────────────────────────

void MasonryLayout::installJSIBindings(Runtime& rt, Object& target) {
  // Legacy single-section method (kept for backward compatibility)
  target.setProperty(rt, "computeMasonryLayout",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeMasonryLayout"), 1,
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

  // Standard contract: computeSections(sections: object[]) → undefined
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

  // Standard contract: invalidateSectionsFrom(fromSection, sections[]) → undefined
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
