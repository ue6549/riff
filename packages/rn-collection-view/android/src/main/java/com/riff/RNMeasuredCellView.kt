package com.riff

import android.content.Context
import android.widget.FrameLayout
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper

/**
 * Android equivalent of RNMeasuredCellView.mm.
 *
 * A FrameLayout that:
 * - Guards its layout origin (set by the parent container's applyPositionsFromState)
 *   from being overwritten by Yoga's sequential flex-column layout.
 * - Fires an onMeasured event via the Fabric EventDispatcher when its size changes.
 * - Stores a cacheKey for visual-attrs lookup.
 */
class RNMeasuredCellView(context: Context) : FrameLayout(context) {

    /** Set to true by the parent container's applyPositionsFromState when this
     *  cell is a direct container child and the ShadowNode is the position authority. */
    var shadowNodePositioned: Boolean = false

    /** Cache key from props — used by applyPositionsFromState to look up visual attributes. */
    var cacheKey: String? = null

    /** Last size reported via onMeasured — suppress duplicates. */
    private var lastFiredWidth: Int = 0
    private var lastFiredHeight: Int = 0

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        // When the ShadowNode (parent container) is the position authority, preserve the
        // origin that applyPositionsFromState set via child.layout(). Only allow the size
        // (right - left, bottom - top) to flow through from Yoga.
        // Without this guard Fabric's sequential top-down layout() call overwrites the
        // x/y that the C++ LayoutCache computed, causing cells to stack at y=0.
        if (shadowNodePositioned && !changed) {
            // Size hasn't changed and origin is already correct — nothing to do.
            val w = right - left
            val h = bottom - top
            if (w == lastFiredWidth && h == lastFiredHeight) return
            lastFiredWidth = w
            lastFiredHeight = h
            val density = resources.displayMetrics.density
            dispatchOnMeasured(w / density, h / density)
            return
        }

        if (shadowNodePositioned) {
            // Size changed but we own the origin: re-apply the cached position so Fabric's
            // layout call doesn't shift us to 0,0.
            val w = right - left
            val h = bottom - top
            val l = this.left
            val t = this.top
            // Let super run with corrected geometry if Fabric changed the bounds.
            super.onLayout(changed, l, t, l + w, t + h)

            if (w == lastFiredWidth && h == lastFiredHeight) return
            lastFiredWidth = w
            lastFiredHeight = h
            val density = resources.displayMetrics.density
            dispatchOnMeasured(w / density, h / density)
            return
        }

        super.onLayout(changed, left, top, right, bottom)

        val w = right - left
        val h = bottom - top

        if (w == lastFiredWidth && h == lastFiredHeight) return
        if (h <= 0) return

        lastFiredWidth = w
        lastFiredHeight = h

        val density = resources.displayMetrics.density
        dispatchOnMeasured(w / density, h / density)
    }

    private fun dispatchOnMeasured(widthDp: Float, heightDp: Float) {
        val ctx = context as? ReactContext ?: return
        val surfaceId = UIManagerHelper.getSurfaceId(this)
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(ctx, id)
            ?: UIManagerHelper.getUIManager(ctx, com.facebook.react.uimanager.common.UIManagerType.FABRIC)
                ?.eventDispatcher
            ?: return
        dispatcher.dispatchEvent(RiffMeasuredEvent(surfaceId, id, widthDp, heightDp))
    }

    /**
     * Called by Fabric before returning this view to its pool for reuse.
     */
    fun prepareForRecycle() {
        shadowNodePositioned = false
        lastFiredWidth = 0
        lastFiredHeight = 0
        cacheKey = null
        alpha = 1.0f
        translationZ = 0f
        scaleX = 1f
        scaleY = 1f
        rotationX = 0f
        rotationY = 0f
        translationX = 0f
        translationY = 0f
    }
}
