// performance.now() is provided by Hermes; declare for tsc.
declare const performance: { now(): number };

/**
 * M1.4 — SpatialIndex: getAttributesInRect correctness + performance
 *
 * Acceptance criteria:
 *   · viewport-sized rect returns exactly 14 items (items 0–13)
 *   · all returned items actually intersect the query rect (no false positives)
 *   · mid-list rect also returns exactly 14 items (no false negatives)
 *   · 100 iterations of getAttributesInRect < 100ms total
 */
import React, { useEffect, useState } from 'react';
import { native } from './native';
import { TestResult, TestScreen } from './shared';

// ─── Constants ────────────────────────────────────────────────────────────────

const ITEMS  = 1000;
const ITEM_H = 44;
const WIDTH  = 390;

// ─── Tests ────────────────────────────────────────────────────────────────────

function runTests(): TestResult[] {
  const results: TestResult[] = [];

  native.layoutCache.clear();
  native.listLayout.computeListLayout({
    itemCount:          ITEMS,
    itemHeight:         ITEM_H,
    viewportWidth:      WIDTH,
    sectionInsetTop:    0,
    sectionInsetBottom: 0,
    sectionInsetLeft:   0,
    sectionInsetRight:  0,
    itemSpacing:        0,
    section:            0,
    keyPrefix:          'item-0-',
  });

  const viewportRect = { x: 0, y: 0, width: 390, height: 600 };

  // ── Test 1: Correct count for viewport-sized rect ────────────────────────
  // items 0–13 intersect (item 13: y=572, bottom=616 > 0 and y=572 < 600 ✓;
  // item 14: y=616 >= 600 ✗)
  const vpItems = native.layoutCache.getAttributesInRect(viewportRect);
  results.push({
    label: 'getAttributesInRect(viewport 600px) → exactly 14 items',
    value: `got ${vpItems.length} item(s)`,
    pass:  vpItems.length === 14,
  });

  // ── Test 2: No false positives ───────────────────────────────────────────
  let fpOk = true;
  let fpDetail = '';
  for (const item of vpItems) {
    const intersects =
      item.frame.y < viewportRect.y + viewportRect.height &&
      item.frame.y + item.frame.height > viewportRect.y;
    if (!intersects) {
      fpOk     = false;
      fpDetail = `${item.key}: y=${item.frame.y} h=${item.frame.height} does not intersect rect`;
      break;
    }
  }
  results.push({
    label: 'No false positives — all returned items intersect the rect',
    value: fpOk ? `${vpItems.length}/${vpItems.length} correct` : fpDetail,
    pass:  fpOk,
  });

  // ── Test 3: No false negatives (mid-list) ────────────────────────────────
  // rect y=10000 height=600 → items whose y < 10600 and y+44 > 10000
  // item 227: y=9988, bottom=10032 > 10000 ✓
  // item 241: y=10604 >= 10600 ✗  → expect 14 results
  const midRect = { x: 0, y: 10000, width: 390, height: 600 };
  const midItems = native.layoutCache.getAttributesInRect(midRect);
  results.push({
    label: 'getAttributesInRect(mid-list y=10000 h=600) → exactly 14 items',
    value: `got ${midItems.length} item(s)`,
    pass:  midItems.length === 14,
  });

  // ── Test 4: Performance — 100 iterations < 100ms ─────────────────────────
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    native.layoutCache.getAttributesInRect(viewportRect);
  }
  const totalMs = performance.now() - t0;
  results.push({
    label: '100 × getAttributesInRect < 100ms total',
    value: `${totalMs.toFixed(2)}ms total (${(totalMs / 100).toFixed(2)}ms avg)`,
    pass:  totalMs < 100,
  });

  return results;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M1_4_SpatialIndex() {
  const [results, setResults] = useState<TestResult[]>([]);
  useEffect(() => { setResults(runTests()); }, []);

  return (
    <TestScreen
      title="M1.4 — SpatialIndex: getAttributesInRect"
      subtitle={`${ITEMS.toLocaleString()} items · height ${ITEM_H}px · width ${WIDTH}px`}
      results={results}
    />
  );
}
