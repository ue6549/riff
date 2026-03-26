/**
 * Re-export of the RNMeasuredCell codegen spec.
 *
 * The canonical spec lives in src/specs/ (required by codegenConfig.jsSrcsDir
 * for pod install / codegen). But at runtime, if CollectionView.tsx imports
 * the spec from that path, Metro resolves `react-native` to the library's own
 * node_modules/react-native — a separate instance from the example app's.
 * The component registers in the wrong ReactNativeViewConfigRegistry and the
 * render fails with "View config getter callback must be a function".
 *
 * This re-export file lives in example/components/ alongside CollectionView.tsx.
 * When Babel's codegen plugin transforms the codegenNativeComponent call, the
 * require('react-native/...') is resolved from THIS directory — which walks up
 * to example/node_modules/react-native (the single correct instance).
 *
 * Same pattern as CollectionView.tsx living in example/ instead of src/.
 */
import type { ViewProps } from 'react-native';
import type { DirectEventHandler, Float } from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

type OnMeasuredEvent = Readonly<{
  height: Float;
  width: Float;
}>;

interface NativeProps extends ViewProps {
  onMeasured?: DirectEventHandler<OnMeasuredEvent>;
}

export default codegenNativeComponent<NativeProps>('RNMeasuredCell');
