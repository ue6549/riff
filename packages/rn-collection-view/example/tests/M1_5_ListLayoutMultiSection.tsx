// performance.now() is provided by Hermes; declare for tsc.
declare const performance: { now(): number };

/**
 * M1.5 — ListLayout: multi-section with headers/footers
 *
 * Acceptance criteria:
 *   · 10 sections × 1 000 items: computeSections < 25ms (includes SpatialIndex overhead from M1.4)
 *   · sectionOffsets[N] = correct absolute Y of section N's first item
 *   · header[N].frame.y = sectionOffsets[N] - headerHeight (sectionInsetTop=0)
 *   · footer[N].frame.y = last item bottom + sectionInsetBottom
 *   · invalidateSectionsFrom(5) leaves sections 0–4 untouched
 *   · invalidateSectionsFrom(5) reflows sections 5–9 from the correct Y
 */
import React, { useEffect, useState } from 'react';
import NativeCollectionViewModule from '../components/NativeCollectionViewModule';
import { TestResult, TestScreen } from './shared';

// ─── Native types ──────────────────────────────────────────────────────────────

type Frame = { x: number; y: number; width: number; height: number };
type NativeAttrs = {
  key: string; section: number; index: number; frame: Frame;
  isSupplementary: boolean; supplementaryKind: string | null;
  sizingState: string; zIndex: number; isDirty: boolean; tier: string;
  isSticky: boolean; alpha: number; isAnimating: boolean;
};

const native = NativeCollectionViewModule as unknown as {
  layoutCache: {
    clear(): void;
    setAttributes(a: NativeAttrs): void;
    getAttributes(key: string): NativeAttrs | null;
    getSectionOffsets(): number[];
    getTotalContentSize(): { width: number; height: number };
  };
  listLayout: {
    computeSections(sections: object[]): void;
    invalidateSectionsFrom(sectionIndex: number, sections: object[]): void;
  };
};

// ─── Test data ────────────────────────────────────────────────────────────────

const SECTIONS      = 10;
const ITEMS         = 1_000;
const ITEM_H        = 44;
const HEADER_H      = 48;
const FOOTER_H      = 24;
const INSET_TOP     = 0;
const INSET_BOTTOM  = 8;
const SPACING       = 0;
const WIDTH         = 390;

function makeSections() {
  return Array.from({ length: SECTIONS }, (_, s) => ({
    itemCount:          ITEMS,
    itemHeight:         ITEM_H,
    headerHeight:       HEADER_H,
    footerHeight:       FOOTER_H,
    sectionInsetTop:    INSET_TOP,
    sectionInsetBottom: INSET_BOTTOM,
    sectionInsetLeft:   0,
    sectionInsetRight:  0,
    itemSpacing:        SPACING,
    viewportWidth:      WIDTH,
    keyPrefix:          `item-${s}-`,
  }));
}

function expectedSectionOffset(sectionIndex: number): number {
  const itemsHeight   = ITEMS * ITEM_H + (ITEMS - 1) * SPACING;
  const sectionHeight = HEADER_H + INSET_TOP + itemsHeight + INSET_BOTTOM + FOOTER_H;
  return sectionIndex * sectionHeight + HEADER_H + INSET_TOP;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function runTests(): TestResult[] {
  const results: TestResult[] = [];
  const sections = makeSections();

  native.layoutCache.clear();

  // ── Test 1: compute 10 × 1000 items < 25ms ───────────────────────────────
  const t0 = performance.now();
  native.listLayout.computeSections(sections);
  const computeMs = performance.now() - t0;
  results.push({
    label: `computeSections ${SECTIONS} × ${ITEMS.toLocaleString()} items`,
    value: `${computeMs.toFixed(2)}ms`,
    pass:  computeMs < 25,
  });

  // ── Test 2: sectionOffsets correctness ───────────────────────────────────
  const offsets = native.layoutCache.getSectionOffsets();
  let offsetsOk = true;
  let offsetDetail = '';
  for (let s = 0; s < SECTIONS; s++) {
    const expected = expectedSectionOffset(s);
    if (Math.abs((offsets[s] ?? -1) - expected) > 0.001) {
      offsetsOk    = false;
      offsetDetail = `s${s}: got ${offsets[s]}, expected ${expected}`;
      break;
    }
  }
  results.push({
    label: 'sectionOffsets[N] = first item Y for all sections',
    value: offsetsOk ? `${SECTIONS} sections correct` : offsetDetail,
    pass:  offsetsOk,
  });

  // ── Test 3: header[N].frame.y = sectionOffsets[N] - headerHeight ─────────
  let headersOk = true;
  let headerDetail = '';
  for (let s = 0; s < SECTIONS; s++) {
    const header         = native.layoutCache.getAttributes(`item-${s}-header`);
    const expectedHeaderY = (offsets[s] ?? 0) - HEADER_H;
    if (!header || Math.abs(header.frame.y - expectedHeaderY) > 0.001) {
      headersOk    = false;
      headerDetail = `s${s}: header.y=${header?.frame.y}, expected ${expectedHeaderY}`;
      break;
    }
    if (!header.isSupplementary || header.supplementaryKind !== 'header') {
      headersOk    = false;
      headerDetail = `s${s}: isSupplementary=${header.isSupplementary} kind=${header.supplementaryKind}`;
      break;
    }
  }
  results.push({
    label: 'header[N].y = sectionOffsets[N] − headerHeight, isSupplementary',
    value: headersOk ? `${SECTIONS} headers correct` : headerDetail,
    pass:  headersOk,
  });

  // ── Test 4: footer[N].frame.y = last item bottom + insetBottom ───────────
  let footersOk = true;
  let footerDetail = '';
  for (let s = 0; s < SECTIONS; s++) {
    const lastItem = native.layoutCache.getAttributes(`item-${s}-${ITEMS - 1}`);
    const footer   = native.layoutCache.getAttributes(`item-${s}-footer`);
    if (!lastItem || !footer) { footersOk = false; footerDetail = `s${s}: missing`; break; }
    const expectedFooterY = lastItem.frame.y + lastItem.frame.height + INSET_BOTTOM;
    if (Math.abs(footer.frame.y - expectedFooterY) > 0.001) {
      footersOk    = false;
      footerDetail = `s${s}: footer.y=${footer.frame.y}, expected ${expectedFooterY}`;
      break;
    }
    if (!footer.isSupplementary || footer.supplementaryKind !== 'footer') {
      footersOk    = false;
      footerDetail = `s${s}: kind=${footer.supplementaryKind}`;
      break;
    }
  }
  results.push({
    label: 'footer[N].y = lastItem.bottom + insetBottom, isSupplementary',
    value: footersOk ? `${SECTIONS} footers correct` : footerDetail,
    pass:  footersOk,
  });

  // ── Test 5: invalidateSectionsFrom(5) leaves sections 0–4 untouched ──────
  const offsetsBefore = native.layoutCache.getSectionOffsets().slice();

  const item5_0 = native.layoutCache.getAttributes('item-5-0')!;
  native.layoutCache.setAttributes({
    ...item5_0,
    frame:             { ...item5_0.frame, height: ITEM_H + 100 },
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

  const tInv = performance.now();
  native.listLayout.invalidateSectionsFrom(5, sections);
  const invMs = performance.now() - tInv;

  const offsetsAfter = native.layoutCache.getSectionOffsets();

  let earlyUnchanged = true;
  for (let s = 0; s < 5; s++) {
    if (Math.abs((offsetsAfter[s] ?? 0) - (offsetsBefore[s] ?? 0)) > 0.001) {
      earlyUnchanged = false; break;
    }
  }
  results.push({
    label: 'invalidateSectionsFrom(5): sections 0–4 unchanged',
    value: earlyUnchanged ? 'all unchanged ✓' : 'some changed ✗',
    pass:  earlyUnchanged,
  });

  // ── Test 6: sections 5–9 shifted by +100 ─────────────────────────────────
  const DELTA = 100;
  let lateShifted = true;
  let shiftDetail = '';
  for (let s = 5; s < SECTIONS; s++) {
    const expectedAfter = s === 5
      ? offsetsBefore[5]!
      : (offsetsBefore[s] ?? 0) + DELTA;
    if (Math.abs((offsetsAfter[s] ?? 0) - expectedAfter) > 0.001) {
      lateShifted = false;
      shiftDetail = `s${s}: got ${offsetsAfter[s]?.toFixed(1)}, expected ${expectedAfter.toFixed(1)}`;
      break;
    }
  }
  results.push({
    label: `invalidateSectionsFrom(5): sections 6–9 shifted by +${DELTA}px`,
    value: lateShifted ? `all shifted ✓  (${invMs.toFixed(2)}ms)` : shiftDetail,
    pass:  lateShifted,
  });

  return results;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M1_5_ListLayoutMultiSection() {
  const [results, setResults] = useState<TestResult[]>([]);
  useEffect(() => { setResults(runTests()); }, []);

  return (
    <TestScreen
      title="M1.5 — ListLayout: multi-section"
      subtitle={`${SECTIONS} sections × ${ITEMS.toLocaleString()} items · headers ${HEADER_H}px · footers ${FOOTER_H}px`}
      results={results}
    />
  );
}
