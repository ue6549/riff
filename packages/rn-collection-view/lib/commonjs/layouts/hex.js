"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.hex = void 0;
var _NativeCollectionViewModule = _interopRequireDefault(require("../specs/NativeCollectionViewModule"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * Hex layout — honeycomb tiling. Static (no scroll-driven recomputation).
 * Items are placed on an offset grid where every other row is shifted by
 * half a hex width.
 *
 * NOTE: shipped as TypeScript today for parity with radial/spiral/carousel3D.
 * A C++ port (HexLayoutEngine + registerLayoutEngine + TS shim) is a planned
 * follow-up to demonstrate native custom layouts using the same H-2 framework.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={hex({ hexSize: 56 })}
 *     data={items}
 *     renderItem={({ item }) => <HexCell item={item} />}
 *     sectionIndex={5}
 *     scrollDirection="none"
 *     crossAxisSize={400}
 *   />
 */

const nativeMod = _NativeCollectionViewModule.default;
class HexLayout {
  type = 'hex';
  horizontal = false;
  needsSpatialQuery = false;
  ctx = null;
  itemKeys = [];
  _contentSize = {
    width: 0,
    height: 0
  };
  _cache = nativeMod.layoutCache;
  constructor(opts) {
    this.opts = {
      hexSize: opts.hexSize ?? 64,
      paddingX: opts.paddingX ?? 8,
      paddingY: opts.paddingY ?? 8,
      gap: opts.gap ?? 4
    };
  }
  prepare(context) {
    this._cache = nativeMod.layoutCacheById(context.cacheId);
    this.ctx = context;
    const sec = context.sections[0];
    if (!sec) {
      this.itemKeys = [];
      this._contentSize = {
        width: 0,
        height: 0
      };
      return;
    }
    this.itemKeys = sec.itemKeys ? Array.from(sec.itemKeys) : Array.from({
      length: sec.itemCount
    }, (_, i) => `hex-${i}`);
    const cw = context.containerWidth;
    const sz = this.opts.hexSize;
    const gap = this.opts.gap;

    // Pointy-top hex tiling math:
    //   horizontal stride = sz + gap (full width per hex on a row)
    //   vertical   stride = sz * 0.75 + gap (rows overlap by 25% of the hex)
    //   odd rows shifted by (sz + gap) / 2
    const colStride = sz + gap;
    const rowStride = sz * 0.75 + gap;
    const usableW = Math.max(0, cw - this.opts.paddingX * 2);
    const cols = Math.max(1, Math.floor((usableW + gap) / colStride));
    let maxBottom = 0;
    const batch = new Array(this.itemKeys.length);
    for (let i = 0; i < this.itemKeys.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const xOffset = row % 2 === 1 ? colStride / 2 : 0;
      const x = this.opts.paddingX + col * colStride + xOffset;
      const y = this.opts.paddingY + row * rowStride;
      maxBottom = Math.max(maxBottom, y + sz);
      batch[i] = {
        key: this.itemKeys[i],
        section: 0,
        index: i,
        frame: {
          x,
          y,
          width: sz,
          height: sz
        },
        zIndex: 0,
        alpha: 1
      };
    }
    this._cache.setAttributesBatch(batch);
    this._contentSize = {
      width: cw,
      height: maxBottom + this.opts.paddingY
    };
  }

  // No processScroll — hex is a static layout.

  attributesForElements(_inRect) {
    const result = [];
    for (let i = 0; i < this.itemKeys.length; i++) {
      const a = this._cache.getAttributes(this.itemKeys[i]);
      if (a) result.push(a);
    }
    return result;
  }
  attributesForItem(index, _section) {
    const k = this.itemKeys[index];
    return k ? this._cache.getAttributes(k) : null;
  }
  attributesForSupplementary(_kind, _section) {
    return null;
  }
  contentSize() {
    return this._contentSize;
  }
  shouldInvalidate(oldBounds, newBounds) {
    return oldBounds.width !== newBounds.width;
  }
}
const hex = (opts = {}) => new HexLayout(opts);
exports.hex = hex;
//# sourceMappingURL=hex.js.map