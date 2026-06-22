package com.riff

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * React Native package that registers all Riff view managers and modules.
 * Auto-linked by the React Native Gradle plugin via the codegenConfig in package.json.
 */
class RiffPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(RiffModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return listOf(
            RNMeasuredCellViewManager(),
            RNCollectionViewContainerViewManager(),
            RNCollectionSubContainerViewManager(),
            RNScrollCoordinatedViewViewManager(),
            RNOrthogonalSectionViewManager(),
        )
    }
}
