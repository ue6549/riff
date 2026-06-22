cmake_minimum_required(VERSION 3.13)
set(CMAKE_VERBOSE_MAKEFILE ON)

set(LIB_LITERAL RiffSpec)
set(LIB_TARGET_NAME react_codegen_${LIB_LITERAL})

set(LIB_ANDROID_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../..)
set(LIB_CPP_DIR ${LIB_ANDROID_DIR}/../cpp)
set(LIB_ANDROID_GENERATED_JNI_DIR ${LIB_ANDROID_DIR}/build/generated/source/codegen/jni)
set(LIB_ANDROID_GENERATED_COMPONENTS_DIR ${LIB_ANDROID_GENERATED_JNI_DIR}/react/renderer/components/${LIB_LITERAL})

# Riff's own C++ sources (shared with iOS)
set(RIFF_CPP_SOURCES
  ${LIB_CPP_DIR}/CollectionViewModule.cpp
  ${LIB_CPP_DIR}/CollectionViewContainerShadowNode.cpp
  ${LIB_CPP_DIR}/CollectionSubContainerShadowNode.cpp
  ${LIB_CPP_DIR}/LayoutCache.cpp
  ${LIB_CPP_DIR}/DiffEngine.cpp
  ${LIB_CPP_DIR}/SpatialIndex.cpp
  ${LIB_CPP_DIR}/layouts/ListLayout.cpp
  ${LIB_CPP_DIR}/layouts/GridLayout.cpp
  ${LIB_CPP_DIR}/layouts/MasonryLayout.cpp
  ${LIB_CPP_DIR}/layouts/FlowLayout.cpp
  ${LIB_CPP_DIR}/layouts/CompositionalLayout.cpp
  ${LIB_CPP_DIR}/CollectionViewContainerState.cpp
  ${LIB_CPP_DIR}/CollectionSubContainerState.cpp
)

# Codegen-generated C++ sources — include selectively.
# We EXCLUDE ShadowNodes.cpp, ComponentDescriptors.cpp, and States.cpp because
# our custom ShadowNodes define the same extern symbols (component name constants)
# and our custom State types (CollectionViewContainerState, CollectionSubContainerState)
# replace the codegen's generic StateData aliases. We provide our own registration
# in RiffComponentRegistration.cpp.
# ShadowNodes.cpp from codegen defines component name constants AND the codegen
# ShadowNode types. We keep it for the name constants but our shim ShadowNodes.h
# overrides the type aliases to use our custom ShadowNodes.
set(LIB_CODEGEN_SRCS
  ${LIB_ANDROID_GENERATED_JNI_DIR}/RiffSpec-generated.cpp
  ${LIB_ANDROID_GENERATED_COMPONENTS_DIR}/ShadowNodes.cpp
  ${LIB_ANDROID_GENERATED_COMPONENTS_DIR}/EventEmitters.cpp
  ${LIB_ANDROID_GENERATED_COMPONENTS_DIR}/Props.cpp
)

# Our custom JNI bridge and component registration
set(RIFF_JNI_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/RiffComponentRegistration.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/RiffModuleJNI.cpp
)

add_library(
  ${LIB_TARGET_NAME}
  SHARED
  ${RIFF_CPP_SOURCES}
  ${LIB_CODEGEN_SRCS}
  ${RIFF_JNI_SOURCES}
)

# Our shim headers (ShadowNodes.h, ComponentDescriptors.h) must come BEFORE
# the codegen-generated headers so that #include <react/renderer/components/RiffSpec/...>
# finds our versions first. This makes autolinking_registerProviders use our
# custom ShadowNodes with layout() overrides and rich state types.
target_include_directories(
  ${LIB_TARGET_NAME}
  PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${LIB_CPP_DIR}
  ${LIB_CPP_DIR}/layouts
  ${LIB_ANDROID_GENERATED_JNI_DIR}
  ${LIB_ANDROID_GENERATED_COMPONENTS_DIR}
)

target_link_libraries(
  ${LIB_TARGET_NAME}
  fbjni
  jsi
  reactnative
  android
  log
)

target_compile_reactnative_options(${LIB_TARGET_NAME} PRIVATE)

# Suppress warnings that become errors in the app's strict build:
# - Geometry.h is deprecated in RN 0.85 but our shared headers still include it (iOS is fine)
# - Unused variables exist in some ShadowNode paths
# Required for CollectionViewContainerState::getDynamic() and
# CollectionSubContainerState::getDynamic() to be compiled.
# Without this, state serialization is compiled out and the
# Android ViewManager's updateState() receives empty state data.
target_compile_definitions(${LIB_TARGET_NAME} PRIVATE RN_SERIALIZABLE_STATE)

target_compile_options(
  ${LIB_TARGET_NAME}
  PRIVATE
  -Wno-unused-variable
  -Wno-unused-but-set-variable
  -Wno-unused-function
  -Wno-unused-private-field
  -Wno-\#warnings
)
