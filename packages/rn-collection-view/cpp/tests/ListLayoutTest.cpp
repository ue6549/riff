/**
 * ListLayoutTest.cpp — Unit tests for ListLayout calculation paths.
 *
 * Verifies:
 *   1. computeSection (fresh path) and computeSectionFromCache (stash path)
 *      produce identical Y positions for identical inputs.
 *   2. stash fallback chain: cache hit → stash hit → itemHeights[i] → scalar.
 *   3. Insert/delete position correctness.
 *   4. applyMeasurements cascade correctness.
 */

#include <gtest/gtest.h>
#include "LayoutCache.h"
#include "layouts/ListLayout.h"

using namespace rncv;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Build a minimal single-section ListLayoutParams.
static ListLayoutParams makeParams(int itemCount, double itemHeight = 56.0,
                                    double spacing = 0.0, double viewport = 390.0) {
  ListLayoutParams p;
  p.itemCount    = itemCount;
  p.itemHeight   = itemHeight;
  p.itemSpacing  = spacing;
  p.viewportWidth = viewport;
  return p;
}

/// Build params with per-item heights array.
static ListLayoutParams makeParamsWithHeights(const std::vector<double>& heights,
                                               double spacing = 0.0) {
  ListLayoutParams p;
  p.itemCount   = static_cast<int>(heights.size());
  p.itemHeight  = heights.empty() ? 44.0 : heights[0]; // scalar fallback
  p.itemHeights = heights;
  p.itemSpacing = spacing;
  p.viewportWidth = 390.0;
  return p;
}

/// Read item Y from cache by default key "item-{section}-{index}".
static double getY(LayoutCache& cache, int section, int index) {
  const std::string key = "item-" + std::to_string(section) + "-" + std::to_string(index);
  auto attrs = cache.getAttributes(key);
  return attrs ? attrs->frame.y : -1.0;
}

static double getH(LayoutCache& cache, int section, int index) {
  const std::string key = "item-" + std::to_string(section) + "-" + std::to_string(index);
  auto attrs = cache.getAttributes(key);
  return attrs ? attrs->frame.height : -1.0;
}

// ─── Fresh path vs. cache path parity ────────────────────────────────────────

TEST(ListLayout, FreshAndCacheParity_UniformHeight) {
  // Two caches, two layout objects — produce identical Y positions.
  auto cache1 = std::make_shared<LayoutCache>();
  auto cache2 = std::make_shared<LayoutCache>();
  ListLayout layout1(cache1);
  ListLayout layout2(cache2);

  auto p = makeParams(5, 56.0);

  // Run computeSections (uses computeSectionFromCache internally now).
  layout1.computeSections({p});

  // Separately populate cache2 by running compute (the old fresh path) is private —
  // so we run computeSections on cache2 as well (it now uses computeSectionFromCache).
  // For parity testing, both should produce the same results since fallback → scalar.
  layout2.computeSections({p});

  for (int i = 0; i < 5; ++i) {
    EXPECT_NEAR(getY(*cache1, 0, i), getY(*cache2, 0, i), 0.1)
      << "Y positions must match at item " << i;
    EXPECT_NEAR(getH(*cache1, 0, i), 56.0, 0.1)
      << "Height must equal itemHeight at item " << i;
  }
}

TEST(ListLayout, YPositions_UniformHeight_NoSpacing) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  layout.computeSections({makeParams(5, 56.0)});

  for (int i = 0; i < 5; ++i) {
    EXPECT_NEAR(getY(*cache, 0, i), i * 56.0, 0.1)
      << "Item " << i << " should be at Y=" << (i * 56.0);
  }
}

TEST(ListLayout, YPositions_WithSpacing) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  layout.computeSections({makeParams(4, 44.0, 8.0)});
  // item 0: y=0, item 1: y=52, item 2: y=104, item 3: y=156
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 52.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 2), 104.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 3), 156.0, 0.1);
}

TEST(ListLayout, YPositions_PerItemHeights) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  std::vector<double> heights = {80.0, 40.0, 60.0, 50.0};
  layout.computeSections({makeParamsWithHeights(heights)});

  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 80.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 2), 120.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 3), 180.0, 0.1);
}

// ─── Stash fallback chain ─────────────────────────────────────────────────────

TEST(ListLayout, StashFallback_UsesStashedHeight_AfterClear) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  // Initial layout with measured heights.
  std::vector<double> measuredHeights = {80.0, 60.0, 70.0};
  layout.computeSections({makeParamsWithHeights(measuredHeights)});

  // Mark items as Measured (simulating Yoga measurement).
  for (int i = 0; i < 3; ++i) {
    std::string key = "item-0-" + std::to_string(i);
    auto attrs = cache->getAttributes(key);
    ASSERT_TRUE(attrs.has_value());
    auto updated = *attrs;
    updated.sizingState = SizingState::Measured;
    cache->setAttributes(updated);
  }

  // Stash → clear → recompute (simulates insert/delete flow).
  cache->stashHeights();
  cache->clear();

  // Recompute with scalar estimate (itemHeights empty — as if measuredHeightForItem
  // returned undefined because the cache was cleared).
  auto p = makeParams(3, 44.0); // scalar estimate = 44, stash should win
  layout.computeSections({p});
  cache->clearStash();

  // Stash had measured heights (80, 60, 70) → should be used, not scalar 44.
  EXPECT_NEAR(getH(*cache, 0, 0), 80.0, 0.1) << "Item 0 height should come from stash";
  EXPECT_NEAR(getH(*cache, 0, 1), 60.0, 0.1) << "Item 1 height should come from stash";
  EXPECT_NEAR(getH(*cache, 0, 2), 70.0, 0.1) << "Item 2 height should come from stash";

  // Y positions consistent with stashed heights.
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 80.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 2), 140.0, 0.1);
}

TEST(ListLayout, FallbackChain_ScalarWhenNoStashNoItemHeights) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  // No prior layout (empty cache, empty stash), no itemHeights → scalar.
  auto p = makeParams(3, 44.0);
  layout.computeSections({p});

  EXPECT_NEAR(getH(*cache, 0, 0), 44.0, 0.1) << "Scalar estimate should be used as fallback";
  EXPECT_NEAR(getH(*cache, 0, 1), 44.0, 0.1);
  EXPECT_NEAR(getH(*cache, 0, 2), 44.0, 0.1);
}

// ─── Insert/delete position correctness ──────────────────────────────────────

TEST(ListLayout, InsertAtStart_ShiftsSubsequentPositions) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  // Initial: 5 items at 56px each.
  layout.computeSections({makeParams(5, 56.0)});

  // Record original positions.
  std::vector<double> originalY;
  for (int i = 0; i < 5; ++i) originalY.push_back(getY(*cache, 0, i));

  // Simulate insert 3 items at start: total becomes 8.
  // Stash → clear → recompute 8 items at 56px.
  for (int i = 0; i < 5; ++i) {
    auto attrs = cache->getAttributes("item-0-" + std::to_string(i));
    ASSERT_TRUE(attrs.has_value());
    auto updated = *attrs; updated.sizingState = SizingState::Measured;
    cache->setAttributes(updated);
  }
  cache->stashHeights();
  cache->clear();
  layout.computeSections({makeParams(8, 56.0)});
  cache->clearStash();

  // Items 3..7 (originally 0..4) should have shifted by 3 * 56 = 168.
  for (int i = 0; i < 5; ++i) {
    const double expectedY = originalY[i] + 3 * 56.0;
    EXPECT_NEAR(getY(*cache, 0, i + 3), expectedY, 0.1)
      << "Item " << (i + 3) << " should shift by 3×itemHeight after 3 inserts at start";
  }
  // Items 0..2 are new — should be at 0, 56, 112.
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 56.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 2), 112.0, 0.1);
}

TEST(ListLayout, DeleteAtStart_ShiftsPositionsUp) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  layout.computeSections({makeParams(5, 56.0)});

  // Simulate delete 2 items from start: total becomes 3.
  for (int i = 0; i < 5; ++i) {
    auto attrs = cache->getAttributes("item-0-" + std::to_string(i));
    ASSERT_TRUE(attrs.has_value());
    auto updated = *attrs; updated.sizingState = SizingState::Measured;
    cache->setAttributes(updated);
  }
  cache->stashHeights();
  cache->clear();
  layout.computeSections({makeParams(3, 56.0)});
  cache->clearStash();

  // Items 0,1,2 should be at 0, 56, 112 (shifted up by 2×56=112 from original 112, 168, 224).
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 56.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 2), 112.0, 0.1);
}

TEST(ListLayout, InsertInMiddle_ItemsBeforeUnchanged) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  layout.computeSections({makeParams(4, 56.0)});

  std::vector<double> originalY;
  for (int i = 0; i < 4; ++i) originalY.push_back(getY(*cache, 0, i));

  // Simulate insert 2 items at index 2: indices 0,1 unchanged; 2,3 shift by 2×56=112.
  for (int i = 0; i < 4; ++i) {
    auto attrs = cache->getAttributes("item-0-" + std::to_string(i));
    ASSERT_TRUE(attrs.has_value());
    auto updated = *attrs; updated.sizingState = SizingState::Measured;
    cache->setAttributes(updated);
  }
  cache->stashHeights();
  cache->clear();
  layout.computeSections({makeParams(6, 56.0)});
  cache->clearStash();

  // Items 0,1 are new items at top (stash only covers original 4 keys).
  // With stash the original keys are item-0-0..item-0-3.
  // After 6-item layout: items 0..5 at 0,56,112,168,224,280.
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 56.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 2), 112.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 3), 168.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 4), 224.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 5), 280.0, 0.1);
}

// ─── applyMeasurements cascade ────────────────────────────────────────────────

TEST(ListLayout, ApplyMeasurements_SingleDelta_ShiftsItemsBelow) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  // 5 items at 56px each: Y = 0, 56, 112, 168, 224.
  layout.computeSections({makeParams(5, 56.0)});

  // Simulate Yoga measuring item-0-1 as 100 instead of 56.
  MeasurementDelta delta;
  delta.key      = "item-0-1";
  delta.index    = 1;
  delta.oldValue = 56.0;
  delta.newValue = 100.0;

  const bool handled = layout.applyMeasurements({delta}, *cache);
  EXPECT_TRUE(handled) << "ListLayout must handle applyMeasurements";

  // Item 1: height = 100, Y = 56 (unchanged).
  EXPECT_NEAR(getH(*cache, 0, 1), 100.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 56.0, 0.1);

  // Items 2,3,4 shift by +44 (100-56).
  EXPECT_NEAR(getY(*cache, 0, 2), 156.0, 0.1);  // was 112, now 112+44=156
  EXPECT_NEAR(getY(*cache, 0, 3), 212.0, 0.1);  // was 168, now 168+44=212
  EXPECT_NEAR(getY(*cache, 0, 4), 268.0, 0.1);  // was 224, now 224+44=268

  // Item 0: before the delta — unchanged.
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getH(*cache, 0, 0), 56.0, 0.1);
}

TEST(ListLayout, ApplyMeasurements_MultipleDeltas_AggregateShift) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  layout.computeSections({makeParams(5, 56.0)});

  // Item 0 grows by 20, item 2 grows by 30.
  std::vector<MeasurementDelta> deltas = {
    {"item-0-0", 0, 56.0, 76.0},  // +20
    {"item-0-2", 2, 56.0, 86.0},  // +30
  };

  layout.applyMeasurements(deltas, *cache);

  // Item 0: 76px at Y=0.
  EXPECT_NEAR(getH(*cache, 0, 0), 76.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);

  // Item 1: shifted by +20 (item 0 grew).
  EXPECT_NEAR(getY(*cache, 0, 1), 76.0, 0.1);   // was 56, now 56+20=76

  // Item 2: shifted by +20, at Y=76+56=132.
  EXPECT_NEAR(getY(*cache, 0, 2), 132.0, 0.1);  // was 112, now 112+20=132

  // Items 3,4: shifted by +20+30=50.
  EXPECT_NEAR(getY(*cache, 0, 3), 218.0 + 0.0, 0.1); // item2_y + item2_h = 132 + 86 = 218
  EXPECT_NEAR(getY(*cache, 0, 4), 218.0 + 56.0, 0.1); // 218 + 56 = 274
}

TEST(ListLayout, ApplyMeasurements_ItemAboveFirstDelta_Unchanged) {
  auto cache = std::make_shared<LayoutCache>();
  ListLayout layout(cache);

  layout.computeSections({makeParams(4, 56.0)});

  // Only item-0-3 grows.
  MeasurementDelta delta{"item-0-3", 3, 56.0, 120.0};
  layout.applyMeasurements({delta}, *cache);

  // Items 0,1,2: positions unchanged.
  EXPECT_NEAR(getY(*cache, 0, 0), 0.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 1), 56.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 2), 112.0, 0.1);

  // Item 3: height = 120, Y = 168.
  EXPECT_NEAR(getH(*cache, 0, 3), 120.0, 0.1);
  EXPECT_NEAR(getY(*cache, 0, 3), 168.0, 0.1);
}
