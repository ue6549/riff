cmake_minimum_required(VERSION 3.13)
project(Riff)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# C++ sources shared across platforms
set(RIFF_CPP_SOURCES
  cpp/CollectionViewModule.cpp
  cpp/CollectionViewContainerShadowNode.cpp
  cpp/CollectionSubContainerShadowNode.cpp
  cpp/CollectionViewContainerState.cpp
  cpp/CollectionSubContainerState.cpp
  cpp/LayoutCache.cpp
  cpp/DiffEngine.cpp
  cpp/SpatialIndex.cpp
  cpp/layouts/ListLayout.cpp
  cpp/layouts/GridLayout.cpp
  cpp/layouts/MasonryLayout.cpp
  cpp/layouts/FlowLayout.cpp
  cpp/layouts/CompositionalLayout.cpp
)

# iOS: sources are compiled via Xcode/CocoaPods (see podspec)
# Android: add_library below
if(ANDROID)
  find_package(ReactAndroid REQUIRED CONFIG)
  find_package(fbjni REQUIRED CONFIG)

  # Codegen-generated C++ sources (props, event emitters, shadow nodes).
  # The react-native Gradle plugin generates these under the build dir.
  file(GLOB CODEGEN_SRCS
    "${REACT_ANDROID_BUILD_DIR}/generated/source/codegen/jni/*.cpp"
  )

  add_library(
    riff
    SHARED
    ${RIFF_CPP_SOURCES}
    ${CODEGEN_SRCS}
  )

  target_include_directories(riff
    PUBLIC
      ${CMAKE_CURRENT_SOURCE_DIR}/cpp
      ${CMAKE_CURRENT_SOURCE_DIR}/cpp/layouts
  )

  # Codegen-generated headers
  target_include_directories(riff
    PRIVATE
      "${REACT_ANDROID_BUILD_DIR}/generated/source/codegen/jni"
  )

  target_link_libraries(riff
    ReactAndroid::reactnativejni
    ReactAndroid::jsi
    ReactAndroid::react_render_core
    ReactAndroid::react_render_graphics
    ReactAndroid::react_render_componentregistry
    ReactAndroid::yoga
    ReactAndroid::rrc_view
    fbjni::fbjni
  )
endif()
