package com.riff

import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.uimanager.events.Event

/**
 * Scroll lifecycle event dispatched to JS for begin-drag, end-drag,
 * momentum-begin, and momentum-end — matching iOS UIScrollViewDelegate callbacks.
 *
 * Event payload shape is identical to RiffScrollEvent so JS handlers can
 * read contentOffset, contentSize, and layoutMeasurement from all event types.
 */
class RiffScrollLifecycleEvent(
    surfaceId: Int,
    viewTag: Int,
    private val lifecycleEventName: String,
    private val offsetX: Float,
    private val offsetY: Float,
    private val contentW: Float,
    private val contentH: Float,
    private val layoutW: Float,
    private val layoutH: Float,
) : Event<RiffScrollLifecycleEvent>(surfaceId, viewTag) {

    override fun getEventName(): String = lifecycleEventName

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
