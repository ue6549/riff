"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.__INTERNAL_VIEW_CONFIG = void 0;
var _codegenNativeComponent = _interopRequireDefault(require("react-native/Libraries/Utilities/codegenNativeComponent"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * RNCollectionSubContainer — generic Fabric component for ANY layout that
 * owns a slice of items inside a parent CollectionView.
 *
 * This is the framework component for H-2 and beyond. It hosts items in its
 * own coordinate space, applies frames + transforms + opacity + zIndex from
 * a C++ State object (CollectionSubContainerState), and optionally provides
 * a UIScrollView for layouts that need scroll-driven recomputation.
 *
 * Specialized wrappers compose this:
 *   - RNOrthogonalSectionView  → uses this + horizontal UIScrollView for H lists/grids
 *   - radial / spiral / carousel3D → use this + vertical UIScrollView; scroll drives layout
 *   - hex (C++)                → uses this + no scroll (static tiling)
 *
 * Frames & transforms are applied NATIVELY (no JS bridge), driven by a
 * dedicated CollectionSubContainerShadowNode that performs Yoga measurement
 * + cascade for its own children (scoped, not the entire collection).
 *
 * Props:
 *   layoutCacheId   — integer key for the LayoutCache registry (shared with parent)
 *   sectionIndex    — which slice of the cache this sub-container owns
 *   scrollDirection — 'vertical' | 'horizontal' | 'none'. When != 'none', the
 *                     view embeds a UIScrollView and forwards scroll events.
 *   contentWidth    — total content width along the X axis (STANDALONE ONLY).
 *                     For compositional H sections (H-2.1), the C++ ShadowNode
 *                     reads section size from the cache `h-section-cw-{N}` /
 *                     `h-section-wrapper-{N}` entries directly, NOT from these
 *                     props. Round-tripping section size through JS as a prop
 *                     created a Fabric-commit feedback loop that broke iOS
 *                     bounce animations and JS performance during deceleration.
 *                     Standalone consumers (CollectionSubContainer.tsx for
 *                     custom layouts like radial / spiral / carousel3D) still
 *                     pass these — they have no compositional cache entry.
 *   contentHeight   — total content height along the Y axis. Same semantics as
 *                     contentWidth above.
 *
 * Events:
 *   onSubScroll     — fires on every scroll tick when scrollDirection != 'none'.
 *                     JS handler should call processSubScroll(sectionIndex, x, y)
 *                     JSI to drive layout-cache update + window computation.
 */
const NativeComponentRegistry = require('react-native/Libraries/NativeComponent/NativeComponentRegistry');
const {
  ConditionallyIgnoredEventHandlers
} = require('react-native/Libraries/NativeComponent/ViewConfigIgnore');
let nativeComponentName = 'RNCollectionSubContainer';
const __INTERNAL_VIEW_CONFIG = exports.__INTERNAL_VIEW_CONFIG = {
  uiViewClassName: 'RNCollectionSubContainer',
  directEventTypes: {
    topSubScroll: {
      registrationName: 'onSubScroll'
    }
  },
  validAttributes: {
    layoutCacheId: true,
    sectionIndex: true,
    scrollDirection: true,
    contentWidth: true,
    contentHeight: true,
    layoutCacheVersion: true,
    ...ConditionallyIgnoredEventHandlers({
      onSubScroll: true
    })
  }
};
var _default = exports.default = NativeComponentRegistry.get(nativeComponentName, () => __INTERNAL_VIEW_CONFIG);
//# sourceMappingURL=RNCollectionSubContainerNativeComponent.js.map