// performance.now() is provided by Hermes; declare for tsc.
declare const performance: { now(): number };

/**
 * M1.2 — ListLayout: fixed-height single-section
 *
 * Acceptance criteria:
 *   · computeListLayout(1000 items @ 44px) < 25ms (includes SpatialIndex overhead from M1.4)
 *   · item-0-0.frame.y = 0 (sectionInsetTop=0)
 *   · item-0-999.frame.y = 999 * 44 = 43956
 *   · all items frame.width = 390 (spot-check)
 *   · sizingState = 'measured' for all items (spot-check)
 *   · getTotalContentSize().height = 1000 * 44 = 44000
 */
import React, { useEffect, useState } from 'react';
import { native } from './native';
import { TestResult, TestScreen } from './shared';

// ─── Constants ────────────────────────────────────────────────────────────────

const ITEMS     = 1000;
const ITEM_H    = 44;
const SPACING   = 0;
const INSET_TOP = 0;
const WIDTH     = 390;

// ─── Tests ────────────────────────────────────────────────────────────────────

function runTests(): TestResult[] {
  const results: TestResult[] = [];

  native.layoutCache.clear();

  // ── Test 1: Performance < 25ms ───────────────────────────────────────────
  const t0 = performance.now();
  native.listLayout.computeListLayout({
    itemCount:          ITEMS,
    itemHeight:         ITEM_H,
    viewportWidth:      WIDTH,
    sectionInsetTop:    INSET_TOP,
    sectionInsetBottom: 0,
    sectionInsetLeft:   0,
    sectionInsetRight:  0,
    itemSpacing:        SPACING,
    section:            0,
    keyPrefix:          'item-0-',
  });
  const computeMs = performance.now() - t0;
  results.push({
    label: `computeListLayout ${ITEMS.toLocaleString()} items performance < 25ms`,
    value: `${computeMs.toFixed(2)}ms`,
    pass:  computeMs < 25,
  });

  // ── Test 2: item-0-0.frame.y = sectionInsetTop (0) ──────────────────────
  const item0 = native.layoutCache.getAttributes('item-0-0');
  results.push({
    label: 'item-0-0.frame.y = 0 (sectionInsetTop)',
    value: `got y=${item0?.frame.y ?? 'null'}`,
    pass:  item0?.frame.y === 0,
  });

  // ── Test 3: item-0-999.frame.y = 999 * ITEM_H = 43956 ───────────────────
  const item999 = native.layoutCache.getAttributes('item-0-999');
  const expectedY999 = 999 * ITEM_H;
  results.push({
    label: `item-0-999.frame.y = ${expectedY999}`,
    value: `got y=${item999?.frame.y ?? 'null'}`,
    pass:  item999?.frame.y === expectedY999,
  });

  // ── Test 4: All items frame.width = WIDTH (spot-check) ───────────────────
  const spotKeys = ['item-0-0', 'item-0-100', 'item-0-500', 'item-0-999'];
  let widthOk = true;
  let widthDetail = '';
  for (const key of spotKeys) {
    const a = native.layoutCache.getAttributes(key);
    if (!a || a.frame.width !== WIDTH) {
      widthOk     = false;
      widthDetail = `${key}: width=${a?.frame.width ?? 'null'}`;
      break;
    }
  }
  results.push({
    label: `frame.width = ${WIDTH} for items 0, 100, 500, 999`,
    value: widthOk ? `${spotKeys.length}/${spotKeys.length} correct` : widthDetail,
    pass:  widthOk,
  });

  // ── Test 5: sizingState = 'measured' for all (spot-check) ────────────────
  const sizingKeys = ['item-0-0', 'item-0-499', 'item-0-999'];
  let sizingOk = true;
  let sizingDetail = '';
  for (const key of sizingKeys) {
    const a = native.layoutCache.getAttributes(key);
    if (!a || a.sizingState !== 'measured') {
      sizingOk     = false;
      sizingDetail = `${key}: sizingState=${a?.sizingState ?? 'null'}`;
      break;
    }
  }
  results.push({
    label: 'sizingState = "measured" for items 0, 499, 999',
    value: sizingOk ? `${sizingKeys.length}/${sizingKeys.length} correct` : sizingDetail,
    pass:  sizingOk,
  });

  // ── Test 6: getTotalContentSize().height = ITEMS * ITEM_H ────────────────
  const expectedHeight = ITEMS * ITEM_H;
  const size = native.layoutCache.getTotalContentSize();
  results.push({
    label: `getTotalContentSize().height = ${expectedHeight.toLocaleString()}`,
    value: `got height=${size.height}`,
    pass:  size.height === expectedHeight,
  });

  return results;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M1_2_ListLayoutFixed() {
  const [results, setResults] = useState<TestResult[]>([]);
  useEffect(() => { setResults(runTests()); }, []);

  return (
    <TestScreen
      title="M1.2 — ListLayout: fixed height"
      subtitle={`${ITEMS.toLocaleString()} items · height ${ITEM_H}px · spacing ${SPACING}px`}
      results={results}
    />
  );
}
