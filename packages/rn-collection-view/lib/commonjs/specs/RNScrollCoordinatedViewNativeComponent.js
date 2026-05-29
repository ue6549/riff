"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.__INTERNAL_VIEW_CONFIG = void 0;
var _codegenNativeComponent = _interopRequireDefault(require("react-native/Libraries/Utilities/codegenNativeComponent"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * RNScrollCoordinatedView — Fabric component for scroll-driven positioning.
 *
 * A native wrapper view that applies a translateY transform to its content
 * based on the parent ScrollView's content offset. The transform is computed
 * entirely on the UI thread (in scrollViewDidScroll) — no JS involvement
 * per frame, zero lag.
 *
 * Fabric manages the wrapper's frame at its natural layout position.
 * The internal transform is managed by the native side — Fabric never
 * touches it, so there is no conflict.
 *
 * Supported behaviours:
 *   - 'sticky': translateY = max(0, scrollY - naturalY)
 *   - 'push':   translateY = max(0, min(scrollY - naturalY, boundaryY - naturalY - headerHeight))
 *
 * Props:
 *   behavior     — 'sticky' or 'push'
 *   naturalY     — the view's natural Y position in scroll content (before transform)
 *   boundaryY    — Y of the next sticky header (push mode: current is pushed out when next arrives)
 *   headerHeight — height of this view (push mode: needed for push-out calculation)
 *   enabled      — when false, no transform is applied (passthrough)
 */
const NativeComponentRegistry = require('react-native/Libraries/NativeComponent/NativeComponentRegistry');
let nativeComponentName = 'RNScrollCoordinatedView';
const __INTERNAL_VIEW_CONFIG = exports.__INTERNAL_VIEW_CONFIG = {
  uiViewClassName: 'RNScrollCoordinatedView',
  validAttributes: {
    behavior: true,
    naturalY: true,
    boundaryY: true,
    boundaryX: true,
    headerHeight: true,
    enabled: true,
    horizontal: true,
    type: true,
    kind: true,
    index: true,
    cacheKey: true,
    isMeasureOnly: true
  }
};
var _default = exports.default = NativeComponentRegistry.get(nativeComponentName, () => __INTERNAL_VIEW_CONFIG);
//# sourceMappingURL=RNScrollCoordinatedViewNativeComponent.js.map