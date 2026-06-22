/**
 * CollectionSubContainerState — serialization for Android Fabric state bridge.
 *
 * Serializes per-child visual states (frame, opacity, zIndex, transform) into
 * a folly::dynamic object that Android's StateWrapper delivers to Kotlin.
 */

#include "CollectionSubContainerState.h"

#ifdef ANDROID
#include <folly/dynamic.h>

namespace facebook::react {

CollectionSubContainerState::CollectionSubContainerState(
    const CollectionSubContainerState &previousState,
    folly::dynamic data)
    : contentSize(previousState.contentSize),
      contentBoundingRect(previousState.contentBoundingRect),
      children(previousState.children),
      childTags(previousState.childTags),
      layoutRevision(previousState.layoutRevision) {
  // No Java → C++ state updates expected for sub-containers.
}

folly::dynamic CollectionSubContainerState::getDynamic() const {
  // Per-child visual state — flat arrays for efficient JNI transfer.
  folly::dynamic xs = folly::dynamic::array;
  folly::dynamic ys = folly::dynamic::array;
  folly::dynamic ws = folly::dynamic::array;
  folly::dynamic hs = folly::dynamic::array;
  folly::dynamic opacities = folly::dynamic::array;
  folly::dynamic zIndexes = folly::dynamic::array;
  // hasTransform: one bool per child. childTransform: 16 floats per child,
  // column-major (same layout as CATransform3D). Only populated when
  // hasTransform is true; Android skips the block otherwise.
  folly::dynamic hasTransformArr = folly::dynamic::array;
  folly::dynamic transformArr = folly::dynamic::array;  // flat: N * 16

  for (const auto &child : children) {
    xs.push_back((double)child.x);
    ys.push_back((double)child.y);
    ws.push_back((double)child.w);
    hs.push_back((double)child.h);
    opacities.push_back((double)child.opacity);
    zIndexes.push_back((double)child.zIndex);
    hasTransformArr.push_back(child.hasTransform);
    if (child.hasTransform) {
      for (int k = 0; k < 16; ++k) {
        transformArr.push_back((double)child.transform[k]);
      }
    } else {
      // Push identity so the flat index stays aligned (16 values per child).
      const double id[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
      for (int k = 0; k < 16; ++k) transformArr.push_back(id[k]);
    }
  }

  folly::dynamic tagsArray = folly::dynamic::array;
  for (auto t : childTags) {
    tagsArray.push_back(t);
  }

  return folly::dynamic::object
      ("contentWidth", (double)contentSize.width)
      ("contentHeight", (double)contentSize.height)
      ("childX", std::move(xs))
      ("childY", std::move(ys))
      ("childW", std::move(ws))
      ("childH", std::move(hs))
      ("childOpacity", std::move(opacities))
      ("childZIndex", std::move(zIndexes))
      ("childHasTransform", std::move(hasTransformArr))
      ("childTransform", std::move(transformArr))
      ("childTags", std::move(tagsArray))
      ("layoutRevision", layoutRevision);
}

} // namespace facebook::react

#endif // ANDROID
