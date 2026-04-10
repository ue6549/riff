cmake_minimum_required(VERSION 3.16)
project(RNCVTests CXX)

set(CMAKE_CXX_STANDARD 17)

# ── Google Test ───────────────────────────────────────────────────────────────
include(FetchContent)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/archive/v1.14.0.zip
  DOWNLOAD_EXTRACT_TIMESTAMP ON
)
# Prevent overriding the parent project's compiler/linker settings on Windows
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

# ── Source files under test ───────────────────────────────────────────────────
set(RNCV_SRC
  ${CMAKE_CURRENT_SOURCE_DIR}/../LayoutCache.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../SpatialIndex.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../layouts/ListLayout.cpp
)

# ── Test executable ───────────────────────────────────────────────────────────
add_executable(rncv_tests
  ListLayoutTest.cpp
  MVCCorrectionTest.cpp
  ${RNCV_SRC}
)

target_include_directories(rncv_tests PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/..           # cpp/ — for LayoutCache.h, Geometry.h, etc.
  ${CMAKE_CURRENT_SOURCE_DIR}/stubs        # provides jsi/jsi.h stub
)

# Suppress RNCV debug logging in tests
target_compile_definitions(rncv_tests PRIVATE
  RNCV_ENABLE_NATIVE_LOGS=0
  RNCV_ENABLE_MVC_TRACE=0
)

target_link_libraries(rncv_tests gtest gtest_main)
include(GoogleTest)
gtest_discover_tests(rncv_tests)

# ── How to build and run ──────────────────────────────────────────────────────
# From this directory:
#   mkdir build && cd build
#   cmake .. && cmake --build .
#   ./rncv_tests        # or: ctest --output-on-failure
#
# Note: No 'pod install' needed — tests use only pure C++ code.
# The JSI stub in stubs/jsi/jsi.h satisfies the compiler without linking JSI.
