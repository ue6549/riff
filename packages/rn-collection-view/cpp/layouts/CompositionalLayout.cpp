#include "CompositionalLayout.h"
#include <algorithm>
#include <climits>
#include <cmath>
#include <string>

namespace rncv {

using namespace facebook;
using namespace facebook::jsi;

// ── Helpers ────────────────────────────────────────────────────────────────────

// Extract viewportWidth from any param variant (all four types have it).
static float viewportWidthFromParams(const CompositionalSectionInfo& info) {
  return std::visit([](const auto& p) -> float {
    return static_cast<float>(p.viewportWidth);
  }, info.params);
}

// V-axis height of an H-section as it occupies the outer vertical scroll.
// - Flow H: viewportHeight is the fixed cross-axis extent (items pack within it).
// - Grid / List / Masonry H: estimatedCrossAxisHeight is the initial estimate;
//   Yoga + MVC refines it via applyMeasurements.
static float hSectionVHeight(const CompositionalSectionInfo& info) {
  if (info.layoutType == "flow") {
    const auto& p = std::get<FlowLayoutParams>(info.params);
    return static_cast<float>(p.viewportHeight > 0 ? p.viewportHeight : 44.0);
  }
  if (info.layoutType == "grid") {
    const auto& p = std::get<GridLayoutParams>(info.params);
    return static_cast<float>(p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 200.0);
  }
  if (info.layoutType == "masonry") {
    const auto& p = std::get<MasonryLayoutParams>(info.params);
    return static_cast<float>(p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 200.0);
  }
  // list (default)
  const auto& p = std::get<ListLayoutParams>(info.params);
  return static_cast<float>(p.estimatedCrossAxisHeight > 0 ? p.estimatedCrossAxisHeight : 200.0);
}

// ── Construction ───────────────────────────────────────────────────────────────

CompositionalLayout::CompositionalLayout(
    std::shared_ptr<LayoutCache>    cache,
    std::shared_ptr<ListLayout>     listLayout,
    std::shared_ptr<GridLayout>     gridLayout,
    std::shared_ptr<FlowLayout>     flowLayout,
    std::shared_ptr<MasonryLayout>  masonryLayout)
    : _cache(std::move(cache))
    , _listLayout(std::move(listLayout))
    , _gridLayout(std::move(gridLayout))
    , _flowLayout(std::move(flowLayout))
    , _masonryLayout(std::move(masonryLayout)) {}

// ── Leaf engine dispatch helpers ───────────────────────────────────────────────

// Dispatch to the correct sub-engine's computeSection.
double CompositionalLayout::dispatchLeafCompute(
    const CompositionalSectionInfo& info,
    int sectionIndex,
    double startPrimary) {
  if (info.layoutType == "grid")
    return _gridLayout->computeSection(
        std::get<GridLayoutParams>(info.params), sectionIndex, startPrimary);
  if (info.layoutType == "flow")
    return _flowLayout->computeSection(
        std::get<FlowLayoutParams>(info.params), sectionIndex, startPrimary);
  if (info.layoutType == "masonry")
    return _masonryLayout->computeSection(
        std::get<MasonryLayoutParams>(info.params), sectionIndex, startPrimary);
  return _listLayout->computeSection(
      std::get<ListLayoutParams>(info.params), sectionIndex, startPrimary);
}

// Dispatch to the correct sub-engine's computeSectionFromCache.
double CompositionalLayout::dispatchLeafComputeFromCache(
    const CompositionalSectionInfo& info,
    int sectionIndex,
    double startPrimary) {
  if (info.layoutType == "grid")
    return _gridLayout->computeSectionFromCache(
        std::get<GridLayoutParams>(info.params), sectionIndex, startPrimary);
  if (info.layoutType == "flow")
    return _flowLayout->computeSectionFromCache(
        std::get<FlowLayoutParams>(info.params), sectionIndex, startPrimary);
  if (info.layoutType == "masonry")
    return _masonryLayout->computeSectionFromCache(
        std::get<MasonryLayoutParams>(info.params), sectionIndex, startPrimary);
  return _listLayout->computeSectionFromCache(
      std::get<ListLayoutParams>(info.params), sectionIndex, startPrimary);
}

// ── Level 1 supplementary helpers ─────────────────────────────────────────────

// Write a compositional-level header or footer to the cache.
static void writeCompSupplementary(
    LayoutCache& cache,
    int sectionIndex,
    const std::string& kind,  // "header" or "footer"
    int flatIndex,
    float x, float y, float w, float h) {
  LayoutAttributes attr;
  attr.key               = "comp-" + std::to_string(sectionIndex) + "-" + kind;
  attr.section           = sectionIndex;
  attr.index             = -1;
  attr.flatIndex         = flatIndex;
  attr.isSupplementary   = true;
  attr.supplementaryKind = kind;
  attr.sizingState       = SizingState::Measured;
  attr.frame             = { x, y, w, h };
  cache.setAttributes(attr);
}

// Write a section background decoration spanning (x, y, w, h).
static void writeCompSectionBackground(
    LayoutCache& cache,
    int sectionIndex,
    float x, float y, float w, float h) {
  LayoutAttributes bg;
  bg.key            = "decoration-" + std::to_string(sectionIndex) + "-sectionBackground";
  bg.section        = sectionIndex;
  bg.index          = -1;
  bg.isDecoration   = true;
  bg.decorationKind = "sectionBackground";
  bg.zIndex         = -1;
  bg.frame          = { x, y, w, h };
  cache.setAttributes(bg);
}

// H-section post-processing: shift item frame.y, write wrapper + cw entries.
void CompositionalLayout::finalizeHSection(
    const CompositionalSectionInfo& info,
    int sectionIndex,
    double contentCursorY,
    double hContentEnd) {
  float vpW      = viewportWidthFromParams(info);
  float sectionH = hSectionVHeight(info);
  float contentW = std::max(static_cast<float>(hContentEnd), vpW);

  // Shift all H-section items' frame.y by contentCursorY so that processScroll
  // (V-absolute coordinates) correctly includes them when section is visible.
  // TS renderCell subtracts sectionOriginY to convert back to section-local Y.
  if (contentCursorY > 0.0) {
    auto hItems = _cache->getAttributesInRect({
        -1e5f, 0.0f, 2e5f, std::max(sectionH, 1.0f)
    });
    for (const auto& a : hItems) {
      if (a.section == sectionIndex && !a.isDecoration && !a.isSupplementary) {
        auto updated = a;
        updated.frame.y += static_cast<float>(contentCursorY);
        _cache->setAttributes(updated);
      }
    }
  }

  // Wrapper entry: V position (0, contentCursorY), size (vpW, sectionH).
  LayoutAttributes wrapper;
  wrapper.key           = "h-section-wrapper-" + std::to_string(sectionIndex);
  wrapper.frame         = { 0.0f, static_cast<float>(contentCursorY), vpW, sectionH };
  wrapper.section       = sectionIndex;
  wrapper.isDecoration  = true;
  wrapper.decorationKind = "h-section-wrapper";
  _cache->setAttributes(wrapper);

  // Content-width entry for TS (frame.width = total H content width).
  LayoutAttributes cw;
  cw.key           = "h-section-cw-" + std::to_string(sectionIndex);
  cw.frame         = { 0.0f, 0.0f, contentW, 0.0f };
  cw.isDecoration  = true;
  cw.decorationKind = "h-section-cw";
  _cache->setAttributes(cw);
}

// ── computeOneSection / computeOneSectionFromCache ─────────────────────────────
//
// Two-level supplementary system:
//   Level 1 (compositional): headers/footers/backgrounds in V-coordinates.
//   Level 2 (leaf): items (and any leaf-level supplementaries) in the leaf's
//   coordinate space (V for V-sections, H for H-sections).
//
// Cursor chain:
//   startPrimary
//   += sectionSpacing (if section > 0)
//   += headerHeight (compositional header)
//   → leaf content (items only — leaf params have headerHeight=0)
//   += footerHeight (compositional footer)
//   → section background (startPrimary to cursor)

double CompositionalLayout::computeOneSection(
    const CompositionalSectionInfo& info,
    int sectionIndex,
    double startPrimary) {

  float vpW = viewportWidthFromParams(info);
  double cursor = startPrimary;

  // Section spacing (gap between consecutive sections).
  if (sectionIndex > 0 && info.sectionSpacing > 0) {
    cursor += info.sectionSpacing;
  }

  double sectionTopY = cursor;

  // Level 1: compositional-owned header.
  if (info.headerHeight > 0 && info.headerFlatIndex >= 0) {
    writeCompSupplementary(*_cache, sectionIndex, "header",
                           info.headerFlatIndex,
                           0.0f, static_cast<float>(cursor), vpW, info.headerHeight);
    cursor += info.headerHeight;
  }

  double contentStartY = cursor;

  if (info.horizontal) {
    // H-section: sub-engine works in X-from-0 space.
    double hContentEnd = dispatchLeafCompute(info, sectionIndex, 0.0);
    float sectionH = hSectionVHeight(info);
    finalizeHSection(info, sectionIndex, cursor, hContentEnd);
    cursor += sectionH;
  } else {
    // V-section: normal cursor chaining.
    cursor = dispatchLeafCompute(info, sectionIndex, cursor);
  }

  double contentEndY = cursor;

  // Level 1: compositional-owned footer.
  if (info.footerHeight > 0 && info.footerFlatIndex >= 0) {
    writeCompSupplementary(*_cache, sectionIndex, "footer",
                           info.footerFlatIndex,
                           0.0f, static_cast<float>(cursor), vpW, info.footerHeight);
    cursor += info.footerHeight;
  }

  // Level 1: section background decoration spanning header → footer.
  if (info.emitSectionBackground && cursor > sectionTopY) {
    writeCompSectionBackground(*_cache, sectionIndex,
                               0.0f, static_cast<float>(sectionTopY),
                               vpW, static_cast<float>(cursor - sectionTopY));
  }

  return cursor;
}

double CompositionalLayout::computeOneSectionFromCache(
    const CompositionalSectionInfo& info,
    int sectionIndex,
    double startPrimary) {

  float vpW = viewportWidthFromParams(info);
  double cursor = startPrimary;

  if (sectionIndex > 0 && info.sectionSpacing > 0) {
    cursor += info.sectionSpacing;
  }

  double sectionTopY = cursor;

  if (info.headerHeight > 0 && info.headerFlatIndex >= 0) {
    writeCompSupplementary(*_cache, sectionIndex, "header",
                           info.headerFlatIndex,
                           0.0f, static_cast<float>(cursor), vpW, info.headerHeight);
    cursor += info.headerHeight;
  }

  if (info.horizontal) {
    double hContentEnd = dispatchLeafComputeFromCache(info, sectionIndex, 0.0);
    float sectionH = hSectionVHeight(info);
    finalizeHSection(info, sectionIndex, cursor, hContentEnd);
    cursor += sectionH;
  } else {
    cursor = dispatchLeafComputeFromCache(info, sectionIndex, cursor);
  }

  if (info.footerHeight > 0 && info.footerFlatIndex >= 0) {
    writeCompSupplementary(*_cache, sectionIndex, "footer",
                           info.footerFlatIndex,
                           0.0f, static_cast<float>(cursor), vpW, info.footerHeight);
    cursor += info.footerHeight;
  }

  if (info.emitSectionBackground && cursor > sectionTopY) {
    writeCompSectionBackground(*_cache, sectionIndex,
                               0.0f, static_cast<float>(sectionTopY),
                               vpW, static_cast<float>(cursor - sectionTopY));
  }

  return cursor;
}

// ── computeSections ─────────────────────────────────────────────────────────────

void CompositionalLayout::computeSections(
    const std::vector<CompositionalSectionInfo>& sections) {
  _cache->clear();
  _sectionInfos = sections;
  _sectionStartPrimaries.resize(sections.size(), 0.0);

  double cursor = 0.0;
  for (int s = 0; s < static_cast<int>(sections.size()); ++s) {
    _sectionStartPrimaries[s] = cursor;
    cursor = computeOneSection(sections[s], s, cursor);
  }
}

// ── invalidateSectionsFrom ──────────────────────────────────────────────────────

void CompositionalLayout::invalidateSectionsFrom(
    int fromSection,
    const std::vector<CompositionalSectionInfo>& sections) {
  if (sections.empty() || fromSection >= static_cast<int>(sections.size())) return;

  // Find the starting primary for fromSection.
  // Use stored start primaries if sections match current layout, else scan cache.
  double startPrimary = 0.0;
  if (fromSection > 0
      && fromSection <= static_cast<int>(_sectionStartPrimaries.size())) {
    startPrimary = _sectionStartPrimaries[fromSection];
  }

  // Reflow: use fromCache for the first changed section (preserves measured heights),
  // then fresh computeSection for all subsequent sections.
  double cursor = computeOneSectionFromCache(sections[fromSection], fromSection, startPrimary);

  for (int s = fromSection + 1; s < static_cast<int>(sections.size()); ++s) {
    _sectionStartPrimaries[s] = cursor;
    cursor = computeOneSection(sections[s], s, cursor);
  }
}

// ── applyMeasurements ──────────────────────────────────────────────────────────

bool CompositionalLayout::applyMeasurements(
    const std::vector<MeasurementDelta>& deltas,
    LayoutCache& cache) {
  if (deltas.empty() || _sectionInfos.empty()) return true;

  int firstChangedSection = INT_MAX;

  // Phase 1: Write new sizes to cache, track the first affected section.
  for (const auto& d : deltas) {
    auto existing = cache.getAttributes(d.key);
    if (!existing) continue;

    auto updated = *existing;
    const bool matchesH = std::abs(updated.frame.height - d.oldValue) < 1.0;
    const bool matchesW = std::abs(updated.frame.width  - d.oldValue) < 1.0;

    if (d.axis == MeasurementAxis::Height) {
      updated.frame.height = d.newValue;
    } else if (d.axis == MeasurementAxis::Width) {
      updated.frame.width = d.newValue;
    } else if (matchesH && !matchesW) {
      updated.frame.height = d.newValue;
    } else if (matchesW && !matchesH) {
      updated.frame.width = d.newValue;
    } else {
      // Ambiguous: default to height for vertical layouts.
      updated.frame.height = d.newValue;
    }
    updated.sizingState = SizingState::Measured;
    cache.setAttributes(updated);

    if (!existing->isDecoration && !existing->isSupplementary) {
      firstChangedSection = std::min(firstChangedSection, existing->section);
    }
  }

  if (firstChangedSection == INT_MAX) return true;

  // Phase 2: Reflow from firstChangedSection onward using updated cache heights.
  // computeOneSectionFromCache reads the heights we just wrote in Phase 1.
  invalidateSectionsFrom(firstChangedSection, _sectionInfos);
  return true;
}

// ── JSI parsing ────────────────────────────────────────────────────────────────

CompositionalSectionInfo CompositionalLayout::sectionInfoFromJSI(
    Runtime& rt,
    const Object& obj) {
  CompositionalSectionInfo info;

  Value ltVal = obj.getProperty(rt, "layoutType");
  info.layoutType = ltVal.isString() ? ltVal.getString(rt).utf8(rt) : "list";

  Value hzVal = obj.getProperty(rt, "horizontal");
  info.horizontal = hzVal.isBool() ? hzVal.getBool() : false;

  // Level 1 (compositional-owned) supplementary fields.
  Value hhVal = obj.getProperty(rt, "compHeaderHeight");
  info.headerHeight = hhVal.isNumber() ? static_cast<float>(hhVal.getNumber()) : 0;

  Value fhVal = obj.getProperty(rt, "compFooterHeight");
  info.footerHeight = fhVal.isNumber() ? static_cast<float>(fhVal.getNumber()) : 0;

  Value hfiVal = obj.getProperty(rt, "compHeaderFlatIndex");
  info.headerFlatIndex = hfiVal.isNumber() ? static_cast<int>(hfiVal.getNumber()) : -1;

  Value ffiVal = obj.getProperty(rt, "compFooterFlatIndex");
  info.footerFlatIndex = ffiVal.isNumber() ? static_cast<int>(ffiVal.getNumber()) : -1;

  Value esbVal = obj.getProperty(rt, "compEmitSectionBackground");
  info.emitSectionBackground = esbVal.isBool() ? esbVal.getBool() : false;

  Value ssVal = obj.getProperty(rt, "compSectionSpacing");
  info.sectionSpacing = ssVal.isNumber() ? static_cast<float>(ssVal.getNumber()) : 0;

  if (info.layoutType == "grid") {
    info.params = GridLayout::paramsFromJSI(rt, obj);
  } else if (info.layoutType == "flow") {
    info.params = FlowLayout::paramsFromJSI(rt, obj);
  } else if (info.layoutType == "masonry") {
    info.params = MasonryLayout::paramsFromJSI(rt, obj);
  } else {
    // Default: "list" (handles unknown types gracefully)
    info.params = ListLayout::paramsFromJSI(rt, obj);
  }

  return info;
}

std::vector<CompositionalSectionInfo> CompositionalLayout::sectionsFromJSI(
    Runtime& rt,
    const Array& arr) {
  size_t len = arr.length(rt);
  std::vector<CompositionalSectionInfo> sections;
  sections.reserve(len);
  for (size_t i = 0; i < len; ++i) {
    Value elem = arr.getValueAtIndex(rt, i);
    if (!elem.isObject()) continue;
    sections.push_back(sectionInfoFromJSI(rt, elem.getObject(rt)));
  }
  return sections;
}

// ── JSI bindings ───────────────────────────────────────────────────────────────

void CompositionalLayout::installJSIBindings(Runtime& rt, Object& target) {
  // computeSections(sections: object[]) → undefined
  target.setProperty(rt, "computeSections",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "computeSections"), 1,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1 || !args[0].isObject()) return Value::undefined();
        auto arr = args[0].getObject(rt).asArray(rt);
        computeSections(sectionsFromJSI(rt, arr));
        return Value::undefined();
      }));

  // invalidateSectionsFrom(fromSection: number, sections: object[]) → undefined
  target.setProperty(rt, "invalidateSectionsFrom",
    Function::createFromHostFunction(rt,
      PropNameID::forAscii(rt, "invalidateSectionsFrom"), 2,
      [this](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 2) return Value::undefined();
        int fromSection = args[0].isNumber() ? static_cast<int>(args[0].getNumber()) : 0;
        if (!args[1].isObject()) return Value::undefined();
        auto arr = args[1].getObject(rt).asArray(rt);
        invalidateSectionsFrom(fromSection, sectionsFromJSI(rt, arr));
        return Value::undefined();
      }));
}

} // namespace rncv
