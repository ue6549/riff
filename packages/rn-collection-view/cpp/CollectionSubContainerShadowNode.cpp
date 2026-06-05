#include "CollectionSubContainerShadowNode.h"
#include "CollectionViewModule.h"
#include "LayoutEngine.h"
#include "layouts/CompositionalLayout.h"

#include <algorithm>
#include <cmath>
#include <yoga/YGNode.h>

// Cross-platform debug logging for the sub-container ShadowNode.
// Active only in DEBUG builds; no-op in release.
#ifndef RNCV_ENABLE_NATIVE_LOGS
#define RNCV_ENABLE_NATIVE_LOGS 0
#endif

#if DEBUG && RNCV_ENABLE_NATIVE_LOGS
  #ifdef __APPLE__
    #include <cstdio>
    #define RNCV_SUB_LOG(fmt, ...) do { fprintf(stderr, "[RNCV-SUB] " fmt "\n", ##__VA_ARGS__); fflush(stderr); } while(0)
  #else
    #include <android/log.h>
    #define RNCV_SUB_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-SUB", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_SUB_LOG(fmt, ...) ((void)0)
#endif

// Targeted H sub-container scroll diagnostics. Independent from the broader
// RNCV_ENABLE_NATIVE_LOGS so we can crank these up without re-enabling every
// generic native log site in the codebase.
//
// Flip to 1 to enable. Sister flags:
//   - example/components/CollectionView.tsx          → RNCV_HSUB_LOGS
//   - cpp/CollectionViewModule.cpp                   → RNCV_ENABLE_HSUB_LOGS
//   - ios/RNCollectionSubContainerView.mm            → RNCV_ENABLE_HSUB_LOGS
//
// Filterable tags emitted from this file:
//   RNCV-HSUB-CPP-LAYOUT   per-layout child cv.x/y/w/h, ySectionShift, cache hit/miss
//   RNCV-HSUB-CPP-STATE    correctedContentSize → state.contentSize transitions,
//                          defensive retain decisions, childTags hash
#ifndef RNCV_ENABLE_HSUB_LOGS
#define RNCV_ENABLE_HSUB_LOGS 0
#endif

// Intentionally NOT gated on DEBUG — the flag is opt-in (default 0). Some
// Pods are built without DEBUG defined even in dev configurations, and
// requiring both gates silently swallows the user's flag flip.
#if RNCV_ENABLE_HSUB_LOGS
  #ifdef __APPLE__
    #include <cstdio>
    #define RNCV_HSUB_LOG(fmt, ...) do { fprintf(stderr, "[RNCV-HSUB-CPP] " fmt "\n", ##__VA_ARGS__); fflush(stderr); } while(0)
  #else
    #include <android/log.h>
    #define RNCV_HSUB_LOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, "RNCV-HSUB-CPP", fmt, ##__VA_ARGS__)
  #endif
#else
  #define RNCV_HSUB_LOG(fmt, ...) ((void)0)
#endif

// ── Diagnostic: H sub-container layout commit + skip-correction rate ─────
// Hypothesis under test: on compositional pages with many H sub-containers,
// each V container commit fans out into a commit on every sub-container.
// `shouldSkipCorrection()` short-circuits when nothing changed for that
// sub-container — but if its hit rate is low, every V tick produces real
// work across all sub-containers (the storefront p75/p90 CPU regression
// candidate after the visual-attrs gate fix).
//
// Output: every 50 sub-container layout() invocations, one line:
//   [RNCV-HSUB-DIAG] commits=<N> skips=<M> skipRate=<P>%
//
// Interpretation:
//   - skipRate > 80% → fan-out is cheap, not a CPU cost source
//   - skipRate 30–80% → fan-out has real cost, worth optimising
//   - skipRate < 30% → every V tick re-runs all H sub-container correction
//
// Independent of all other log flags. Set RNCV_HSUB_SKIP_DIAG to 0 after
// measurement is complete.
// Re-enabled for B4.17 Phase 1 to correlate sub-container `fail.ver` count
// with V container's `applyMeas` count — same bench, same log stream.
// Disabled after Fix B verified: fail.ver dropped from 1127 → 54 (-95%),
// HSub skip rate jumped from 27% → 80.6% (+53.6 pp). B4.17 closed.
#define RNCV_HSUB_SKIP_DIAG 0

#if RNCV_HSUB_SKIP_DIAG
#include <atomic>
#include <cstdio>
namespace {
  // Static-storage atomics: guaranteed zero-initialized by C++ before any
  // dynamic init runs, so no explicit initializer is needed.
  std::atomic<uint32_t> g_hsubCommits;
  std::atomic<uint32_t> g_hsubSkips;
  // Per-reason counters for "skip check failed and returned false".
  // Bench shows skipRate==0%, so one of these is hitting every commit.
  // Output identifies the culprit so we know whether to fix the check
  // or accept the invalidation.
  std::atomic<uint32_t> g_hsubFailLcv;        // props.layoutCacheVersion changed
  std::atomic<uint32_t> g_hsubFailNoCache;    // layoutCacheForId returned null
  std::atomic<uint32_t> g_hsubFailVersion;    // cache->version() changed
  std::atomic<uint32_t> g_hsubFailHMvc;       // cache->hMvcVersion() changed (H only)
  std::atomic<uint32_t> g_hsubFailChildCount; // N != lastChildCount_
  std::atomic<uint32_t> g_hsubFailHash;       // tag/yoga hash changed
  // Counter for cnt-change occurrences, used to sample 1 in 10 cnt-change logs
  // (otherwise the cnt=100% pattern would flood the log).
  std::atomic<uint32_t> g_hsubCntChangeCount;
}
#define RNCV_HSUB_DIAG_COMMIT()                                                  \
  do {                                                                           \
    uint32_t _c = g_hsubCommits.fetch_add(1, std::memory_order_relaxed) + 1;     \
    if (_c % 50 == 0) {                                                          \
      uint32_t _s = g_hsubSkips.load(std::memory_order_relaxed);                 \
      uint32_t _flcv  = g_hsubFailLcv.load(std::memory_order_relaxed);           \
      uint32_t _fnc   = g_hsubFailNoCache.load(std::memory_order_relaxed);       \
      uint32_t _fver  = g_hsubFailVersion.load(std::memory_order_relaxed);       \
      uint32_t _fhmvc = g_hsubFailHMvc.load(std::memory_order_relaxed);          \
      uint32_t _fcnt  = g_hsubFailChildCount.load(std::memory_order_relaxed);    \
      uint32_t _fhash = g_hsubFailHash.load(std::memory_order_relaxed);          \
      fprintf(stderr,                                                            \
              "[RNCV-HSUB-DIAG] commits=%u skips=%u skipRate=%.1f%% "            \
              "fail{lcv=%u noCache=%u ver=%u hMvc=%u cnt=%u hash=%u}\n",         \
              _c, _s, _c > 0 ? (_s * 100.0 / _c) : 0.0,                          \
              _flcv, _fnc, _fver, _fhmvc, _fcnt, _fhash);                        \
      fflush(stderr);                                                            \
    }                                                                            \
  } while (0)
#define RNCV_HSUB_DIAG_SKIP()                                                    \
  do {                                                                           \
    g_hsubSkips.fetch_add(1, std::memory_order_relaxed);                         \
  } while (0)
// Reason taggers — used inside shouldSkipCorrection at each false-return path.
#define RNCV_HSUB_DIAG_FAIL_LCV()        g_hsubFailLcv.fetch_add(1, std::memory_order_relaxed)
#define RNCV_HSUB_DIAG_FAIL_NOCACHE()    g_hsubFailNoCache.fetch_add(1, std::memory_order_relaxed)
#define RNCV_HSUB_DIAG_FAIL_VERSION()    g_hsubFailVersion.fetch_add(1, std::memory_order_relaxed)
#define RNCV_HSUB_DIAG_FAIL_HMVC()       g_hsubFailHMvc.fetch_add(1, std::memory_order_relaxed)
#define RNCV_HSUB_DIAG_FAIL_CHILDCOUNT() g_hsubFailChildCount.fetch_add(1, std::memory_order_relaxed)
#define RNCV_HSUB_DIAG_FAIL_HASH()       g_hsubFailHash.fetch_add(1, std::memory_order_relaxed)
#else
#define RNCV_HSUB_DIAG_COMMIT() ((void)0)
#define RNCV_HSUB_DIAG_SKIP()   ((void)0)
#define RNCV_HSUB_DIAG_FAIL_LCV()        ((void)0)
#define RNCV_HSUB_DIAG_FAIL_NOCACHE()    ((void)0)
#define RNCV_HSUB_DIAG_FAIL_VERSION()    ((void)0)
#define RNCV_HSUB_DIAG_FAIL_HMVC()       ((void)0)
#define RNCV_HSUB_DIAG_FAIL_CHILDCOUNT() ((void)0)
#define RNCV_HSUB_DIAG_FAIL_HASH()       ((void)0)
#endif

namespace facebook::react {

// Must match the string used in codegenNativeComponent('RNCollectionSubContainer').
const char CollectionSubContainerComponentName[] = "RNCollectionSubContainer";

// ── Clone constructor: propagate skip-correction tracking state ─────────────
// See header for the full diagnostic background. In short: Fabric's clone
// path uses the (source, fragment) constructor signature, NOT the C++
// default copy constructor. The base class's clone copies base-class state;
// derived state (our lastXxx_ fields) has to be propagated explicitly.
// Without this, every Fabric commit produces a clone with reset tracking
// state — shouldSkipCorrection() never finds a match and runs full
// correction every commit on every sub-container instance.
//
// Scratch members (correctedChildren_, childTags_, correctedContentSize_,
// correctedBoundingRect_) are intentionally NOT propagated — they're
// rebuilt by correctChildPositionsIfNeeded() when correction actually runs,
// and ignored when shouldSkipCorrection() returns true (Fabric's state
// mechanism carries forward the previous state's payload across clones).
CollectionSubContainerShadowNode::CollectionSubContainerShadowNode(
    const ShadowNode& sourceShadowNode,
    const ShadowNodeFragment& fragment)
    : ConcreteViewShadowNode(sourceShadowNode, fragment) {
  const auto& source =
      static_cast<const CollectionSubContainerShadowNode&>(sourceShadowNode);
  lastCacheVersion_       = source.lastCacheVersion_;
  lastHMvcVersion_        = source.lastHMvcVersion_;
  lastLayoutCacheVersion_ = source.lastLayoutCacheVersion_;
  lastChildCount_         = source.lastChildCount_;
  lastChildTagsHash_      = source.lastChildTagsHash_;
  lastYogaHeightHash_     = source.lastYogaHeightHash_;
}

// ── H-4b: Short-circuit check ──────────────────────────────────────────────
// When the main container relayouts (V scroll cell churn), Yoga re-runs on
// every sub-container as a side-effect even if their children + cache are
// unchanged. This check avoids the expensive 4-phase correction + state
// update in that common case.
bool CollectionSubContainerShadowNode::shouldSkipCorrection() {
  const auto& props =
      *std::static_pointer_cast<const RNCollectionSubContainerProps>(getProps());

  // ── LCV check, post-fix: passive signal only ─────────────────────────────
  //
  // props.layoutCacheVersion is a JS-side React state that bumps on (a) any
  // JS-initiated invalidation (invalidateItem, snapshot.apply) and (b) any
  // JS detection of a C++ cache version change (double-RAF poll, V scroll
  // handler). In case (b), the LCV bump is a redundant downstream notification
  // of a C++ change that this sub-container can check directly via
  // cache->version() and yogaHash below — so reacting to LCV here causes a
  // false invalidation on every passive bump.
  //
  // We continue to track the current LCV value (so the diagnostic counter
  // remains meaningful) but no longer return false on a mismatch. The C++
  // checks below — cache version, hMvcVersion, child count, tag hash,
  // Yoga hash — together cover every real reason a sub-container should
  // re-correct.
  // ── Snapshot inputs at function entry ────────────────────────────────────
  // Captured before we overwrite tracked state, so sample logs can show
  // current-vs-last for each check.
  const int curLCV = props.layoutCacheVersion;
  const int snapLastLCV = lastLayoutCacheVersion_;
  bool failLcv = false;
  if (curLCV != snapLastLCV) {
    lastLayoutCacheVersion_ = curLCV;
    failLcv = true;
    RNCV_HSUB_DIAG_FAIL_LCV();
  }

  // Diagnostic-only locals — track every authoritative reason a skip would
  // fail, independent of which one would trigger first under early-return.
  // Bench output via fail{} reports the real distribution, not the bias of
  // first-match-wins ordering.
  bool failVer = false, failHMvc = false, failCnt = false, failHash = false;

  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);
  if (!cache) {
    RNCV_HSUB_DIAG_FAIL_NOCACHE();
    return false;
  }

  const uint64_t cv = cache->version();
  const uint64_t snapLastVer = lastCacheVersion_;
  if (cv != snapLastVer) {
    failVer = true;
    RNCV_HSUB_DIAG_FAIL_VERSION();
  }

  // H sub-containers also invalidate on H-only cache writes. These are batched
  // via endHBatch() — they bump _hMvcVersion but NOT _version, so the check
  // above passes. Without this, an H sub-container that just wrote its own
  // measurement deltas would silently skip re-reading the updated positions.
  // V containers (main container) intentionally don't check _hMvcVersion —
  // they have no interest in H item position changes.
  const bool isH =
      (props.scrollDirection == RNCollectionSubContainerScrollDirection::Horizontal);
  const uint64_t hMvcCur = cache->hMvcVersion();
  const uint64_t snapLastHMvc = lastHMvcVersion_;
  if (isH && hMvcCur != snapLastHMvc) {
    failHMvc = true;
    RNCV_HSUB_DIAG_FAIL_HMVC();
  }

  auto children = getLayoutableChildNodes();
  const size_t N = children.size();
  const size_t snapLastN = lastChildCount_;
  if (N != snapLastN) {
    failCnt = true;
    RNCV_HSUB_DIAG_FAIL_CHILDCOUNT();
    // Sample 1 in 10 cnt-change occurrences — the full set would flood at
    // cnt=100%. Tells us whether N is oscillating (pool eviction +
    // re-mount as V scroll moves past + back to the section) or growing /
    // shrinking with a different pattern.
#if RNCV_HSUB_SKIP_DIAG
    uint32_t cChange = g_hsubCntChangeCount.fetch_add(1, std::memory_order_relaxed) + 1;
    if (cChange % 10 == 0) {
      fprintf(stderr, "[RNCV-HSUB-CNTCHG] #%u s=%d N=%zu→%zu delta=%+d\n",
              cChange, props.sectionIndex, snapLastN, N,
              (int)(N - snapLastN));
      fflush(stderr);
    }
#endif
  }
  if (N == 0 && !failVer && !failHMvc && !failCnt) {
    // Empty children + no other change signals → nothing to correct.
    return true;
  }
  if (N == 0) {
    // Empty but something else changed → fall through to update tracked state
    // by running correction (it's a no-op anyway for empty children).
    return false;
  }

  // Boost-style hash combine of child Fabric tags AND full Yoga frame.
  //
  // The tag hash guards against child identity changes (add/remove cells).
  // The Yoga frame hash guards against content-only changes (Resize,
  // expand/collapse) where tags/count/cacheVersion are all unchanged but
  // actual Yoga-measured dimensions differ. Without this check,
  // shouldSkipCorrection returns true after Resize and nobody calls
  // applyMeasurements — the main container skips grandchild cascade for
  // H-2 sub-containers (ownsGrandchildCascade=true), so stale wrapper
  // height persists until the next scroll event.
  //
  // All four frame fields (origin + size) are hashed so width changes
  // (future custom cell widths, orientation changes) are also caught.
  // Comparison uses != not > so the hash is correct even if it wraps.
  // 2-decimal precision (×100 → round) captures real layout changes while
  // filtering sub-pixel Yoga jitter (< 0.01pt pass-to-pass).
  size_t tagHash   = N;
  size_t yogaHash  = N;
  for (size_t i = 0; i < N; ++i) {
    auto tag = static_cast<size_t>(children[i]->getTag());
    tagHash ^= std::hash<size_t>{}(tag) + 0x9e3779b9 + (tagHash << 6) + (tagHash >> 2);

    const auto& f = children[i]->getLayoutMetrics().frame;
    const size_t vals[4] = {
      static_cast<size_t>(std::lround(f.origin.x      * 100.0f)),
      static_cast<size_t>(std::lround(f.origin.y      * 100.0f)),
      static_cast<size_t>(std::lround(f.size.width    * 100.0f)),
      static_cast<size_t>(std::lround(f.size.height   * 100.0f)),
    };
    for (size_t v : vals) {
      yogaHash ^= v + 0x9e3779b9 + (yogaHash << 6) + (yogaHash >> 2);
    }
  }
  if (tagHash != lastChildTagsHash_) {
    failHash = true;
    RNCV_HSUB_DIAG_FAIL_HASH();
  }

  // Log only on mismatch — the interesting case where content changed.
  if (yogaHash != lastYogaHeightHash_) {
    RNCV_HSUB_LOG("SKIP-CHECK sIdx=%d yogaFrame mismatch: %zu → %zu (running correction)",
                  props.sectionIndex, lastYogaHeightHash_, yogaHash);
    failHash = true;
    RNCV_HSUB_DIAG_FAIL_HASH();
  }

  // ── Per-call sample log — every 100th sub-container layout() invocation ──
  // Emits one line with the full state diff. Identifies which section, the
  // current and previous values for every check, and whether each fired.
  // Density: with 4 active sub-containers, ~1 sample line every 25 Fabric
  // commits — light enough to read, dense enough to spot cascade patterns.
  //
  // Cascade detection: if `ver=A→B` and B-A>1 in consecutive lines for the
  // same section, another sub-container wrote between this section's
  // commits → cache version cascade is real.
#if RNCV_HSUB_SKIP_DIAG
  {
    const uint32_t curCommits = g_hsubCommits.load(std::memory_order_relaxed);
    if (curCommits % 100 == 0) {
      fprintf(stderr,
        "[RNCV-HSUB-SAMPLE] #%u s=%d isH=%d "
        "lcv=%d→%d ver=%llu→%llu hMvc=%llu→%llu N=%zu→%zu "
        "fired{lcv=%d ver=%d hMvc=%d cnt=%d hash=%d}\n",
        curCommits,
        props.sectionIndex,
        isH ? 1 : 0,
        snapLastLCV, curLCV,
        (unsigned long long)snapLastVer, (unsigned long long)cv,
        (unsigned long long)snapLastHMvc, (unsigned long long)hMvcCur,
        snapLastN, N,
        failLcv ? 1 : 0,
        failVer ? 1 : 0,
        failHMvc ? 1 : 0,
        failCnt ? 1 : 0,
        failHash ? 1 : 0);
      fflush(stderr);
    }
  }
#endif

  // Decision: skip only when none of the authoritative C++ signals fired.
  // LCV (JS-side) is recorded in failLcv but intentionally NOT considered
  // here — it's a redundant downstream signal that fires on passive cache
  // observation, which we'd otherwise re-detect via failVer.
  if (failVer || failHMvc || failCnt || failHash) {
    return false;
  }
  // Suppress unused-variable warning when diag macros expand to no-ops.
  (void)failLcv;

  RNCV_HSUB_LOG("SKIP-DECISION sIdx=%d SKIP cv=%llu N=%zu",
                props.sectionIndex,
                (unsigned long long)cache->version(),
                N);
  return true;
}

void CollectionSubContainerShadowNode::layout(LayoutContext layoutContext) {
  RNCV_SUB_LOG("layout() BEGIN");

  // Step 1: Yoga sizes children.
  ConcreteViewShadowNode::layout(layoutContext);

  // Diagnostic counter — must increment BEFORE the skip branch so commits
  // count includes skipped invocations.
  RNCV_HSUB_DIAG_COMMIT();

  // H-4b: Skip correction + state update when children + cache are unchanged.
  // The state from the previous commit (carried forward by Fabric clone) is
  // already correct — no need to re-read cache, compute deltas, or diff state.
  if (shouldSkipCorrection()) {
    RNCV_SUB_LOG("layout() SKIP — children + cache unchanged");
    RNCV_HSUB_LOG("LAYOUT-SKIP (H-4b confirmed)");
    RNCV_HSUB_DIAG_SKIP();
    return;
  }

  // Step 2: Read final visual state from cache, cascade Yoga deltas if any.
  correctChildPositionsIfNeeded();

  // Step 3: Update component state for the iOS view to consume.
  updateStateIfNeeded();

  RNCV_SUB_LOG("layout() END children=%zu contentW=%.1f contentH=%.1f",
               correctedChildren_.size(),
               correctedContentSize_.width,
               correctedContentSize_.height);
}

void CollectionSubContainerShadowNode::correctChildPositionsIfNeeded() {
  const auto& props =
      *std::static_pointer_cast<const RNCollectionSubContainerProps>(getProps());
  const auto children = getLayoutableChildNodes();

  correctedChildren_.clear();
  childTags_.clear();
  correctedBoundingRect_ = Rect{};

  auto cache = CollectionViewModule::getLayoutCacheForId(props.layoutCacheId);
  const bool isH = (props.scrollDirection == RNCollectionSubContainerScrollDirection::Horizontal);

  // ── Read section size from cache (H-2.1 round-trip cut) ──────────────────
  //
  // Compositional H sections write two cache entries from
  // `CompositionalLayout::finalizeHSection`:
  //   - `h-section-wrapper-{N}` → frame { 0, contentCursorY, vpW, sectionH }
  //                                (Y-position + cross-axis section height)
  //   - `h-section-cw-{N}`      → frame { 0, 0, totalContentW, 0 }
  //                                (full content extent on the scroll axis)
  //
  // BEFORE H-2.1, this ShadowNode read section size from props
  // (`props.contentWidth` / `props.contentHeight`), which JS populated by
  // reading these same cache entries via `compositional.hSectionInfo()` and
  // forwarding them as Fabric props. That JS round-trip created a feedback
  // loop:
  //   cell measures (Yoga) → cache write → finalizeHSection updates section
  //   size → JS reads cache → JS re-renders <RNCollectionSubContainer> with
  //   new contentHeight prop → Fabric commits the new prop → wrapper view
  //   bounds change → Yoga re-runs on subtree → cell measures again →
  //   pixel-grid rounding lands differently → goto step 1.
  // Symptoms: unnatural slow-decay bounce, gestures wedged after edge bounce,
  // JS render storm during deceleration (lcv climbing 20-30× per bounce).
  //
  // FIX: read section size directly from the cache here. The C++ ShadowNode
  // already reads `h-section-wrapper-{N}` for ySectionShift below, so it has
  // everything it needs without going through JS. Standalone consumers (e.g.
  // CollectionSubContainer.tsx for radial / spiral / carousel3D demos) still
  // pass props.contentWidth/Height — they have no compositional cache entry,
  // so the props serve as the standalone fallback.
  Float ySectionShift = 0;
  Size cacheSectionSize{0, 0};
  if (cache) {
    auto wrapperKey = std::string("h-section-wrapper-") +
                      std::to_string(props.sectionIndex);
    auto wrapperAttrs = cache->getAttributes(wrapperKey);
    if (wrapperAttrs) {
      ySectionShift           = static_cast<Float>(wrapperAttrs->frame.y);
      cacheSectionSize.height = static_cast<Float>(wrapperAttrs->frame.height);
    }
    RNCV_HSUB_LOG("INIT-CACHE sIdx=%d wrapperFound=%s ySectionShift=%.1f "
                  "cacheSectionH=%.1f cacheVersion=%llu",
                  props.sectionIndex,
                  wrapperAttrs ? "YES" : "NO",
                  (float)ySectionShift,
                  (float)cacheSectionSize.height,
                  (unsigned long long)cache->version());
    auto cwKey = std::string("h-section-cw-") +
                 std::to_string(props.sectionIndex);
    auto cwAttrs = cache->getAttributes(cwKey);
    if (cwAttrs) {
      cacheSectionSize.width = static_cast<Float>(cwAttrs->frame.width);
    }
  }

  // Helper: pick cache size when present, else props (standalone path).
  auto resolveContentSize = [&]() -> Size {
    if (cacheSectionSize.width > 0 || cacheSectionSize.height > 0) {
      return cacheSectionSize;
    }
    return Size{
      props.contentWidth  > 0 ? props.contentWidth  : 0,
      props.contentHeight > 0 ? props.contentHeight : 0,
    };
  };

  if (children.empty()) {
    // Initial layout pass before cells mount: use cache (compositional) or
    // props (standalone). The defensive retain in updateStateIfNeeded covers
    // any axis still zero. We deliberately do NOT collapse to Size{} —
    // that would tear down the scrollview's bounds before the next valid
    // layout pass arrives.
    correctedContentSize_ = resolveContentSize();
    return;
  }

  // Sub-containers in compositional layouts use the compositional engine for
  // measurement cascade — it knows how to dispatch deltas to the per-section
  // sub-layout. Standalone sub-containers can override this in future via a
  // new prop (e.g. sectionLayoutType) when needed.
  auto engine = CollectionViewModule::getLayoutEngineForId(
      props.layoutCacheId, "compositional");

  const size_t N = children.size();
  correctedChildren_.reserve(N);
  childTags_.reserve(N);

  // ── Phase 1: Extract cacheKeys from RNMeasuredCellProps ──────────────────
  // Direct children of a sub-container are RNMeasuredCell instances (cells).
  // Each cell carries its own cacheKey prop — we use that as the lookup key.
  std::vector<std::string> keys(N);
  std::vector<int32_t>     indices(N, -1);
  for (size_t i = 0; i < N; ++i) {
    if (auto p = std::dynamic_pointer_cast<const RNMeasuredCellProps>(
            children[i]->getProps())) {
      keys[i]    = p->cacheKey;
      indices[i] = p->index;
    }
  }

  // ── Phase 2: Bulk-read frames from cache ─────────────────────────────────
  rncv::BulkFrameResult bulkFrames;
  if (cache) {
    bulkFrames = cache->getFramesForKeys(keys);
  }

  // ── Phase 2b: Y-shift for compositional H-sections (already resolved) ────
  // ySectionShift was computed above alongside the section size lookup.
  // Standalone sub-containers (RiffDemo H-2 tabs) have no compositional
  // wrapper entry → ySectionShift stays 0 → cache positions are used as-is
  // (those layouts already write section-local positions).

#if RNCV_ENABLE_HSUB_LOGS
  {
    int hits = 0, misses = 0;
    for (size_t i = 0; i < N; ++i) {
      if (i < bulkFrames.found.size() && bulkFrames.found[i]) hits++;
      else misses++;
    }
    RNCV_HSUB_LOG(
      "LAYOUT s=%d N=%zu cacheHits=%d cacheMisses=%d ySectionShift=%.1f "
      "cacheCS=(%.1fx%.1f) propCS=(%.1fx%.1f) scrollDir=%d",
      props.sectionIndex, N, hits, misses, ySectionShift,
      cacheSectionSize.width, cacheSectionSize.height,
      props.contentWidth, props.contentHeight,
      static_cast<int>(props.scrollDirection));
  }
#endif

  // ── Phase 3: Initialize correctedChildren_ from cache + Yoga deltas ──────
  // For dimensions that are content-determined (Yoga measures), build deltas
  // and apply via the layout engine. For layouts that govern all dimensions
  // (radial, spiral, hex), no deltas are needed.
  auto contentDim = engine
      ? engine->contentDeterminedDimension()
      : rncv::ContentDimension::Height;

  // Gate the per-cell visual-attrs cache read: when the layout doesn't write
  // non-default alpha/zIndex/transform3D, ChildVisualState defaults (opacity=1,
  // zIndex=0, hasTransform=false) already match what the cache would return.
  // Skipping the read avoids N mutex-locked cache lookups per commit.
  // Static H layouts (flow / list horizontal / grid horizontal etc.) — which
  // make up all of storefront — go through this fast path.
  //
  // When the gate IS open (radial / spiral / carousel3D), we use a single
  // bulk-read with one mutex acquisition instead of N per-cell getAttributes
  // calls — eliminates lock contention on the cache during scroll-driven
  // recomputation.
  const bool layoutWritesVisualAttrs = engine && engine->writesVisualAttributes();
  rncv::BulkAttributesResult bulkAttrs;
  if (layoutWritesVisualAttrs && cache) {
    bulkAttrs = cache->getAttributesForKeys(keys);
  }

  std::vector<rncv::MeasurementDelta> deltas;

  for (size_t i = 0; i < N; ++i) {
    ChildVisualState cv;

    // Initialize from cache. Subtract section Y so cells land inside the
    // sub-container's local coordinate space (origin at section top-left).
    if (cache && i < bulkFrames.found.size() && bulkFrames.found[i]) {
      cv.x = static_cast<Float>(bulkFrames.frames[i * 4 + 0]);
      cv.y = static_cast<Float>(bulkFrames.frames[i * 4 + 1]) - ySectionShift;
      cv.w = static_cast<Float>(bulkFrames.frames[i * 4 + 2]);
      cv.h = static_cast<Float>(bulkFrames.frames[i * 4 + 3]);
    }

    // Pull richer attributes (transform/opacity/zIndex) from cache when the
    // layout writes them (radial, spiral, carousel3D via setAttributesBatch).
    // Static layouts skip this block entirely — their cache attrs would be
    // identity defaults matching ChildVisualState's own defaults. When the
    // gate is open, attrs came from a single bulk read above (one mutex
    // acquisition for all keys).
    if (layoutWritesVisualAttrs && i < bulkAttrs.found.size() && bulkAttrs.found[i]) {
      const auto& a = bulkAttrs.attrs[i];
      cv.opacity = static_cast<Float>(a.alpha);
      cv.zIndex  = static_cast<Float>(a.zIndex);
      if (a.transform3D != rncv::kIdentityTransform3D) {
        for (size_t k = 0; k < 16; ++k) {
          cv.transform[k] = static_cast<Float>(a.transform3D[k]);
        }
        cv.hasTransform = true;
      }
    }

    // Compare Yoga measurement against cache for content-determined axes.
    //
    // The 0.5pt threshold filters writing essentially-the-same-value back to
    // the cache on every commit (sub-pixel jitter from text rendering / image
    // sizing rounding accumulates differently pass-to-pass). Above 0.5pt is
    // a real measurement signal worth cascading.
    //
    // Note: an earlier iteration applied std::ceil to yoga values + a 1.5pt
    // threshold to dampen a feedback loop (cache change → JS render → Fabric
    // commit → Yoga re-run → goto). That loop was a symptom of round-tripping
    // section size through JS as a Fabric prop. H-2.1 cuts the round-trip at
    // its source — section size now flows cache → C++ ShadowNode → state →
    // iOS view, with no JS in between. Cell measurements can drift sub-pixel
    // freely; the wrapper view's bounds update natively without re-rendering
    // the React tree, so there's no loop to dampen.
    const auto& childMetrics = children[i]->getLayoutMetrics();
    const auto yogaWidth  = childMetrics.frame.size.width;
    const auto yogaHeight = childMetrics.frame.size.height;
    // Activity=hidden collapses the cell's Yoga height to 0. The Activity
    // ancestor receives display:none but its OWN displayType stays Inline on
    // the cell's LayoutMetrics — only the parent Activity node is None, so
    // displayType is not a reliable signal here. yogaHeight == 0 is the
    // practical proxy: H-list cells always have cross-axis height > 0 when
    // rendered; only Activity=hidden produces exactly 0.
    const bool cellIsHidden = (yogaHeight == 0.0f);

    static constexpr Float kCellMVCThresholdPt = 0.5f;

    if ((contentDim == rncv::ContentDimension::Height ||
         contentDim == rncv::ContentDimension::Both) &&
        !cellIsHidden &&
        yogaHeight > 0 &&
        std::abs(yogaHeight - cv.h) > kCellMVCThresholdPt &&
        !keys[i].empty()) {
      deltas.push_back({
        keys[i],
        indices[i],
        cv.h,
        yogaHeight,
        rncv::MeasurementAxis::Height,
      });
      cv.h = yogaHeight;
    }

    // Skip when Activity=hidden: Yoga resets width to the estimated value,
    // oscillating the H-list content size on every bounce. The cache retains
    // the last real measurement so content size stays stable off-screen.
    if ((contentDim == rncv::ContentDimension::Width ||
         contentDim == rncv::ContentDimension::Both) &&
        !cellIsHidden &&
        yogaWidth > 0 &&
        std::abs(yogaWidth - cv.w) > kCellMVCThresholdPt &&
        !keys[i].empty()) {
      deltas.push_back({
        keys[i],
        indices[i],
        cv.w,
        yogaWidth,
        rncv::MeasurementAxis::Width,
      });
      cv.w = yogaWidth;
    }

    correctedChildren_.push_back(cv);
    childTags_.push_back(static_cast<int32_t>(children[i]->getTag()));

#if RNCV_ENABLE_HSUB_LOGS
    RNCV_HSUB_LOG(
      "LAYOUT-CHILD s=%d i=%zu key='%s' idx=%d tag=%d "
      "cv=(x=%.1f y=%.1f w=%.1f h=%.1f) yoga=(w=%.1f h=%.1f) "
      "found=%d",
      props.sectionIndex, i, keys[i].c_str(), indices[i],
      static_cast<int32_t>(children[i]->getTag()),
      cv.x, cv.y, cv.w, cv.h, yogaWidth, yogaHeight,
      (i < bulkFrames.found.size() && bulkFrames.found[i]) ? 1 : 0);
#endif
  }

  // ── Phase 4: Apply cascade and re-read final attributes ──────────────────
  RNCV_HSUB_LOG("PHASE4 sIdx=%d deltas=%zu engine=%s cache=%s",
                props.sectionIndex, deltas.size(),
                engine ? "YES" : "NO", cache ? "YES" : "NO");
#if RNCV_ENABLE_HSUB_LOGS
  for (const auto& d : deltas) {
    RNCV_HSUB_LOG("DELTA sIdx=%d key='%s' axis=%s old=%.2f new=%.2f diff=%.2f",
                  props.sectionIndex, d.key.c_str(),
                  d.axis == rncv::MeasurementAxis::Width ? "W" : "H",
                  d.oldValue, d.newValue, d.newValue - d.oldValue);
  }
#endif
  if (!deltas.empty() && engine && cache) {
    cache->snapshotAnchorIfNeeded();
    // Batch mode: coalesce all position writes into a single version bump.
    // H sub-containers use endHBatch() so their writes bump _hMvcVersion
    // instead of _version — V sub-containers won't see H writes as version
    // changes and won't re-run shouldSkipCorrection unnecessarily.
    cache->beginBatch();
    bool handled = engine->applyMeasurements(deltas, *cache);
    if (isH) cache->endHBatch(); else cache->endBatch();
    RNCV_SUB_LOG("applyMeasurements deltas=%zu handled=%s",
                 deltas.size(), handled ? "YES" : "NO");

    if (handled) {
      // Re-read after cascade to pick up new positions for items downstream
      // of the deltas (later items shifted by height/width changes).
      // Apply the same V-absolute → section-local Y shift as the initial read.
      auto reread = cache->getFramesForKeys(keys);
      for (size_t i = 0; i < N; ++i) {
        if (i >= reread.found.size() || !reread.found[i]) continue;
        correctedChildren_[i].x = static_cast<Float>(reread.frames[i * 4 + 0]);
        correctedChildren_[i].y = static_cast<Float>(reread.frames[i * 4 + 1]) - ySectionShift;
        correctedChildren_[i].w = static_cast<Float>(reread.frames[i * 4 + 2]);
        correctedChildren_[i].h = static_cast<Float>(reread.frames[i * 4 + 3]);
      }
    }

    // Refresh h-section-wrapper-{N} height directly from current item frames.
    // applyMeasurements' 0.5pt threshold and finalizeHSection's 2pt hysteresis
    // can both suppress the wrapper rewrite when deltas are below-threshold or
    // when _sectionInfos hasn't converged yet. The helper scans cached item
    // frames and updates only frame.height — no reflow, no cascade overhead.
    // Phase 4.5 below then re-reads the updated value into cacheSectionSize.
    // NOTE: always endBatch() — wrapper height is V-space metadata (consumed by
    // the main V container's shouldSkipCorrection). Using endHBatch() here would
    // prevent the main container from seeing the updated wrapper height.
    cache->beginBatch();
    rncv::CompositionalLayout::refreshHSectionWrapperHeight(*cache, props.sectionIndex);
    cache->endBatch();

  } else if (!deltas.empty() && cache) {
    // No engine — write Yoga measurements back to cache directly.
    cache->beginBatch();
    for (const auto& d : deltas) {
      auto cached = cache->getAttributes(d.key);
      if (cached) {
        auto updated = *cached;
        if (d.axis == rncv::MeasurementAxis::Height) {
          updated.frame.height = d.newValue;
        } else if (d.axis == rncv::MeasurementAxis::Width) {
          updated.frame.width = d.newValue;
        }
        updated.sizingState = rncv::SizingState::Measured;
        cache->setAttributes(updated);
      }
    }
    cache->endBatch();
  }

  // ── Phase 4.5: Re-read section size into cacheSectionSize ───────────────
  //
  // cacheSectionSize was captured at the top of this function before any
  // measurement processing. refreshHSectionWrapperHeight (above) has now
  // written the correct cross-axis height to h-section-wrapper-{N}. Re-read
  // it here so resolveContentSize() returns the correct value this commit.
  if (!deltas.empty() && cache) {
    const auto wrapperKey = std::string("h-section-wrapper-") +
                            std::to_string(props.sectionIndex);
    if (const auto wa = cache->getAttributes(wrapperKey)) {
      ySectionShift           = static_cast<Float>(wa->frame.y);
      cacheSectionSize.height = static_cast<Float>(wa->frame.height);
    }
    const auto cwKey = std::string("h-section-cw-") +
                       std::to_string(props.sectionIndex);
    if (const auto ca = cache->getAttributes(cwKey)) {
      cacheSectionSize.width = static_cast<Float>(ca->frame.width);
    }
    RNCV_HSUB_LOG("PHASE4.5 sIdx=%d cacheSectionH=%.1f cacheSectionW=%.1f",
                  props.sectionIndex,
                  (float)cacheSectionSize.height,
                  (float)cacheSectionSize.width);
  }

  // ── Phase 5: Compute content size + bounding rect ────────────────────────
  //
  // Content size MUST be the layout-declared total extent — the section's
  // full size as the layout engine computed it — NOT a max() of the windowed
  // children's bounds.
  //
  // Why: correctedChildren_ contains ONLY the items currently inside the H
  // render window. If we let `maxRight` track the rightmost windowed child's
  // edge, the computed contentSize fluctuates as the window slides;
  // UIScrollView re-clamps `contentOffset` to the new bounds on every state
  // commit, which surfaces as snap/cut during bounce-back and gesture fight
  // when the user H-scrolls fast (H-3 amplifies via velocity-adaptive width;
  // H-3.5 amplifies further by mounting more cells).
  //
  // Source of truth — picked up-top via `resolveContentSize`:
  //   - Compositional H section: cache `h-section-cw-{N}.frame.width` (total
  //     scroll-axis extent) + `h-section-wrapper-{N}.frame.height` (cross-axis
  //     section size). Written by CompositionalLayout::finalizeHSection.
  //   - Standalone sub-container (radial / spiral / carousel3D demos):
  //     props.contentWidth / contentHeight, set by the JS layout engine.
  //
  // If both signals are still zero (very first layout pass before sections
  // are sized), fall back to the children bounding rect so the scrollview
  // is at least functional. This is a degenerate edge case.
  Size resolved = resolveContentSize();
  if (resolved.width > 0 || resolved.height > 0) {
    correctedContentSize_ = resolved;
  } else {
    Float maxRight = 0, maxBottom = 0;
    for (size_t i = 0; i < N; ++i) {
      const auto& cv = correctedChildren_[i];
      Float right  = cv.x + cv.w;
      Float bottom = cv.y + cv.h;
      if (right  > maxRight)  maxRight  = right;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    correctedContentSize_ = Size{maxRight, maxBottom};
  }

  // Bounding rect (debug / hit-test) is still the union of child frames —
  // independent of contentSize and not surfaced to UIScrollView.
  for (size_t i = 0; i < N; ++i) {
    const auto& cv = correctedChildren_[i];
    correctedBoundingRect_.unionInPlace(Rect{
      Point{cv.x, cv.y},
      Size{cv.w, cv.h},
    });
  }

  // ── H-4b: Update tracking state for next layout's short-circuit check ────
  lastChildCount_ = N;
  {
    size_t tagHash  = N;
    size_t yogaHash = N;
    for (size_t i = 0; i < N; ++i) {
      auto tag = static_cast<size_t>(children[i]->getTag());
      tagHash ^= std::hash<size_t>{}(tag) + 0x9e3779b9 + (tagHash << 6) + (tagHash >> 2);

      const auto& f = children[i]->getLayoutMetrics().frame;
      const size_t vals[4] = {
        static_cast<size_t>(std::lround(f.origin.x    * 100.0f)),
        static_cast<size_t>(std::lround(f.origin.y    * 100.0f)),
        static_cast<size_t>(std::lround(f.size.width  * 100.0f)),
        static_cast<size_t>(std::lround(f.size.height * 100.0f)),
      };
      for (size_t v : vals) {
        yogaHash ^= v + 0x9e3779b9 + (yogaHash << 6) + (yogaHash >> 2);
      }
    }
    lastChildTagsHash_  = tagHash;
    lastYogaHeightHash_ = yogaHash;
  }
  if (cache) {
    lastCacheVersion_ = cache->version();
    lastHMvcVersion_  = cache->hMvcVersion();
  }
}

void CollectionSubContainerShadowNode::updateStateIfNeeded() {
  auto state = getStateData();

  bool changed = false;

  // Defensive contentSize: never collapse a previously-valid axis to zero.
  //
  // Symptoms this prevents:
  //   - H bounce snap at the right edge: contentSize.width briefly shrinks ->
  //     UIScrollView re-clamps contentOffset to (newWidth - vpWidth) ->
  //     bounce-back animation snaps to the new (smaller) target.
  //   - H gesture-stuck after right-edge bounce: contentSize.width <= vpWidth
  //     -> UIScrollView disables horizontal scroll entirely on that axis.
  //
  // Why a zero might still appear: cache `h-section-wrapper-{N}` /
  // `h-section-cw-{N}` haven't been populated yet on the very first layout
  // pass (compositional path), or the children-empty early return wrote
  // Size{}. We trust state.contentSize as the running source of truth — a
  // zero value means "no signal this pass", not "set the scrollview to zero".
  Size targetSize = correctedContentSize_;
  bool retainedW = false, retainedH = false;
  if (targetSize.width  <= 0 && state.contentSize.width  > 0) {
    targetSize.width = state.contentSize.width;
    retainedW = true;
  }
  if (targetSize.height <= 0 && state.contentSize.height > 0) {
    targetSize.height = state.contentSize.height;
    retainedH = true;
  }

#if RNCV_ENABLE_HSUB_LOGS
  {
    const auto &props =
        *std::static_pointer_cast<const RNCollectionSubContainerProps>(getProps());
    RNCV_HSUB_LOG(
      "STATE s=%d corrected=(%.1fx%.1f) targetAfterRetain=(%.1fx%.1f) "
      "prevState=(%.1fx%.1f) retainedW=%d retainedH=%d "
      "childCount=%zu prevChildCount=%zu rev=%d",
      props.sectionIndex,
      correctedContentSize_.width, correctedContentSize_.height,
      targetSize.width, targetSize.height,
      state.contentSize.width, state.contentSize.height,
      retainedW ? 1 : 0, retainedH ? 1 : 0,
      correctedChildren_.size(), state.children.size(),
      state.layoutRevision);
  }
#endif

  if (state.contentSize != targetSize) {
    state.contentSize = targetSize;
    changed = true;
  }

  if (state.contentBoundingRect != correctedBoundingRect_) {
    state.contentBoundingRect = correctedBoundingRect_;
    changed = true;
  }

  // Compare child arrays element-wise via ChildVisualState's operator!=.
  bool childrenChanged = (state.children.size() != correctedChildren_.size());
  if (!childrenChanged) {
    for (size_t i = 0; i < correctedChildren_.size(); ++i) {
      if (state.children[i] != correctedChildren_[i]) {
        childrenChanged = true;
        break;
      }
    }
  }

  if (childrenChanged || state.childTags != childTags_) {
    state.children   = correctedChildren_;
    state.childTags  = childTags_;
    state.layoutRevision++;
    changed = true;
  }

  if (changed) {
    setStateData(std::move(state));
  }
}

} // namespace facebook::react
