package com.riff

import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.uimanager.events.Event

/**
 * Scroll event dispatched from RNCollectionViewContainerView to JS.
 * Matches the onScroll payload format expected by CollectionView.tsx.
 */
class RiffScrollEvent(
    surfaceId: Int,
    viewTag: Int,
    private val offsetX: Float,
    private val offsetY: Float,
    private val contentW: Float,
    private val contentH: Float,
    private val layoutW: Float,
    private val layoutH: Float,
) : Event<RiffScrollEvent>(surfaceId, viewTag) {

    override fun getEventName(): String = "topScroll"

    override fun getEventData(): WritableNativeMap {
        return WritableNativeMap().apply {
            putMap("contentOffset", WritableNativeMap().apply {
                putDouble("x", offsetX.toDouble())
                putDouble("y", offsetY.toDouble())
            })
            putMap("contentSize", WritableNativeMap().apply {
                putDouble("width", contentW.toDouble())
                putDouble("height", contentH.toDouble())
            })
            putMap("layoutMeasurement", WritableNativeMap().apply {
                putDouble("width", layoutW.toDouble())
                putDouble("height", layoutH.toDouble())
            })
        }
    }
}
