/**
 * M1.3 — ListLayout: variable heights + invalidateListLayoutFrom
 *
 * Acceptance criteria:
 *   · each item's frame.height matches its entry in HEIGHTS[]
 *   · cumulative Y positions are correct
 *   · sizingState = 'placeholder' for all 5 items
 *   · invalidateListLayoutFrom leaves items before the pivot unchanged
 *   · invalidateListLayoutFrom reflows the tail from the correct Y
 */
import React, { useEffect, useState } from 'react';
import { native } from './native';
import { TestResult, TestScreen } from './shared';

// ─── Constants ────────────────────────────────────────────────────────────────

const HEIGHTS = [100, 200, 150, 80, 120];
const WIDTH   = 390;

// ─── Tests ────────────────────────────────────────────────────────────────────

function runTests(): TestResult[] {
  const results: TestResult[] = [];

  native.layoutCache.clear();

  native.listLayout.computeListLayout({
    itemCount:          5,
    itemHeights:        HEIGHTS,
    viewportWidth:      WIDTH,
    sectionInsetTop:    0,
    sectionInsetBottom: 0,
    sectionInsetLeft:   0,
    sectionInsetRight:  0,
    itemSpacing:        0,
    section:            0,
    keyPrefix:          'item-0-',
  });

  // ── Test 1: Variable heights stored ──────────────────────────────────────
  let heightsOk = true;
  let heightDetail = '';
  for (let i = 0; i < HEIGHTS.length; i++) {
    const a = native.layoutCache.getAttributes(`item-0-${i}`);
    if (!a || a.frame.height !== HEIGHTS[i]) {
      heightsOk    = false;
      heightDetail = `item-0-${i}: got height=${a?.frame.height ?? 'null'}, expected ${HEIGHTS[i]}`;
      break;
    }
  }
  results.push({
    label: 'Variable heights stored for all 5 items',
    value: heightsOk ? `${HEIGHTS.length}/${HEIGHTS.length} correct` : heightDetail,
    pass:  heightsOk,
  });

  // ── Test 2: Cumulative Y positions correct ────────────────────────────────
  // item-0-0 y=0, item-0-1 y=100, item-0-2 y=300, item-0-3 y=450, item-0-4 y=530
  const expectedYs = [0, 100, 300, 450, 530];
  let yOk = true;
  let yDetail = '';
  for (let i = 0; i < expectedYs.length; i++) {
    const a = native.layoutCache.getAttributes(`item-0-${i}`);
    if (!a || a.frame.y !== expectedYs[i]) {
      yOk     = false;
      yDetail = `item-0-${i}: got y=${a?.frame.y ?? 'null'}, expected ${expectedYs[i]}`;
      break;
    }
  }
  results.push({
    label: 'Cumulative Y positions (0, 100, 300, 450, 530)',
    value: yOk ? `${expectedYs.length}/${expectedYs.length} correct` : yDetail,
    pass:  yOk,
  });

  // ── Test 3: sizingState = 'placeholder' ──────────────────────────────────
  let placeholderOk = true;
  let placeholderDetail = '';
  for (let i = 0; i < HEIGHTS.length; i++) {
    const a = native.layoutCache.getAttributes(`item-0-${i}`);
    if (!a || a.sizingState !== 'placeholder') {
      placeholderOk    = false;
      placeholderDetail = `item-0-${i}: sizingState=${a?.sizingState ?? 'null'}`;
      break;
    }
  }
  results.push({
    label: 'sizingState = "placeholder" for all 5 items',
    value: placeholderOk ? `${HEIGHTS.length}/${HEIGHTS.length} correct` : placeholderDetail,
    pass:  placeholderOk,
  });

  // ── Test 4: invalidateListLayoutFrom preserves items before pivot ─────────
  const item0Before = native.layoutCache.getAttributes('item-0-0');
  const yBefore = item0Before?.frame.y ?? -1;

  // mutate item-0-1 height to 300 in the cache
  const item1 = native.layoutCache.getAttributes('item-0-1');
  if (item1) {
    native.layoutCache.setAttributes({
      ...item1,
      frame:             { ...item1.frame, height: 300 },
      sizingState:       'measured',
      zIndex:            0,
      isSupplementary:   false,
      supplementaryKind: null,
      isDirty:           false,
      tier:              'outside',
      isSticky:          false,
      alpha:             1,
      isAnimating:       false,
    });
  }

  native.listLayout.invalidateListLayoutFrom('item-0-1', {
    itemCount:          5,
    itemHeight:         44,
    viewportWidth:      WIDTH,
    sectionInsetTop:    0,
    sectionInsetBottom: 0,
    sectionInsetLeft:   0,
    sectionInsetRight:  0,
    itemSpacing:        0,
    section:            0,
    keyPrefix:          'item-0-',
  });

  const item0After = native.layoutCache.getAttributes('item-0-0');
  const yAfter = item0After?.frame.y ?? -1;
  const pivotPreserved = yAfter === 0;
  results.push({
    label: 'invalidateListLayoutFrom: item-0-0.y unchanged (still 0)',
    value: `before=${yBefore} after=${yAfter}`,
    pass:  pivotPreserved,
  });

  // ── Test 5: invalidateListLayoutFrom reflows tail correctly ───────────────
  // After step 4: item-0-1 y=100 h=300, item-0-2 y=400 h=150,
  //               item-0-3 y=550 h=80,  item-0-4 y=630 h=120
  type Expectation = { key: string; y: number; h: number };
  const tailExpected: Expectation[] = [
    { key: 'item-0-1', y: 100, h: 300 },
    { key: 'item-0-2', y: 400, h: 150 },
    { key: 'item-0-3', y: 550, h: 80  },
    { key: 'item-0-4', y: 630, h: 120 },
  ];
  let tailOk = true;
  let tailDetail = '';
  for (const exp of tailExpected) {
    const a = native.layoutCache.getAttributes(exp.key);
    if (!a || a.frame.y !== exp.y || a.frame.height !== exp.h) {
      tailOk     = false;
      tailDetail = `${exp.key}: got y=${a?.frame.y ?? 'null'} h=${a?.frame.height ?? 'null'}, expected y=${exp.y} h=${exp.h}`;
      break;
    }
  }
  results.push({
    label: 'invalidateListLayoutFrom: tail reflowed correctly',
    value: tailOk ? `${tailExpected.length}/${tailExpected.length} correct` : tailDetail,
    pass:  tailOk,
  });

  return results;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M1_3_ListLayoutEstimated() {
  const [results, setResults] = useState<TestResult[]>([]);
  useEffect(() => { setResults(runTests()); }, []);

  return (
    <TestScreen
      title="M1.3 — ListLayout: variable heights + invalidate"
      subtitle={`heights: [${HEIGHTS.join(', ')}] · width ${WIDTH}px`}
      results={results}
    />
  );
}
