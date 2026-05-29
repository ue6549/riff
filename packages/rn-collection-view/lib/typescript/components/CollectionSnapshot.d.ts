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
export declare class RiffSnapshot<T> {
    private readonly _origData;
    private readonly _ke;
    private readonly _ops;
    constructor(data: T[], keyExtractor?: (item: T, index: number) => string);
    /** Append items at the end of the list. */
    appendItems(items: T[]): this;
    /**
     * Insert items immediately after `afterKey`.
     * Pass `afterKey = null` to insert at the beginning (prepend).
     * No-op if afterKey is provided but not found.
     */
    insertItems(items: T[], afterKey: string | null): this;
    /**
     * Insert items so they end up at `index` in the result.
     * `index = 0` prepends. `index >= data.length` appends.
     *
     * Indices resolve against the data at snapshot() time, not post-prior-op state.
     * For complex batches that mix index and key ops, prefer insertItems().
     */
    insertItemsAt(items: T[], index: number): this;
    /** Remove items by key. Items whose keys are not found are silently skipped. */
    deleteItems(keys: string[]): this;
    /**
     * Remove items at the given flat indices.
     *
     * Indices resolve against the data at snapshot() time, not post-prior-op state.
     * For complex batches that mix index and key ops, prefer deleteItems().
     */
    deleteItemsAt(indices: number[]): this;
    /**
     * Relocate `key` so it appears immediately after `afterKey`.
     * Pass `afterKey = null` to move the item to the front.
     * No-op if either key is not found in the current data.
     */
    moveItem(key: string, afterKey: string | null): this;
    /**
     * Move the item at `fromIndex` so it ends up at `toIndex` in the result.
     *
     * Indices resolve against the data at snapshot() time, not post-prior-op state.
     * For complex batches that mix index and key ops, prefer moveItem().
     */
    moveItemFromTo(fromIndex: number, toIndex: number): this;
    /**
     * Mark items as needing a full re-render (new data behind same key).
     * Their cached heights are evicted so they are re-measured on the next pass.
     */
    reloadItems(keys: string[]): this;
    /**
     * Apply all pending mutations in order and return the resulting data array.
     * This method is pure — it does not mutate the original data or this snapshot.
     * Safe to call multiple times; each call returns an independent result.
     */
    apply(): ApplyResult<T>;
    /** How many operations are pending in this snapshot. */
    get operationCount(): number;
    /** Original data this snapshot was built from. */
    get originalData(): readonly T[];
}
