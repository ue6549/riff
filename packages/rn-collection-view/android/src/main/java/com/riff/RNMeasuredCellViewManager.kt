package com.riff

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewGroupManager
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.RNMeasuredCellManagerDelegate
import com.facebook.react.viewmanagers.RNMeasuredCellManagerInterface

/**
 * Fabric ViewManager for RNMeasuredCellView.
 * Registers with the codegen-generated delegate for type-safe prop application.
 */
@ReactModule(name = RNMeasuredCellViewManager.NAME)
class RNMeasuredCellViewManager : ViewGroupManager<RNMeasuredCellView>(),
    RNMeasuredCellManagerInterface<RNMeasuredCellView> {

    companion object {
        const val NAME = "RNMeasuredCell"
    }

    init {
        setupViewRecycling()
    }

    private val delegate = RNMeasuredCellManagerDelegate(this)

    override fun getName(): String = NAME

    override fun getDelegate(): ViewManagerDelegate<RNMeasuredCellView> = delegate

    override fun createViewInstance(context: ThemedReactContext): RNMeasuredCellView {
        return RNMeasuredCellView(context)
    }

    override fun prepareToRecycleView(
        reactContext: ThemedReactContext,
        view: RNMeasuredCellView
    ): RNMeasuredCellView {
        view.prepareForRecycle()
        return view
    }

    override fun recycleView(
        reactContext: ThemedReactContext,
        view: RNMeasuredCellView
    ): RNMeasuredCellView = view

    @ReactProp(name = "type")
    override fun setType(view: RNMeasuredCellView, value: String?) {
        // Stored for debug visuals only — no-op on Android for now.
    }

    @ReactProp(name = "kind")
    override fun setKind(view: RNMeasuredCellView, value: String?) {
        // Stored for debug visuals only.
    }

    @ReactProp(name = "index", defaultInt = -1)
    override fun setIndex(view: RNMeasuredCellView, value: Int) {
        // Used for debug logging.
    }

    @ReactProp(name = "cacheKey")
    override fun setCacheKey(view: RNMeasuredCellView, value: String?) {
        view.cacheKey = value
    }

    @ReactProp(name = "isMeasureOnly", defaultBoolean = false)
    override fun setIsMeasureOnly(view: RNMeasuredCellView, value: Boolean) {
        // Used for debug visuals — no-op on Android for now.
    }

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any>? {
        return mapOf(
            "topMeasured" to mapOf(
                "registrationName" to "onMeasured"
            )
        )
    }
}
