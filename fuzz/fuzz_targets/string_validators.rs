#![no_main]
//! Small text parsers fed by other devices, a browser or a QR scan.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libfuzzer_sys::fuzz_target;
use polyth_link_core::http_io::{percent_decode_path, resolve_static_path};
use polyth_link_core::local_proxy::{
    bootstrap_redirect_target, host_allowed, origin_allowed, proxy_session_from_cookie_header,
    requires_proxy_session, validate_redirect_target,
};
use polyth_link_core::limits::Limits;
use polyth_link_core::protocol::{validate_http_method, validate_http_path};
use polyth_link_core::qr::{pack_qr_modules, ticket_qr_modules};
use polyth_link_core::timefmt::parse_rfc3339_to_unix_ms;
use polyth_link_core::ws_local::validate_ws_protocols;
use polyth_link_core::{clean_label, normalize_code};

/// A throwaway web root with an index page, made once per process.
fn static_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("polyth-fuzz-root-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), "<!doctype html>").unwrap();
        root
    })
}

fuzz_target!(|text: &str| {
    let _ = validate_http_method(text);
    let _ = validate_http_path(text);
    let _ = parse_rfc3339_to_unix_ms(text);
    let _ = percent_decode_path(text);
    let _ = host_allowed(text, 8080);
    let _ = origin_allowed(text, 8080);
    let _ = proxy_session_from_cookie_header(text, 8080);
    let _ = requires_proxy_session("GET", text);
    let _ = bootstrap_redirect_target(Some(text));
    let protocols: Vec<String> = text.split(',').map(str::to_string).collect();
    let _ = validate_ws_protocols(&protocols);

    // A redirect target the validator accepts stays on this origin.
    if let Ok(target) = validate_redirect_target(text) {
        assert!(target.starts_with('/') && !target.starts_with("//"));
        assert!(!target.contains('\\') && !target.contains("://"));
    }

    // An accepted code is exactly six ASCII digits.
    if let Ok(code) = normalize_code(text) {
        assert!(code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()));
    }

    // A cleaned label is one printable line within the limit, and cleaning is stable.
    if let Some(label) = clean_label(text) {
        assert!(!label.chars().any(char::is_control));
        assert!(label.chars().count() <= Limits::v1().label_chars);
        assert_eq!(clean_label(&label).as_deref(), Some(label.as_str()));
    }

    // A static path never resolves outside the root.
    let root = static_root();
    if let Ok(path) = resolve_static_path(root, text) {
        assert!(path.starts_with(root.canonicalize().unwrap()));
    }

    if text.len() <= 512 {
        if let Ok(modules) = ticket_qr_modules(text) {
            let (size, packed) = pack_qr_modules(&modules);
            assert_eq!(size, modules.len());
            assert!(!packed.is_empty());
        }
    }
});
