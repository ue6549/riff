/**
 * CollectionViewContainerState — serialization for Android Fabric state bridge.
 *
 * Implements getDynamic() to serialize positions, childTags, contentSize, and
 * layoutRevision into a folly::dynamic object that Android's StateWrapper can
 * deliver to the Kotlin ViewManager via ReadableNativeMap.
 *
 * On iOS, state is accessed directly as C++ objects (ObjC++ bridge).
 * On Android, Fabric calls getDynamic() → JNI → ReadableNativeMap → Kotlin.
 */

#include "CollectionViewContainerState.h"

#ifdef ANDROID
#include <folly/dynamic.h>

namespace facebook::react {

CollectionViewContainerState::CollectionViewContainerState(
    const CollectionViewContainerState &previousState,
    folly::dynamic data)
    : contentSize(previousState.contentSize),
      contentOffset(previousState.contentOffset),
      contentBoundingRect(previousState.contentBoundingRect),
      positions(previousState.positions),
      childTags(previousState.childTags),
      layoutRevision(previousState.layoutRevision) {
  // Android → C++ state updates (e.g. scroll offset from native scroll view)
  if (data.count("contentOffsetX")) {
    contentOffset.x = (Float)data["contentOffsetX"].getDouble();
  }
  if (data.count("contentOffsetY")) {
    contentOffset.y = (Float)data["contentOffsetY"].getDouble();
  }
}

folly::dynamic CollectionViewContainerState::getDynamic() const {
  // Serialize positions as a flat folly::dynamic array [x0,y0,w0,h0, x1,y1,w1,h1, ...]
  folly::dynamic posArray = folly::dynamic::array;
  for (auto v : positions) {
    posArray.push_back((double)v);
  }

  // Serialize childTags as a flat array [tag0, tag1, ...]
  folly::dynamic tagsArray = folly::dynamic::array;
  for (auto t : childTags) {
    tagsArray.push_back(t);
  }

  return folly::dynamic::object
      ("contentWidth", (double)contentSize.width)
      ("contentHeight", (double)contentSize.height)
      ("positions", std::move(posArray))
      ("childTags", std::move(tagsArray))
      ("layoutRevision", layoutRevision);
}

} // namespace facebook::react

#endif // ANDROID
