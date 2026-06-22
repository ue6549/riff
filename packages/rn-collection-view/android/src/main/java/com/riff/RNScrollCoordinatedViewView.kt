package com.riff

import android.content.Context
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Android equivalent of RNScrollCoordinatedViewView.mm.
 *
 * A FrameLayout that applies a translationY (or translationX for horizontal)
 * transform based on the parent ScrollView's scroll position. The transform
 * is computed entirely on the UI thread — no JS involvement per frame.
 *
 * Uses ViewTreeObserver.OnScrollChangedListener instead of iOS KVO.
 *
 * Supported behaviours:
 *   - 'sticky': translate = max(0, scrollOffset - naturalPos)
 *   - 'push':   translate = max(0, min(scrollOffset - naturalPos, boundary - naturalPos - headerSize))
 */
class RNScrollCoordinatedViewView(context: Context) : FrameLayout(context) {

    // ── Public properties ────────────────────────────────────────────────────
    var layoutCacheId: Int = 0

    // ── Cached props ─────────────────────────────────────────────────────────
    private var boundaryY: Float = Float.MAX_VALUE
    private var boundaryX: Float = Float.MAX_VALUE
    private var headerHeight: Float = 0f
    private var isPush: Boolean = true
    private var enabled: Boolean = true
    private var isFooter: Boolean = false
    private var isHorizontal: Boolean = false

    // ── Pending props — each setter stores here; flushPendingProps applies all ──
    // This ensures any prop arriving in any Fabric commit order produces the
    // correct final state (previously only behavior triggered updateProps).
    var pendingBoundaryY: Float = Float.MAX_VALUE
    var pendingBoundaryX: Float = Float.MAX_VALUE
    var pendingHeaderHeight: Float = 0f
    var pendingBehavior: String = "push"
    var pendingEnabled: Boolean = true
    var pendingKind: String = ""
    var pendingHorizontal: Boolean = false

    fun flushPendingProps() {
        updateProps(
            newBoundaryY    = pendingBoundaryY,
            newBoundaryX    = pendingBoundaryX,
            newHeaderHeight = pendingHeaderHeight,
            behavior        = pendingBehavior,
            newEnabled      = pendingEnabled,
            kind            = pendingKind,
            horizontal      = pendingHorizontal,
        )
    }

    // ── Parent scroll view tracking ──────────────────────────────────────────
    private var parentScrollView: ScrollView? = null
    private var parentHScrollView: HorizontalScrollView? = null
    private var scrollListener: ViewTreeObserver.OnScrollChangedListener? = null
    private var observing: Boolean = false

    // ── Props update ─────────────────────────────────────────────────────────

    fun updateProps(
        newBoundaryY: Float,
        newBoundaryX: Float,
        newHeaderHeight: Float,
        behavior: String,
        newEnabled: Boolean,
        kind: String,
        horizontal: Boolean
    ) {
        boundaryY = newBoundaryY
        boundaryX = newBoundaryX
        headerHeight = newHeaderHeight
        isPush = (behavior == "push")
        enabled = newEnabled
        isFooter = (kind == "footer")
        isHorizontal = horizontal

        applyTransform()
    }

    // ── View hierarchy — find parent ScrollView ──────────────────────────────

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        findAndObserveScrollView()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        stopObserving()
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)

        // Fabric may assemble the hierarchy after onAttachedToWindow.
        if (!observing) {
            findAndObserveScrollView()
        }

        // Recompute sticky transform whenever our geometry changes.
        applyTransform()
    }

    private fun findAndObserveScrollView() {
        stopObserving()

        var v = parent as? android.view.View
        while (v != null) {
            if (v is ScrollView) {
                parentScrollView = v
                break
            }
            if (v is HorizontalScrollView) {
                parentHScrollView = v
                break
            }
            v = v.parent as? android.view.View
        }

        val targetView = parentScrollView ?: parentHScrollView
        if (targetView != null) {
            val listener = ViewTreeObserver.OnScrollChangedListener {
                applyTransform()
            }
            scrollListener = listener
            targetView.viewTreeObserver.addOnScrollChangedListener(listener)
            observing = true
            applyTransform()
        }
    }

    private fun stopObserving() {
        if (observing) {
            scrollListener?.let { listener ->
                parentScrollView?.viewTreeObserver?.removeOnScrollChangedListener(listener)
                parentHScrollView?.viewTreeObserver?.removeOnScrollChangedListener(listener)
            }
        }
        observing = false
        parentScrollView = null
        parentHScrollView = null
        scrollListener = null
    }

    // ── Transform computation ────────────────────────────────────────────────

    private fun applyTransform() {
        if (!enabled) {
            translationX = 0f
            translationY = 0f
            translationZ = 0f
            return
        }

        // Skip if not laid out yet.
        if (width <= 0 || height <= 0) return

        val density = resources.displayMetrics.density

        if (isHorizontal) {
            val scrollPx = parentHScrollView?.scrollX ?: parentScrollView?.scrollX ?: return
            val scrollX = scrollPx / density
            val viewportW = (parentHScrollView?.width ?: parentScrollView?.width ?: return) / density
            // Natural X from layout position (not affected by translationX).
            val naturalX = left / density

            val translateX: Float
            if (isFooter) {
                val desiredLeft = scrollX + viewportW - headerHeight
                translateX = if (isPush) {
                    val minTranslate = boundaryX - naturalX
                    min(0f, max(desiredLeft - naturalX, minTranslate))
                } else {
                    min(0f, desiredLeft - naturalX)
                }
            } else {
                translateX = if (isPush) {
                    val maxTranslate = boundaryX - naturalX - headerHeight
                    max(0f, min(scrollX - naturalX, maxTranslate))
                } else {
                    max(0f, scrollX - naturalX)
                }
            }

            this.translationX = translateX * density
            this.translationZ = if (abs(translateX) > 0.1f) 100f else 0f
            return
        }

        // ── Vertical path ────────────────────────────────────────────────────
        val scrollPx = parentScrollView?.scrollY ?: parentHScrollView?.scrollY ?: return
        val scrollY = scrollPx / density
        val viewportH = (parentScrollView?.height ?: parentHScrollView?.height ?: return) / density
        val naturalY = top / density

        val translateY: Float
        if (isFooter) {
            val desiredTop = scrollY + viewportH - headerHeight
            translateY = if (isPush) {
                val minTranslate = boundaryY - naturalY
                min(0f, max(desiredTop - naturalY, minTranslate))
            } else {
                min(0f, desiredTop - naturalY)
            }
        } else {
            translateY = if (isPush) {
                val maxTranslate = boundaryY - naturalY - headerHeight
                max(0f, min(scrollY - naturalY, maxTranslate))
            } else {
                max(0f, scrollY - naturalY)
            }
        }

        this.translationY = translateY * density
        this.translationZ = if (abs(translateY) > 0.1f) 100f else 0f
    }
}
