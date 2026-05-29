"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RiffSnapshot = void 0;
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

// ─── RiffSnapshot ─────────────────────────────────────────────────────────────

class RiffSnapshot {
  _ops = [];
  constructor(data, keyExtractor) {
    this._origData = data;
    this._ke = keyExtractor ?? ((_, i) => String(i));
  }

  // ── Mutation builders ─────────────────────────────────────────────────────

  /** Append items at the end of the list. */
  appendItems(items) {
    if (items.length > 0) this._ops.push({
      type: 'append',
      items
    });
    return this;
  }

  /**
   * Insert items immediately after `afterKey`.
   * Pass `afterKey = null` to insert at the beginning (prepend).
   * No-op if afterKey is provided but not found.
   */
  insertItems(items, afterKey) {
    if (items.length > 0) this._ops.push({
      type: 'insert',
      items,
      afterKey
    });
    return this;
  }

  /**
   * Insert items so they end up at `index` in the result.
   * `index = 0` prepends. `index >= data.length` appends.
   *
   * Indices resolve against the data at snapshot() time, not post-prior-op state.
   * For complex batches that mix index and key ops, prefer insertItems().
   */
  insertItemsAt(items, index) {
    if (items.length === 0) return this;
    if (index <= 0) return this.insertItems(items, null);
    const afterItem = this._origData[index - 1];
    if (afterItem === undefined) return this.appendItems(items);
    return this.insertItems(items, this._ke(afterItem, index - 1));
  }

  /** Remove items by key. Items whose keys are not found are silently skipped. */
  deleteItems(keys) {
    if (keys.length > 0) this._ops.push({
      type: 'delete',
      keys: new Set(keys)
    });
    return this;
  }

  /**
   * Remove items at the given flat indices.
   *
   * Indices resolve against the data at snapshot() time, not post-prior-op state.
   * For complex batches that mix index and key ops, prefer deleteItems().
   */
  deleteItemsAt(indices) {
    const keys = [];
    for (const i of indices) {
      const item = this._origData[i];
      if (item !== undefined) keys.push(this._ke(item, i));
    }
    return this.deleteItems(keys);
  }

  /**
   * Relocate `key` so it appears immediately after `afterKey`.
   * Pass `afterKey = null` to move the item to the front.
   * No-op if either key is not found in the current data.
   */
  moveItem(key, afterKey) {
    this._ops.push({
      type: 'move',
      key,
      afterKey
    });
    return this;
  }

  /**
   * Move the item at `fromIndex` so it ends up at `toIndex` in the result.
   *
   * Indices resolve against the data at snapshot() time, not post-prior-op state.
   * For complex batches that mix index and key ops, prefer moveItem().
   */
  moveItemFromTo(fromIndex, toIndex) {
    if (fromIndex === toIndex) return this;
    const fromItem = this._origData[fromIndex];
    if (fromItem === undefined) return this;
    const fromKey = this._ke(fromItem, fromIndex);
    if (toIndex <= 0) return this.moveItem(fromKey, null);
    if (fromIndex < toIndex) {
      // Items between from+1..toIndex shift left by 1 after the move.
      // The item at toIndex in _origData becomes the after-anchor.
      const afterItem = this._origData[toIndex];
      if (afterItem === undefined) return this.moveItem(fromKey, null);
      return this.moveItem(fromKey, this._ke(afterItem, toIndex));
    } else {
      // fromIndex > toIndex: insert after the item currently at toIndex-1.
      const afterItem = this._origData[toIndex - 1];
      if (afterItem === undefined) return this.moveItem(fromKey, null);
      return this.moveItem(fromKey, this._ke(afterItem, toIndex - 1));
    }
  }

  /**
   * Mark items as needing a full re-render (new data behind same key).
   * Their cached heights are evicted so they are re-measured on the next pass.
   */
  reloadItems(keys) {
    if (keys.length > 0) this._ops.push({
      type: 'reload',
      keys: new Set(keys)
    });
    return this;
  }

  // ── Materialise ───────────────────────────────────────────────────────────

  /**
   * Apply all pending mutations in order and return the resulting data array.
   * This method is pure — it does not mutate the original data or this snapshot.
   * Safe to call multiple times; each call returns an independent result.
   */
  apply() {
    let arr = [...this._origData];
    const reloadedKeys = new Set();
    let firstChanged = -1;
    const mark = idx => {
      if (firstChanged === -1 || idx < firstChanged) firstChanged = idx;
    };
    for (const op of this._ops) {
      switch (op.type) {
        case 'append':
          {
            mark(arr.length);
            arr = [...arr, ...op.items];
            break;
          }
        case 'insert':
          {
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
        case 'delete':
          {
            // Record the earliest deletion point before filtering.
            for (let i = 0; i < arr.length; i++) {
              if (op.keys.has(this._ke(arr[i], i))) {
                mark(i);
                break;
              }
            }
            arr = arr.filter((item, i) => !op.keys.has(this._ke(item, i)));
            break;
          }
        case 'move':
          {
            const fromIdx = arr.findIndex((item, i) => this._ke(item, i) === op.key);
            if (fromIdx === -1) break;
            const [moved] = arr.splice(fromIdx, 1);
            let toIdx;
            if (op.afterKey === null) {
              arr.unshift(moved);
              toIdx = 0;
            } else {
              // afterKey index is searched in the array after the splice.
              const afterIdx = arr.findIndex((item, i) => this._ke(item, i) === op.afterKey);
              if (afterIdx === -1) {
                // afterKey not found — revert
                arr.splice(fromIdx, 0, moved);
                break;
              }
              toIdx = afterIdx + 1;
              arr.splice(toIdx, 0, moved);
            }
            mark(Math.min(fromIdx, toIdx));
            break;
          }
        case 'reload':
          {
            for (const k of op.keys) reloadedKeys.add(k);
            for (let i = 0; i < arr.length; i++) {
              if (op.keys.has(this._ke(arr[i], i))) {
                mark(i);
                break;
              }
            }
            break;
          }
      }
    }
    return {
      data: arr,
      reloadedKeys,
      firstChangedIndex: firstChanged
    };
  }

  /** How many operations are pending in this snapshot. */
  get operationCount() {
    return this._ops.length;
  }

  /** Original data this snapshot was built from. */
  get originalData() {
    return this._origData;
  }
}
exports.RiffSnapshot = RiffSnapshot;
//# sourceMappingURL=CollectionSnapshot.js.map