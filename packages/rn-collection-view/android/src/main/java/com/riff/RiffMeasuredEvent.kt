package com.riff

import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.uimanager.events.Event

/**
 * onMeasured event dispatched from RNMeasuredCellView when its laid-out size
 * changes. Matches the OnMeasuredEvent payload expected by CollectionView.tsx:
 *   { width: Float, height: Float }  (in logical dp, same as iOS pts)
 */
class RiffMeasuredEvent(
    surfaceId: Int,
    viewTag: Int,
    private val widthDp: Float,
    private val heightDp: Float,
) : Event<RiffMeasuredEvent>(surfaceId, viewTag) {

    override fun getEventName(): String = "topMeasured"

    override fun getEventData(): WritableNativeMap {
        return WritableNativeMap().apply {
            putDouble("width", widthDp.toDouble())
            putDouble("height", heightDp.toDouble())
        }
    }
}
