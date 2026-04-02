#pragma once

#include "Geometry.h"
#include "SpatialIndex.h"
#include <jsi/jsi.h>
#include <array>
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

/// Identity transform constant (4x4 column-major, matches CATransform3D layout).
inline constexpr std::array<double, 16> kIdentityTransform3D = {
  1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1
};

/**
 * Full layout attributes for a cell or supplementary view.
 * Mirrors UICollectionViewLayoutAttributes — comprehensive attribute set
 * covering geometry, visual properties, and layout metadata.
 *
 * One instance per cell / supplementary view.
 * Immutable after insertion; replaced (never mutated) on update.
 */
struct LayoutAttributes {
  // ── Identity ─────────────────────────────────────────────────────────
  std::string key;
  int         section       = 0;
  int         index         = -1;

  // ── Geometry (layout-computed) ───────────────────────────────────────
  Rect        frame;                   // x, y, width, height
  int         zIndex        = 0;
  double      alpha         = 1.0;
  bool        isHidden      = false;

  // 4x4 column-major transform matrix (identity = no transform).
  // Covers rotation, scale, translation, perspective.
  std::array<double, 16> transform3D = kIdentityTransform3D;

  // ── Supplementary view metadata ──────────────────────────────────────
  bool        isSupplementary = false;
  std::string supplementaryKind;       // empty for regular cells

  // ── Sizing state (three-tier tracking) ───────────────────────────────
  SizingState sizingState   = SizingState::Placeholder;
  bool        isDirty       = false;

  // ── Window tier ──────────────────────────────────────────────────────
  WindowTier  tier          = WindowTier::Outside;

  // ── Sticky behavior ──────────────────────────────────────────────────
  bool        isSticky      = false;

  // ── Animation state ──────────────────────────────────────────────────
  bool        isAnimating   = false;

  // ── Decoration metadata ──────────────────────────────────────────────
  // Set by layout engines that emit visual-only views (section backgrounds,
  // separators). Decoration views have no data backing and are owned by the
  // layout — their frames are fully determined by the layout engine.
  bool        isDecoration   = false;
  std::string decorationKind;           // "sectionBackground", "separator"

  // ── Escape hatch for layout-specific data ────────────────────────────
  // Arbitrary key-value pairs. No native release needed to add new data.
  // Use for layout-specific properties (parallax factor, snap alignment, etc.)
  std::unordered_map<std::string, double> extras;
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
   * Returns heights for items 0..count-1 in the given section.
   * Items without cache entries get height 0.
   * Single-call alternative to N getAttributes() calls.
   */
  std::vector<double> getItemHeights(int section, int count) const;

  /**
   * Y offset of each section's first item.
   * Index i = section i's starting Y coordinate.
   */
  std::vector<double> getSectionOffsets() const;

  // ── Scroll offset (shared between native view and ShadowNode) ───────────
  // Stored here instead of component state to avoid triggering Fabric commits
  // from the native scroll handler, which races with JS render updates.

  void setScrollOffset(double x, double y);
  Point getScrollOffset() const;

  // ── MVC (maintainVisibleContentPosition) correction ───────────────────
  // Three-step API called from the JS prepare() useMemo:
  //   1. snapshotAnchor()          — before prepare() rewrites positions
  //   2. computeCorrection()      — after prepare() writes new positions
  //   3. consumePendingCorrection() — called by native view in updateState:

  /// Enable/disable MVC correction. Called from JS when the prop changes.
  /// When disabled, snapshotAnchorIfNeeded() is a no-op (ShadowNode won't
  /// auto-snapshot for size-change mutations).
  void setMVCEnabled(bool enabled);

  /// Set scroll axis. When horizontal=true, MVC correction anchors by X instead of Y.
  /// Called from JS before prepare() when the list layout is horizontal.
  void setHorizontal(bool horizontal);

  /// Record the anchor item: smallest-Y item at or below the current scroll
  /// offset (reads _scrollOffset internally — written by native view on every
  /// scroll frame). Call BEFORE prepare() so old positions are still in cache.
  void snapshotAnchor();

  /// Like snapshotAnchor(), but a no-op if an anchor is already set.
  /// Called by the ShadowNode before applyMeasurements() to cover size-change
  /// mutations where JS prepare() was not re-run (layoutContext unchanged).
  void snapshotAnchorIfNeeded();

  /// Compare anchor's new Y to snapshotted Y. Store result as pending correction.
  /// Call AFTER prepare() writes new positions. Returns the correction delta.
  double computeCorrection();

  /// Return and atomically clear the pending correction. Called once by the
  /// native view in updateState: to adjust UIScrollView.contentOffset.
  double consumePendingCorrection();

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
  Point                                             _scrollOffset{0, 0};

  // MVC anchor snapshot state (guarded by _mutex)
  std::string _anchorKey;
  double      _anchorY             = 0;
  double      _anchorX             = 0;   // used when _horizontal == true
  bool        _hasAnchor           = false;
  bool        _mvcEnabled          = false;
  bool        _horizontal          = false; // when true, anchor by X; correction on X axis
  double      _pendingCorrectionY  = 0;
  bool        _hasPendingCorrection = false;

  // Internal helpers (call with lock held)
  void _setAttributesLocked(const LayoutAttributes& attrs);
  void _snapshotAnchorLocked(); // anchor-finding logic; caller must hold _mutex

  // JSI conversion helpers
  static LayoutAttributes  attrsFromJSI(facebook::jsi::Runtime& rt,
                                         const facebook::jsi::Object& obj);
  static facebook::jsi::Object attrsToJSI(facebook::jsi::Runtime& rt,
                                            const LayoutAttributes& attrs);
  static Rect rectFromJSI(facebook::jsi::Runtime& rt,
                           const facebook::jsi::Object& obj);
};

} // namespace rncv
