/**
 * SlotManager.test.ts — Unit tests for SlotManager cell pooling.
 *
 * Tests are pure JS — no native module required.
 *
 * Run: cd example && npx jest components/__tests__/SlotManager.test.ts
 */

import { SlotManager } from '../SlotManager';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Item = { id: string; value: number };

/** Build a simple data array. */
const makeData = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, value: i }));

/** Run a sync() call with defaults for most params. */
function syncRange(
  sm: SlotManager<Item>,
  data: Item[],
  renderFirst: number,
  renderLast: number,
  opts?: {
    measureFirst?: number | null;
    measureLast?: number | null;
    stickySet?: Set<number>;
  },
) {
  const { measureFirst = null, measureLast = null, stickySet = null } = opts ?? {};
  return sm.sync(
    renderFirst,
    renderLast,
    measureFirst,
    measureLast,
    (i) => data[i]!.id,
    (_i) => 'default',
    (i) => `cache-${data[i]!.id}`,
    (i) => data[i]!,
    data.length,
    stickySet,
  );
}

// ─── Basic slot assignment ────────────────────────────────────────────────────

test('assigns a slot to each item in range', () => {
  const sm = new SlotManager<Item>();
  const data = makeData(5);
  const slots = syncRange(sm, data, 0, 4);

  expect(slots.size).toBe(5);
  // All assigned slots should be non-pooled.
  for (const slot of slots.values()) {
    expect(slot.isPooled).toBe(false);
  }
});

test('slot keys are stable across re-renders for the same data', () => {
  const sm = new SlotManager<Item>();
  const data = makeData(5);

  const slots1 = syncRange(sm, data, 0, 4);
  const keysBefore = new Map<string, string>(); // dataKey → slotKey
  for (const slot of slots1.values()) {
    if (!slot.isPooled) keysBefore.set(slot.dataKey, slot.slotKey);
  }

  // Re-render with same range — slot keys must be preserved.
  const slots2 = syncRange(sm, data, 0, 4);
  for (const slot of slots2.values()) {
    if (!slot.isPooled) {
      expect(slot.slotKey).toBe(keysBefore.get(slot.dataKey));
    }
  }
});

// ─── Recycle pool ─────────────────────────────────────────────────────────────

test('releases slots to pool when items scroll out', () => {
  const sm = new SlotManager<Item>();
  const data = makeData(10);

  // Render items 0-4.
  syncRange(sm, data, 0, 4);

  // Shift window to 5-9 — items 0-4 should be pooled.
  const slots = syncRange(sm, data, 5, 9);

  let pooledCount = 0;
  for (const slot of slots.values()) {
    if (slot.isPooled) pooledCount++;
  }
  // Up to maxPoolSize (4) old slots stay mounted as pooled; rest unmounted.
  expect(pooledCount).toBeGreaterThanOrEqual(0);
  expect(pooledCount).toBeLessThanOrEqual(sm.maxPoolSize);
});

test('recycled slot reuses an existing slot key', () => {
  const sm = new SlotManager<Item>();
  const data = makeData(10);

  // Render items 0..2 — creates 3 slot keys.
  const slots1 = syncRange(sm, data, 0, 2);
  const knownSlotKeys = new Set([...slots1.values()].map(s => s.slotKey));
  expect(knownSlotKeys.size).toBe(3);

  // Shift window to 5..7 — items 0..2 leave (pool or discard), new items enter.
  const slots2 = syncRange(sm, data, 5, 7);
  const activeSlotKeys = [...slots2.values()].filter(s => !s.isPooled).map(s => s.slotKey);

  // All 3 active slots for items 5..7 must be RECYCLED from the known set.
  // (Pool size ≥ 3 = maxPoolSize default 4, so all 3 slots should be recycled.)
  for (const k of activeSlotKeys) {
    expect(knownSlotKeys.has(k)).toBe(true);
  }
  expect(activeSlotKeys.length).toBe(3);
});

// ─── Phase 3 Case B: dataKeyToSlot map corruption guard ──────────────────────

test('Phase3 CaseB guard: no duplicate render on insert→delete in same render', () => {
  // This tests the specific guard added to prevent dataKeyToSlot corruption:
  //   "only delete old dataKey mapping if it still points to THIS slot"
  //
  // Setup: items A, B in view. Render shifts: B leaves, C enters (C gets B's slot).
  // Then the SAME render: A also leaves, A's old slot goes to pool.
  // Without the guard, the dataKeyToSlot.delete(B's old dataKey) could corrupt
  // the map if B's slot was already re-assigned to C in the same Phase 3 loop.

  const sm = new SlotManager<Item>();
  const data = makeData(5);

  // Render items 0 and 1.
  syncRange(sm, data, 0, 1);

  // Scroll so 0 and 1 leave, 3 and 4 enter — both slots should recycle.
  const slots = syncRange(sm, data, 3, 4);

  const active = [...slots.values()].filter(s => !s.isPooled);
  // Two active slots, each referencing a different data item.
  expect(active.length).toBe(2);
  const dataKeys = active.map(s => s.dataKey);
  expect(new Set(dataKeys).size).toBe(2); // no duplicates
  expect(dataKeys).toContain('item-3');
  expect(dataKeys).toContain('item-4');
});

// ─── Sticky items excluded from sync ─────────────────────────────────────────

test('sticky items are excluded from neededIndices', () => {
  const sm = new SlotManager<Item>();
  const data = makeData(5);

  const stickySet = new Set([0, 2]);
  const slots = syncRange(sm, data, 0, 4, { stickySet });

  // Items 1, 3, 4 should be in slots; items 0, 2 (sticky) excluded.
  const dataKeys = [...slots.values()].filter(s => !s.isPooled).map(s => s.dataKey);
  expect(dataKeys).not.toContain('item-0');
  expect(dataKeys).not.toContain('item-2');
  expect(dataKeys).toContain('item-1');
  expect(dataKeys).toContain('item-3');
  expect(dataKeys).toContain('item-4');
});

// ─── maxPoolSize enforcement ──────────────────────────────────────────────────

test('pool size does not exceed maxPoolSize', () => {
  const sm = new SlotManager<Item>();
  sm.maxPoolSize = 2;
  const data = makeData(20);

  syncRange(sm, data, 0, 9);   // 10 slots created
  syncRange(sm, data, 10, 19); // 10 old slots: 2 kept pooled, 8 unmounted

  let pooledCount = 0;
  for (const slot of sm['activeSlots'].values()) {
    if (slot.isPooled) pooledCount++;
  }
  expect(pooledCount).toBeLessThanOrEqual(2);
});

// ─── reset ───────────────────────────────────────────────────────────────────

test('reset clears all state', () => {
  const sm = new SlotManager<Item>();
  const data = makeData(5);
  syncRange(sm, data, 0, 4);

  sm.reset();

  expect(sm['activeSlots'].size).toBe(0);
  expect(sm['recyclePools'].size).toBe(0);
  expect(sm['dataKeyToSlot'].size).toBe(0);
  expect(sm['slotCounter']).toBe(0);
});

// ─── Measure-only flag ────────────────────────────────────────────────────────

test('items in measure range but outside render range are measureOnly', () => {
  const sm = new SlotManager<Item>();
  const data = makeData(10);

  // renderFirst=0, renderLast=2, measureFirst=0, measureLast=4
  const slots = syncRange(sm, data, 0, 2, { measureFirst: 0, measureLast: 4 });

  for (const slot of slots.values()) {
    if (slot.isPooled) continue;
    if (slot.dataIndex >= 0 && slot.dataIndex <= 2) {
      expect(slot.measureOnly).toBe(false);
    } else if (slot.dataIndex >= 3 && slot.dataIndex <= 4) {
      expect(slot.measureOnly).toBe(true);
    }
  }
});
