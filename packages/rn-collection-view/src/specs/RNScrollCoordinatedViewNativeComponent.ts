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
import type { ViewProps } from 'react-native';
import type { WithDefault, Float, Int32 } from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

interface NativeProps extends ViewProps {
  behavior?: WithDefault<'sticky' | 'push', 'push'>;
  naturalY?: Float;
  boundaryY?: Float;
  headerHeight?: Float;
  enabled?: WithDefault<boolean, true>;
  type?: string;
  kind?: string;
  index?: Int32;
  cacheKey?: string;
  isMeasureOnly?: boolean;
}

export default codegenNativeComponent<NativeProps>('RNScrollCoordinatedView');
