#pragma once

#include <vector>
#include <cmath>
#include <algorithm>

namespace rncv {

/**
 * Inclusive index range into the data array.
 * last < first means empty.
 */
struct Range {
  int first;
  int last;
};

/**
 * Result of computeRanges / computeVariableRanges.
 */
struct WindowState {
  Range render;
  Range visible;
};

/**
 * P1.1 — C++ Window Controller
 *
 * Computes render/visible/measure ranges from scroll position + velocity.
 * All methods are pure arithmetic — no allocations, no locks, sub-microsecond.
 *
 * Fixed-height: O(1) arithmetic.
 * Variable-height: O(log n) binary search on positions array.
 *
 * Thread safety: stateless computation functions. The positions vector
 * is set from JS thread only; scroll handler reads it on JS thread too.
 */
class WindowController {
public:
  // ── Fixed-height range computation (O(1)) ───────────────────────────────────

  /**
   * Compute render and visible index ranges from scroll position.
   *
   * velocity: px/ms, positive = scrolling down. 0 = symmetric.
   * Each 1 px/ms of speed adds 1 additional viewport on the leading edge
   * (capped at +4 viewports). Trailing edge shrinks to minimum 0.25×.
   */
  static WindowState computeRanges(
    double scrollY,
    double vpHeight,
    int    itemCount,
    double stride,
    double renderMult,
    double sectionInsetTop,
    double velocity
  ) {
    if (itemCount == 0 || stride <= 0) {
      return { {0, -1}, {0, -1} };
    }

    double speed     = std::abs(velocity);
    double leadBoost = std::min(4.0, speed) * renderMult;
    double leadMult  = renderMult + leadBoost;
    double trailMult = std::max(0.25, renderMult - leadBoost * 0.5);
    bool   goingDown = velocity >= 0;

    double abovePad = (goingDown ? trailMult : leadMult) * vpHeight;
    double belowPad = (goingDown ? leadMult  : trailMult) * vpHeight;

    double adj = scrollY - sectionInsetTop;

    Range render {
      std::max(0,             static_cast<int>(std::floor((adj - abovePad) / stride)) - 1),
      std::min(itemCount - 1, static_cast<int>(std::ceil((adj + vpHeight + belowPad) / stride)) + 1),
    };
    Range visible {
      std::max(0,             static_cast<int>(std::floor(adj / stride)) - 1),
      std::min(itemCount - 1, static_cast<int>(std::ceil((adj + vpHeight) / stride)) + 1),
    };

    return { render, visible };
  }

  // ── Variable-height range computation (O(log n)) ────────────────────────────

  /**
   * Binary search: last index where positions[i] < bound.
   */
  static int posFirst(const double* positions, int count, double bound) {
    int lo = 0, hi = count - 1;
    while (lo < hi) {
      int mid = (lo + hi) >> 1;
      if (positions[mid] < bound) lo = mid + 1;
      else hi = mid;
    }
    return std::max(0, lo - 1);
  }

  /**
   * Binary search: last index where positions[i] <= bound.
   */
  static int posLast(const double* positions, int count, double bound) {
    int lo = 0, hi = count - 1;
    while (lo < hi) {
      int mid = (lo + hi + 1) >> 1;
      if (positions[mid] <= bound) lo = mid;
      else hi = mid - 1;
    }
    return (count > 0 && positions[lo] <= bound) ? lo : -1;
  }

  /**
   * Variable-height variant. Uses actual item positions for accurate ranges.
   * positions[i] = top-Y of item i.
   */
  static WindowState computeVariableRanges(
    double        scrollY,
    double        vpHeight,
    const double* positions,
    int           posCount,
    int           itemCount,
    double        renderMult,
    double        velocity
  ) {
    if (itemCount == 0 || posCount == 0) {
      return { {0, -1}, {0, -1} };
    }

    double speed     = std::abs(velocity);
    double leadBoost = std::min(4.0, speed) * renderMult;
    double leadMult  = renderMult + leadBoost;
    double trailMult = std::max(0.25, renderMult - leadBoost * 0.5);
    bool   goingDown = velocity >= 0;

    double abovePad = (goingDown ? trailMult : leadMult) * vpHeight;
    double belowPad = (goingDown ? leadMult  : trailMult) * vpHeight;

    int rFirst = posFirst(positions, posCount, scrollY - abovePad);
    int rLast  = std::min(itemCount - 1, posLast(positions, posCount, scrollY + vpHeight + belowPad) + 1);
    int vFirst = posFirst(positions, posCount, scrollY);
    int vLast  = std::min(itemCount - 1, posLast(positions, posCount, scrollY + vpHeight) + 1);

    return {
      { rFirst, rLast },
      { vFirst, vLast },
    };
  }

  // ── Budget constraint (M3.5) ────────────────────────────────────────────────

  /**
   * Trims render range to fit within mountedWindowSize viewport-multiples.
   * Visible range anchors the trim so the visible area is always covered.
   */
  static Range applyBudget(
    Range  render,
    Range  visible,
    double mountedWindowSize,
    double vpHeight,
    double stride
  ) {
    if (stride <= 0 || vpHeight <= 0) return render;
    // mountedWindowSize == Infinity check: if > 1e9, treat as unlimited
    if (mountedWindowSize > 1e9) return render;

    int budget = static_cast<int>(std::ceil((mountedWindowSize * vpHeight) / stride));
    int size   = render.last - render.first + 1;
    if (size <= budget) return render;

    double visibleMid = (visible.first + visible.last) / 2.0;
    int    half       = budget / 2;
    int    first      = std::max(render.first, static_cast<int>(std::round(visibleMid)) - half);
    int    last       = std::min(render.last,  first + budget - 1);
    int    adjFirst   = std::max(render.first, last - budget + 1);
    return { adjFirst, last };
  }

  // ── Measure range (M4.1) ────────────────────────────────────────────────────

  /**
   * Compute measure range: extends budgeted render range by `ahead` items
   * in both directions, clamped to [0, itemCount-1].
   */
  static Range computeMeasureRange(
    Range budgeted,
    int   ahead,
    int   itemCount
  ) {
    return {
      std::max(0,             budgeted.first - ahead),
      std::min(itemCount - 1, budgeted.last  + ahead),
    };
  }
};

} // namespace rncv
