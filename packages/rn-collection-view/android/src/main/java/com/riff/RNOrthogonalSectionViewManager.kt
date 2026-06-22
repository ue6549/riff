package com.riff

import android.view.View
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewGroupManager
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.RNOrthogonalSectionViewManagerDelegate
import com.facebook.react.viewmanagers.RNOrthogonalSectionViewManagerInterface

@ReactModule(name = RNOrthogonalSectionViewManager.NAME)
class RNOrthogonalSectionViewManager : ViewGroupManager<RNOrthogonalSectionView>(),
    RNOrthogonalSectionViewManagerInterface<RNOrthogonalSectionView> {

    companion object {
        const val NAME = "RNOrthogonalSectionView"
    }

    private val delegate = RNOrthogonalSectionViewManagerDelegate(this)

    override fun getName(): String = NAME

    override fun getDelegate(): ViewManagerDelegate<RNOrthogonalSectionView> = delegate

    override fun createViewInstance(context: ThemedReactContext): RNOrthogonalSectionView {
        return RNOrthogonalSectionView(context)
    }

    override fun needsCustomLayoutForChildren(): Boolean = true

    @ReactProp(name = "sectionIndex", defaultInt = 0)
    override fun setSectionIndex(view: RNOrthogonalSectionView, value: Int) {}

    @ReactProp(name = "contentWidth", defaultFloat = 0f)
    override fun setContentWidth(view: RNOrthogonalSectionView, value: Float) {}

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any>? {
        return mapOf(
            "topHScroll" to mapOf("registrationName" to "onHScroll")
        )
    }
}
