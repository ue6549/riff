#pragma once

#include <atomic>
#include <algorithm>

namespace rncv {

/**
 * MetricCollector — lock-free frame time ring buffer.
 *
 * Written by the CADisplayLink callback on the main thread.
 * Read by JSI (JS thread) at ~10 Hz via getFrameMetrics().
 *
 * Single-producer (main thread) / single-consumer (JS thread) ring buffer.
 * No mutex needed: _writeIdx is the only shared mutable state that crosses
 * the producer/consumer boundary, and it is only incremented by the producer.
 * Consumers read a snapshot of recent samples — a slightly stale read is
 * acceptable for a HUD that refreshes at 10 Hz.
 */
class MetricCollector {
public:
  static constexpr int kRingSize = 120; // 2 s at 60 fps, 1 s at 120 fps

  // Record one display-link tick. Called on the main thread.
  void recordFrame(double durationMs) {
    int idx = _writeIdx.fetch_add(1, std::memory_order_relaxed) % kRingSize;
    _ring[idx] = durationMs;
    _totalFrames.fetch_add(1, std::memory_order_relaxed);
  }

  struct FrameMetrics {
    double fps;          // frames per second, averaged over kAvgWindow frames
    double frameTimeMs;  // average frame duration in ms
  };

  // Read averaged frame metrics. Called on JS thread at ~10 Hz.
  FrameMetrics getFrameMetrics() const {
    int total = _totalFrames.load(std::memory_order_relaxed);
    int count = std::min(total, kAvgWindow);
    if (count == 0) return {0.0, 0.0};

    int writeIdx = _writeIdx.load(std::memory_order_relaxed);
    double sum = 0.0;
    for (int i = 0; i < count; i++) {
      int idx = (writeIdx - 1 - i % kRingSize + kRingSize * 2) % kRingSize;
      sum += _ring[idx];
    }
    double avgMs = sum / count;
    double fps   = avgMs > 0.0 ? 1000.0 / avgMs : 0.0;
    return {fps, avgMs};
  }

  void reset() {
    _writeIdx.store(0, std::memory_order_relaxed);
    _totalFrames.store(0, std::memory_order_relaxed);
  }

private:
  static constexpr int kAvgWindow = 30; // average over last 30 frames (~0.5 s)

  double           _ring[kRingSize]{};
  std::atomic<int> _writeIdx{0};
  std::atomic<int> _totalFrames{0};
};

} // namespace rncv
