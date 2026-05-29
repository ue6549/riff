"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.__INTERNAL_VIEW_CONFIG = void 0;
var _codegenNativeComponent = _interopRequireDefault(require("react-native/Libraries/Utilities/codegenNativeComponent"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * RNOrthogonalSectionView — Fabric component for horizontal-scrolling sections
 * within the main vertical CollectionView.
 *
 * Each H-section is a UIScrollView (horizontal=true) placed at the section's
 * Y position in the outer container. Items belonging to the H-section are
 * Fabric children of this view, absolutely positioned along the H axis.
 *
 * Props:
 *   sectionIndex  — which compositional section this view represents
 *   contentWidth  — total H content size; sets UIScrollView.contentSize.width
 *
 * Events:
 *   onHScroll     — fires on every H scroll tick; payload includes sectionIndex
 *                   and scrollX so JS can call processHScroll() JSI
 */
const NativeComponentRegistry = require('react-native/Libraries/NativeComponent/NativeComponentRegistry');
const {
  ConditionallyIgnoredEventHandlers
} = require('react-native/Libraries/NativeComponent/ViewConfigIgnore');
let nativeComponentName = 'RNOrthogonalSectionView';
const __INTERNAL_VIEW_CONFIG = exports.__INTERNAL_VIEW_CONFIG = {
  uiViewClassName: 'RNOrthogonalSectionView',
  directEventTypes: {
    topHScroll: {
      registrationName: 'onHScroll'
    }
  },
  validAttributes: {
    sectionIndex: true,
    contentWidth: true,
    ...ConditionallyIgnoredEventHandlers({
      onHScroll: true
    })
  }
};
var _default = exports.default = NativeComponentRegistry.get(nativeComponentName, () => __INTERNAL_VIEW_CONFIG);
//# sourceMappingURL=RNOrthogonalSectionNativeComponent.js.map