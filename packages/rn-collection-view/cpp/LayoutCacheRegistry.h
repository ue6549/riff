#pragma once

/**
 * LayoutCacheRegistry — thin lookup header.
 *
 * Exposes `layoutCacheForId()` without dragging in CollectionViewModule's
 * heavy dependencies (TurboModule, JSI, layout engines, etc.).
 *
 * Used by native iOS views (Objective-C++) that need to write scroll offsets
 * to the LayoutCache without including the full module header.
 */

#include <memory>
#include <cstdint>

// Forward-declare LayoutCache to keep this header dependency-free.
namespace rncv { class LayoutCache; }

namespace facebook::react {

/**
 * Returns the LayoutCache registered for the given cacheId, or nullptr.
 * Thread-safe. Implemented in CollectionViewModule.cpp.
 */
std::shared_ptr<rncv::LayoutCache> layoutCacheForId(int32_t cacheId);

} // namespace facebook::react
