package com.riff

import android.view.View
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewGroupManager
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.RNCollectionSubContainerManagerDelegate
import com.facebook.react.viewmanagers.RNCollectionSubContainerManagerInterface

@ReactModule(name = RNCollectionSubContainerViewManager.NAME)
class RNCollectionSubContainerViewManager : ViewGroupManager<RNCollectionSubContainerView>(),
    RNCollectionSubContainerManagerInterface<RNCollectionSubContainerView> {

    companion object {
        const val NAME = "RNCollectionSubContainer"
    }

    init {
        setupViewRecycling()
    }

    private val delegate = RNCollectionSubContainerManagerDelegate(this)

    override fun getName(): String = NAME

    override fun getDelegate(): ViewManagerDelegate<RNCollectionSubContainerView> = delegate

    override fun createViewInstance(context: ThemedReactContext): RNCollectionSubContainerView {
        return RNCollectionSubContainerView(context)
    }

    override fun prepareToRecycleView(
        reactContext: ThemedReactContext,
        view: RNCollectionSubContainerView
    ): RNCollectionSubContainerView {
        view.prepareForRecycle()
        return view
    }

    override fun recycleView(
        reactContext: ThemedReactContext,
        view: RNCollectionSubContainerView
    ): RNCollectionSubContainerView = view

    // ── Child management — route into internal contentViewChild ──────────────

    override fun addView(parent: RNCollectionSubContainerView, child: View, index: Int) {
        parent.mountChildComponentView(child, index)
    }

    override fun removeViewAt(parent: RNCollectionSubContainerView, index: Int) {
        val child = parent.getContentChildAt(index)
        if (child != null) parent.unmountChildComponentView(child)
    }

    override fun getChildCount(parent: RNCollectionSubContainerView): Int {
        return parent.getContentChildCount()
    }

    override fun getChildAt(parent: RNCollectionSubContainerView, index: Int): View? {
        return parent.getContentChildAt(index)
    }

    override fun removeAllViews(parent: RNCollectionSubContainerView) {
        parent.removeAllContentChildren()
    }

    override fun needsCustomLayoutForChildren(): Boolean = true

    // ── Props ────────────────────────────────────────────────────────────────
    //
    // Prop arrival order from Fabric is not guaranteed. Previously each setter called
    // updateProps with hardcoded "none" / 0 defaults for the other values, so e.g.
    // setLayoutCacheId arriving after setScrollDirection("horizontal") would silently
    // reset scrollDirection back to "none". Now each setter stores only its own value
    // and calls flushPendingProps() which applies all accumulated props together.

    @ReactProp(name = "layoutCacheId", defaultInt = 0)
    override fun setLayoutCacheId(view: RNCollectionSubContainerView, value: Int) {
        view.pendingLayoutCacheId = value
        view.flushPendingSubContainerProps()
    }

    @ReactProp(name = "sectionIndex", defaultInt = 0)
    override fun setSectionIndex(view: RNCollectionSubContainerView, value: Int) {
        view.pendingSectionIndex = value
        view.flushPendingSubContainerProps()
    }

    @ReactProp(name = "scrollDirection")
    override fun setScrollDirection(view: RNCollectionSubContainerView, value: String?) {
        view.pendingScrollDirection = value ?: "none"
        view.flushPendingSubContainerProps()
    }

    @ReactProp(name = "contentWidth", defaultFloat = 0f)
    override fun setContentWidth(view: RNCollectionSubContainerView, value: Float) {
        view.pendingContentWidth = value
        view.flushPendingSubContainerProps()
    }

    @ReactProp(name = "contentHeight", defaultFloat = 0f)
    override fun setContentHeight(view: RNCollectionSubContainerView, value: Float) {
        view.pendingContentHeight = value
        view.flushPendingSubContainerProps()
    }

    @ReactProp(name = "layoutCacheVersion", defaultInt = 0)
    override fun setLayoutCacheVersion(view: RNCollectionSubContainerView, value: Int) {}

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any>? {
        return mapOf(
            "topSubScroll" to mapOf("registrationName" to "onSubScroll")
        )
    }

    // ── State delivery from C++ ShadowNode ───────────────────────────────────

    override fun updateState(
        view: RNCollectionSubContainerView,
        props: ReactStylesDiffMap,
        stateWrapper: StateWrapper
    ): Any? {
        val stateData = stateWrapper.stateData
        if (stateData == null) {
            android.util.Log.e("RIFF_DBG", "SubContainer updateState: stateData=null")
            return null
        }

        val contentWidth = stateData.getDouble("contentWidth").toFloat()
        val contentHeight = stateData.getDouble("contentHeight").toFloat()

        val xArr = stateData.getArray("childX")
        val yArr = stateData.getArray("childY")
        val wArr = stateData.getArray("childW")
        val hArr = stateData.getArray("childH")
        val opArr = stateData.getArray("childOpacity")
        val zArr = stateData.getArray("childZIndex")
        val tagsArr = stateData.getArray("childTags")
        val hasTransformArr = stateData.getArray("childHasTransform")
        val transformArr = stateData.getArray("childTransform")

        val count = tagsArr?.size() ?: 0
        val xs = FloatArray(count) { xArr?.getDouble(it)?.toFloat() ?: 0f }
        val ys = FloatArray(count) { yArr?.getDouble(it)?.toFloat() ?: 0f }
        val ws = FloatArray(count) { wArr?.getDouble(it)?.toFloat() ?: 0f }
        val hs = FloatArray(count) { hArr?.getDouble(it)?.toFloat() ?: 0f }
        val opacities = FloatArray(count) { opArr?.getDouble(it)?.toFloat() ?: 1f }
        val zIndexes = FloatArray(count) { zArr?.getDouble(it)?.toFloat() ?: 0f }
        val tags = IntArray(count) { tagsArr?.getInt(it) ?: 0 }
        val hasTransforms = BooleanArray(count) { hasTransformArr?.getBoolean(it) ?: false }
        // Flat column-major 4×4 matrices — 16 floats per child.
        val transforms = FloatArray(count * 16) { i ->
            transformArr?.getDouble(i)?.toFloat() ?: (if (i % 17 == 0) 1f else 0f)
        }

        android.util.Log.e("RIFF_DBG", "SubContainer updateState: children=${count} content=${contentWidth}x${contentHeight} viewW=${view.width} viewH=${view.height}")

        view.updateState(xs, ys, ws, hs, opacities, zIndexes, hasTransforms, transforms, tags, contentWidth, contentHeight)
        return null
    }
}
