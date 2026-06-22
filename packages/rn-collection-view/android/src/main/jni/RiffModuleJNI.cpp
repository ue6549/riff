/**
 * RiffModuleJNI.cpp — JNI bridge for RiffModule.nativeInstall().
 *
 * Installs a CollectionViewModule C++ HostObject as global.__riffNativeMod on
 * the JSI runtime. JS then accesses this global instead of the JavaTurboModule,
 * getting the full JSI binding surface (createLayoutCache, layoutCacheById, etc.).
 *
 * Called from RiffModule.initialize() in Kotlin, which runs synchronously during
 * TurboModuleRegistry.getEnforcing('RiffModule') — so the global is set before
 * NativeCollectionViewModule.ts finishes evaluating.
 */

#include "CollectionViewModule.h"
#include "LayoutCacheRegistry.h"
#include <jsi/jsi.h>
#include <jni.h>
#include <mutex>
#include <unordered_map>
#include <memory>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <unistd.h>
#include <android/log.h>

#define RIFF_TAG "RIFF_SCROLL"
#define RIFF_LOGI(...) __android_log_print(ANDROID_LOG_INFO, RIFF_TAG, __VA_ARGS__)
#define RIFF_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, RIFF_TAG, __VA_ARGS__)

using namespace facebook;

// ── JavaVM reference ─────────────────────────────────────────────────────────
// Captured once in JNI_OnLoad; used by the scroll handler to switch threads.

static JavaVM* gJavaVM = nullptr;

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
  gJavaVM = vm;
  RIFF_LOGI("JNI_OnLoad — gJavaVM captured");
  return JNI_VERSION_1_6;
}

// ── Scroll handler registry ───────────────────────────────────────────────────
// Each RNCollectionViewContainerView registers itself here so that C++
// invokeScrollHandler (called from the JS thread via nativeMod.scrollTo) can
// bounce back to Kotlin on the main thread.

struct JScrollEntry {
  jobject viewRef;   // GlobalRef to RNCollectionViewContainerView
  jmethodID mid;     // scrollToFromNative(float x, float y, boolean animated)
};

static std::mutex                            gScrollMutex;
static std::unordered_map<int32_t, JScrollEntry> gScrollEntries;

// ── C++ module reference (for nativeRecordFrame) ──────────────────────────────

static std::weak_ptr<facebook::react::CollectionViewModule> gCppModule;

// ── RiffModule JNI handles (set in nativeInstall, used for metrics/memory) ────

static jobject    gRiffModuleRef    = nullptr;  // GlobalRef to RiffModule
static jmethodID  gStartTimerMid   = nullptr;
static jmethodID  gStopTimerMid    = nullptr;
static jmethodID  gGetMemoryMid    = nullptr;

// ── CPU reading (/proc/self/stat) ─────────────────────────────────────────────
// Reads process-wide CPU utilisation between successive calls (delta-based).

static double readProcessCpuPct() {
  static long     sPrevTicks = -1;
  static int64_t  sPrevWallNs = -1;

  char buf[512];
  FILE* f = fopen("/proc/self/stat", "r");
  if (!f) return -1.0;
  bool ok = (fgets(buf, (int)sizeof(buf), f) != nullptr);
  fclose(f);
  if (!ok) return -1.0;

  // Locate the end of the 'comm' field (enclosed in parentheses, may contain spaces).
  char* p = strrchr(buf, ')');
  if (!p) return -1.0;
  p += 2;  // skip ') '

  // After comm: state(3) ppid(4) pgrp(5) session(6) tty_nr(7) tpgid(8) flags(9)
  //             minflt(10) cminflt(11) majflt(12) cmajflt(13) utime(14) stime(15)
  unsigned long utime = 0, stime = 0;
  int n = sscanf(p,
    " %*c"   // state
    " %*d"   // ppid
    " %*d"   // pgrp
    " %*d"   // session
    " %*d"   // tty_nr
    " %*d"   // tpgid
    " %*u"   // flags
    " %*lu"  // minflt
    " %*lu"  // cminflt
    " %*lu"  // majflt
    " %*lu"  // cmajflt
    " %lu"   // utime (field 14)
    " %lu",  // stime (field 15)
    &utime, &stime);
  if (n != 2) return -1.0;

  long curTicks  = (long)(utime + stime);
  int64_t curNs  = (int64_t)std::chrono::steady_clock::now().time_since_epoch().count();

  if (sPrevTicks < 0) {
    sPrevTicks  = curTicks;
    sPrevWallNs = curNs;
    return -1.0;
  }

  long    deltaTicks = curTicks - sPrevTicks;
  double  deltaWallS = (curNs - sPrevWallNs) / 1e9;
  sPrevTicks  = curTicks;
  sPrevWallNs = curNs;

  if (deltaWallS <= 0.0) return -1.0;

  long clkTck = sysconf(_SC_CLK_TCK);
  double cpuPct = ((double)deltaTicks / clkTck) / deltaWallS * 100.0;
  return cpuPct < 0.0 ? 0.0 : cpuPct > 100.0 ? 100.0 : cpuPct;
}

// ── nativeSetScrollOffset (@CriticalNative, static) ──────────────────────────
// @JvmStatic generates a static method on the outer class, so ART looks for
// the normal symbol name (no $Companion mangling).
// @CriticalNative changes the calling convention: no JNIEnv, no jclass —
// just the primitive arguments. Must not call JNI or allocate JNI handles.
// timestampNs is SystemClock.elapsedRealtimeNanos(); divide by 1e6 → ms to
// match the iOS CACurrentMediaTime * 1000 units used for velocity derivation.

extern "C" JNIEXPORT void JNICALL
Java_com_riff_RNCollectionViewContainerView_nativeSetScrollOffset(
    jint cacheId, jfloat scrollX, jfloat scrollY, jlong timestampNs) {
  auto cache = facebook::react::layoutCacheForId(static_cast<int32_t>(cacheId));
  if (cache) {
    cache->setScrollOffset(
        static_cast<double>(scrollX),
        static_cast<double>(scrollY),
        static_cast<double>(timestampNs) / 1e6);
  }
}

// ── nativeRegisterScrollHandler ───────────────────────────────────────────────
// Called from Kotlin when layoutCacheId is assigned. Stores a GlobalRef to the
// view and registers a C++ lambda that calls scrollToFromNative() via JNI.

extern "C" JNIEXPORT void JNICALL
Java_com_riff_RNCollectionViewContainerView_nativeRegisterScrollHandler(
    JNIEnv* env, jobject thiz, jint cacheId) {

  RIFF_LOGI("nativeRegisterScrollHandler — cacheId=%d", (int)cacheId);

  jclass cls = env->GetObjectClass(thiz);
  jmethodID mid = env->GetMethodID(cls, "scrollToFromNative", "(FFZ)V");
  env->DeleteLocalRef(cls);
  if (!mid) {
    RIFF_LOGE("nativeRegisterScrollHandler — GetMethodID failed for scrollToFromNative(FFZ)V");
    return;
  }
  RIFF_LOGI("nativeRegisterScrollHandler — mid obtained, creating GlobalRef");

  jobject globalRef = env->NewGlobalRef(thiz);

  {
    std::lock_guard<std::mutex> lock(gScrollMutex);
    // Release any previous entry for this cacheId.
    auto it = gScrollEntries.find(static_cast<int32_t>(cacheId));
    if (it != gScrollEntries.end()) {
      JNIEnv* e = nullptr;
      if (gJavaVM && gJavaVM->GetEnv((void**)&e, JNI_VERSION_1_6) == JNI_OK) {
        e->DeleteGlobalRef(it->second.viewRef);
      }
      gScrollEntries.erase(it);
    }
    gScrollEntries[static_cast<int32_t>(cacheId)] = { globalRef, mid };
  }

  facebook::react::registerScrollHandler(
      static_cast<int32_t>(cacheId),
      [cacheId](double x, double y, bool animated) {
        RIFF_LOGI("scrollHandler invoked — cacheId=%d x=%.1f y=%.1f animated=%d",
                  cacheId, x, y, (int)animated);
        if (!gJavaVM) { RIFF_LOGE("scrollHandler — gJavaVM is null!"); return; }

        JScrollEntry entry;
        {
          std::lock_guard<std::mutex> lock(gScrollMutex);
          auto it = gScrollEntries.find(cacheId);
          if (it == gScrollEntries.end()) return;
          entry = it->second;
        }

        JNIEnv* e = nullptr;
        bool attached = false;
        int status = gJavaVM->GetEnv((void**)&e, JNI_VERSION_1_6);
        if (status == JNI_EDETACHED) {
          gJavaVM->AttachCurrentThread(&e, nullptr);
          attached = true;
        } else if (status != JNI_OK) {
          RIFF_LOGE("scrollHandler — GetEnv failed status=%d", status);
          return;
        }

        RIFF_LOGI("scrollHandler — calling scrollToFromNative on view");
        e->CallVoidMethod(
            entry.viewRef, entry.mid,
            static_cast<jfloat>(x),
            static_cast<jfloat>(y),
            static_cast<jboolean>(animated ? JNI_TRUE : JNI_FALSE));

        if (attached) gJavaVM->DetachCurrentThread();
      });
}

// ── nativeUnregisterScrollHandler ────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_riff_RNCollectionViewContainerView_nativeUnregisterScrollHandler(
    JNIEnv* env, jobject /*thiz*/, jint cacheId) {

  facebook::react::unregisterScrollHandler(static_cast<int32_t>(cacheId));

  std::lock_guard<std::mutex> lock(gScrollMutex);
  auto it = gScrollEntries.find(static_cast<int32_t>(cacheId));
  if (it != gScrollEntries.end()) {
    env->DeleteGlobalRef(it->second.viewRef);
    gScrollEntries.erase(it);
  }
}

// ── nativeGetZIndexes ─────────────────────────────────────────────────────────
// Bulk-reads zIndex for a set of LayoutCache keys in a single mutex acquisition.
// Called by applyPositionsFromState when layoutWritesVisualAttributes is true so
// decoration views (negative zIndex) can be drawn behind regular cells.
// Returns a jfloatArray of length keys.length; 0.0f for any cache miss.

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_riff_RNCollectionViewContainerView_nativeGetZIndexes(
    JNIEnv* env, jobject /*thiz*/, jint cacheId, jobjectArray keys) {

  jint count = env->GetArrayLength(keys);
  jfloatArray result = env->NewFloatArray(count);
  if (!result || count == 0) return result;

  auto cache = facebook::react::layoutCacheForId(static_cast<int32_t>(cacheId));
  if (!cache) return result;  // all zeros

  // Convert Kotlin String[] → std::vector<std::string> for the bulk read.
  std::vector<std::string> keyVec(static_cast<size_t>(count));
  for (jint i = 0; i < count; ++i) {
    auto jstr = static_cast<jstring>(env->GetObjectArrayElement(keys, i));
    if (jstr) {
      const char* chars = env->GetStringUTFChars(jstr, nullptr);
      if (chars) {
        keyVec[i] = chars;
        env->ReleaseStringUTFChars(jstr, chars);
      }
      env->DeleteLocalRef(jstr);
    }
  }

  // Single mutex acquisition for all keys.
  auto bulk = cache->getAttributesForKeys(keyVec);

  std::vector<jfloat> zVals(static_cast<size_t>(count), 0.0f);
  for (jint i = 0; i < count; ++i) {
    if (static_cast<size_t>(i) < bulk.found.size() && bulk.found[i]) {
      zVals[i] = static_cast<jfloat>(bulk.attrs[i].zIndex);
    }
  }
  env->SetFloatArrayRegion(result, 0, count, zVals.data());
  return result;
}

// ── nativeGetVisualAttrs ──────────────────────────────────────────────────────
// Bulk-reads zIndex AND opacity for a set of LayoutCache keys in one mutex lock.
// Returns a flat jfloatArray of length keys.length * 2:
//   [zIndex0, alpha0, zIndex1, alpha1, ...]
// 0.0f zIndex and 1.0f alpha for any cache miss.

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_riff_RNCollectionViewContainerView_nativeGetVisualAttrs(
    JNIEnv* env, jobject /*thiz*/, jint cacheId, jobjectArray keys) {

  jint count = env->GetArrayLength(keys);
  // 2 floats per key: [zIndex, alpha, ...]
  jfloatArray result = env->NewFloatArray(count * 2);
  if (!result || count == 0) return result;

  // Default: zIndex=0, alpha=1
  std::vector<jfloat> vals(static_cast<size_t>(count * 2));
  for (jint i = 0; i < count; ++i) {
    vals[i * 2 + 0] = 0.0f;  // zIndex
    vals[i * 2 + 1] = 1.0f;  // alpha
  }

  auto cache = facebook::react::layoutCacheForId(static_cast<int32_t>(cacheId));
  if (cache) {
    std::vector<std::string> keyVec(static_cast<size_t>(count));
    for (jint i = 0; i < count; ++i) {
      auto jstr = static_cast<jstring>(env->GetObjectArrayElement(keys, i));
      if (jstr) {
        const char* chars = env->GetStringUTFChars(jstr, nullptr);
        if (chars) { keyVec[i] = chars; env->ReleaseStringUTFChars(jstr, chars); }
        env->DeleteLocalRef(jstr);
      }
    }

    auto bulk = cache->getAttributesForKeys(keyVec);
    for (jint i = 0; i < count; ++i) {
      if (static_cast<size_t>(i) < bulk.found.size() && bulk.found[i]) {
        vals[i * 2 + 0] = static_cast<jfloat>(bulk.attrs[i].zIndex);
        vals[i * 2 + 1] = static_cast<jfloat>(bulk.attrs[i].alpha);
      }
    }
  }

  env->SetFloatArrayRegion(result, 0, count * 2, vals.data());
  return result;
}

// ── nativeComputeCorrection ───────────────────────────────────────────────────
// Reads MVC correction delta from LayoutCache (called from updateState on
// the UI thread). Returns 0.0 when no correction is needed.

extern "C" JNIEXPORT jdouble JNICALL
Java_com_riff_RNCollectionViewContainerView_nativeComputeCorrection(
    JNIEnv* /*env*/, jobject /*thiz*/, jint cacheId) {
  auto cache = facebook::react::layoutCacheForId(static_cast<int32_t>(cacheId));
  if (!cache) return 0.0;
  return static_cast<jdouble>(cache->computeCorrection());
}

// ── nativeConsumePendingScrollTarget ─────────────────────────────────────────
// Returns the absolute scroll target computed by computeCorrection() and
// clears it from LayoutCache. Must be called immediately after nativeComputeCorrection.

extern "C" JNIEXPORT jdouble JNICALL
Java_com_riff_RNCollectionViewContainerView_nativeConsumePendingScrollTarget(
    JNIEnv* /*env*/, jobject /*thiz*/, jint cacheId) {
  auto cache = facebook::react::layoutCacheForId(static_cast<int32_t>(cacheId));
  if (!cache) return 0.0;
  return static_cast<jdouble>(cache->consumePendingScrollTarget());
}

// ── nativeRecordFrameBatch ────────────────────────────────────────────────────
// Receives a batch of frame durations from RiffModule's pre-allocated DoubleArray.
// Replaces per-frame nativeRecordFrame() calls — reduces JNI call rate from
// ~60/s to ~2/s (32 frames per batch at 60 fps).

extern "C" JNIEXPORT void JNICALL
Java_com_riff_RiffModule_nativeRecordFrameBatch(
    JNIEnv* env, jobject /*thiz*/, jdoubleArray batch, jint count) {
  auto mod = gCppModule.lock();
  if (!mod) return;
  jdouble* data = env->GetDoubleArrayElements(batch, nullptr);
  if (!data) return;
  for (jint i = 0; i < count; ++i) {
    mod->recordFrame(data[i]);
  }
  env->ReleaseDoubleArrayElements(batch, data, JNI_ABORT);
}

// ── nativeInstall ─────────────────────────────────────────────────────────────

extern "C" JNIEXPORT void JNICALL
Java_com_riff_RiffModule_nativeInstall(JNIEnv *env, jobject thiz, jlong runtimePtr) {
  if (runtimePtr == 0) return;
  auto &rt = *reinterpret_cast<jsi::Runtime *>(runtimePtr);

  // Create a CollectionViewModule C++ HostObject.
  // jsInvoker is null here — it's only needed for memory pressure callbacks
  // (metrics/memory features). Core layout operations (createLayoutCache,
  // layoutCacheById, listLayout, etc.) don't require it.
  auto cppModule = std::make_shared<facebook::react::CollectionViewModule>(nullptr);

  // ── Wire metrics callbacks ───────────────────────────────────────────────
  // startFrameTimer / stopFrameTimer → call back to Kotlin RiffModule which
  // drives Choreographer on the main thread.
  if (gJavaVM) {
    // Cache RiffModule GlobalRef and method IDs once.
    if (!gRiffModuleRef) {
      gRiffModuleRef = env->NewGlobalRef(thiz);
      jclass cls = env->GetObjectClass(thiz);
      gStartTimerMid = env->GetMethodID(cls, "startFrameTimer", "()V");
      gStopTimerMid  = env->GetMethodID(cls, "stopFrameTimer",  "()V");
      gGetMemoryMid  = env->GetMethodID(cls, "getAvailableMemory", "()J");
      env->DeleteLocalRef(cls);
      RIFF_LOGI("nativeInstall — cached RiffModule refs: start=%p stop=%p mem=%p",
                (void*)gStartTimerMid, (void*)gStopTimerMid, (void*)gGetMemoryMid);
    }

    // Frame-timer start/stop callbacks — called from JS thread.
    cppModule->setMetricsCallbacks(
      [](){ // startCb
        if (!gJavaVM || !gRiffModuleRef || !gStartTimerMid) return;
        JNIEnv* e = nullptr;
        bool att = false;
        if (gJavaVM->GetEnv((void**)&e, JNI_VERSION_1_6) == JNI_EDETACHED) {
          gJavaVM->AttachCurrentThread(&e, nullptr); att = true;
        }
        if (e) e->CallVoidMethod(gRiffModuleRef, gStartTimerMid);
        if (att) gJavaVM->DetachCurrentThread();
      },
      [](){ // stopCb
        if (!gJavaVM || !gRiffModuleRef || !gStopTimerMid) return;
        JNIEnv* e = nullptr;
        bool att = false;
        if (gJavaVM->GetEnv((void**)&e, JNI_VERSION_1_6) == JNI_EDETACHED) {
          gJavaVM->AttachCurrentThread(&e, nullptr); att = true;
        }
        if (e) e->CallVoidMethod(gRiffModuleRef, gStopTimerMid);
        if (att) gJavaVM->DetachCurrentThread();
      });

    // Available memory callback — calls Kotlin getAvailableMemory() → long.
    cppModule->setGetAvailableMemoryCallback([]() -> int64_t {
      if (!gJavaVM || !gRiffModuleRef || !gGetMemoryMid) return -1;
      JNIEnv* e = nullptr;
      bool att = false;
      if (gJavaVM->GetEnv((void**)&e, JNI_VERSION_1_6) == JNI_EDETACHED) {
        gJavaVM->AttachCurrentThread(&e, nullptr); att = true;
      }
      jlong result = e ? e->CallLongMethod(gRiffModuleRef, gGetMemoryMid) : -1;
      if (att) gJavaVM->DetachCurrentThread();
      return static_cast<int64_t>(result);
    });
  }

  // CPU callback — reads /proc/self/stat, no JNI required.
  cppModule->setMainThreadCPUCallback([]() -> double {
    return readProcessCpuPct();
  });

  // Store weak ref so nativeRecordFrameBatch can feed batched frame durations in.
  gCppModule = cppModule;

  // Install as global.__riffNativeMod — a JSI HostObject whose get() provides
  // createLayoutCache(), layoutCacheById(), layoutCache, listLayout, etc.
  rt.global().setProperty(
      rt,
      "__riffNativeMod",
      jsi::Object::createFromHostObject(rt, cppModule));
}
