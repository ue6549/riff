/**
 * MVCCorrectionTest.cpp — Unit tests for MVC (maintainVisibleContentPosition) correction.
 *
 * Tests the three-method protocol:
 *   snapshotAnchor() / snapshotAnchorIfNeeded() → computeCorrection()
 *
 * And the _correctionConsumed flag that prevents re-arming during animated scrollTo.
 */

#include <gtest/gtest.h>
#include "LayoutCache.h"

using namespace rncv;

// Helper: create a LayoutAttributes entry at the given Y position.
static LayoutAttributes makeItem(const std::string& key, double y, double height = 56.0,
                                  SizingState state = SizingState::Measured) {
  LayoutAttributes a;
  a.key         = key;
  a.frame       = {0, y, 390, height};
  a.sizingState = state;
  return a;
}

// Helper: place a scrollOffset on the cache.
static void setScroll(LayoutCache& cache, double y) {
  cache.setScrollOffset(0, y, 0);
}

// ─── snapshotAnchor + computeCorrection ──────────────────────────────────────

TEST(MVCCorrection, ZeroCorrection_WhenPositionUnchanged) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 60));
  cache.setAttributes(makeItem("item-0-2", 120));
  setScroll(cache, 60);

  // Snapshot before layout, then don't change positions.
  cache.snapshotAnchor();
  const double correction = cache.computeCorrection();

  EXPECT_NEAR(correction, 0.0, 0.5) << "No position change → correction should be zero";
}

TEST(MVCCorrection, CorrectDelta_WhenAnchorShifts) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  // Initial layout: items at 0, 56, 112, 168, 224.
  for (int i = 0; i < 5; ++i) {
    cache.setAttributes(makeItem("item-0-" + std::to_string(i), i * 56.0));
  }
  setScroll(cache, 112); // scrolled to item-0-2

  cache.snapshotAnchor(); // anchor = item-0-2 at y=112

  // Simulate insert 1 item at top (all positions shift by 56).
  for (int i = 0; i < 5; ++i) {
    cache.setAttributes(makeItem("item-0-" + std::to_string(i), (i + 1) * 56.0));
  }

  const double correction = cache.computeCorrection();
  // item-0-2 was at 112, now at 168 → delta = +56.
  EXPECT_NEAR(correction, 56.0, 0.5) << "Insert at top should produce +56 correction";
}

TEST(MVCCorrection, NegativeDelta_WhenAnchorShiftsUp) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  // Initial: items at 0, 56, 112.
  for (int i = 0; i < 3; ++i) {
    cache.setAttributes(makeItem("item-0-" + std::to_string(i), i * 56.0));
  }
  setScroll(cache, 112);
  cache.snapshotAnchor(); // anchor = item-0-2 at y=112

  // Simulate delete 1 item at top (all positions shift down by 56).
  for (int i = 0; i < 3; ++i) {
    cache.setAttributes(makeItem("item-0-" + std::to_string(i), i * 56.0 - 56.0 < 0 ? 0 : i * 56.0 - 56.0));
  }
  // item-0-2 moves from 112 to 56 (shift -56).
  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 56));
  cache.setAttributes(makeItem("item-0-2", 56)); // item at 56 now (was at 112)
  // Re-emit correctly: anchor key is item-0-2, new pos = 56.
  LayoutAttributes anchor = makeItem("item-0-2", 56.0);
  cache.setAttributes(anchor);

  const double correction = cache.computeCorrection();
  EXPECT_NEAR(correction, -56.0, 0.5) << "Delete at top should produce -56 correction";
}

TEST(MVCCorrection, AnchorDeleted_ReturnsZero) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 56));
  setScroll(cache, 56);
  cache.snapshotAnchor(); // anchor = item-0-1

  // Delete the anchor item.
  cache.removeAttributes("item-0-1");

  const double correction = cache.computeCorrection();
  EXPECT_NEAR(correction, 0.0, 0.5) << "Deleted anchor → correction should be zero (no crash)";
}

TEST(MVCCorrection, ComputeCorrection_OneShotPerTransaction) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 56));
  setScroll(cache, 56);
  cache.snapshotAnchor();

  // Shift item-0-1 by 100.
  cache.setAttributes(makeItem("item-0-1", 156));
  const double c1 = cache.computeCorrection();
  EXPECT_NEAR(c1, 100.0, 0.5);

  // Second call should return 0 (hasAnchor = false after first call).
  const double c2 = cache.computeCorrection();
  EXPECT_NEAR(c2, 0.0, 0.5) << "computeCorrection is one-shot; second call must return 0";
}

// ─── _correctionConsumed flag ─────────────────────────────────────────────────

TEST(MVCCorrection, CorrectionConsumed_PreventsSnapshotAnchorIfNeeded) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  // Phase 1: JS snapshotAnchor (simulates prepare useMemo).
  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 56));
  setScroll(cache, 0);
  cache.snapshotAnchor();  // _correctionConsumed = false, _hasAnchor = true

  // Phase 2: positions shift (insert), computeCorrection fires.
  cache.setAttributes(makeItem("item-0-1", 112));
  const double correction = cache.computeCorrection();
  // After computeCorrection: _hasAnchor = false, _correctionConsumed = true.
  EXPECT_NE(correction, 0.0); // non-zero correction happened

  // Phase 3: ShadowNode calls snapshotAnchorIfNeeded (simulates scrollTo animation path).
  // Should be a no-op because _correctionConsumed = true.
  cache.setAttributes(makeItem("item-0-2", 168));
  setScroll(cache, 10); // different scroll position
  cache.snapshotAnchorIfNeeded();

  // If snapshotAnchorIfNeeded fired, it would set _hasAnchor = true.
  // computeCorrection would then return a non-zero delta.
  // Expected: returns 0 because snapshotAnchorIfNeeded was blocked.
  cache.setAttributes(makeItem("item-0-2", 200)); // shift anchor's position
  const double c2 = cache.computeCorrection();
  EXPECT_NEAR(c2, 0.0, 0.5)
    << "_correctionConsumed should prevent snapshotAnchorIfNeeded from re-arming";
}

TEST(MVCCorrection, SnapshotAnchor_ResetsCorrectionConsumed) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 56));
  setScroll(cache, 0);

  // Transaction 1: snapshot → shift → correct → consumed.
  cache.snapshotAnchor();
  cache.setAttributes(makeItem("item-0-1", 100));
  const double c1 = cache.computeCorrection();
  EXPECT_NE(c1, 0.0);

  // At this point _correctionConsumed = true.
  // snapshotAnchorIfNeeded should be blocked.
  cache.snapshotAnchorIfNeeded();
  cache.setAttributes(makeItem("item-0-1", 150));
  EXPECT_NEAR(cache.computeCorrection(), 0.0, 0.5)
    << "snapshotAnchorIfNeeded must be blocked while correctionConsumed=true";

  // Transaction 2: snapshotAnchor() resets _correctionConsumed.
  setScroll(cache, 100);
  cache.snapshotAnchor(); // _correctionConsumed = false again
  cache.setAttributes(makeItem("item-0-1", 200));
  const double c2 = cache.computeCorrection();
  EXPECT_NE(c2, 0.0) << "After snapshotAnchor(), correction should work again";
}

TEST(MVCCorrection, MVCDisabled_SnapshotAnchorIfNeeded_IsNoOp) {
  LayoutCache cache;
  cache.setMVCEnabled(false); // disabled

  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 56));
  setScroll(cache, 0);

  cache.snapshotAnchorIfNeeded();
  cache.setAttributes(makeItem("item-0-1", 100));

  const double correction = cache.computeCorrection();
  EXPECT_NEAR(correction, 0.0, 0.5)
    << "snapshotAnchorIfNeeded must be a no-op when MVC is disabled";
}

// ─── consumePendingCorrection ─────────────────────────────────────────────────

TEST(MVCCorrection, ConsumePendingCorrection_ClearsAfterRead) {
  LayoutCache cache;
  cache.setMVCEnabled(true);

  cache.setAttributes(makeItem("item-0-0", 0));
  cache.setAttributes(makeItem("item-0-1", 56));
  setScroll(cache, 56);
  cache.snapshotAnchor();
  cache.setAttributes(makeItem("item-0-1", 112));
  cache.computeCorrection(); // stores pending

  const double p1 = cache.consumePendingCorrection();
  EXPECT_NEAR(p1, 56.0, 0.5);

  const double p2 = cache.consumePendingCorrection(); // second read
  EXPECT_NEAR(p2, 0.0, 0.5) << "consumePendingCorrection is one-shot";
}

// ─── Height stash ─────────────────────────────────────────────────────────────

TEST(HeightStash, StashSurvivesClear) {
  LayoutCache cache;

  cache.setAttributes(makeItem("item-0-0", 0, 80.0, SizingState::Measured));
  cache.setAttributes(makeItem("item-0-1", 80, 60.0, SizingState::Measured));

  cache.stashHeights();
  cache.clear();

  EXPECT_NEAR(cache.getStashedHeight("item-0-0"), 80.0, 0.1);
  EXPECT_NEAR(cache.getStashedHeight("item-0-1"), 60.0, 0.1);
  EXPECT_NEAR(cache.getStashedHeight("item-0-99"), -1.0, 0.1)
    << "Unknown key should return -1";
}

TEST(HeightStash, PlaceholderNotStashed) {
  LayoutCache cache;
  // Placeholder items are NOT stashed (only Measured items are).
  cache.setAttributes(makeItem("item-0-0", 0, 56.0, SizingState::Placeholder));

  cache.stashHeights();
  EXPECT_NEAR(cache.getStashedHeight("item-0-0"), -1.0, 0.1)
    << "Placeholder items must not be stashed";
}

TEST(HeightStash, ClearStash_ReleasesMemory) {
  LayoutCache cache;
  cache.setAttributes(makeItem("item-0-0", 0, 80.0, SizingState::Measured));
  cache.stashHeights();
  cache.clearStash();

  EXPECT_NEAR(cache.getStashedHeight("item-0-0"), -1.0, 0.1)
    << "After clearStash(), stash should be empty";
}
