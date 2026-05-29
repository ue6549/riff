/**
 * TurboModule spec — codegen input.
 * Defines the JS-visible surface of the C++ JSI module.
 * Must only use codegen-supported types.
 */
import type { TurboModule } from 'react-native';
export interface Spec extends TurboModule {
    /**
     * M0.3: Smoke test — proves synchronous JSI call works.
     * Returns "pong" synchronously.
     */
    ping(): string;
}
declare const _default: Spec;
export default _default;
