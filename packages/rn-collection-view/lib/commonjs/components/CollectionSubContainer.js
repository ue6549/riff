"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CollectionSubContainer = void 0;
var React = _interopRequireWildcard(require("react"));
var _reactNative = require("react-native");
var _RNCollectionSubContainerNativeComponent = _interopRequireDefault(require("../specs/RNCollectionSubContainerNativeComponent"));
var _RNMeasuredCellNativeComponent = _interopRequireDefault(require("../specs/RNMeasuredCellNativeComponent"));
var _NativeCollectionViewModule = _interopRequireDefault(require("../specs/NativeCollectionViewModule"));
var _jsxRuntime = require("react/jsx-runtime");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
/**
 * CollectionSubContainer — generic JS host for a single section that owns its
 * own layout (orthogonal, radial, spiral, carousel3D, hex, user-defined).
 *
 * Composition model:
 *   <CollectionSubContainer
 *     layout={radial({ radius: 150, itemSize: 80 })}
 *     data={items}
 *     renderItem={...}
 *     layoutCacheId={cacheId}     // shared with parent CollectionView
 *     sectionIndex={2}            // slice of the cache this owns
 *   />
 *
 * What the component does:
 *   - Calls `layout.prepare(ctx)` on mount, viewport size change, or data change.
 *   - For scroll-driven layouts: forwards onSubScroll → `layout.processScroll(...)`,
 *     which writes new attributes to the cache via `setAttributesBatch`. The
 *     C++ ShadowNode picks them up on its next layout pass and the iOS view
 *     applies the new frames + transforms + opacity natively (no JS work in
 *     the apply path).
 *   - Mounts each data item inside an RNMeasuredCell. Cells receive NO absolute
 *     positioning — their frames come from the sub-container ShadowNode.
 *
 * The scrollDirection is derived from the layout (`horizontal: true` →
 * 'horizontal'; `horizontal: false` → 'vertical'). Pass `scrollDirection="none"`
 * explicitly for static layouts (e.g. hex tiling that fits in the viewport).
 */

const nativeMod = _NativeCollectionViewModule.default;
/**
 * Cells live inside the native sub-container; positions are applied natively.
 * Wrap each rendered item in RNMeasuredCell so:
 *   1. The cell carries a stable cacheKey for ShadowNode lookup
 *   2. Yoga measures intrinsic size when the layout is content-determined
 *      (list, grid with variable height, etc.)
 */
function CollectionSubContainerInner({
  layout,
  data,
  renderItem,
  keyExtractor,
  layoutCacheId,
  sectionIndex,
  scrollDirection,
  crossAxisSize,
  style
}) {
  const cacheId = layoutCacheId ?? nativeMod.layoutCacheId;

  // ── Container width is needed to call layout.prepare() with a real context ──
  const [containerSize, setContainerSize] = React.useState({
    w: 0,
    h: crossAxisSize ?? 0
  });
  const onLayout = React.useCallback(e => {
    const {
      width,
      height
    } = e.nativeEvent.layout;
    setContainerSize(prev => {
      if (Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5) return prev;
      return {
        w: width,
        h: height
      };
    });
  }, []);

  // ── Resolve item keys (used for cell mounting + as cacheKey identity) ──
  const itemKeys = React.useMemo(() => data.map((item, i) => keyExtractor ? keyExtractor(item, i) : `sub-${sectionIndex}-${i}`), [data, keyExtractor, sectionIndex]);

  // ── Build LayoutContext for prepare()/processScroll() calls ──
  const layoutCtxRef = React.useRef(null);
  React.useMemo(() => {
    if (containerSize.w <= 0) return;
    const sectionInfo = {
      itemCount: data.length,
      supplementaryItems: [],
      itemKeys
    };
    layoutCtxRef.current = {
      containerWidth: containerSize.w,
      containerHeight: containerSize.h,
      scrollOffset: {
        x: 0,
        y: 0
      },
      cacheId,
      sections: [sectionInfo]
    };
  }, [containerSize.w, containerSize.h, data.length, itemKeys]);

  // ── Run prepare() whenever inputs change ──
  // Layout writes attributes into the cache; the C++ ShadowNode reads them
  // on its next layout pass and packs them into ChildVisualState entries.
  React.useEffect(() => {
    const ctx = layoutCtxRef.current;
    if (!ctx) return;
    layout.prepare(ctx);
  }, [layout, containerSize.w, containerSize.h, data.length, itemKeys]);

  // ── Scroll handler ──
  // Forward to layout.processScroll if defined. The layout writes new
  // attributes into the cache via setAttributesBatch; the C++ ShadowNode
  // re-reads on its next state update; iOS native view applies frames +
  // transforms in one shot.
  const handleScroll = React.useCallback(e => {
    if (!layout.processScroll) return;
    const ctx = layoutCtxRef.current;
    if (!ctx) return;
    const {
      scrollX,
      scrollY
    } = e.nativeEvent;
    // Update ctx with current offset for the layout's reference.
    const updatedCtx = {
      ...ctx,
      scrollOffset: {
        x: scrollX,
        y: scrollY
      }
    };
    layoutCtxRef.current = updatedCtx;
    layout.processScroll({
      x: scrollX,
      y: scrollY
    }, updatedCtx);
  }, [layout]);

  // ── Resolve scroll direction ──
  const dir = scrollDirection ?? (layout.horizontal ? 'horizontal' : 'vertical');

  // ── Content size for the native ScrollView ──
  // Read from layout.contentSize() — single source of truth.
  const contentSize = React.useMemo(() => {
    if (containerSize.w <= 0) return {
      width: 0,
      height: 0
    };
    try {
      return layout.contentSize();
    } catch {
      return {
        width: 0,
        height: 0
      };
    }
  }, [layout, containerSize.w, containerSize.h, data.length]);
  return /*#__PURE__*/(0, _jsxRuntime.jsx)(_reactNative.View, {
    onLayout: onLayout,
    style: style,
    children: /*#__PURE__*/(0, _jsxRuntime.jsx)(_RNCollectionSubContainerNativeComponent.default, {
      layoutCacheId: cacheId,
      sectionIndex: sectionIndex,
      scrollDirection: dir,
      contentWidth: contentSize.width,
      contentHeight: contentSize.height,
      onSubScroll: handleScroll,
      style: {
        flex: 1
      },
      children: data.map((item, i) => {
        const key = itemKeys[i];
        return /*#__PURE__*/(0, _jsxRuntime.jsx)(_RNMeasuredCellNativeComponent.default, {
          cacheKey: key,
          type: "cell",
          index: i,
          children: renderItem({
            item,
            index: i,
            section: sectionIndex
          })
        }, key);
      })
    })
  });
}

// Generics-friendly export.
const CollectionSubContainer = exports.CollectionSubContainer = /*#__PURE__*/React.memo(CollectionSubContainerInner);
//# sourceMappingURL=CollectionSubContainer.js.map