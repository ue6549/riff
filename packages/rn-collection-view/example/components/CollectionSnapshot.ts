/**
 * CollectionSnapshot — F1.2
 *
 * Mutation builder for CollectionView data. Records a batch of insert /
 * delete / move / reload operations and materialises them in one pass via
 * `apply()`. The caller owns the state — apply() returns the new data array;
 * wrap the resulting setState call in `React.startTransition` to keep scroll
 * responsive during the update.
 *
 * Usage:
 *   const snap = listRef.current.snapshot();   // seeded with current data
 *   snap.appendItems(newItems);
 *   snap.deleteItems(['key-42', 'key-43']);
 *   const { data: newData } = snap.apply();
 *   React.startTransition(() => setData(newData));
 *
 * CollectionView automatically re-uses cached heights for items whose keys
 * survive the mutation, so only genuinely new/reloaded cells are re-measured.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type MutationOp<T> =
  | { type: 'append';  items: T[] }
  | { type: 'insert';  items: T[]; afterKey: string | null }
  | { type: 'delete';  keys: Set<string> }
  | { type: 'move';    key: string; afterKey: string | null }
  | { type: 'reload';  keys: Set<string> };

export type ApplyResult<T> = {
  /** New data array after all mutations are applied in order. */
  data: T[];
  /**
   * Keys of items marked for reload — their cached heights should be evicted
   * so CollectionView re-measures them on the next render.
   */
  reloadedKeys: Set<string>;
  /**
   * Earliest index in the resulting array that was affected by any mutation.
   * Useful for partial layout invalidation: positions at indices ≥ this value
   * may have shifted. -1 when no mutations were recorded.
   */
  firstChangedIndex: number;
};

// ─── RiffSnapshot ─────────────────────────────────────────────────────────────

export class RiffSnapshot<T> {
  private readonly _origData: T[];
  private readonly _ke: (item: T, index: number) => string;
  private readonly _ops: MutationOp<T>[] = [];

  constructor(
    data: T[],
    keyExtractor?: (item: T, index: number) => string,
  ) {
    this._origData = data;
    this._ke = keyExtractor ?? ((_, i) => String(i));
  }

  // ── Mutation builders ─────────────────────────────────────────────────────

  /** Append items at the end of the list. */
  appendItems(items: T[]): this {
    if (items.length > 0) this._ops.push({ type: 'append', items });
    return this;
  }

  /**
   * Insert items immediately after `afterKey`.
   * Pass `afterKey = null` to insert at the beginning (prepend).
   * No-op if afterKey is provided but not found.
   */
  insertItems(items: T[], afterKey: string | null): this {
    if (items.length > 0) this._ops.push({ type: 'insert', items, afterKey });
    return this;
  }

  /** Remove items by key. Items whose keys are not found are silently skipped. */
  deleteItems(keys: string[]): this {
    if (keys.length > 0) this._ops.push({ type: 'delete', keys: new Set(keys) });
    return this;
  }

  /**
   * Relocate `key` so it appears immediately after `afterKey`.
   * Pass `afterKey = null` to move the item to the front.
   * No-op if either key is not found in the current data.
   */
  moveItem(key: string, afterKey: string | null): this {
    this._ops.push({ type: 'move', key, afterKey });
    return this;
  }

  /**
   * Mark items as needing a full re-render (new data behind same key).
   * Their cached heights are evicted so they are re-measured on the next pass.
   */
  reloadItems(keys: string[]): this {
    if (keys.length > 0) this._ops.push({ type: 'reload', keys: new Set(keys) });
    return this;
  }

  // ── Materialise ───────────────────────────────────────────────────────────

  /**
   * Apply all pending mutations in order and return the resulting data array.
   * This method is pure — it does not mutate the original data or this snapshot.
   * Safe to call multiple times; each call returns an independent result.
   */
  apply(): ApplyResult<T> {
    let arr: T[] = [...this._origData];
    const reloadedKeys = new Set<string>();
    let firstChanged = -1;

    const mark = (idx: number) => {
      if (firstChanged === -1 || idx < firstChanged) firstChanged = idx;
    };

    for (const op of this._ops) {
      switch (op.type) {

        case 'append': {
          mark(arr.length);
          arr = [...arr, ...op.items];
          break;
        }

        case 'insert': {
          if (op.afterKey === null) {
            mark(0);
            arr = [...op.items, ...arr];
          } else {
            const afterIdx = arr.findIndex((item, i) => this._ke(item, i) === op.afterKey);
            if (afterIdx === -1) break;
            const insertAt = afterIdx + 1;
            mark(insertAt);
            arr = [...arr.slice(0, insertAt), ...op.items, ...arr.slice(insertAt)];
          }
          break;
        }

        case 'delete': {
          // Record the earliest deletion point before filtering.
          for (let i = 0; i < arr.length; i++) {
            if (op.keys.has(this._ke(arr[i]!, i))) { mark(i); break; }
          }
          arr = arr.filter((item, i) => !op.keys.has(this._ke(item, i)));
          break;
        }

        case 'move': {
          const fromIdx = arr.findIndex((item, i) => this._ke(item, i) === op.key);
          if (fromIdx === -1) break;

          const [moved] = arr.splice(fromIdx, 1);
          let toIdx: number;
          if (op.afterKey === null) {
            arr.unshift(moved!);
            toIdx = 0;
          } else {
            // afterKey index is searched in the array after the splice.
            const afterIdx = arr.findIndex((item, i) => this._ke(item, i) === op.afterKey);
            if (afterIdx === -1) {
              // afterKey not found — revert
              arr.splice(fromIdx, 0, moved!);
              break;
            }
            toIdx = afterIdx + 1;
            arr.splice(toIdx, 0, moved!);
          }
          mark(Math.min(fromIdx, toIdx));
          break;
        }

        case 'reload': {
          for (const k of op.keys) reloadedKeys.add(k);
          for (let i = 0; i < arr.length; i++) {
            if (op.keys.has(this._ke(arr[i]!, i))) { mark(i); break; }
          }
          break;
        }
      }
    }

    return { data: arr, reloadedKeys, firstChangedIndex: firstChanged };
  }

  /** How many operations are pending in this snapshot. */
  get operationCount(): number { return this._ops.length; }

  /** Original data this snapshot was built from. */
  get originalData(): readonly T[] { return this._origData; }
}
