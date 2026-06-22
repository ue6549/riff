package com.riff

import android.content.Context
import android.view.View
import android.view.ViewGroup

/**
 * Content ViewGroup that does NOT measure or layout children via the standard
 * Android measure/layout cycle. Children are Fabric-managed ReactViewGroups
 * positioned exclusively by applyPositionsFromState (from the C++ ShadowNode).
 *
 * Without this, the parent ScrollView triggers measureChildWithMargins on
 * Fabric children, which throws "A catalyst view must have an explicit width
 * and height" because they expect EXACTLY MeasureSpecs from Yoga.
 *
 * Drawing order: decoration views (zIndex < 0) are drawn before cells so
 * they appear behind content — mirrors iOS layer.zPosition behaviour.
 * drawingOrder is rebuilt by the parent container each time it applies positions.
 */
class RiffContentView(context: Context) : ViewGroup(context) {

    /**
     * Parallel to the child view list. Each entry is the drawing index:
     * drawingOrder[drawPosition] = childIndex. Rebuilt by the parent
     * container after every applyPositionsFromState so that decoration
     * views (negative zIndex) are drawn before regular cells.
     *
     * Empty = use default order (no decorations present, fast path).
     */
    var drawingOrder: IntArray = IntArray(0)
        set(value) {
            field = value
            isChildrenDrawingOrderEnabled = value.isNotEmpty()
        }

    override fun getChildDrawingOrder(childCount: Int, drawPosition: Int): Int {
        return if (drawingOrder.size == childCount) drawingOrder[drawPosition] else drawPosition
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Report the full content size (set via layoutParams from updateState)
        // so the parent ScrollView knows the content extends beyond the viewport.
        // Don't measure children — they're Fabric-managed.
        val lp = layoutParams
        val w = if (lp != null && lp.width > 0) lp.width
                else MeasureSpec.getSize(widthMeasureSpec)
        val h = if (lp != null && lp.height > 0) lp.height
                else MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(w, h)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        // Children are positioned by applyPositionsFromState, not by Android layout.
    }
}
