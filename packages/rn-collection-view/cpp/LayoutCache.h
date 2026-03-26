#pragma once

#include "Geometry.h"
#include "SpatialIndex.h"
#include <jsi/jsi.h>
#include <string>
#include <unordered_map>
#include <vector>
#include <optional>
#include <mutex>

namespace rncv {

// ─── Enums ───────────────────────────────────────────────────────────────────

enum class SizingState  { Placeholder, Measured, Dirty };
enum class WindowTier   { Visible, Render, Layout, Data, Outside };

// ─── LayoutAttributes ────────────────────────────────────────────────────────

/**
 * C++ equivalent of LayoutAttributes TypeScript type.
 * One instance per cell / supplementary view.
 * Immutable after insertion; replaced (never mutated) on update.
 */
struct LayoutAttributes {
  std::string key;
  int         section       = 0;
  int         index         = -1;
  Rect        frame;
  int         zIndex        = 0;
  bool        isSupplementary = false;
  std::string supplementaryKind;   // empty for regular cells
  SizingState sizingState   = SizingState::Placeholder;
  bool        isDirty       = false;
  WindowTier  tier          = WindowTier::Outside;
  bool        isSticky      = false;
  double      alpha         = 1.0;
  bool        isAnimating   = false;
};

// ─── LayoutCache ─────────────────────────────────────────────────────────────

/**
 * In-memory store for layout attributes.
 * Single source of truth for all positional data in the collection view.
 *
 * Thread-safety: all public methods acquire _mutex.
 * JSI methods are called from the JS thread; layout computations may call
 * from a background thread — the lock keeps them safe.
 *
 * Version is incremented on every mutation so callers can detect staleness
 * without comparing attribute contents.
 */
class LayoutCache {
public:
  LayoutCache() = default;

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  void setAttributes(const LayoutAttributes& attrs);
  std::optional<LayoutAttributes> getAttributes(const std::string& key) const;
  void removeAttributes(const std::string& key);
  void clear();

  // ── Bulk access ───────────────────────────────────────────────────────────

  /** Returns all attributes in insertion order (matches layout order). */
  std::vector<LayoutAttributes> getAll() const;

  /** Returns attributes for all items whose frame intersects rect. */
  std::vector<LayoutAttributes> getAttributesInRect(const Rect& rect) const;

  // ── Aggregate queries ─────────────────────────────────────────────────────

  Size getTotalContentSize() const;

  /**
   * Y offset of each section's first item.
   * Index i = section i's starting Y coordinate.
   */
  std::vector<double> getSectionOffsets() const;

  // ── Versioning ────────────────────────────────────────────────────────────

  uint64_t version() const;

  // ── JSI bindings ──────────────────────────────────────────────────────────

  /**
   * Installs all LayoutCache methods onto `target` in the JSI runtime.
   * Called once during module initialisation.
   *
   * Exposed methods:
   *   layoutCache.setAttributes(attrsObject) → undefined
   *   layoutCache.getAttributes(key: string) → attrsObject | null
   *   layoutCache.removeAttributes(key: string) → undefined
   *   layoutCache.getAll() → attrsObject[]
   *   layoutCache.getAttributesInRect(rect) → attrsObject[]
   *   layoutCache.getTotalContentSize() → { width, height }
   *   layoutCache.getSectionOffsets() → number[]
   *   layoutCache.clear() → undefined
   *   layoutCache.version() → number
   */
  void installJSIBindings(
      facebook::jsi::Runtime& rt,
      facebook::jsi::Object& target);

private:
  // Insertion-ordered key list (used by getAll and getSectionOffsets)
  std::vector<std::string>                          _insertionOrder;
  std::unordered_map<std::string, LayoutAttributes> _map;
  uint64_t                                          _version = 0;
  mutable std::mutex                                _mutex;
  SpatialIndex                                      _index;   // M1.4

  // Internal helpers (call with lock held)
  void _setAttributesLocked(const LayoutAttributes& attrs);

  // JSI conversion helpers
  static LayoutAttributes  attrsFromJSI(facebook::jsi::Runtime& rt,
                                         const facebook::jsi::Object& obj);
  static facebook::jsi::Object attrsToJSI(facebook::jsi::Runtime& rt,
                                            const LayoutAttributes& attrs);
  static Rect rectFromJSI(facebook::jsi::Runtime& rt,
                           const facebook::jsi::Object& obj);
};

} // namespace rncv
