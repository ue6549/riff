cmake_minimum_required(VERSION 3.13)
project(RNCollectionView)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# C++ sources shared across platforms
set(RNCOLLECTIONVIEW_CPP_SOURCES
  cpp/CollectionViewModule.cpp
)

# iOS: sources are compiled via Xcode/CocoaPods (see podspec)
# Android: add_library below
if(ANDROID)
  find_package(ReactAndroid REQUIRED CONFIG)
  find_package(fbjni REQUIRED CONFIG)

  add_library(
    rn_collection_view
    SHARED
    ${RNCOLLECTIONVIEW_CPP_SOURCES}
  )

  target_include_directories(rn_collection_view
    PUBLIC
      ${CMAKE_CURRENT_SOURCE_DIR}/cpp
  )

  target_link_libraries(rn_collection_view
    ReactAndroid::reactnativejni
    fbjni::fbjni
  )
endif()
