package com.riff

import android.content.Context
import android.widget.FrameLayout

/**
 * Android equivalent of RNOrthogonalSectionView.
 * Simple wrapper for H-scrolling sections — the actual scroll behavior
 * is handled by RNCollectionSubContainerView. This view exists for
 * backwards compatibility with the legacy orthogonal section spec.
 */
class RNOrthogonalSectionView(context: Context) : FrameLayout(context) {
    var shadowNodePositioned: Boolean = false
}
