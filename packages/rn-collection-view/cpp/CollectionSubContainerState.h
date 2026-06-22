#pragma once

/**
 * CollectionSubContainerState — shared state between the
 * CollectionSubContainerShadowNode and the native iOS view.
 *
 * Mirrors CollectionViewContainerState in spirit, but is scoped to a single
 * section of the parent CollectionView. The ShadowNode iterates only its
 * direct children (the cells of one section) and writes their final visual
 * properties here; the iOS view applies them via a tag→view map.
 *
 * Unlike the main container (which only carries flat [x,y,w,h] frames),
 * the sub-container carries the full ChildVisualState — frame + transform
 * + opacity + zIndex — so that scroll-driven layouts (radial, spiral,
 * carousel3D) can natively apply rich per-frame visual updates without any
 * JS round-trip.
 *
 * State is immutable per revision — updates create new instances.
 */

#include <react/renderer/graphics/Float.h>
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-W#warnings"
#include <react/renderer/graphics/Geometry.h>
#pragma GCC diagnostic pop
#include <array>
#include <vector>

#ifdef ANDROID
#include <folly/dynamic.h>
#endif

namespace facebook::react {

/**
 * Per-child visual state. One per cell in the sub-container.
 *
 * Flat fields chosen for cache-friendly iteration in the iOS apply loop;
 * std::array<Float,16> for the transform matches CATransform3D's column-major
 * layout (direct memcpy or component-wise assignment is safe).
 *
 * `hasTransform` lets the iOS view skip CALayer.transform assignment when the
 * matrix is identity (default for layouts that only position items).
 */
struct ChildVisualState {
  Float x = 0;
  Float y = 0;
  Float w = 0;
  Float h = 0;

  Float opacity = 1.0f;
  Float zIndex  = 0;

  // 4x4 column-major transform matrix (default = identity).
  // Layouts like radial/spiral/carousel3D write rotation/scale/perspective here.
  std::array<Float, 16> transform = {
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    0,0,0,1,
  };
  bool hasTransform = false;  // true → apply layer.transform; false → skip

  bool operator==(const ChildVisualState& other) const noexcept {
    return x == other.x && y == other.y && w == other.w && h == other.h
        && opacity == other.opacity && zIndex == other.zIndex
        && hasTransform == other.hasTransform
        && (!hasTransform || transform == other.transform);
  }
  bool operator!=(const ChildVisualState& other) const noexcept {
    return !(*this == other);
  }
};

class CollectionSubContainerState final {
public:
  CollectionSubContainerState() = default;

  /// Total content size of this sub-container's owned region.
  /// Sets the embedded UIScrollView's contentSize (when scrollable).
  Size contentSize{};

  /// Bounding rect of all positioned children (in sub-container coordinates).
  Rect contentBoundingRect{};

  /// Per-child visual state, one per direct child (cell) of this sub-container.
  /// Order matches childTags below; iOS view uses tag→view map for application.
  std::vector<ChildVisualState> children;

  /// Fabric tags for each child in ShadowNode order, parallel to children.
  /// Tag-based lookup avoids breakage from Fabric's "last index" reconciler
  /// optimization (which can leave native subview order out of sync with
  /// ShadowNode child order across mutations).
  std::vector<int32_t> childTags;

  /// Bumped on every layout revision. Native view uses to detect changes.
  int32_t layoutRevision = 0;

  Size getContentSize() const { return contentSize; }

#ifdef ANDROID
  CollectionSubContainerState(
      const CollectionSubContainerState &previousState,
      folly::dynamic data);
  folly::dynamic getDynamic() const;
#endif
};

} // namespace facebook::react
