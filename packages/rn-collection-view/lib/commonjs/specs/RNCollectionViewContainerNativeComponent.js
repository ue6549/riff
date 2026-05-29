"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.__INTERNAL_VIEW_CONFIG = void 0;
var _codegenNativeComponent = _interopRequireDefault(require("react-native/Libraries/Utilities/codegenNativeComponent"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * RNCollectionViewContainer — Fabric component with custom ShadowNode.
 *
 * This native component owns a UIScrollView internally and provides:
 * - Zero-frame measurement correction via ShadowNode layout() override
 * - Scroll offset correction when items above viewport change height
 * - Content size management
 *
 * The ShadowNode reads Yoga-computed child heights during the layout phase
 * and repositions children using the C++ layout engine — all within a single
 * Fabric commit cycle, eliminating the native→JS→native measurement roundtrip.
 *
 * Props:
 *   layoutCacheId    — integer key for static LayoutCache registry (ShadowNode lookup)
 *   layoutCacheVersion — bumped when JS enriches cache (triggers Fabric re-commit)
 *   estimatedItemHeight — fallback height for items not in LayoutCache
 *   layoutType       — which layout engine to use ('list' | 'grid' | 'masonry' | 'flow')
 *   columns          — number of columns (grid/masonry)
 *   columnSpacing    — horizontal spacing between columns
 *   rowSpacing       — vertical spacing between rows (or itemSpacing for list)
 *   sectionInsetTop/Bottom/Left/Right — content insets
 *   maintainVisibleContentPosition — opt-in scroll offset correction (default true)
 *   onScroll         — scroll event forwarded to JS for render range computation
 */
const NativeComponentRegistry = require('react-native/Libraries/NativeComponent/NativeComponentRegistry');
const {
  ConditionallyIgnoredEventHandlers
} = require('react-native/Libraries/NativeComponent/ViewConfigIgnore');
let nativeComponentName = 'RNCollectionViewContainer';
const __INTERNAL_VIEW_CONFIG = exports.__INTERNAL_VIEW_CONFIG = {
  uiViewClassName: 'RNCollectionViewContainer',
  directEventTypes: {
    topScroll: {
      registrationName: 'onScroll'
    },
    topScrollBeginDrag: {
      registrationName: 'onScrollBeginDrag'
    },
    topScrollEndDrag: {
      registrationName: 'onScrollEndDrag'
    },
    topMomentumScrollBegin: {
      registrationName: 'onMomentumScrollBegin'
    },
    topMomentumScrollEnd: {
      registrationName: 'onMomentumScrollEnd'
    }
  },
  validAttributes: {
    layoutType: true,
    columns: true,
    columnSpacing: true,
    rowSpacing: true,
    sectionInsetTop: true,
    sectionInsetBottom: true,
    sectionInsetLeft: true,
    sectionInsetRight: true,
    layoutCacheId: true,
    layoutCacheVersion: true,
    estimatedItemHeight: true,
    renderRangeStart: true,
    renderRangeEnd: true,
    maintainVisibleContentPosition: true,
    horizontal: true,
    scrollEnabled: true,
    bounces: true,
    showsVerticalScrollIndicator: true,
    scrollEventThrottle: true,
    ...ConditionallyIgnoredEventHandlers({
      onScroll: true,
      onScrollBeginDrag: true,
      onScrollEndDrag: true,
      onMomentumScrollBegin: true,
      onMomentumScrollEnd: true
    })
  }
};
var _default = exports.default = NativeComponentRegistry.get(nativeComponentName, () => __INTERNAL_VIEW_CONFIG);
//# sourceMappingURL=RNCollectionViewContainerNativeComponent.js.map