package com.riff

import android.content.Context
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.HorizontalScrollView
import kotlin.math.abs

/**
 * HorizontalScrollView that proactively claims the touch gesture on ACTION_DOWN
 * so a parent RiffScrollView (vertical) cannot intercept it prematurely.
 *
 * Also fires drag-begin / drag-end / momentum-begin / momentum-end callbacks
 * to match iOS UIScrollViewDelegate parity.
 */
class RiffHorizontalScrollView(context: Context) : HorizontalScrollView(context) {
    var onScrollListener: ((scrollX: Int) -> Unit)? = null
    var onScrollBeginDragListener: (() -> Unit)? = null
    var onScrollEndDragListener: (() -> Unit)? = null
    var onMomentumScrollBeginListener: (() -> Unit)? = null
    var onMomentumScrollEndListener: (() -> Unit)? = null

    private var downX = 0f
    private var downY = 0f
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private var isDragging = false
    private var isFling = false

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.x
                downY = ev.y
                isDragging = false
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = abs(ev.x - downX)
                val dy = abs(ev.y - downY)
                if (dy > touchSlop && dy > dx) {
                    // Gesture is vertical — release parent so it can scroll.
                    parent?.requestDisallowInterceptTouchEvent(false)
                }
                if (!isDragging) {
                    isDragging = true
                    onScrollBeginDragListener?.invoke()
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                parent?.requestDisallowInterceptTouchEvent(false)
                if (isDragging) {
                    isDragging = false
                    onScrollEndDragListener?.invoke()
                    isFling = true
                }
            }
        }
        return super.onTouchEvent(ev)
    }

    override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
        super.onScrollChanged(l, t, oldl, oldt)
        onScrollListener?.invoke(l)

        if (isFling && !isDragging) {
            onMomentumScrollBeginListener?.invoke()
            isFling = false
        }
    }

    override fun onOverScrolled(scrollX: Int, scrollY: Int, clampedX: Boolean, clampedY: Boolean) {
        super.onOverScrolled(scrollX, scrollY, clampedX, clampedY)
        if (!isDragging && (clampedX || clampedY)) {
            onMomentumScrollEndListener?.invoke()
        }
    }
}
