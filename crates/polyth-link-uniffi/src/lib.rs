//! Stable native ABI over the shared `polyth-link-client` state machine.
//!
//! Protocol, pairing, reconnect, and proxy behavior stay in Rust. Platform
//! adapters own only OS secure storage and Capacitor plumbing. Device secrets
//! cross this ABI only as native memory and are never serialized in results.

use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};
use std::path::PathBuf;
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use polyth_link_client::{generate_identity_secret, identity_endpoint_id, NativeClient};
use polyth_link_core::{parse_pairing_ticket, LinkError};
use serde_json::{json, Value};
use tokio::runtime::Runtime;
use zeroize::Zeroize;

const ABI_VERSION: u32 = 1;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static CLIENTS: OnceLock<Mutex<HashMap<u64, Arc<NativeClient>>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| Runtime::new().expect("Polyth Link Tokio runtime"))
}

fn clients() -> &'static Mutex<HashMap<u64, Arc<NativeClient>>> {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn c_string(value: String) -> *mut c_char {
    CString::new(value)
        .map(CString::into_raw)
        .unwrap_or(ptr::null_mut())
}

fn response(result: Result<Value, String>) -> *mut c_char {
    let value = match result {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    c_string(value.to_string())
}

unsafe fn required_string<'a>(ptr: *const c_char) -> Result<&'a str, String> {
    if ptr.is_null() {
        return Err(LinkError::PairingInvalid.code().to_string());
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map_err(|_| LinkError::PairingInvalid.code().to_string())
}

unsafe fn optional_path(ptr: *const c_char) -> Result<Option<PathBuf>, String> {
    if ptr.is_null() {
        return Ok(None);
    }
    let value = CStr::from_ptr(ptr)
        .to_str()
        .map_err(|_| LinkError::PairingInvalid.code().to_string())?;
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(value)))
    }
}

fn client(handle: u64) -> Result<Arc<NativeClient>, String> {
    clients()
        .lock()
        .map_err(|_| LinkError::TransportUnavailable.code().to_string())?
        .get(&handle)
        .cloned()
        .ok_or_else(|| LinkError::DeviceUnknown.code().to_string())
}

#[no_mangle]
pub extern "C" fn polyth_link_abi_version() -> u32 {
    ABI_VERSION
}

/// Create one independent native client registry entry.
///
/// `data_dir` is required and must be an app-private directory. `web_dist` may
/// be null; when present it must point at packaged trusted web assets.
#[no_mangle]
pub unsafe extern "C" fn polyth_link_client_new(
    data_dir: *const c_char,
    web_dist: *const c_char,
) -> u64 {
    let result = std::panic::catch_unwind(|| {
        let data_dir = PathBuf::from(required_string(data_dir)?);
        let web_dist = optional_path(web_dist)?;
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        if handle == 0 {
            return Err(LinkError::TransportUnavailable.code().to_string());
        }
        clients()
            .lock()
            .map_err(|_| LinkError::TransportUnavailable.code().to_string())?
            .insert(handle, Arc::new(NativeClient::new(data_dir, web_dist)));
        Ok(handle)
    });
    match result {
        Ok(Ok(handle)) => handle,
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn polyth_link_client_free(handle: u64) {
    if let Ok(mut clients) = clients().lock() {
        clients.remove(&handle);
    }
}

/// Invoke a high-level client method synchronously from native code.
///
/// `params_json` must be a JSON object. `identity_secret` is optional and only
/// accepted by the shared client for pairing.begin/connect. The returned JSON
/// envelope contains either `{ok:true,result:...}` or `{ok:false,error:"..."}`.
#[no_mangle]
pub unsafe extern "C" fn polyth_link_invoke(
    handle: u64,
    method: *const c_char,
    params_json: *const c_char,
    identity_secret: *const u8,
    identity_secret_len: usize,
) -> *mut c_char {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let method = required_string(method)?;
        let params_raw = required_string(params_json)?;
        let params: Value = serde_json::from_str(params_raw)
            .map_err(|_| LinkError::PairingInvalid.code().to_string())?;
        if !params.is_object() {
            return Err(LinkError::PairingInvalid.code().to_string());
        }
        let secret = if identity_secret_len == 0 {
            None
        } else {
            if identity_secret.is_null() || identity_secret_len != 32 {
                return Err(LinkError::PairingStorageFailed.code().to_string());
            }
            Some(slice::from_raw_parts(identity_secret, identity_secret_len))
        };
        let client = client(handle)?;
        runtime().block_on(client.invoke(method, params, secret))
    }));
    match result {
        Ok(result) => response(result),
        Err(_) => response(Err(LinkError::TransportProtocolError.code().to_string())),
    }
}

/// Fill `out` with a fresh 32-byte device identity secret.
/// Returns the number of bytes written or zero on failure.
#[no_mangle]
pub unsafe extern "C" fn polyth_link_generate_identity_secret(
    out: *mut u8,
    out_len: usize,
) -> usize {
    if out.is_null() || out_len < 32 {
        return 0;
    }
    let result = std::panic::catch_unwind(|| {
        let mut secret = generate_identity_secret();
        if secret.len() != 32 {
            secret.zeroize();
            return 0;
        }
        ptr::copy_nonoverlapping(secret.as_ptr(), out, 32);
        secret.zeroize();
        32
    });
    result.unwrap_or(0)
}

/// Return the public device endpoint ID derived from a 32-byte native secret.
#[no_mangle]
pub unsafe extern "C" fn polyth_link_identity_endpoint_id(
    secret: *const u8,
    secret_len: usize,
) -> *mut c_char {
    if secret.is_null() || secret_len != 32 {
        return ptr::null_mut();
    }
    let secret = slice::from_raw_parts(secret, secret_len);
    match identity_endpoint_id(secret) {
        Ok(endpoint) => c_string(endpoint),
        Err(_) => ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn polyth_link_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

pub fn parse_ticket(raw: String) -> Result<String, String> {
    let ticket = parse_pairing_ticket(&raw).map_err(|error| error.code().to_string())?;
    Ok(ticket.host.endpoint_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn abi_identity_generation_stays_binary() {
        let mut bytes = [0u8; 32];
        let written = unsafe { polyth_link_generate_identity_secret(bytes.as_mut_ptr(), bytes.len()) };
        assert_eq!(written, 32);
        let endpoint = unsafe {
            polyth_link_identity_endpoint_id(bytes.as_ptr(), bytes.len())
        };
        assert!(!endpoint.is_null());
        unsafe { polyth_link_string_free(endpoint) };
        bytes.zeroize();
    }

    #[test]
    fn independent_clients_get_independent_handles() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let first_path = CString::new(first.path().to_str().unwrap()).unwrap();
        let second_path = CString::new(second.path().to_str().unwrap()).unwrap();
        let first_handle = unsafe {
            polyth_link_client_new(first_path.as_ptr(), ptr::null())
        };
        let second_handle = unsafe {
            polyth_link_client_new(second_path.as_ptr(), ptr::null())
        };
        assert_ne!(first_handle, 0);
        assert_ne!(second_handle, 0);
        assert_ne!(first_handle, second_handle);
        polyth_link_client_free(first_handle);
        polyth_link_client_free(second_handle);
    }
}
