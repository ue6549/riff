package com.riff

import android.content.Context
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.ScrollView
import kotlin.math.abs

/**
 * ScrollView subclass that fires a callback on every scroll position change
 * and yields to child HorizontalScrollViews when a horizontal swipe is detected.
 *
 * Also fires drag-begin / drag-end / momentum-begin / momentum-end callbacks
 * to match iOS UIScrollViewDelegate parity.
 */
class RiffScrollView(context: Context) : ScrollView(context) {
    var onScrollListener: ((scrollY: Int) -> Unit)? = null
    var onScrollBeginDragListener: (() -> Unit)? = null
    var onScrollEndDragListener: (() -> Unit)? = null
    var onMomentumScrollBeginListener: (() -> Unit)? = null
    var onMomentumScrollEndListener: (() -> Unit)? = null

    private var downX = 0f
    private var downY = 0f
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private var isDragging = false
    private var isFling = false

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.x
                downY = ev.y
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = abs(ev.x - downX)
                val dy = abs(ev.y - downY)
                if (dx > touchSlop && dx > dy) return false
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                downX = 0f
                downY = 0f
            }
        }
        return super.onInterceptTouchEvent(ev)
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                isDragging = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (!isDragging) {
                    isDragging = true
                    onScrollBeginDragListener?.invoke()
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (isDragging) {
                    isDragging = false
                    onScrollEndDragListener?.invoke()
                    // If a fling was triggered, ScrollView will keep scrolling.
                    // We detect fling onset via the next onScrollChanged after touch-up.
                    isFling = true
                }
            }
        }
        val result = super.onTouchEvent(ev)
        return result
    }

    override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
        super.onScrollChanged(l, t, oldl, oldt)
        onScrollListener?.invoke(t)

        if (isFling && !isDragging) {
            onMomentumScrollBeginListener?.invoke()
            isFling = false
        }
    }

    override fun onOverScrolled(scrollX: Int, scrollY: Int, clampedX: Boolean, clampedY: Boolean) {
        super.onOverScrolled(scrollX, scrollY, clampedX, clampedY)
        // When clamped during deceleration, momentum is done.
        if (!isDragging && (clampedY || clampedX)) {
            onMomentumScrollEndListener?.invoke()
        }
    }
}
