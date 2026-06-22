package com.riff

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Android equivalent of RNCollectionSubContainerView.mm.
 *
 * Generic host for a single section of the parent CollectionView. Owns a
 * contentView that holds cells as subviews, optionally embedded in a
 * HorizontalScrollView or ScrollView when scrollDirection != "none".
 *
 * Frames, transforms, opacity, and zIndex are applied natively from
 * CollectionSubContainerState driven by the C++ ShadowNode.
 */
class RNCollectionSubContainerView(context: Context) : FrameLayout(context) {

    // ── Public properties ────────────────────────────────────────────────────
    var shadowNodePositioned: Boolean = false
    val contentViewChild: RiffContentView = RiffContentView(context)

    // ── Cached props ─────────────────────────────────────────────────────────
    var sectionIndex: Int = 0
        private set
    var layoutCacheId: Int = 0
        private set

    private var scrollDirection: String = "none" // "none" | "horizontal" | "vertical"

    // ── Pending props — stored by each setter; flushed atomically ────────────
    // Fixes prop-ordering bug: previously each setter called updateProps with
    // hardcoded "none"/0 for other values, so a later setLayoutCacheId would
    // silently reset scrollDirection back to "none".
    var pendingLayoutCacheId: Int = 0
    var pendingSectionIndex: Int = 0
    var pendingScrollDirection: String = "none"
    var pendingContentWidth: Float = 0f
    var pendingContentHeight: Float = 0f

    fun flushPendingSubContainerProps() {
        updateProps(
            newSectionIndex    = pendingSectionIndex,
            newLayoutCacheId   = pendingLayoutCacheId,
            newScrollDirection = pendingScrollDirection,
            contentWidth       = pendingContentWidth,
            contentHeight      = pendingContentHeight,
        )
    }

    // ── Internal scroll view (created lazily) ────────────────────────────────
    private var hScrollView: HorizontalScrollView? = null
    private var vScrollView: ScrollView? = null

    // ── State from ShadowNode ────────────────────────────────────────────────
    // ChildVisualState data (flat arrays for cache-friendly iteration).
    private var childX: FloatArray = FloatArray(0)
    private var childY: FloatArray = FloatArray(0)
    private var childW: FloatArray = FloatArray(0)
    private var childH: FloatArray = FloatArray(0)
    private var childOpacity: FloatArray = FloatArray(0)
    private var childZIndex: FloatArray = FloatArray(0)
    private var childHasTransform: BooleanArray = BooleanArray(0)
    // Flat column-major 4×4 matrices, 16 floats per child (same layout as CATransform3D).
    private var childTransforms: FloatArray = FloatArray(0)
    private var stateChildTags: IntArray = IntArray(0)

    // ── Scroll position save/restore across Fabric recycles ──────────────────
    private var pendingRestoreScrollX: Float = 0f
    private var needsScrollRestore: Boolean = false

    // ── Scroll event throttle ────────────────────────────────────────────────
    private var lastScrollEventTime: Long = 0
    private val scrollEventMinIntervalMs: Long = 16

    // ── Bounds gate for layoutSubviews ───────────────────────────────────────
    private var lastAppliedWidth: Int = 0
    private var lastAppliedHeight: Int = 0

    // ── Scroll event dispatch ─────────────────────────────────────────────────

    private fun dispatchOnSubScroll(scrollXPx: Int, scrollYPx: Int) {
        val now = System.currentTimeMillis()
        if (now - lastScrollEventTime < scrollEventMinIntervalMs) return
        lastScrollEventTime = now

        val density = resources.displayMetrics.density
        val ctx = context as? ReactContext ?: return
        val surfaceId = UIManagerHelper.getSurfaceId(this)
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(ctx, id)
            ?: UIManagerHelper.getUIManager(ctx, com.facebook.react.uimanager.common.UIManagerType.FABRIC)
                ?.eventDispatcher
            ?: return
        dispatcher.dispatchEvent(
            RiffSubScrollEvent(surfaceId, id, sectionIndex, scrollXPx / density, scrollYPx / density)
        )
    }

    init {
        // Default: non-scrollable. contentView is a direct child of self.
        contentViewChild.clipChildren = false
        addView(contentViewChild, LayoutParams(
            LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
        ))
        clipChildren = true
    }

    // ── Props update ─────────────────────────────────────────────────────────

    fun updateProps(
        newSectionIndex: Int,
        newLayoutCacheId: Int,
        newScrollDirection: String,
        contentWidth: Float,
        contentHeight: Float
    ) {
        sectionIndex = newSectionIndex
        layoutCacheId = newLayoutCacheId

        if (newScrollDirection != scrollDirection) {
            scrollDirection = newScrollDirection
            reconfigureScrollView()
        }

        // Apply content size from props (prop-based fallback, same scroll-axis filtering as updateState).
        val density = resources.displayMetrics.density
        val cwPx = (contentWidth * density).toInt()
        val chPx = (contentHeight * density).toInt()
        when (scrollDirection) {
            "horizontal" -> {
                if (cwPx > 0) {
                    contentViewChild.layoutParams = contentViewChild.layoutParams?.apply {
                        width = cwPx
                    } ?: LayoutParams(cwPx, LayoutParams.MATCH_PARENT)
                }
            }
            "vertical" -> {
                if (chPx > 0) {
                    contentViewChild.layoutParams = contentViewChild.layoutParams?.apply {
                        height = chPx
                    } ?: LayoutParams(LayoutParams.MATCH_PARENT, chPx)
                }
            }
            else -> {
                if (cwPx > 0 && chPx > 0) {
                    contentViewChild.layoutParams = contentViewChild.layoutParams?.apply {
                        width = cwPx
                        height = chPx
                    } ?: LayoutParams(cwPx, chPx)
                }
            }
        }
    }

    private fun reconfigureScrollView() {
        // Remove contentView from current parent and tear down old scroll view.
        (contentViewChild.parent as? ViewGroup)?.removeView(contentViewChild)
        hScrollView?.let { removeView(it) }
        vScrollView?.let { removeView(it) }
        hScrollView = null
        vScrollView = null

        when (scrollDirection) {
            "horizontal" -> {
                val hsv = object : HorizontalScrollView(context) {
                    private var downX = 0f
                    private var downY = 0f
                    private val touchSlop =
                        android.view.ViewConfiguration.get(context).scaledTouchSlop.toFloat()

                    override fun onTouchEvent(ev: MotionEvent): Boolean {
                        when (ev.actionMasked) {
                            MotionEvent.ACTION_DOWN -> {
                                downX = ev.x
                                downY = ev.y
                                // Preemptively disallow — the parent decides on first MOVE
                                // whether to take the gesture back (vertical) or leave it.
                                parent?.requestDisallowInterceptTouchEvent(true)
                            }
                            MotionEvent.ACTION_MOVE -> {
                                val dx = abs(ev.x - downX)
                                val dy = abs(ev.y - downY)
                                if (dy > touchSlop && dy > dx) {
                                    // Gesture turned out vertical — release the parent.
                                    parent?.requestDisallowInterceptTouchEvent(false)
                                }
                            }
                        }
                        return super.onTouchEvent(ev)
                    }

                    override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
                        super.onScrollChanged(l, t, oldl, oldt)
                        dispatchOnSubScroll(l, 0)
                    }
                }.apply {
                    layoutParams = LayoutParams(
                        LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
                    )
                    isHorizontalScrollBarEnabled = false
                    isHorizontalFadingEdgeEnabled = false
                    isNestedScrollingEnabled = true
                }
                hsv.addView(contentViewChild, LayoutParams(
                    LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT
                ))
                // Remove any existing children (the non-scrollable contentView was added in init).
                removeAllViews()
                addView(hsv)
                hScrollView = hsv
            }
            "vertical" -> {
                val sv = ScrollView(context).apply {
                    layoutParams = LayoutParams(
                        LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
                    )
                    isVerticalScrollBarEnabled = false
                    isVerticalFadingEdgeEnabled = false
                    setOnScrollChangeListener { _, _, scrollY, _, _ ->
                        dispatchOnSubScroll(0, scrollY)
                    }
                }
                sv.addView(contentViewChild, LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT
                ))
                removeAllViews()
                addView(sv)
                vScrollView = sv
            }
            else -> {
                // Non-scrollable: contentView is a direct child.
                removeAllViews()
                addView(contentViewChild, LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
                ))
            }
        }
    }

    // ── State update from ShadowNode ─────────────────────────────────────────

    fun updateState(
        xs: FloatArray, ys: FloatArray, ws: FloatArray, hs: FloatArray,
        opacities: FloatArray, zIndexes: FloatArray,
        hasTransforms: BooleanArray, transforms: FloatArray,
        tags: IntArray,
        contentWidth: Float, contentHeight: Float
    ) {
        childX = xs
        childY = ys
        childW = ws
        childH = hs
        childOpacity = opacities
        childZIndex = zIndexes
        childHasTransform = hasTransforms
        childTransforms = transforms
        stateChildTags = tags

        // Apply content size — only update the scroll axis to avoid disrupting
        // rubber-band or deceleration on the cross-axis (matches iOS scroll-axis filtering).
        val density = resources.displayMetrics.density
        val cwPx = (contentWidth * density).toInt()
        val chPx = (contentHeight * density).toInt()

        when (scrollDirection) {
            "horizontal" -> {
                // H-scroll: width is the scroll axis; clamp height to max(bounds, contentHeight)
                // so the H-scroll view always fills the wrapper height.
                val boundsH = max(height, if (chPx > 0) chPx else height)
                val newW = if (cwPx > 0) cwPx else contentViewChild.layoutParams?.width ?: 0
                if (newW > 0 || boundsH > 0) {
                    contentViewChild.layoutParams = contentViewChild.layoutParams?.apply {
                        if (newW > 0) width = newW
                        height = boundsH
                    } ?: LayoutParams(newW, boundsH)
                }
            }
            "vertical" -> {
                // V-scroll: height is the scroll axis; keep width as-is.
                val newH = if (chPx > 0) chPx else contentViewChild.layoutParams?.height ?: 0
                if (newH > 0) {
                    contentViewChild.layoutParams = contentViewChild.layoutParams?.apply {
                        height = newH
                    } ?: LayoutParams(LayoutParams.MATCH_PARENT, newH)
                }
            }
            else -> {
                // Non-scrollable: apply both when valid.
                if (cwPx > 0 && chPx > 0) {
                    contentViewChild.layoutParams = contentViewChild.layoutParams?.apply {
                        width = cwPx
                        height = chPx
                    } ?: LayoutParams(cwPx, chPx)
                }
            }
        }

        applyChildVisualStates()
    }

    // ── Child management ─────────────────────────────────────────────────────

    fun mountChildComponentView(childView: View, index: Int) {
        contentViewChild.addView(childView, index)
        applyChildVisualStates()
    }

    fun unmountChildComponentView(childView: View) {
        contentViewChild.removeView(childView)
    }

    fun getContentChildAt(index: Int): View? = contentViewChild.getChildAt(index)
    fun getContentChildCount(): Int = contentViewChild.childCount
    fun removeAllContentChildren() { contentViewChild.removeAllViews() }

    // ── Apply ChildVisualState array to subviews via tag map ─────────────────

    private fun applyChildVisualStates() {
        val childCount = stateChildTags.size
        if (childCount == 0 || contentViewChild.childCount == 0) return

        val density = resources.displayMetrics.density

        // Build tag → View map.
        val tagToView = HashMap<Int, View>(contentViewChild.childCount)
        for (i in 0 until contentViewChild.childCount) {
            val child = contentViewChild.getChildAt(i)
            tagToView[child.id] = child
        }

        for (i in 0 until childCount) {
            if (i >= childX.size) break
            val child = tagToView[stateChildTags[i]] ?: continue

            val targetX = (childX[i] * density).toInt()
            val targetY = (childY[i] * density).toInt()
            val targetW = (childW[i] * density).toInt()
            val targetH = (childH[i] * density).toInt()

            if (targetW <= 0 || targetH <= 0) continue

            // Claim authority.
            if (child is RNMeasuredCellView && !child.shadowNodePositioned) {
                child.shadowNodePositioned = true
            }

            val diffX = abs(child.left - targetX) > 1
            val diffY = abs(child.top - targetY) > 1
            val diffW = abs(child.width - targetW) > 1
            val diffH = abs(child.height - targetH) > 1

            if (diffX || diffY || diffW || diffH) {
                child.measure(
                    View.MeasureSpec.makeMeasureSpec(targetW, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(targetH, View.MeasureSpec.EXACTLY)
                )
                child.layout(targetX, targetY, targetX + targetW, targetY + targetH)
            }

            // Opacity.
            if (i < childOpacity.size && abs(child.alpha - childOpacity[i]) > 1e-3f) {
                child.alpha = childOpacity[i]
            }

            // Z-ordering via translationZ (elevation for shadows, translationZ for layering).
            if (i < childZIndex.size && abs(child.translationZ - childZIndex[i]) > 1e-3f) {
                child.translationZ = childZIndex[i]
            }

            // 3D transform matrix — decompose column-major 4×4 into Android view properties.
            // Handles the H-2 framework layouts: radial (scale), spiral (scale),
            // carousel3D (rotateY + perspective), hex (identity).
            if (i < childHasTransform.size) {
                if (childHasTransform[i] && childTransforms.size >= (i + 1) * 16) {
                    child.setLayerType(View.LAYER_TYPE_HARDWARE, null)
                    applyTransform3D(child, childTransforms, i * 16, density)
                } else if (!childHasTransform[i]) {
                    // Reset to identity if a previously-transformed cell no longer has one.
                    child.scaleX = 1f
                    child.scaleY = 1f
                    child.rotationY = 0f
                    child.rotationX = 0f
                    child.rotation = 0f
                }
            }
        }
    }

    /**
     * Decompose a column-major 4×4 CATransform3D matrix into Android View properties.
     *
     * Layout: t[col*4 + row], so:
     *   m11=t[0]  m21=t[1]  m31=t[2]  m41=t[3]
     *   m12=t[4]  m22=t[5]  m32=t[6]  m42=t[7]
     *   m13=t[8]  m23=t[9]  m33=t[10] m43=t[11]
     *   m14=t[12] m24=t[13] m34=t[14] m44=t[15]
     *
     * Handles the transforms produced by the H-2 layouts:
     *   radial/spiral  → pure XY scale  (m11=m22=s, others identity)
     *   carousel3D     → rotateY + perspective (m34 = -1/d in pt)
     */
    private fun applyTransform3D(view: View, t: FloatArray, offset: Int, density: Float) {
        val m11 = t[offset + 0];  val m31 = t[offset + 2]
        val m22 = t[offset + 5]
        val m13 = t[offset + 8];  val m33 = t[offset + 10]
        val m34 = t[offset + 14]

        // Scale: column-0 magnitude for X, column-1 magnitude for Y.
        // For pure rotateY, this correctly returns 1.0.
        val scaleX = Math.sqrt((m11 * m11 + m31 * m31).toDouble()).toFloat()
        val scaleY = m22  // column-1 magnitude for XY-uniform scale + rotateY

        // RotationY: extracted from the rotation sub-matrix.
        // For rotateY(θ): m11=cos θ, m13=-sin θ  → atan2(sin, cos) = atan2(-m13, m11)
        val rotationYDeg = Math.toDegrees(Math.atan2(-m13.toDouble(), m11.toDouble())).toFloat()

        view.scaleX = scaleX
        view.scaleY = scaleY
        view.rotationY = rotationYDeg

        // Perspective: iOS m34 = -1/d (d in dp). Android cameraDistance is in px.
        // Only set when non-zero to avoid overwriting the Android default.
        if (m34 != 0f) {
            view.cameraDistance = density / (-m34)
        }
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)

        val w = right - left
        val h = bottom - top
        val boundsChanged = w != lastAppliedWidth || h != lastAppliedHeight

        if (boundsChanged) {
            lastAppliedWidth = w
            lastAppliedHeight = h

            // Sync scroll view frame to bounds — mirrors iOS _applyOrDeferScrollViewFrame.
            // For H-scroll, also clamp the scroll view height to max(bounds, contentHeight)
            // so the scroll area always covers the full wrapper height.
            hScrollView?.let { hsv ->
                val params = hsv.layoutParams as? LayoutParams ?: LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
                )
                val contentH = contentViewChild.layoutParams?.height ?: 0
                params.width  = LayoutParams.MATCH_PARENT
                params.height = max(h, if (contentH > 0) contentH else h)
                hsv.layoutParams = params
            }
            vScrollView?.let { vsv ->
                vsv.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
            }

            applyChildVisualStates()
        }
    }

    // ── Recycling ────────────────────────────────────────────────────────────

    fun prepareForRecycle() {
        // Save scroll position for restoration.
        if (hScrollView != null && layoutCacheId > 0) {
            val ox = hScrollView?.scrollX ?: 0
            if (ox > 1) {
                savedHScrollOffsets["${layoutCacheId}:${sectionIndex}"] = ox
            }
        }

        shadowNodePositioned = false
        childX = FloatArray(0)
        childY = FloatArray(0)
        childW = FloatArray(0)
        childH = FloatArray(0)
        childOpacity = FloatArray(0)
        childZIndex = FloatArray(0)
        childHasTransform = BooleanArray(0)
        childTransforms = FloatArray(0)
        stateChildTags = IntArray(0)
        lastScrollEventTime = 0
        lastAppliedWidth = 0
        lastAppliedHeight = 0
        needsScrollRestore = false
        pendingRestoreScrollX = 0f

        hScrollView?.scrollTo(0, 0)
        vScrollView?.scrollTo(0, 0)
    }

    companion object {
        /** Static scroll-offset registry — persists H scroll position across Fabric recycles. */
        val savedHScrollOffsets = HashMap<String, Int>()
    }
}
