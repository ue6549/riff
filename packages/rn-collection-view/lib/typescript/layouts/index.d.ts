/**
 * Layout factories — create layout engines for CollectionView.
 *
 * Usage:
 *   import { list, masonry, grid, flow, customLayout } from 'rn-collection-view/layouts';
 *
 *   <CollectionView layout={list({ itemHeight: 44 })} ... />
 *   <CollectionView layout={masonry({ columns: 3, heightForItem: fn })} ... />
 *   <CollectionView layout={grid({ columns: 4, rowHeight: 100 })} ... />
 *   <CollectionView layout={flow({ sizeForItem: fn })} ... />
 *   <CollectionView layout={customLayout({ attributesForItem: fn })} ... />
 */
export { list } from './list';
export { masonry } from './masonry';
export { grid } from './grid';
export { flow } from './flow';
export { customLayout } from './custom';
export { compositional } from './compositional';
export type { CompositionalEntry, SectionRange } from './compositional';
