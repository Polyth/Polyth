fn main() {
    // Cargo/rustc emit no SONAME for a cdylib. Android's dynamic linker can
    // only resolve a dependency by a SONAME it finds in the app's native
    // library directory, so a CMake link against the absolute jniLibs path
    // records that build-host path in DT_NEEDED and
    // System.loadLibrary("polyth_link_jni") fails on-device. Stamp the stable
    // SONAME so the packaged libpolyth_link_uniffi.so stays loadable.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-soname,libpolyth_link_uniffi.so");
    }
}
