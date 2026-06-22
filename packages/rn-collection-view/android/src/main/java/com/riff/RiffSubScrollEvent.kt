package com.riff

import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.uimanager.events.Event

/**
 * onSubScroll event dispatched from RNCollectionSubContainerView when the internal
 * scroll view scrolls. Carries { sectionIndex, scrollX, scrollY } in dp.
 * JS handler calls processSubScroll(sectionIndex, x, y) to update H cell render range.
 */
class RiffSubScrollEvent(
    surfaceId: Int,
    viewTag: Int,
    private val sectionIndex: Int,
    private val scrollXDp: Float,
    private val scrollYDp: Float,
) : Event<RiffSubScrollEvent>(surfaceId, viewTag) {

    override fun getEventName(): String = "topSubScroll"

    override fun getEventData(): WritableNativeMap {
        return WritableNativeMap().apply {
            putInt("sectionIndex", sectionIndex)
            putDouble("scrollX", scrollXDp.toDouble())
            putDouble("scrollY", scrollYDp.toDouble())
        }
    }
}
