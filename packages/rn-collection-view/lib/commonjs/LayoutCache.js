"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layoutCache = exports.LayoutCache = void 0;
var _NativeCollectionViewModule = _interopRequireDefault(require("./specs/NativeCollectionViewModule"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * TypeScript wrapper around the C++ LayoutCache JSI object.
 *
 * The native module exposes a `layoutCache` property which is a plain JSI
 * object with methods installed by LayoutCache::installJSIBindings().
 * This class wraps it with proper types.
 */

// The native module exposes layoutCache as an untyped object property.
// We access it via the module reference and cast.
const nativeModule = _NativeCollectionViewModule.default;
class LayoutCache {
  constructor() {
    this._native = nativeModule.layoutCache;
  }

  /** Insert or replace attributes for an item. O(1) amortised. */
  setAttributes(attrs) {
    this._native.setAttributes(attrs);
  }

  /** Retrieve attributes by item key. O(1). Returns null if not found. */
  getAttributes(key) {
    return this._native.getAttributes(key);
  }

  /** Remove an item from the cache. O(n) due to insertion-order maintenance. */
  removeAttributes(key) {
    this._native.removeAttributes(key);
  }

  /** All attributes in insertion (layout) order. */
  getAll() {
    return this._native.getAll();
  }

  /**
   * Rect-based spatial query — returns all items whose frame intersects rect.
   * This is the primary interface for the window controller.
   * 2D-ready: works for both vertical and horizontal scroll.
   */
  getAttributesInRect(rect) {
    return this._native.getAttributesInRect(rect);
  }

  /** Total scroll content size derived from the union of all frames. */
  getTotalContentSize() {
    return this._native.getTotalContentSize();
  }

  /**
   * Y offset of each section's first item.
   * Used by the window controller for fast section-level queries.
   */
  getSectionOffsets() {
    return this._native.getSectionOffsets();
  }

  /** Clear all attributes. */
  clear() {
    this._native.clear();
  }

  /**
   * Monotonically increasing version number.
   * Incremented on every mutation. Use to detect cache staleness
   * without diffing attribute contents.
   */
  get version() {
    return this._native.version();
  }
}

/** Singleton for the collection view's primary layout cache. */
exports.LayoutCache = LayoutCache;
const layoutCache = exports.layoutCache = new LayoutCache();
//# sourceMappingURL=LayoutCache.js.map