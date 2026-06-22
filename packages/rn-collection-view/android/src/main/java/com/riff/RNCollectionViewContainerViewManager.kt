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
import com.facebook.react.viewmanagers.RNCollectionViewContainerManagerDelegate
import com.facebook.react.viewmanagers.RNCollectionViewContainerManagerInterface

@ReactModule(name = RNCollectionViewContainerViewManager.NAME)
class RNCollectionViewContainerViewManager : ViewGroupManager<RNCollectionViewContainerView>(),
    RNCollectionViewContainerManagerInterface<RNCollectionViewContainerView> {

    companion object {
        const val NAME = "RNCollectionViewContainer"
    }

    init {
        setupViewRecycling()
    }

    private val delegate = RNCollectionViewContainerManagerDelegate(this)

    override fun getName(): String = NAME

    override fun getDelegate(): ViewManagerDelegate<RNCollectionViewContainerView> = delegate

    override fun createViewInstance(context: ThemedReactContext): RNCollectionViewContainerView {
        return RNCollectionViewContainerView(context)
    }

    override fun prepareToRecycleView(
        reactContext: ThemedReactContext,
        view: RNCollectionViewContainerView
    ): RNCollectionViewContainerView {
        view.prepareForRecycle()
        return view
    }

    override fun recycleView(
        reactContext: ThemedReactContext,
        view: RNCollectionViewContainerView
    ): RNCollectionViewContainerView = view

    // ── Child management — route into internal contentView ───────────────────

    override fun addView(parent: RNCollectionViewContainerView, child: View, index: Int) {
        parent.mountChildComponentView(child, index)
    }

    override fun removeViewAt(parent: RNCollectionViewContainerView, index: Int) {
        val child = parent.getContentChildAt(index)
        if (child != null) parent.unmountChildComponentView(child)
    }

    override fun getChildCount(parent: RNCollectionViewContainerView): Int {
        return parent.getContentChildCount()
    }

    override fun getChildAt(parent: RNCollectionViewContainerView, index: Int): View? {
        return parent.getContentChildAt(index)
    }

    override fun removeAllViews(parent: RNCollectionViewContainerView) {
        parent.removeAllContentChildren()
    }

    override fun needsCustomLayoutForChildren(): Boolean = true

    // ── Props ────────────────────────────────────────────────────────────────

    @ReactProp(name = "layoutType")
    override fun setLayoutType(view: RNCollectionViewContainerView, value: String?) {}

    @ReactProp(name = "columns", defaultInt = 1)
    override fun setColumns(view: RNCollectionViewContainerView, value: Int) {}

    @ReactProp(name = "columnSpacing", defaultFloat = 0f)
    override fun setColumnSpacing(view: RNCollectionViewContainerView, value: Float) {}

    @ReactProp(name = "rowSpacing", defaultFloat = 0f)
    override fun setRowSpacing(view: RNCollectionViewContainerView, value: Float) {}

    @ReactProp(name = "sectionInsetTop", defaultFloat = 0f)
    override fun setSectionInsetTop(view: RNCollectionViewContainerView, value: Float) {}

    @ReactProp(name = "sectionInsetBottom", defaultFloat = 0f)
    override fun setSectionInsetBottom(view: RNCollectionViewContainerView, value: Float) {}

    @ReactProp(name = "sectionInsetLeft", defaultFloat = 0f)
    override fun setSectionInsetLeft(view: RNCollectionViewContainerView, value: Float) {}

    @ReactProp(name = "sectionInsetRight", defaultFloat = 0f)
    override fun setSectionInsetRight(view: RNCollectionViewContainerView, value: Float) {}

    @ReactProp(name = "layoutCacheId", defaultInt = 0)
    override fun setLayoutCacheId(view: RNCollectionViewContainerView, value: Int) {
        view.updateProps(
            newHorizontal = view.horizontal,
            scrollEnabled = true, bounces = true, showsVerticalScrollIndicator = true,
            scrollEventThrottle = 16f,
            newLayoutWritesVisualAttributes = view.layoutWritesVisualAttributes,
            newLayoutCacheId = value
        )
    }

    @ReactProp(name = "layoutCacheVersion", defaultInt = 0)
    override fun setLayoutCacheVersion(view: RNCollectionViewContainerView, value: Int) {}

    @ReactProp(name = "estimatedItemHeight", defaultFloat = 50f)
    override fun setEstimatedItemHeight(view: RNCollectionViewContainerView, value: Float) {}

    @ReactProp(name = "layoutWritesVisualAttributes", defaultBoolean = false)
    override fun setLayoutWritesVisualAttributes(view: RNCollectionViewContainerView, value: Boolean) {
        view.updateProps(
            newHorizontal = view.horizontal,
            scrollEnabled = true, bounces = true, showsVerticalScrollIndicator = true,
            scrollEventThrottle = 16f,
            newLayoutWritesVisualAttributes = value,
            newLayoutCacheId = view.layoutCacheId
        )
    }

    @ReactProp(name = "renderRangeStart", defaultInt = 0)
    override fun setRenderRangeStart(view: RNCollectionViewContainerView, value: Int) {}

    @ReactProp(name = "renderRangeEnd", defaultInt = -1)
    override fun setRenderRangeEnd(view: RNCollectionViewContainerView, value: Int) {}

    @ReactProp(name = "maintainVisibleContentPosition", defaultBoolean = true)
    override fun setMaintainVisibleContentPosition(view: RNCollectionViewContainerView, value: Boolean) {}

    @ReactProp(name = "horizontal", defaultBoolean = false)
    override fun setHorizontal(view: RNCollectionViewContainerView, value: Boolean) {
        view.updateProps(
            newHorizontal = value,
            scrollEnabled = true, bounces = true, showsVerticalScrollIndicator = true,
            scrollEventThrottle = 16f,
            newLayoutWritesVisualAttributes = view.layoutWritesVisualAttributes,
            newLayoutCacheId = view.layoutCacheId
        )
    }

    @ReactProp(name = "scrollEnabled", defaultBoolean = true)
    override fun setScrollEnabled(view: RNCollectionViewContainerView, value: Boolean) {}

    @ReactProp(name = "bounces", defaultBoolean = true)
    override fun setBounces(view: RNCollectionViewContainerView, value: Boolean) {}

    @ReactProp(name = "showsVerticalScrollIndicator", defaultBoolean = true)
    override fun setShowsVerticalScrollIndicator(view: RNCollectionViewContainerView, value: Boolean) {}

    @ReactProp(name = "scrollEventThrottle", defaultFloat = 0f)
    override fun setScrollEventThrottle(view: RNCollectionViewContainerView, value: Float) {}

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any>? {
        return mapOf(
            "topScroll" to mapOf("registrationName" to "onScroll"),
            "topScrollBeginDrag" to mapOf("registrationName" to "onScrollBeginDrag"),
            "topScrollEndDrag" to mapOf("registrationName" to "onScrollEndDrag"),
            "topMomentumScrollBegin" to mapOf("registrationName" to "onMomentumScrollBegin"),
            "topMomentumScrollEnd" to mapOf("registrationName" to "onMomentumScrollEnd"),
        )
    }

    // ── State delivery from C++ ShadowNode ───────────────────────────────────

    override fun updateState(
        view: RNCollectionViewContainerView,
        props: ReactStylesDiffMap,
        stateWrapper: StateWrapper
    ): Any? {
        val stateData = stateWrapper.stateData
        android.util.Log.e("RIFF_DBG", "updateState called, stateData=${stateData != null}")
        if (stateData == null) return null

        val positionsArray: ReadableArray? = stateData.getArray("positions")
        val positions = if (positionsArray != null) {
            FloatArray(positionsArray.size()) { positionsArray.getDouble(it).toFloat() }
        } else FloatArray(0)

        val tagsArray: ReadableArray? = stateData.getArray("childTags")
        val childTags = if (tagsArray != null) {
            IntArray(tagsArray.size()) { tagsArray.getInt(it) }
        } else IntArray(0)

        val contentWidth = stateData.getDouble("contentWidth").toFloat()
        val contentHeight = stateData.getDouble("contentHeight").toFloat()
        val layoutRevision = stateData.getInt("layoutRevision")

        android.util.Log.e("RIFF_DBG", "updateState: positions=${positions.size/4} tags=${childTags.size} content=${contentWidth}x${contentHeight} rev=$layoutRevision")

        view.updateState(positions, childTags, contentWidth, contentHeight, layoutRevision)
        return null
    }
}
