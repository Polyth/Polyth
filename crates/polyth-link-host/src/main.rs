use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use iroh::Endpoint;
use polyth_link_core::identity::{self, HostIdentity};
use polyth_link_core::pairing::HostPairing;
use polyth_link_core::protocol::DISABLE_0RTT;
use polyth_link_core::qr::ticket_qr_modules;
use polyth_link_core::ticket::POLYTH_LINK_ALPN;
use polyth_link_core::transport::TransportPolicy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::{broadcast, Mutex};

mod conn;

#[derive(Deserialize)]
struct RpcRequest {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct RpcResponse {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

#[derive(Clone)]
pub(crate) struct TrustedDevice {
    pub(crate) device_id: String,
    pub(crate) grants: Vec<String>,
    pub(crate) grant_revision: u32,
    pub(crate) revoked: bool,
}

pub(crate) struct LiveConnection {
    pub(crate) connection_id: String,
    pub(crate) device_id: String,
    pub(crate) endpoint_id: String,
    pub(crate) transport: &'static str,
    pub(crate) connection: iroh::endpoint::Connection,
}

pub(crate) struct HostState {
    pub(crate) identity: HostIdentity,
    pub(crate) pairing: HostPairing,
    pub(crate) policy: TransportPolicy,
    pub(crate) policy_path: PathBuf,
    pub(crate) endpoint: Option<Endpoint>,
    pub(crate) trust: HashMap<String, TrustedDevice>,
    pub(crate) connections: HashMap<String, LiveConnection>,
    pub(crate) ingress_socket: Option<PathBuf>,
    pub(crate) ingress_secret: Option<String>,
    pub(crate) events: broadcast::Sender<Value>,
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "serve".into());
    match cmd.as_str() {
        "serve" => {
            let data_dir = args.next().unwrap_or_else(|| ".".into());
            let socket = args
                .next()
                .unwrap_or_else(|| "/tmp/polyth-link.sock".into());
            if let Err(error) = serve(PathBuf::from(data_dir), PathBuf::from(socket)).await {
                eprintln!("polyth-link-host: {error}");
                std::process::exit(1);
            }
        }
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(2);
        }
    }
}

async fn serve(data_dir: PathBuf, socket: PathBuf) -> Result<(), String> {
    let identity_path = data_dir.join("tunnel").join("identity");
    let identity = identity::load_or_create(&identity_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
    }
    let policy_path = data_dir.join("tunnel").join("policy.json");
    let policy = load_host_policy(&policy_path);
    save_host_policy(&policy_path, policy);
    let (events, _) = broadcast::channel(128);
    let state = Arc::new(Mutex::new(HostState {
        identity,
        pairing: HostPairing::new(),
        policy,
        policy_path,
        endpoint: None,
        trust: HashMap::new(),
        connections: HashMap::new(),
        ingress_socket: None,
        ingress_secret: None,
        events,
    }));
    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            let (reader, mut writer) = stream.into_split();
            let mut lines = BufReader::new(reader).lines();
            let mut events = state.lock().await.events.subscribe();
            loop {
                tokio::select! {
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(line)) => {
                                let response = handle_line(state.clone(), &line).await;
                                if writer.write_all(response.as_bytes()).await.is_err() { break; }
                                if writer.write_all(b"\n").await.is_err() { break; }
                            }
                            _ => break,
                        }
                    }
                    event = events.recv() => {
                        if let Ok(params) = event {
                            let payload = json!({"method":"event","params": params});
                            if writer.write_all(payload.to_string().as_bytes()).await.is_err() { break; }
                            if writer.write_all(b"\n").await.is_err() { break; }
                        }
                    }
                }
            }
        });
    }
}

async fn handle_line(state: Arc<Mutex<HostState>>, line: &str) -> String {
    let request: RpcRequest = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(_) => {
            return serde_json::to_string(&RpcResponse {
                id: 0,
                result: None,
                error: Some(json!({"code": "pairing-invalid"})),
            })
            .unwrap();
        }
    };
    let result = dispatch(state, &request.method, request.params).await;
    let response = match result {
        Ok(value) => RpcResponse {
            id: request.id,
            result: Some(value),
            error: None,
        },
        Err(code) => RpcResponse {
            id: request.id,
            result: None,
            error: Some(json!({"code": code})),
        },
    };
    serde_json::to_string(&response).unwrap()
}

async fn dispatch(
    state: Arc<Mutex<HostState>>,
    method: &str,
    params: Value,
) -> Result<Value, &'static str> {
    match method {
        "identity.status" => {
            let state = state.lock().await;
            Ok(json!({
                "endpointId": state.identity.endpoint_id(),
                "fingerprint": state.identity.fingerprint(),
                "endpointBound": state.endpoint.is_some(),
                "activePolicy": state.policy.as_str(),
                "irohVersion": polyth_link_core::IROH_CRATE_VERSION,
            }))
        }
        "identity.rotate" => {
            let shared = state.clone();
            let (path, policy, live, old_endpoint) = {
                let mut guard = state.lock().await;
                let live: Vec<_> = std::mem::take(&mut guard.connections)
                    .into_values()
                    .collect();
                let old_endpoint = guard.endpoint.take();
                (
                    guard.identity.path().to_path_buf(),
                    guard.policy,
                    live,
                    old_endpoint,
                )
            };
            for connection in live {
                connection.connection.close(0u32.into(), b"rotated");
            }
            if let Some(endpoint) = old_endpoint {
                endpoint.close().await;
            }
            let identity = identity::rotate(&path).map_err(|_| "host-identity-corrupt")?;
            let secret = identity.secret_key();
            let endpoint = polyth_link_core::net::bind_link_endpoint(secret, policy)
                .await
                .map_err(|_| "transport-unavailable")?;
            let accept = endpoint.clone();
            let endpoint_id = identity.endpoint_id();
            let fingerprint = identity.fingerprint();
            {
                let mut guard = state.lock().await;
                guard.identity = identity;
                guard.pairing.invalidate_all();
                for trusted in guard.trust.values_mut() {
                    trusted.revoked = true;
                }
                guard.endpoint = Some(endpoint);
                let _ = guard
                    .events
                    .send(json!({"type": "tunnel/identity-rotated"}));
            }
            tokio::spawn(conn::accept_loop(shared, accept));
            Ok(json!({
                "endpointId": endpoint_id,
                "fingerprint": fingerprint,
                "endpointBound": true,
            }))
        }
        "trust.sync" => {
            let mut state = state.lock().await;
            state.trust.clear();
            if let Some(devices) = params.get("devices").and_then(Value::as_array) {
                for device in devices {
                    let endpoint_id = device
                        .get("endpointId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if endpoint_id.is_empty() {
                        continue;
                    }
                    state.trust.insert(
                        endpoint_id.to_string(),
                        TrustedDevice {
                            device_id: device
                                .get("deviceId")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            grants: device
                                .get("grants")
                                .and_then(Value::as_array)
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_default(),
                            grant_revision: device
                                .get("grantRevision")
                                .and_then(Value::as_u64)
                                .unwrap_or(0) as u32,
                            revoked: device
                                .get("revoked")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        },
                    );
                }
            }
            Ok(json!({ "ok": true, "count": state.trust.len() }))
        }
        "trust.upsert" => {
            let mut state = state.lock().await;
            let endpoint_id = params
                .get("endpointId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or("pairing-invalid")?;
            let device_id = params
                .get("deviceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or("pairing-invalid")?;
            state.trust.insert(
                endpoint_id.to_string(),
                TrustedDevice {
                    device_id: device_id.to_string(),
                    grants: params
                        .get("grants")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default(),
                    grant_revision: params
                        .get("grantRevision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u32,
                    revoked: params
                        .get("revoked")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
            );
            Ok(json!({ "ok": true }))
        }
        "trust.revoke" => {
            let mut state = state.lock().await;
            let device_id = params
                .get("deviceId")
                .and_then(Value::as_str)
                .ok_or("device-unknown")?;
            let mut found = false;
            for trusted in state.trust.values_mut() {
                if trusted.device_id == device_id {
                    trusted.revoked = true;
                    found = true;
                }
            }
            if !found {
                return Err("device-unknown");
            }
            conn::close_device_connections(&mut state, device_id).await;
            let _ = state.events.send(json!({
                "type": "tunnel/device-revoked",
                "deviceId": device_id,
            }));
            Ok(json!({ "ok": true }))
        }
        "trust.restore" => {
            let mut state = state.lock().await;
            let device_id = params
                .get("deviceId")
                .and_then(Value::as_str)
                .ok_or("device-unknown")?;
            let mut found = false;
            for trusted in state.trust.values_mut() {
                if trusted.device_id == device_id {
                    trusted.revoked = false;
                    found = true;
                }
            }
            if !found {
                return Err("device-unknown");
            }
            Ok(json!({ "ok": true }))
        }
        "trust.update_grants" => {
            let mut state = state.lock().await;
            let device_id = params
                .get("deviceId")
                .and_then(Value::as_str)
                .ok_or("device-unknown")?;
            let grants: Vec<String> = params
                .get("grants")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let revision = params
                .get("grantRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let mut found = false;
            for trusted in state.trust.values_mut() {
                if trusted.device_id == device_id {
                    trusted.grants = grants.clone();
                    trusted.grant_revision = revision;
                    found = true;
                }
            }
            if !found {
                return Err("device-unknown");
            }
            let _ = state.events.send(json!({
                "type": "tunnel/grants-updated",
                "deviceId": device_id,
                "grantRevision": revision,
            }));
            Ok(json!({ "ok": true }))
        }
        "ingress.configure" => {
            let mut state = state.lock().await;
            let socket = params
                .get("socket")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            let secret = params
                .get("secret")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            state.ingress_socket = Some(PathBuf::from(socket));
            state.ingress_secret = Some(secret.to_string());
            Ok(json!({ "ok": true }))
        }
        "pairing.create" => {
            let mut state = state.lock().await;
            let profile = params
                .get("profile")
                .and_then(Value::as_str)
                .unwrap_or("interact");
            let requested = params
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("direct-preferred");
            if requested != "direct-preferred" {
                return Err("pairing-invalid");
            }
            let policy = "direct-preferred";
            let label = params.get("label").and_then(Value::as_str);
            let grants: Vec<String> = params
                .get("grants")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let mut relays: Vec<String> = params
                .get("relayUrls")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if let Some(endpoint) = &state.endpoint {
                if relays.is_empty() && state.policy.allow_public_relays() {
                    relays = polyth_link_core::net::current_relay_urls(endpoint);
                }
            }
            let direct = state
                .endpoint
                .as_ref()
                .map(polyth_link_core::net::current_direct_addresses);
            let host_endpoint = state.identity.endpoint_id();
            let invitation = state
                .pairing
                .create(
                    &host_endpoint,
                    label,
                    profile,
                    grants,
                    relays,
                    direct,
                    policy,
                    Instant::now(),
                )
                .map_err(|e| e.code())?;
            let qr = ticket_qr_modules(&invitation.ticket).unwrap_or_default();
            let _ = state
                .events
                .send(json!({"type":"tunnel/pairing-created","pairingId": invitation.pairing_id}));
            Ok(json!({
                "pairing": {
                    "id": invitation.pairing_id,
                    "expiresAt": invitation.expires_at,
                    "safetyPhrase": null,
                    "state": "created",
                },
                "ticket": invitation.ticket,
                "qrPayload": invitation.ticket,
                "qrModules": qr,
            }))
        }
        "pairing.get" => {
            let mut state = state.lock().await;
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            state.pairing.expire(Instant::now());
            let invitation = state.pairing.get(id).ok_or("pairing-invalid")?;
            Ok(json!({
                "id": invitation.pairing_id,
                "state": invitation.state.as_str(),
                "issuedAt": invitation.issued_at,
                "expiresAt": invitation.expires_at,
                "endpointId": invitation.claimant,
                "deviceConfirmed": invitation.device_confirmed,
                "hostConfirmed": invitation.host_confirmed,
                "safetyPhrase": invitation.safety_phrase,
                "requestedGrants": invitation.grants,
                "device": invitation.device_label.as_ref().map(|label| json!({
                    "label": label,
                    "platform": invitation.device_platform,
                    "appVersion": invitation.device_app_version,
                    "endpointFingerprint": invitation.claimant.as_deref().map(|id| format!("{}…{}", &id[..id.len().min(4)], &id[id.len().saturating_sub(4)..])).unwrap_or_default(),
                })),
            }))
        }
        "pairing.approve" => {
            let mut state = state.lock().await;
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            state
                .pairing
                .confirm_host(id, Instant::now())
                .map_err(|e| e.code())?;
            maybe_emit_committing(&state, id);
            Ok(json!({ "ok": true }))
        }
        "pairing.reject" => {
            let mut state = state.lock().await;
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            state.pairing.reject(id).map_err(|e| e.code())?;
            let _ = state.events.send(
                json!({"type":"tunnel/pairing-finished","pairingId": id, "state":"rejected"}),
            );
            Ok(json!({ "ok": true }))
        }
        "pairing.cancel" => {
            let mut state = state.lock().await;
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            state.pairing.cancel(id).map_err(|e| e.code())?;
            Ok(json!({ "ok": true }))
        }
        "pairing.finish" => {
            let mut state = state.lock().await;
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            state.pairing.mark_committed(id).map_err(|e| e.code())?;
            let _ = state.events.send(
                json!({"type":"tunnel/pairing-finished","pairingId": id, "state":"committed"}),
            );
            Ok(json!({ "ok": true }))
        }
        "pairing.storage_failed" => {
            let mut state = state.lock().await;
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or("pairing-invalid")?;
            let _ = state.pairing.mark_storage_failed(id);
            Ok(json!({ "ok": true }))
        }
        "connection.close_device" => {
            let mut state = state.lock().await;
            let device_id = params
                .get("deviceId")
                .and_then(Value::as_str)
                .ok_or("device-unknown")?;
            conn::close_device_connections(&mut state, device_id).await;
            let _ = state.events.send(json!({
                "type": "tunnel/device-revoked",
                "deviceId": device_id,
            }));
            Ok(json!({ "ok": true }))
        }
        "connection.notify_grants" => {
            let state = state.lock().await;
            let device_id = params
                .get("deviceId")
                .and_then(Value::as_str)
                .ok_or("device-unknown")?;
            let revision = params
                .get("grantRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let _ = state.events.send(json!({
                "type": "tunnel/grants-updated",
                "deviceId": device_id,
                "grantRevision": revision,
            }));
            Ok(json!({ "ok": true }))
        }
        "endpoint.set_policy" => {
            let requested = params
                .get("policy")
                .and_then(Value::as_str)
                .unwrap_or("direct-preferred");
            if requested != "direct-preferred" {
                return Err("pairing-invalid");
            }
            let shared = state.clone();
            let (secret, old_endpoint, live, policy_path) = {
                let mut guard = state.lock().await;
                let live: Vec<_> = std::mem::take(&mut guard.connections)
                    .into_values()
                    .collect();
                let old_endpoint = guard.endpoint.take();
                guard.policy = TransportPolicy::DirectPreferred;
                (
                    guard.identity.secret_key(),
                    old_endpoint,
                    live,
                    guard.policy_path.clone(),
                )
            };
            for connection in live {
                connection.connection.close(0u32.into(), b"policy");
            }
            if let Some(endpoint) = old_endpoint {
                endpoint.close().await;
            }
            let endpoint =
                polyth_link_core::net::bind_link_endpoint(secret, TransportPolicy::DirectPreferred)
                    .await
                    .map_err(|_| "transport-unavailable")?;
            let accept = endpoint.clone();
            {
                let mut guard = state.lock().await;
                guard.endpoint = Some(endpoint);
            }
            save_host_policy(&policy_path, TransportPolicy::DirectPreferred);
            tokio::spawn(conn::accept_loop(shared, accept));
            Ok(json!({
                "ok": true,
                "activePolicy": "direct-preferred",
                "endpointBound": true,
            }))
        }
        "endpoint.start" => {
            let shared = state.clone();
            let guard = state.lock().await;
            if guard.endpoint.is_some() {
                return Ok(json!({ "ok": true, "zeroRttDisabled": DISABLE_0RTT }));
            }
            let secret = guard.identity.secret_key();
            let policy = guard.policy;
            drop(guard);
            let endpoint = polyth_link_core::net::bind_link_endpoint(secret, policy)
                .await
                .map_err(|_| "transport-unavailable")?;
            let accept = endpoint.clone();
            {
                let mut guard = state.lock().await;
                guard.endpoint = Some(endpoint);
            }
            tokio::spawn(conn::accept_loop(shared, accept));
            Ok(json!({ "ok": true, "zeroRttDisabled": DISABLE_0RTT, "alpn": POLYTH_LINK_ALPN }))
        }
        "status" => {
            let state = state.lock().await;
            let relay_urls = state
                .endpoint
                .as_ref()
                .map(polyth_link_core::net::current_relay_urls)
                .unwrap_or_default();
            let direct_addresses = state
                .endpoint
                .as_ref()
                .map(polyth_link_core::net::current_direct_addresses)
                .unwrap_or_default();
            Ok(json!({
                "fingerprint": state.identity.fingerprint(),
                "endpointId": state.identity.endpoint_id(),
                "mode": state.policy.as_str(),
                "activePolicy": state.policy.as_str(),
                "endpointBound": state.endpoint.is_some(),
                "irohVersion": polyth_link_core::IROH_CRATE_VERSION,
                "zeroRttDisabled": DISABLE_0RTT,
                "activeConnections": state.connections.len(),
                "relayUrls": relay_urls,
                "directAddresses": direct_addresses,
                "transports": state.connections.values().map(|live| live.transport).collect::<Vec<_>>(),
                "peers": state.connections.values().map(|live| {
                    format!("{}…{}", &live.endpoint_id[..live.endpoint_id.len().min(4)], &live.endpoint_id[live.endpoint_id.len().saturating_sub(4)..])
                }).collect::<Vec<_>>(),
            }))
        }
        _ => Err("pairing-invalid"),
    }
}

pub(crate) fn maybe_emit_committing(state: &HostState, pairing_id: &str) {
    let Some(invitation) = state.pairing.get(pairing_id) else {
        return;
    };
    if invitation.state.as_str() == "committing" {
        let _ = state.events.send(json!({
            "type": "tunnel/pairing-committing",
            "pairingId": pairing_id,
            "endpointId": invitation.claimant,
            "label": invitation.device_label,
            "platform": invitation.device_platform,
            "grants": invitation.grants,
        }));
    }
    let _ = state.events.send(json!({
        "type": "tunnel/pairing-updated",
        "pairingId": pairing_id,
        "state": invitation.state.as_str(),
    }));
}

fn load_host_policy(path: &Path) -> TransportPolicy {
    let Ok(text) = std::fs::read_to_string(path) else {
        return TransportPolicy::DirectPreferred;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return TransportPolicy::DirectPreferred;
    };
    match value.get("policy").and_then(Value::as_str) {
        Some("direct-preferred") => TransportPolicy::DirectPreferred,
        Some("relay-only") | Some("air-gapped") => {
            eprintln!(
                "polyth-link-host: stored policy is not available in this build; using direct-preferred"
            );
            TransportPolicy::DirectPreferred
        }
        _ => TransportPolicy::DirectPreferred,
    }
}

fn save_host_policy(path: &Path, policy: TransportPolicy) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        path,
        serde_json::to_vec(&json!({ "policy": policy.as_str() })).unwrap_or_default(),
    );
}
