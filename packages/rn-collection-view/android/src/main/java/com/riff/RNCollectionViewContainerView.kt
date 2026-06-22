package com.riff

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import com.facebook.react.uimanager.events.EventDispatcher
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Android equivalent of RNCollectionViewContainerView.mm.
 *
 * Owns an internal ScrollView (or HorizontalScrollView). The ShadowNode handles
 * child positioning via layout() override. This view reads CollectionViewContainerState
 * to apply child frames, content size, scroll offset corrections, and forward scroll
 * events to JS for render range computation.
 *
 * Android-specific performance optimisations vs the naive JNI-per-event baseline:
 *
 *   • Dispatcher + surfaceId cached at onAttachedToWindow — eliminates UIManagerHelper
 *     map lookups (60/s on main thread) from the scroll hot path.
 *
 *   • Nanosecond-precision throttle (SystemClock.elapsedRealtimeNanos) — System.currentTimeMillis
 *     has ~1 ms granularity; nanos lets the 16 ms window be exact, preventing an extra event
 *     firing at 17-18 ms due to millisecond rounding.
 *
 *   • @CriticalNative on nativeSetScrollOffset — ART calls this without a JNI frame
 *     (~10× cheaper than a normal JNI call). Qualifies because the C++ impl never calls
 *     back into JNI or allocates JNI handles.
 *
 *   • Choreographer-aligned MVC scroll correction — deferring the correction to the next
 *     vsync boundary avoids a double-layout within a single frame when updateState and
 *     onLayout race during a fling.
 *
 *   • Pre-warm: emitOnScroll is called immediately when the view first receives valid
 *     dimensions so processScroll runs before the first user gesture.
 */
class RNCollectionViewContainerView(context: Context) : FrameLayout(context) {

    // ── Internal scroll hierarchy ────────────────────────────────────────────
    private var scrollView: RiffScrollView? = null
    private var hScrollView: RiffHorizontalScrollView? = null
    private val contentView: RiffContentView = RiffContentView(context)

    // ── State from ShadowNode ────────────────────────────────────────────────
    private var positions: FloatArray = FloatArray(0)
    private var childTags: IntArray = IntArray(0)
    private var layoutRevision: Int = -1
    private var hasReceivedFirstState: Boolean = false

    // ── Scroll event throttling ──────────────────────────────────────────────
    // Use nanoseconds (SystemClock.elapsedRealtimeNanos) for exact 16 ms boundaries.
    private var lastScrollEventNs: Long = 0
    private var scrollEventMinIntervalNs: Long = 16_000_000L // 16 ms default

    // ── Cached event dispatch handles (set in onAttachedToWindow) ────────────
    // Eliminates UIManagerHelper map lookups (one per scroll event at 60 fps).
    private var cachedDispatcher: EventDispatcher? = null
    private var cachedSurfaceId: Int = -1

    // ── MVC correction (deferred to next vsync via Choreographer) ────────────
    private var applyingCorrection: Boolean = false
    private var pendingMVCCorrection: Double = 0.0
    private var pendingMVCScrollTarget: Double = 0.0

    // ── Cached props ─────────────────────────────────────────────────────────
    var layoutCacheId: Int = 0
        private set
    var horizontal: Boolean = false
        private set
    var layoutWritesVisualAttributes: Boolean = false
        private set
    private var cachedScrollEnabled: Boolean = true
    private var cachedShowsVerticalScrollIndicator: Boolean = true

    private val mainHandler = Handler(Looper.getMainLooper())

    // ── Event callbacks (set by ViewManager) ─────────────────────────────────
    var onScrollCallback: ((
        contentOffsetX: Float, contentOffsetY: Float,
        contentSizeW: Float, contentSizeH: Float,
        layoutW: Float, layoutH: Float
    ) -> Unit)? = null
    var onScrollBeginDragCallback: ((
        contentOffsetX: Float, contentOffsetY: Float,
        contentSizeW: Float, contentSizeH: Float,
        layoutW: Float, layoutH: Float
    ) -> Unit)? = null
    var onScrollEndDragCallback: ((
        contentOffsetX: Float, contentOffsetY: Float,
        contentSizeW: Float, contentSizeH: Float,
        layoutW: Float, layoutH: Float
    ) -> Unit)? = null
    var onMomentumScrollBeginCallback: ((
        contentOffsetX: Float, contentOffsetY: Float,
        contentSizeW: Float, contentSizeH: Float,
        layoutW: Float, layoutH: Float
    ) -> Unit)? = null
    var onMomentumScrollEndCallback: ((
        contentOffsetX: Float, contentOffsetY: Float,
        contentSizeW: Float, contentSizeH: Float,
        layoutW: Float, layoutH: Float
    ) -> Unit)? = null

    init {
        setupVerticalScroll()
    }

    // ── Lifecycle: cache dispatcher + surfaceId once at attach ────────────────

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        rebuildDispatcherCache()
    }

    override fun onDetachedFromWindow() {
        cachedDispatcher = null
        cachedSurfaceId  = -1
        super.onDetachedFromWindow()
    }

    private fun rebuildDispatcherCache() {
        val ctx = context as? com.facebook.react.bridge.ReactContext ?: return
        cachedSurfaceId  = UIManagerHelper.getSurfaceId(this)
        cachedDispatcher = UIManagerHelper.getEventDispatcherForReactTag(ctx, id)
            ?: UIManagerHelper.getUIManager(ctx, UIManagerType.FABRIC)?.eventDispatcher
    }

    // ── Scroll view setup ────────────────────────────────────────────────────

    private fun setupVerticalScroll() {
        (contentView.parent as? ViewGroup)?.removeView(contentView)
        removeAllViews()
        hScrollView = null

        val sv = RiffScrollView(context).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
            isFillViewport = false
            isVerticalScrollBarEnabled = cachedShowsVerticalScrollIndicator
            isScrollbarFadingEnabled = true
            isScrollContainer = false
            overScrollMode = OVER_SCROLL_IF_CONTENT_SCROLLS
            onScrollListener               = { scrollY -> onScrollChanged(scrollY) }
            onScrollBeginDragListener      = { emitScrollLifecycleEvent("topScrollBeginDrag") }
            onScrollEndDragListener        = { emitScrollLifecycleEvent("topScrollEndDrag") }
            onMomentumScrollBeginListener  = { emitScrollLifecycleEvent("topMomentumScrollBegin") }
            onMomentumScrollEndListener    = { emitScrollLifecycleEvent("topMomentumScrollEnd") }
        }
        sv.isEnabled = cachedScrollEnabled
        sv.addView(contentView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        addView(sv)
        scrollView = sv
    }

    private fun setupHorizontalScroll() {
        (contentView.parent as? ViewGroup)?.removeView(contentView)
        removeAllViews()
        scrollView = null

        val hsv = RiffHorizontalScrollView(context).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
            isFillViewport = false
            isHorizontalScrollBarEnabled = false
            isScrollbarFadingEnabled = true
            isScrollContainer = false
            overScrollMode = OVER_SCROLL_IF_CONTENT_SCROLLS
            onScrollListener               = { scrollX -> onScrollChanged(scrollX) }
            onScrollBeginDragListener      = { emitScrollLifecycleEvent("topScrollBeginDrag") }
            onScrollEndDragListener        = { emitScrollLifecycleEvent("topScrollEndDrag") }
            onMomentumScrollBeginListener  = { emitScrollLifecycleEvent("topMomentumScrollBegin") }
            onMomentumScrollEndListener    = { emitScrollLifecycleEvent("topMomentumScrollEnd") }
        }
        hsv.isEnabled = cachedScrollEnabled
        hsv.addView(contentView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT))
        addView(hsv)
        hScrollView = hsv
    }

    // ── Props update ─────────────────────────────────────────────────────────

    fun updateProps(
        newHorizontal: Boolean,
        scrollEnabled: Boolean,
        bounces: Boolean,
        showsVerticalScrollIndicator: Boolean,
        scrollEventThrottle: Float,
        newLayoutWritesVisualAttributes: Boolean,
        newLayoutCacheId: Int
    ) {
        if (newHorizontal != horizontal) {
            horizontal = newHorizontal
            if (horizontal) setupHorizontalScroll() else setupVerticalScroll()
        }

        cachedScrollEnabled = scrollEnabled
        cachedShowsVerticalScrollIndicator = showsVerticalScrollIndicator

        scrollView?.let { sv ->
            sv.isEnabled = scrollEnabled
            sv.isVerticalScrollBarEnabled = showsVerticalScrollIndicator && !horizontal
            sv.isHorizontalScrollBarEnabled = false
            // bounces → Android overScrollMode
            sv.overScrollMode = if (bounces) OVER_SCROLL_IF_CONTENT_SCROLLS else OVER_SCROLL_NEVER
        }
        hScrollView?.let { hsv ->
            hsv.isEnabled = scrollEnabled
            hsv.isHorizontalScrollBarEnabled = false  // never show scrollbar for collection
            hsv.isVerticalScrollBarEnabled = false
            hsv.overScrollMode = if (bounces) OVER_SCROLL_IF_CONTENT_SCROLLS else OVER_SCROLL_NEVER
        }

        if (scrollEventThrottle > 0) {
            scrollEventMinIntervalNs = (scrollEventThrottle * 1_000_000L).toLong()
        }

        layoutWritesVisualAttributes = newLayoutWritesVisualAttributes
        layoutCacheId = newLayoutCacheId
        if (newLayoutCacheId != 0) {
            nativeRegisterScrollHandler(newLayoutCacheId)
        }
    }

    // ── State update from ShadowNode ─────────────────────────────────────────

    fun updateState(
        newPositions: FloatArray,
        newChildTags: IntArray,
        contentWidth: Float,
        contentHeight: Float,
        newLayoutRevision: Int
    ) {
        positions = newPositions
        childTags = newChildTags

        if (!hasReceivedFirstState) {
            hasReceivedFirstState = true
            scrollTo(0, 0)
        }

        val density = resources.displayMetrics.density
        val contentWidthPx = (contentWidth * density).toInt()
        val contentHeightPx = (contentHeight * density).toInt()
        contentView.layoutParams = contentView.layoutParams?.apply {
            width = contentWidthPx
            height = contentHeightPx
        } ?: LayoutParams(contentWidthPx, contentHeightPx)

        val revisionChanged = newLayoutRevision != layoutRevision
        layoutRevision = newLayoutRevision

        if (revisionChanged) {
            // Compute MVC scroll correction before re-laying out.
            // iOS does this in updateState: right after layout revision changes,
            // so inserted/deleted rows above the viewport preserve visible position.
            if (layoutCacheId != 0) {
                val correction = nativeComputeCorrection(layoutCacheId)
                if (Math.abs(correction) > 0.5) {
                    pendingMVCCorrection   = correction
                    pendingMVCScrollTarget = nativeConsumePendingScrollTarget(layoutCacheId)
                }
            }
            emitOnScroll()
        }

        applyPositionsFromState()
        requestLayout()
    }

    // ── Position application ─────────────────────────────────────────────────

    fun applyPositionsFromState() {
        val childCount = positions.size / 4
        if (childCount == 0 || contentView.childCount == 0) return

        val density = resources.displayMetrics.density

        val tagToView = HashMap<Int, View>(contentView.childCount)
        for (i in 0 until contentView.childCount) {
            val child = contentView.getChildAt(i)
            tagToView[child.id] = child
        }

        // Bulk-read zIndex AND alpha from LayoutCache when layoutWritesVisualAttributes is set.
        // One JNI call for all children — matches iOS's single-mutex bulk read.
        // Returns flat [zIndex0, alpha0, zIndex1, alpha1, ...]; default zIndex=0, alpha=1.
        val visualAttrs: FloatArray? = if (layoutWritesVisualAttributes && layoutCacheId != 0 &&
                                           childTags.isNotEmpty()) {
            val keys = Array(childCount) { i ->
                if (i < childTags.size) {
                    (tagToView[childTags[i]] as? RNMeasuredCellView)?.cacheKey ?: ""
                } else ""
            }
            nativeGetVisualAttrs(layoutCacheId, keys)
        } else null

        // Build drawing order: decorations (negative zIndex) first, then normal children.
        if (visualAttrs != null && (0 until childCount).any { i -> i * 2 < visualAttrs.size && visualAttrs[i * 2] < 0f }) {
            val order = (0 until childCount).sortedBy { i ->
                if (i * 2 < visualAttrs.size) visualAttrs[i * 2] else 0f
            }.toIntArray()
            contentView.drawingOrder = order
        } else {
            contentView.drawingOrder = IntArray(0)
        }

        for (i in 0 until childCount) {
            if (i >= childTags.size) break
            val child = tagToView[childTags[i]] ?: continue

            val targetX = (positions[i * 4] * density).toInt()
            val targetY = (positions[i * 4 + 1] * density).toInt()
            val targetW = (positions[i * 4 + 2] * density).toInt()
            val targetH = (positions[i * 4 + 3] * density).toInt()

            if (targetW <= 0 || targetH <= 0) continue

            val currentL = child.left
            val currentT = child.top
            val currentW = child.width
            val currentH = child.height

            val diffX = abs(currentL - targetX) > 1
            val diffY = abs(currentT - targetY) > 1
            val diffW = abs(currentW - targetW) > 1
            val diffH = abs(currentH - targetH) > 1

            if (diffX || diffY || diffW || diffH) {
                when (child) {
                    is RNMeasuredCellView -> child.shadowNodePositioned = true
                    is RNCollectionSubContainerView -> child.shadowNodePositioned = true
                }
                child.measure(
                    View.MeasureSpec.makeMeasureSpec(targetW, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(targetH, View.MeasureSpec.EXACTLY)
                )
                child.layout(targetX, targetY, targetX + targetW, targetY + targetH)
            }

            // Apply zIndex + alpha from LayoutCache (mirrors iOS layer.zPosition / alpha).
            if (visualAttrs != null && i * 2 + 1 < visualAttrs.size) {
                val z = visualAttrs[i * 2]
                val a = visualAttrs[i * 2 + 1]
                if (abs(child.translationZ - z) > 0.01f) child.translationZ = z
                if (abs(child.alpha - a) > 0.001f) child.alpha = a
            }
        }
    }

    // ── MVC correction (Choreographer-aligned) ────────────────────────────────

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)

        // Pre-warm: emit an initial scroll event so JS gets real viewport dimensions
        // and can compute the first render range before the user gestures.
        if (changed && height > 0) {
            emitOnScroll()
        }

        applyPositionsFromState()

        // Defer scroll correction to the next vsync via Choreographer.
        // Applying scrollTo() synchronously inside onLayout can trigger a second layout
        // pass within the same frame; scheduling on the next frame avoids that.
        if (abs(pendingMVCCorrection) > 0.5) {
            val density     = resources.displayMetrics.density
            val targetPx    = max(0, (pendingMVCScrollTarget * density).toInt())
            val isHoriz     = horizontal
            pendingMVCCorrection   = 0.0
            pendingMVCScrollTarget = 0.0

            Choreographer.getInstance().postFrameCallback {
                applyingCorrection = true
                if (isHoriz) hScrollView?.scrollTo(targetPx, 0)
                else         scrollView?.scrollTo(0, targetPx)
                applyingCorrection = false
                emitOnScroll()
            }
        }
    }

    // ── Child management ─────────────────────────────────────────────────────

    fun mountChildComponentView(childView: View, index: Int) {
        contentView.addView(childView, index)
        if (childView is RNScrollCoordinatedViewView) {
            childView.layoutCacheId = layoutCacheId
        }
    }

    fun unmountChildComponentView(childView: View) {
        contentView.removeView(childView)
    }

    fun getContentChildAt(index: Int): View? = contentView.getChildAt(index)
    fun getContentChildCount(): Int = contentView.childCount
    fun removeAllContentChildren() { contentView.removeAllViews() }

    // ── Scroll handling ──────────────────────────────────────────────────────

    private fun onScrollChanged(primaryOffset: Int) {
        if (applyingCorrection) return

        // Write scroll position to LayoutCache unthrottled — @CriticalNative (static)
        // means ART calls this without a JNI frame (~10× cheaper than normal JNI).
        // Pass elapsedRealtimeNanos so C++ can derive velocity for the adaptive
        // render-window (matches iOS which passes CACurrentMediaTime * 1000).
        if (layoutCacheId != 0) {
            val density = resources.displayMetrics.density
            val dp = primaryOffset / density
            val nowNs = SystemClock.elapsedRealtimeNanos()
            if (horizontal) Companion.nativeSetScrollOffset(layoutCacheId, dp, 0f, nowNs)
            else            Companion.nativeSetScrollOffset(layoutCacheId, 0f, dp, nowNs)
        }

        // Nanosecond throttle: exact 16 ms window, no millisecond rounding error.
        val nowNs = SystemClock.elapsedRealtimeNanos()
        if (nowNs - lastScrollEventNs < scrollEventMinIntervalNs) return
        lastScrollEventNs = nowNs

        emitOnScroll()
    }

    private external fun nativeRegisterScrollHandler(cacheId: Int)
    private external fun nativeUnregisterScrollHandler(cacheId: Int)
    // Bulk-read zIndex for a set of cache keys in a single C++ mutex acquisition.
    // Returns FloatArray of length keys.size, 0.0f for cache misses.
    private external fun nativeGetZIndexes(cacheId: Int, keys: Array<String>): FloatArray
    // Bulk-read [zIndex, alpha, zIndex, alpha, ...] — 2 floats per key; alpha=1.0f for misses.
    private external fun nativeGetVisualAttrs(cacheId: Int, keys: Array<String>): FloatArray
    // MVC scroll correction — call after updateState signals a layout revision change.
    private external fun nativeComputeCorrection(cacheId: Int): Double
    private external fun nativeConsumePendingScrollTarget(cacheId: Int): Double

    companion object {
        // @CriticalNative requires a static method — ART skips the JNI frame entirely,
        // ~10× cheaper than a normal JNI call. The C++ impl must not call back into JNI.
        // timestampNs → ms in C++ for velocity derivation (matches iOS CACurrentMediaTime*1000).
        @dalvik.annotation.optimization.CriticalNative
        @JvmStatic
        external fun nativeSetScrollOffset(cacheId: Int, scrollX: Float, scrollY: Float, timestampNs: Long)
    }

    // Called from C++ (JS thread) via JNI — must post to main thread.
    @androidx.annotation.Keep
    fun scrollToFromNative(x: Float, y: Float, animated: Boolean) {
        val density = resources.displayMetrics.density
        val xPx = (x * density).toInt()
        val yPx = (y * density).toInt()
        mainHandler.post {
            if (animated) {
                if (horizontal) hScrollView?.smoothScrollTo(xPx, 0)
                else            scrollView?.smoothScrollTo(0, yPx)
            } else {
                if (horizontal) hScrollView?.scrollTo(xPx, 0)
                else            scrollView?.scrollTo(0, yPx)
            }
        }
    }

    private fun emitOnScroll() {
        // Use cached handles — avoids UIManagerHelper lookups on every scroll event.
        val dispatcher = cachedDispatcher ?: run {
            // Fallback: rebuild cache if not yet set (e.g. emitOnScroll called before attach).
            rebuildDispatcherCache()
            cachedDispatcher
        } ?: return

        val density = resources.displayMetrics.density
        val offsetX: Float
        val offsetY: Float
        if (horizontal) {
            offsetX = (hScrollView?.scrollX ?: 0) / density
            offsetY = 0f
        } else {
            offsetX = 0f
            offsetY = (scrollView?.scrollY ?: 0) / density
        }

        val contentLp = contentView.layoutParams
        val cw = (if (contentLp != null && contentLp.width > 0) contentLp.width
                  else contentView.width) / density
        val ch = (if (contentLp != null && contentLp.height > 0) contentLp.height
                  else contentView.height) / density
        val lw = width / density
        val lh = height / density

        dispatcher.dispatchEvent(
            RiffScrollEvent(cachedSurfaceId, id, offsetX, offsetY, cw, ch, lw, lh)
        )
    }

    // Fires begin-drag, end-drag, momentum-begin, momentum-end events
    // matching iOS UIScrollViewDelegate (topScrollBeginDrag, etc.).
    private fun emitScrollLifecycleEvent(eventName: String) {
        val dispatcher = cachedDispatcher ?: run {
            rebuildDispatcherCache(); cachedDispatcher
        } ?: return

        val density = resources.displayMetrics.density
        val offsetX = if (horizontal) (hScrollView?.scrollX ?: 0) / density else 0f
        val offsetY = if (!horizontal) (scrollView?.scrollY ?: 0) / density else 0f
        val contentLp = contentView.layoutParams
        val cw = (if (contentLp != null && contentLp.width > 0) contentLp.width else contentView.width) / density
        val ch = (if (contentLp != null && contentLp.height > 0) contentLp.height else contentView.height) / density
        val lw = width / density
        val lh = height / density

        dispatcher.dispatchEvent(
            RiffScrollLifecycleEvent(cachedSurfaceId, id, eventName, offsetX, offsetY, cw, ch, lw, lh)
        )
    }

    // ── Recycling ────────────────────────────────────────────────────────────

    fun prepareForRecycle() {
        if (layoutCacheId != 0) nativeUnregisterScrollHandler(layoutCacheId)
        positions = FloatArray(0)
        childTags = IntArray(0)
        hasReceivedFirstState = false
        lastScrollEventNs = 0
        pendingMVCCorrection = 0.0
        pendingMVCScrollTarget = 0.0
        layoutRevision = -1
        cachedDispatcher = null
        cachedSurfaceId  = -1
        scrollView?.scrollTo(0, 0)
        hScrollView?.scrollTo(0, 0)
    }
}
