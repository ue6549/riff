/**
 * M1.1 — LayoutCache: C++ CRUD acceptance tests
 *
 * Acceptance criteria:
 *   · ping() returns "pong"
 *   · setAttributes/getAttributes round-trip preserves all fields
 *   · getAttributes on missing key returns null
 *   · version() increments on each mutation (set + remove)
 *   · getAll() returns items in insertion order
 *   · removeAttributes removes the correct item
 *   · getTotalContentSize() returns union bounding box
 *   · getSectionOffsets() returns first-item Y per section
 */
import React, { useEffect, useState } from 'react';
import { native } from './native';
import { TestResult, TestScreen } from './shared';

// ─── Full LayoutAttributes factory ────────────────────────────────────────────

function makeAttrs(
  key: string,
  section: number,
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Parameters<typeof native.layoutCache.setAttributes>[0] {
  return {
    key,
    section,
    index,
    frame:             { x, y, width, height },
    zIndex:            0,
    isSupplementary:   false,
    supplementaryKind: null,
    sizingState:       'measured',
    isDirty:           false,
    tier:              'outside',
    isSticky:          false,
    alpha:             1,
    isAnimating:       false,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function runTests(): TestResult[] {
  const results: TestResult[] = [];

  // clean slate
  native.layoutCache.clear();

  // ── Test 1: ping() → "pong" ─────────────────────────────────────────────
  const pong = native.ping();
  results.push({
    label: 'ping() → "pong"',
    value: `got "${pong}"`,
    pass:  pong === 'pong',
  });

  // ── Test 2: setAttributes + getAttributes round-trip ────────────────────
  native.layoutCache.setAttributes(makeAttrs('rt-0', 0, 0, 0, 10, 390, 44));
  const got = native.layoutCache.getAttributes('rt-0');
  const rt2Pass =
    got !== null &&
    got.frame.y === 10 &&
    got.frame.width === 390 &&
    got.frame.height === 44 &&
    got.section === 0 &&
    got.sizingState === 'measured';
  results.push({
    label: 'setAttributes + getAttributes round-trip',
    value: got
      ? `y=${got.frame.y} w=${got.frame.width} h=${got.frame.height} section=${got.section} sizingState=${got.sizingState}`
      : 'null',
    pass:  rt2Pass,
  });

  // ── Test 3: getAttributes(missing) → null ───────────────────────────────
  const missing = native.layoutCache.getAttributes('no-such-key');
  results.push({
    label: 'getAttributes(missing key) → null',
    value: `got ${JSON.stringify(missing)}`,
    pass:  missing === null,
  });

  // ── Test 4: version() increments on mutation ────────────────────────────
  native.layoutCache.clear();
  const v0 = native.layoutCache.version();
  native.layoutCache.setAttributes(makeAttrs('ver-0', 0, 0, 0, 0, 390, 44));
  const v1 = native.layoutCache.version();
  native.layoutCache.removeAttributes('ver-0');
  const v2 = native.layoutCache.version();
  results.push({
    label: 'version() increments on setAttributes',
    value: `v0=${v0} v1=${v1} (expected ${v0 + 1})`,
    pass:  v1 === v0 + 1,
  });
  results.push({
    label: 'version() increments on removeAttributes',
    value: `v1=${v1} v2=${v2} (expected ${v1 + 1})`,
    pass:  v2 === v0 + 2,
  });

  // ── Test 5: getAll() insertion order ────────────────────────────────────
  native.layoutCache.clear();
  native.layoutCache.setAttributes(makeAttrs('k0', 0, 0, 0, 0,   390, 44));
  native.layoutCache.setAttributes(makeAttrs('k1', 0, 1, 0, 44,  390, 44));
  native.layoutCache.setAttributes(makeAttrs('k2', 0, 2, 0, 88,  390, 44));
  const all = native.layoutCache.getAll();
  const orderOk =
    all.length === 3 &&
    all[0]?.key === 'k0' &&
    all[1]?.key === 'k1' &&
    all[2]?.key === 'k2';
  results.push({
    label: 'getAll() insertion order (len=3, k0→k1→k2)',
    value: `[${all.map(a => a.key).join(', ')}]`,
    pass:  orderOk,
  });

  // ── Test 6: removeAttributes removes item ───────────────────────────────
  native.layoutCache.removeAttributes('k1');
  const afterRemove = native.layoutCache.getAll();
  const removeOk =
    afterRemove.length === 2 &&
    afterRemove[0]?.key === 'k0' &&
    afterRemove[1]?.key === 'k2';
  results.push({
    label: 'removeAttributes("k1") → [k0, k2]',
    value: `[${afterRemove.map(a => a.key).join(', ')}] len=${afterRemove.length}`,
    pass:  removeOk,
  });

  // ── Test 7: getTotalContentSize() ───────────────────────────────────────
  native.layoutCache.clear();
  native.layoutCache.setAttributes(makeAttrs('sz0', 0, 0, 0, 0,  300, 50));
  native.layoutCache.setAttributes(makeAttrs('sz1', 0, 1, 0, 50, 200, 80));
  const size = native.layoutCache.getTotalContentSize();
  const sizeOk = size.width === 300 && size.height === 130;
  results.push({
    label: 'getTotalContentSize() = {width:300, height:130}',
    value: `{width:${size.width}, height:${size.height}}`,
    pass:  sizeOk,
  });

  // ── Test 8: getSectionOffsets() — first item Y per section ──────────────
  native.layoutCache.clear();
  native.layoutCache.setAttributes(makeAttrs('s0i0', 0, 0, 0, 0,   390, 44));
  native.layoutCache.setAttributes(makeAttrs('s0i1', 0, 1, 0, 44,  390, 44));
  native.layoutCache.setAttributes(makeAttrs('s1i0', 1, 0, 0, 100, 390, 44));
  const offsets = native.layoutCache.getSectionOffsets();
  const offsetsOk =
    offsets.length === 2 &&
    offsets[0] === 0 &&
    offsets[1] === 100;
  results.push({
    label: 'getSectionOffsets() = [0, 100]',
    value: `[${offsets.join(', ')}]`,
    pass:  offsetsOk,
  });

  return results;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M1_1_LayoutCache() {
  const [results, setResults] = useState<TestResult[]>([]);
  useEffect(() => { setResults(runTests()); }, []);

  return (
    <TestScreen
      title="M1.1 — LayoutCache: C++ CRUD"
      results={results}
    />
  );
}
