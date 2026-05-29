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
  int         flatIndex     = -1;  // Pre-computed flat index for processScroll (set by layout engine)

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

  // ── Flow row extent (render-range accuracy) ──────────────────────────
  // V-flow only: max primary-axis size of the row this item belongs to.
  // findRangeByPrimary uses max(frame.height, rowExtentHeight) so shorter
  // items in a multi-height row enter/exit the range with the tallest peer.
  // 0 for all other layouts (safe: max(h, 0) == h).
  double      rowExtentHeight = 0;

  // ── Row group position (masonry render-range accuracy) ───────────────
  // V-masonry: min primary-axis pos of the rank group this item belongs to.
  // When >= 0, findRangeByPrimary uses rowGroupPos as pos and rowExtentHeight
  // as size so all items in the same rank enter/exit the render range together,
  // preventing partial-row pop-in when a new row scrolls into view.
  // -1 (default) = use frame.y/x directly (all non-masonry layouts).
  double      rowGroupPos = -1;

  // ── Escape hatch for layout-specific data ────────────────────────────
  // Arbitrary key-value pairs. No native release needed to add new data.
  // Use for layout-specific properties (parallax factor, snap alignment, etc.)
  std::unordered_map<std::string, double> extras;
};

// ─── BulkFrameResult (Opt B — batch frame reads for ShadowNode) ─────────────

struct BulkFrameResult {
  std::vector<double> frames;  // flat [x0,y0,w0,h0, x1,y1,w1,h1, ...]
  std::vector<bool>   found;   // which keys had cache entries
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
  /**
   * Batch update — applies all attribute updates under a single mutex
   * acquisition. Used by scroll-driven sub-container layouts (radial,
   * spiral, carousel3D) to commit N visible items per scroll tick in one
   * JSI round-trip + one lock acquisition.
   */
  void setAttributesBatch(const std::vector<LayoutAttributes>& batch);
  std::optional<LayoutAttributes> getAttributes(const std::string& key) const;
  void removeAttributes(const std::string& key);
  void clear();

  // ── Height stash (survive fingerprint-clear during insert/delete) ──────────
  // Usage: stashHeights() → clear() → computeSections() → clearStash()
  // The stash lets measured Yoga heights survive the cache.clear() that happens
  // on insert/delete (itemCount fingerprint change). computeSectionFromCache
  // falls through to the stash when the main cache has no entry.

  /** Save primary-axis size for every Measured entry. O(cache_size). */
  void stashHeights();
  /** Return stashed height for key, or -1 if not found. */
  double getStashedHeight(const std::string& key) const;
  /** Save measured width+height for every Measured entry. O(cache_size). */
  void stashMeasuredSizes();
  /** Return stashed measured size for key, or nullopt if not found. */
  std::optional<Size> getStashedMeasuredSize(const std::string& key) const;
  /** Release stash memory after computeSections() is done. */
  void clearStash();

  // ── Bulk access ───────────────────────────────────────────────────────────

  /** Returns all attributes in insertion order (matches layout order). */
  std::vector<LayoutAttributes> getAll() const;

  /** Returns attributes for all items whose frame intersects rect. */
  std::vector<LayoutAttributes> getAttributesInRect(const Rect& rect) const;

  // ── Sorted-layout binary search (replaces spatial queries for list/grid) ──

  /** Result of binary search on primary-axis positions. */
  struct PrimaryRange {
    int firstIdx = -1;   // flat index of first item in range
    int lastIdx  = -1;   // flat index of last item in range
    double firstPos  = 0; // primary-axis position of first item
    double firstSize = 0; // primary-axis size of first item
    double lastPos   = 0; // primary-axis position of last item
    double lastSize  = 0; // primary-axis size of last item
  };

  /**
   * Find the range of items whose primary-axis extent intersects [lo, hi].
   * O(log n) binary search on the sorted position index. Zero struct copies.
   * Single mutex acquisition. Returns flat indices + first/last frame data.
   * Use for sorted layouts (list, grid) instead of getAttributesInRect.
   */
  PrimaryRange findRangeByPrimary(double lo, double hi, bool horizontal) const;

  // ── Aggregate queries ─────────────────────────────────────────────────────

  Size getTotalContentSize() const;

  /** O(1) reverse lookup: section + within-section item index → cache key. */
  std::optional<std::string> getKeyForIndexPath(int section, int item) const;
  /** O(1) lookup: section index → its header's cache key (if a header exists). */
  std::optional<std::string> getHeaderKeyForSection(int section) const;

  /**
   * Returns frame data (x, y, width, height) for all cache entries whose
   * flatIndex falls in [firstFlat, lastFlat]. Result is a flat vector of
   * size (lastFlat - firstFlat + 1) * 4, zero-initialized. Entries with no
   * matching cache entry keep their zero values.
   * Single mutex acquisition. Use to eliminate per-cell JSI calls in renderCell.
   */
  std::vector<double> getFramesForFlatRange(int firstFlat, int lastFlat) const;

  /**
   * Opt B: Batch frame read by key names. Returns x,y,w,h for each key in a
   * single mutex acquisition — eliminates per-key lock + LayoutAttributes copy.
   * Used by ShadowNode::correctChildPositionsIfNeeded() to replace N individual
   * getAttributes() calls.
   */
  BulkFrameResult getFramesForKeys(const std::vector<std::string>& keys) const;

  /**
   * Returns heights for items 0..count-1 in the given section.
   * Items without cache entries get height 0.
   * Single-call alternative to N getAttributes() calls.
   */
  std::vector<double> getItemHeights(int section, int count) const;
  
  /**
   * Returns heights for specifically named keys.
   * Items without cache entries get height 0.
   */
  std::vector<double> getItemHeightsByKeys(const std::vector<std::string>& keys) const;

  /**
   * Y offset of each section's first item.
   * Index i = section i's starting Y coordinate.
   */
  std::vector<double> getSectionOffsets() const;

  // ── Scroll offset (shared between native view and ShadowNode) ───────────
  // Stored here instead of component state to avoid triggering Fabric commits
  // from the native scroll handler, which races with JS render updates.

  void setScrollOffset(double x, double y, double timestampMs = 0.0);
  Point getScrollOffset() const;

  /// Return current estimated scroll velocity (px/ms, signed).
  /// Derived internally from consecutive setScrollOffset calls.
  double getVelocity() const;

  /// Atomic read of offset + velocity (single mutex acquisition).
  struct ScrollSnapshot { Point offset; double velocity; };
  ScrollSnapshot getScrollOffsetAndVelocity() const;

  /// Opt D: Atomic read of offset + velocity + version (single lock, was 2).
  struct ScrollSnapshotV { Point offset; double velocity; uint64_t version; };
  ScrollSnapshotV getScrollSnapshotWithVersion() const;

  /// Opt D: Two binary searches in one lock (sorted path, was 2 locks).
  struct DualRange { PrimaryRange render; PrimaryRange visible; };
  DualRange findDualRangeByPrimary(
      double renderLo, double renderHi,
      double visibleLo, double visibleHi,
      bool horizontal) const;

  /// Opt D: Frames + version in one lock (was 2 locks).
  struct FramesWithVersion { std::vector<double> frames; uint64_t version; };
  FramesWithVersion getFramesForFlatRangeWithVersion(int firstFlat, int lastFlat) const;

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

  /// Return and atomically clear the pending correction delta. Used by unit tests
  /// and JSI to inspect the raw delta. Prefer consumePendingScrollTarget() for
  /// native view application.
  double consumePendingCorrection();

  /// Return and atomically clear the absolute scroll target computed as
  /// (snapshotScrollOffset + correctionDelta). Called by the native view in
  /// updateState: to set UIScrollView.contentOffset directly, avoiding
  /// double-correction when UIKit auto-clamps contentOffset on contentSize change.
  double consumePendingScrollTarget();

  /// Set/clear the programmatic-scroll-active flag. Called by the native view:
  ///   set=true  when _scrollToX:y:animated:YES begins
  ///   set=false in all scroll-end delegate callbacks
  /// While true, snapshotAnchorIfNeeded() is a no-op to prevent MVC correction
  /// from cancelling an in-flight animated scrollTo.
  void setProgrammaticScrollActive(bool active);

  // ── H-section MVC (per-section horizontal scroll correction) ─────────────
  // For H-list sections only (grid/masonry/flow MVC semantics TBD).
  // Two-step API called from JS prepare() useMemo + consumed by native sub-container updateState:
  //   1. snapshotHAnchor(sectionIndex, scrollX) — before prepare(), records first visible H item
  //   2. computeHCorrection(sectionIndex)        — after applyMeasurements, reads new X, returns delta

  /// Snapshot the first visible H item for a section (first item at X >= scrollX).
  /// Call BEFORE prepare() so pre-insert positions are recorded.
  void snapshotHAnchor(int sectionIndex, double scrollX);

  /// Compare anchor's new X to snapshotted X. Returns delta; clears snapshot (one-shot).
  /// Call from native sub-container updateState: after Fabric commit.
  double computeHCorrection(int sectionIndex);

  // ── Versioning ────────────────────────────────────────────────────────────

  uint64_t version() const;

  // H-MVC version — bumped by endHBatch() instead of endBatch().
  // V sub-containers only track version(); H sub-containers only track
  // hMvcVersion(). This prevents H scroll applyMeasurements writes from
  // causing shouldSkipCorrection() misses in unrelated V sub-containers.
  uint64_t hMvcVersion() const;

  // ── Batch mode ─────────────────────────────────────────────────────────────
  // Coalesce multiple setAttributes writes into a single version bump.
  // Without batching, applyMeasurements cascading one Yoga delta through N
  // items produces N version bumps (one per shifted item). Batch mode defers
  // the bump until endBatch(), reducing N bumps to 1 per layout pass.
  //
  // Nestable: beginBatch/endBatch pairs can nest; version bumps only on the
  // outermost endBatch if any entry's frame changed during the batch.
  void beginBatch();
  void endBatch();
  // Like endBatch() but bumps hMvcVersion instead of version.
  // Use for H sub-container applyMeasurements writes.
  void endHBatch();

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

  // Sorted position index for O(log n) binary search queries.
  // Entries are {primaryPos, key} sorted by primaryPos ascending.
  // Maintained incrementally in _setAttributesLocked. Cleared on clear().
  // _sortedHorizontal tracks which axis was used to build the sort.
  struct SortedEntry { double pos; double size; std::string key; };
  mutable std::vector<SortedEntry>                  _sorted;
  mutable bool                                      _sortedDirty = true;
  mutable bool                                      _sortedHorizontal = false;
  uint64_t                                          _version = 0;
  uint64_t                                          _hMvcVersion = 0;
  int                                               _batchDepth = 0;
  bool                                              _batchDirty = false;
  bool                                              _batchIsHMvc = false;
  mutable std::mutex                                _mutex;
  SpatialIndex                                      _index;   // M1.4

  // Opt C: flatIndex → key lookup for O(range) getFramesForFlatRange.
  std::vector<std::string>                          _flatIndexToKey;

  // (section, item) → key: O(1) reverse lookup for scrollToIndexPath.
  // Packed as (uint32_t section << 32 | uint32_t item). Only regular items
  // (non-supplementary, non-decoration, index >= 0).
  std::unordered_map<uint64_t, std::string>         _indexPathToKey;
  // section index → header key: O(1) lookup for scrollToSection.
  std::unordered_map<int32_t, std::string>          _sectionHeaderKey;
  Point                                             _scrollOffset{0, 0};

  // Velocity tracking — updated by setScrollOffset on every native scroll tick.
  double _prevScrollPrimary      = 0.0;
  double _prevScrollTimestamp     = 0.0;
  double _currentVelocity         = 0.0;  // px/ms, signed

  // Height stash — survives fingerprint-triggered clear (not guarded by _mutex;
  // only accessed from the JS thread synchronously around stash/clear/compute).
  std::unordered_map<std::string, double> _heightStash;
  std::unordered_map<std::string, Size>   _measuredSizeStash;

  // MVC anchor snapshot state (guarded by _mutex)
  std::string _anchorKey;
  double      _anchorY             = 0;
  double      _anchorX             = 0;   // used when _horizontal == true
  bool        _hasAnchor           = false;
  bool        _mvcEnabled          = false;
  bool        _horizontal          = false; // when true, anchor by X; correction on X axis
  // Set true by _scrollToX:y:animated: when animated=YES; cleared in all scroll-end
  // delegate callbacks (scrollViewDidEndScrollingAnimation:, scrollViewDidEndDecelerating:,
  // scrollViewDidEndDragging:willDecelerate: when !decelerate).
  // snapshotAnchorIfNeeded() is a no-op while true, preventing MVC re-arming
  // during an animated scrollTo (which would cancel the animation via setContentOffset).
  bool        _programmaticScrollActive = false;
  double      _snapshotScrollPrimary = 0; // scroll offset (Y or X) at snapshotAnchor time
  double      _pendingCorrectionY  = 0;   // delta (newAnchorPos - oldAnchorPos)
  double      _pendingScrollTarget = 0;   // absolute: _snapshotScrollPrimary + delta
  bool        _hasPendingCorrection = false;

  // Per-section H anchor snapshots (guarded by _mutex).
  std::unordered_map<int, std::string> _hAnchorKeys;
  std::unordered_map<int, double>      _hAnchorXs;

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
