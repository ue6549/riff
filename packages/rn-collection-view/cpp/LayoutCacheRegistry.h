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

// ── Scroll handler registry ───────────────────────────────────────────────────
// Allows JS (via nativeMod.scrollTo) to trigger programmatic scrolling on the
// native container view without direct coupling between the module and the view.
//
// Usage:
//   Container view registers on mount:
//     registerScrollHandler(cacheId, [weakSelf](x, y, animated) { ... });
//   Container view unregisters on unmount:
//     unregisterScrollHandler(cacheId);
//   C++ JSI binding calls:
//     invokeScrollHandler(cacheId, x, y, animated);

#include <functional>

void registerScrollHandler(int32_t cacheId, std::function<void(double, double, bool)> handler);
void unregisterScrollHandler(int32_t cacheId);
/// Invokes the registered handler for cacheId. No-op if none registered.
void invokeScrollHandler(int32_t cacheId, double x, double y, bool animated);

} // namespace facebook::react
