/**
 * Runtime spec for RNScrollCoordinatedView — must live in example/components/
 * so codegenNativeComponent resolves react-native from the example app's
 * node_modules (the single correct instance). A bare re-export from
 * src/specs/ would resolve the library's own react-native copy and register
 * in the wrong ReactNativeViewConfigRegistry.
 *
 * Same pattern as RNMeasuredCellNativeComponent.ts.
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
