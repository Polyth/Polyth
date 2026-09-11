cmake_minimum_required(VERSION 3.22.1)
project(polyth_link_jni LANGUAGES CXX)

add_library(polyth_link_uniffi SHARED IMPORTED)
set_target_properties(polyth_link_uniffi PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/../jniLibs/${ANDROID_ABI}/libpolyth_link_uniffi.so"
)

add_library(polyth_link_jni SHARED polyth_link_jni.cpp)
target_compile_features(polyth_link_jni PRIVATE cxx_std_17)
target_link_libraries(polyth_link_jni PRIVATE polyth_link_uniffi log)
