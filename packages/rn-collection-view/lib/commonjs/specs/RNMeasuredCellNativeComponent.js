"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.__INTERNAL_VIEW_CONFIG = void 0;
var _codegenNativeComponent = _interopRequireDefault(require("react-native/Libraries/Utilities/codegenNativeComponent"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * M4.2 — RNMeasuredCell codegen spec.
 *
 * A Fabric view that fires `onMeasured` from its native `layoutSubviews`
 * BEFORE the frame reaches the screen.  This eliminates the JS measurement
 * loop (useLayoutEffect + ref.measure()) and gives CollectionView.tsx the
 * actual cell height within the same native commit.
 *
 * Usage: wrap a variable-height cell with <RNMeasuredCell onMeasured={...}>.
 * Do NOT set an explicit height — Yoga computes the intrinsic height from the
 * content subtree, which is exactly what we want to capture.
 */

const NativeComponentRegistry = require('react-native/Libraries/NativeComponent/NativeComponentRegistry');
const {
  ConditionallyIgnoredEventHandlers
} = require('react-native/Libraries/NativeComponent/ViewConfigIgnore');
let nativeComponentName = 'RNMeasuredCell';
const __INTERNAL_VIEW_CONFIG = exports.__INTERNAL_VIEW_CONFIG = {
  uiViewClassName: 'RNMeasuredCell',
  directEventTypes: {
    topMeasured: {
      registrationName: 'onMeasured'
    }
  },
  validAttributes: {
    type: true,
    kind: true,
    index: true,
    cacheKey: true,
    isMeasureOnly: true,
    ...ConditionallyIgnoredEventHandlers({
      onMeasured: true
    })
  }
};
var _default = exports.default = NativeComponentRegistry.get(nativeComponentName, () => __INTERNAL_VIEW_CONFIG);
//# sourceMappingURL=RNMeasuredCellNativeComponent.js.map