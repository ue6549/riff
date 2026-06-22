package com.riff

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Android TurboModule for Riff — extends the codegen-generated spec so the
 * native binary can find it via TurboModuleRegistry.getEnforcing('RiffModule').
 *
 * FPS measurement: Choreographer fires doFrame() at every vsync (~60/s). Instead
 * of calling nativeRecordFrame() via JNI on every single frame, durations are
 * accumulated in a pre-allocated DoubleArray (BATCH_SIZE = 32 frames, ~533 ms at
 * 60 fps) and flushed in a single nativeRecordFrameBatch() call. This reduces
 * the per-second JNI call count for metrics from 60 to ~2 — bringing Android
 * in line with iOS where CADisplayLink fires C-level callbacks with near-zero
 * overhead.
 */
class RiffModule(reactContext: ReactApplicationContext) :
    NativeCollectionViewModuleSpec(reactContext), ComponentCallbacks2 {

    companion object {
        init {
            System.loadLibrary("react_codegen_RiffSpec")
        }

        private const val BATCH_SIZE = 32
    }

    // ── TurboModule: ping ────────────────────────────────────────────────────

    override fun ping(): String = "pong"

    // ── Frame metrics (Choreographer, batched) ───────────────────────────────

    private val mainHandler = Handler(Looper.getMainLooper())
    private var choreographerCallback: Choreographer.FrameCallback? = null
    private var lastFrameTimeNanos: Long = 0

    // Pre-allocated batch buffer — no allocation in the hot Choreographer path.
    private val frameBatch   = DoubleArray(BATCH_SIZE)
    private var frameBatchSz = 0

    fun startFrameTimer() {
        mainHandler.post {
            stopFrameTimerImpl()
            lastFrameTimeNanos = 0
            frameBatchSz = 0

            val callback = object : Choreographer.FrameCallback {
                override fun doFrame(frameTimeNanos: Long) {
                    if (lastFrameTimeNanos > 0) {
                        frameBatch[frameBatchSz++] =
                            (frameTimeNanos - lastFrameTimeNanos) / 1_000_000.0

                        // Flush batch once it is full — single JNI call per 32 frames
                        // (~533 ms at 60 fps → ~2 JNI calls/second instead of 60).
                        if (frameBatchSz == BATCH_SIZE) {
                            nativeRecordFrameBatch(frameBatch, BATCH_SIZE)
                            frameBatchSz = 0
                        }
                    }
                    lastFrameTimeNanos = frameTimeNanos
                    Choreographer.getInstance().postFrameCallback(this)
                }
            }
            choreographerCallback = callback
            Choreographer.getInstance().postFrameCallback(callback)
        }
    }

    fun stopFrameTimer() {
        mainHandler.post { stopFrameTimerImpl() }
    }

    private fun stopFrameTimerImpl() {
        choreographerCallback?.let { Choreographer.getInstance().removeFrameCallback(it) }
        choreographerCallback = null

        // Flush any remaining partial batch so no frames are lost.
        if (frameBatchSz > 0) {
            nativeRecordFrameBatch(frameBatch, frameBatchSz)
            frameBatchSz = 0
        }
    }

    // ── Memory ───────────────────────────────────────────────────────────────

    fun getAvailableMemory(): Long {
        val am = reactApplicationContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: return -1
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.availMem
    }

    // ── Memory pressure ──────────────────────────────────────────────────────

    override fun onTrimMemory(level: Int) {
        // TODO: forward to C++ via JNI
    }

    override fun onConfigurationChanged(newConfig: Configuration) {}

    override fun onLowMemory() = onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)

    // ── Lifecycle ────────────────────────────────────────────────────────────

    override fun initialize() {
        super.initialize()
        reactApplicationContext.registerComponentCallbacks(this)
        // Must run on the JS thread — javaScriptContextHolder.get() is only a
        // valid jsi::Runtime* when accessed from the JS queue thread. Calling it
        // from mqt_v_native (where initialize() may arrive in bridgeless New Arch)
        // produces a bad pointer whose vtable slot 0 reads as 0x0 → SIGSEGV.
        reactApplicationContext.runOnJSQueueThread {
            val holder = reactApplicationContext.javaScriptContextHolder
            if (holder != null && holder.get() != 0L) {
                nativeInstall(holder.get())
            }
        }
    }

    private external fun nativeInstall(runtimePtr: Long)

    /**
     * Batch variant — receives [count] frame durations from [batch] in a single
     * JNI call. The C++ side feeds each duration into MetricCollector.recordFrame().
     * [batch] may be larger than [count]; only indices [0, count) are valid.
     */
    private external fun nativeRecordFrameBatch(batch: DoubleArray, count: Int)

    override fun invalidate() {
        stopFrameTimer()
        reactApplicationContext.unregisterComponentCallbacks(this)
        super.invalidate()
    }
}
