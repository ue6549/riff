/**
 * TurboModule spec — codegen input.
 * Defines the JS-visible surface of the C++ JSI module.
 * Must only use codegen-supported types.
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * M0.3: Smoke test — proves synchronous JSI call works.
   * Returns "pong" synchronously.
   */
  ping(): string;
}

// On iOS, the TurboModule IS the C++ CollectionViewModule (get() override provides all JSI methods).
// On Android, JavaTurboModule binding ignores C++ get() overrides — JSI methods are installed
// via nativeInstall() in RiffModule.initialize() as a global HostObject instead.
const _turboModule = TurboModuleRegistry.getEnforcing<Spec>('RiffModule');
export default ((global as unknown as Record<string, unknown>).__riffNativeMod ?? _turboModule) as Spec;
