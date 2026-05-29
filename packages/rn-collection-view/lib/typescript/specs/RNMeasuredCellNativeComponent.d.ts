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
import type { ViewProps } from 'react-native';
import type { DirectEventHandler, Float, Int32 } from 'react-native/Libraries/Types/CodegenTypes';
type OnMeasuredEvent = Readonly<{
    height: Float;
    width: Float;
}>;
interface NativeProps extends ViewProps {
    onMeasured?: DirectEventHandler<OnMeasuredEvent>;
    type?: string;
    kind?: string;
    index?: Int32;
    cacheKey?: string;
    isMeasureOnly?: boolean;
}
declare const _default: import("react-native/Libraries/Utilities/codegenNativeComponent").NativeComponentType<NativeProps>;
export default _default;
