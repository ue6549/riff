/**
 * Re-export of the NativeCollectionViewModule TurboModule spec.
 *
 * The canonical spec lives in src/specs/ (required by codegenConfig.jsSrcsDir
 * for pod install / codegen). But if example code imports that spec directly
 * (via 'riff/src/specs/...' or a relative '../../src/specs/...' path),
 * TurboModuleRegistry.getEnforcing resolves 'react-native' from the library's
 * own node_modules/react-native — a separate instance from the example app's.
 * The module registers in the wrong registry and fails silently.
 *
 * This re-export file lives in example/components/ alongside CollectionView.tsx.
 * All 'react-native' imports resolve from THIS directory, which walks up to
 * example/node_modules/react-native (the single correct instance).
 *
 * ALL example/ code that needs NativeCollectionViewModule must import from here.
 * NEVER import from 'riff/src/specs/NativeCollectionViewModule' in example/ code.
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  ping(): string;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNCollectionViewModule');
