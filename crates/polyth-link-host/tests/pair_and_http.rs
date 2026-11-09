use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use iroh::endpoint::{Connection, RecvStream, SendStream};
use polyth_link_core::identity;
use polyth_link_core::net::{bind_link_endpoint, endpoint_addr_from_ticket};
use polyth_link_core::pairing::client_proof;
use polyth_link_core::protocol::{
    decode_head, encode_head, ControlMessage, HttpRequestHeadV1, HttpResponseHeadV1, STREAM_HTTP,
};
use polyth_link_core::ticket::{
    decode_invite_secret, parse_pairing_ticket, PairingTicket, POLYTH_LINK_ALPN,
};
use polyth_link_core::transport::TransportPolicy;
use polyth_link_core::wire::{
    open_control, read_control, read_len_prefixed, write_all, write_control, write_stream_kind,
};
use polyth_link_core::PROTOCOL_VERSION;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::time::timeout;

struct HostProc(Child);

impl Drop for HostProc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn host_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_polyth-link-host"))
}

async fn rpc(stream: &mut BufReader<Control>, id: u64, method: &str, params: Value) -> Value {
    let line = json!({"id": id, "method": method, "params": params});
    stream
        .get_mut()
        .write_all(format!("{line}\n").as_bytes())
        .await
        .unwrap();
    let mut response = String::new();
    loop {
        response.clear();
        let bytes = stream.read_line(&mut response).await.unwrap();
        assert!(
            bytes > 0,
            "rpc {method} id={id}: host closed the control socket"
        );
        let parsed: Value = serde_json::from_str(response.trim()).unwrap_or_else(|error| {
            panic!("rpc {method} id={id}: malformed response {response:?}: {error}")
        });
        if parsed.get("method").and_then(Value::as_str) == Some("event") {
            continue;
        }
        if parsed.get("error").is_some() {
            panic!("rpc {method} failed: {parsed}");
        }
        if parsed.get("id").and_then(Value::as_u64) == Some(id) {
            return parsed.get("result").cloned().unwrap_or(json!({}));
        }
    }
}

async fn rpc_try(stream: &mut BufReader<Control>, id: u64, method: &str, params: Value) -> Value {
    let line = json!({"id": id, "method": method, "params": params});
    stream
        .get_mut()
        .write_all(format!("{line}\n").as_bytes())
        .await
        .unwrap();
    let mut response = String::new();
    loop {
        response.clear();
        let bytes = stream.read_line(&mut response).await.unwrap();
        assert!(
            bytes > 0,
            "rpc {method} id={id}: host closed the control socket"
        );
        let parsed: Value = serde_json::from_str(response.trim()).unwrap_or_else(|error| {
            panic!("rpc {method} id={id}: malformed response {response:?}: {error}")
        });
        if parsed.get("method").and_then(Value::as_str) == Some("event") {
            continue;
        }
        if parsed.get("id").and_then(Value::as_u64) == Some(id) {
            return parsed;
        }
    }
}

// The host's local IPC: Unix sockets, or named pipes on Windows (the same
// shapes the Node owner uses, see packages/tunnel/src/localIpc.ts).
#[cfg(unix)]
type Control = tokio::net::UnixStream;
#[cfg(windows)]
type Control = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(unix)]
fn ipc_paths(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join("host.sock"), dir.join("ingress.sock"))
}

#[cfg(windows)]
fn ipc_paths(_dir: &Path) -> (PathBuf, PathBuf) {
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);
    let nonce = hex::encode(nonce);
    (
        PathBuf::from(format!(r"\\.\pipe\polyth-link-test-{nonce}-host")),
        PathBuf::from(format!(r"\\.\pipe\polyth-link-test-{nonce}-ingress")),
    )
}

#[cfg(unix)]
async fn connect_control(path: &Path) -> Control {
    let started = std::time::Instant::now();
    while !path.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "host socket missing"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::net::UnixStream::connect(path).await.unwrap()
}

#[cfg(windows)]
async fn connect_control(path: &Path) -> Control {
    let started = std::time::Instant::now();
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(path.as_os_str()) {
            Ok(client) => return client,
            // Not created yet, or every instance momentarily busy.
            Err(error) if matches!(error.raw_os_error(), Some(2) | Some(231)) => {
                assert!(
                    started.elapsed() < Duration::from_secs(8),
                    "host pipe missing"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("host pipe: {error}"),
        }
    }
}

#[cfg(unix)]
fn serve_ingress(socket: PathBuf) {
    let _ = std::fs::remove_file(&socket);
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(answer_ingress(stream));
        }
    });
}

#[cfg(windows)]
fn serve_ingress(socket: PathBuf) {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut next = ServerOptions::new()
        .first_pipe_instance(true)
        .create(socket.as_os_str())
        .unwrap();
    tokio::spawn(async move {
        while next.connect().await.is_ok() {
            let Ok(fresh) = ServerOptions::new().create(socket.as_os_str()) else {
                break;
            };
            tokio::spawn(answer_ingress(std::mem::replace(&mut next, fresh)));
        }
    });
}

async fn answer_ingress<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S) {
    let mut buf = vec![0u8; 16 * 1024];
    let n = stream.read(&mut buf).await.unwrap_or(0);
    if n == 0 {
        return;
    }
    // Answer like the real ingress (Node's default HTTP server) with a
    // handler that awaits I/O: a client that half-closes before the
    // answer counts as gone and gets nothing.
    let mut probe = [0u8; 1];
    if let Ok(Ok(0)) = timeout(Duration::from_millis(50), stream.read(&mut probe)).await {
        return;
    }
    let body = br#"{"ok":true,"via":"polyth-link"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

struct LinkHost {
    _proc: HostProc,
    rpc: BufReader<Control>,
    _dir: tempfile::TempDir,
}

/// A host with a bound endpoint and a configured ingress.
async fn start_host() -> LinkHost {
    let dir = tempfile::tempdir().unwrap();
    let (control, ingress) = ipc_paths(dir.path());
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();

    let child = Command::new(host_bin())
        .args(["serve", data.to_str().unwrap(), control.to_str().unwrap()])
        // The host's owner keeps stdin open; on Windows its end is the
        // owner's death signal.
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn host");
    let proc = HostProc(child);

    let rpc_socket = connect_control(&control).await;
    serve_ingress(ingress.clone());
    let mut rpc_stream = BufReader::new(rpc_socket);
    let identity = rpc(&mut rpc_stream, 1, "identity.status", json!({})).await;
    assert!(
        identity
            .get("fingerprint")
            .and_then(Value::as_str)
            .unwrap()
            .len()
            >= 8
    );

    rpc(&mut rpc_stream, 2, "endpoint.start", json!({})).await;
    rpc(
        &mut rpc_stream,
        3,
        "ingress.configure",
        json!({
            "socket": ingress.to_str().unwrap(),
            "secret": "a".repeat(64),
        }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    LinkHost {
        _proc: proc,
        rpc: rpc_stream,
        _dir: dir,
    }
}

async fn create_invitation(rpc_stream: &mut BufReader<Control>) -> (PairingTicket, String) {
    let created = rpc(
        rpc_stream,
        4,
        "pairing.create",
        json!({
            "profile": "interact",
            "mode": "direct-preferred",
            "label": "Desk",
            "grants": ["core.sessions.read"],
        }),
    )
    .await;
    let ticket_text = created
        .get("ticket")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    let pairing_id = created
        .get("pairing")
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    (parse_pairing_ticket(&ticket_text).unwrap(), pairing_id)
}

/// The phone's side of a pairing; ends with the committed connection. The
/// control streams come back too: the link lives only while they are open.
struct PairedLink {
    endpoint: iroh::Endpoint,
    conn: Connection,
    _control: (SendStream, RecvStream),
}

async fn pair_device(
    ticket: PairingTicket,
    device: &identity::HostIdentity,
) -> tokio::task::JoinHandle<PairedLink> {
    let device_ep = bind_link_endpoint(device.secret_key(), TransportPolicy::DirectPreferred)
        .await
        .unwrap();
    let secret = decode_invite_secret(&ticket).unwrap();
    let addr = endpoint_addr_from_ticket(&ticket).unwrap();
    let device_endpoint = device.endpoint_id();
    tokio::spawn(async move {
        let conn = timeout(
            Duration::from_secs(15),
            device_ep.connect(addr, POLYTH_LINK_ALPN.as_bytes()),
        )
        .await
        .expect("connect wait")
        .expect("connect");
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        open_control(&mut send).await.unwrap();
        let mut client_nonce = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut client_nonce);
        write_control(
            &mut send,
            &ControlMessage::PairingHello {
                pairing_id: ticket.pairing_id.clone(),
                client_nonce,
                profile: ticket.profile.clone(),
                device_label: "Phone".into(),
                platform: "linux".into(),
                app_version: "test".into(),
            },
        )
        .await
        .unwrap();
        let ControlMessage::PairingChallenge { server_nonce } =
            read_control(&mut recv).await.unwrap()
        else {
            panic!("challenge");
        };
        let proof = client_proof(
            &secret,
            &ticket.pairing_id,
            &ticket.host.endpoint_id,
            &device_endpoint,
            &client_nonce,
            &server_nonce,
            &ticket.profile,
        );
        write_control(&mut send, &ControlMessage::PairingProof { proof })
            .await
            .unwrap();
        let ControlMessage::PairingSafety { phrase } = read_control(&mut recv).await.unwrap()
        else {
            panic!("safety");
        };
        assert_eq!(phrase.len(), 4);
        write_control(&mut send, &ControlMessage::PairingDeviceConfirmed)
            .await
            .unwrap();
        loop {
            match read_control(&mut recv).await.unwrap() {
                ControlMessage::PairingCommitted { .. } => break,
                ControlMessage::ConnectionAccepted { .. } => break,
                ControlMessage::Ping { nonce } => {
                    write_control(&mut send, &ControlMessage::Pong { nonce })
                        .await
                        .unwrap();
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        PairedLink {
            endpoint: device_ep,
            conn,
            _control: (send, recv),
        }
    })
}

/// The server's side of a pairing, as the tunnel package drives it: approve,
/// store the device's trust, then finish.
async fn commit_pairing(rpc_stream: &mut BufReader<Control>, pairing_id: &str, device_id: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut approved = false;
    let mut finished = false;
    while std::time::Instant::now() < deadline {
        let status = rpc(rpc_stream, 10, "pairing.get", json!({"id": pairing_id})).await;
        let state = status.get("state").and_then(Value::as_str).unwrap_or("");
        if status
            .get("safetyPhrase")
            .and_then(Value::as_array)
            .is_some()
            && !approved
        {
            rpc(rpc_stream, 11, "pairing.approve", json!({"id": pairing_id})).await;
            approved = true;
        }
        if (state == "committing" || status.get("deviceConfirmed") == Some(&json!(true)))
            && approved
            && !finished
        {
            if let Some(endpoint_id) = status.get("endpointId").and_then(Value::as_str) {
                if !endpoint_id.is_empty() {
                    rpc(
                        rpc_stream,
                        12,
                        "trust.upsert",
                        json!({
                            "endpointId": endpoint_id,
                            "deviceId": device_id,
                            "grants": ["core.sessions.read"],
                            "grantRevision": 1,
                            "revoked": false
                        }),
                    )
                    .await;
                    rpc(rpc_stream, 13, "pairing.finish", json!({"id": pairing_id})).await;
                    finished = true;
                }
            }
        }
        if finished {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(approved && finished, "host did not commit pairing");
}

async fn get_health(conn: &Connection) {
    let (mut http_send, mut http_recv) = conn.open_bi().await.unwrap();
    write_stream_kind(&mut http_send, STREAM_HTTP)
        .await
        .unwrap();
    let mut request_id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut request_id);
    write_all(
        &mut http_send,
        &encode_head(&HttpRequestHeadV1 {
            version: 1,
            request_id,
            method: "GET".into(),
            path_and_query: "/api/health".into(),
            headers: vec![],
            body_length: Some(0),
        })
        .unwrap(),
    )
    .await
    .unwrap();
    http_send.finish().unwrap();
    let payload = read_len_prefixed(&mut http_recv, 64 * 1024).await.unwrap();
    let mut framed = Vec::new();
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(&payload);
    let (response, _): (HttpResponseHeadV1, usize) = decode_head(&framed).unwrap();
    assert_eq!(response.status, 200);
    let mut buf = [0u8; 64];
    let n = http_recv.read(&mut buf).await.unwrap();
    let count = n.unwrap_or(0);
    assert!(count > 0 || response.body_length == Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_binary_pairs_and_proxies_http() {
    let mut host = start_host().await;
    let rpc_stream = &mut host.rpc;
    let status = rpc(rpc_stream, 20, "status", json!({})).await;
    assert_eq!(
        status.get("activePolicy").and_then(Value::as_str),
        Some("direct-preferred")
    );
    assert_eq!(
        status.get("endpointBound").and_then(Value::as_bool),
        Some(true)
    );
    let rejected = rpc_try(
        rpc_stream,
        21,
        "pairing.create",
        json!({ "profile": "interact", "mode": "relay-only" }),
    )
    .await;
    assert!(rejected.get("error").is_some());
    let policy_rejected = rpc_try(
        rpc_stream,
        22,
        "endpoint.set_policy",
        json!({ "policy": "air-gapped" }),
    )
    .await;
    assert!(policy_rejected.get("error").is_some());

    let (ticket, pairing_id) = create_invitation(rpc_stream).await;
    assert_eq!(ticket.candidates[0].policy, "direct-preferred");
    let status = rpc(rpc_stream, 23, "status", json!({})).await;
    assert_eq!(
        status.get("activePolicy").and_then(Value::as_str),
        Some(ticket.candidates[0].policy.as_str())
    );

    let device_dir = tempfile::tempdir().unwrap();
    let device = identity::load_or_create(device_dir.path().join("identity")).unwrap();
    let device_task = pair_device(ticket, &device).await;
    commit_pairing(rpc_stream, &pairing_id, "dev-e2e").await;
    let link = timeout(Duration::from_secs(15), device_task)
        .await
        .expect("device timeout")
        .unwrap();
    get_health(&link.conn).await;
}

/// A phone keeps one identity per host. After its device is revoked (by its
/// owner, or with the owner's account) the same identity must be able to pair
/// again with a new invitation, while its old trust still refuses a plain
/// reconnect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_device_pairs_again_with_the_same_identity() {
    let mut host = start_host().await;
    let rpc_stream = &mut host.rpc;
    let device_dir = tempfile::tempdir().unwrap();
    let device = identity::load_or_create(device_dir.path().join("identity")).unwrap();

    let (ticket, pairing_id) = create_invitation(rpc_stream).await;
    let host_addr = endpoint_addr_from_ticket(&ticket).unwrap();
    let first = pair_device(ticket, &device).await;
    commit_pairing(rpc_stream, &pairing_id, "dev-first").await;
    let first_link = timeout(Duration::from_secs(15), first)
        .await
        .expect("first pairing timeout")
        .unwrap();
    get_health(&first_link.conn).await;
    rpc(
        rpc_stream,
        30,
        "trust.revoke",
        json!({"deviceId": "dev-first"}),
    )
    .await;
    first_link.endpoint.close().await;
    drop(first_link);

    // The revoked trust still answers a reconnect authoritatively.
    let probe_ep = bind_link_endpoint(device.secret_key(), TransportPolicy::DirectPreferred)
        .await
        .unwrap();
    let conn = timeout(
        Duration::from_secs(15),
        probe_ep.connect(host_addr, POLYTH_LINK_ALPN.as_bytes()),
    )
    .await
    .expect("reconnect wait")
    .expect("reconnect");
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    open_control(&mut send).await.unwrap();
    write_control(
        &mut send,
        &ControlMessage::ConnectionHello {
            version: PROTOCOL_VERSION,
            device_endpoint: device.endpoint_id(),
        },
    )
    .await
    .unwrap();
    match read_control(&mut recv).await {
        Ok(ControlMessage::ConnectionRejected { code }) => assert_eq!(code, "device-revoked"),
        Ok(other) => panic!("revoked reconnect answered {other:?}"),
        // The host may close the connection before the rejection frame lands.
        Err(_) => {
            let reason = format!("{:?}", conn.closed().await);
            assert!(
                reason.contains("revoked"),
                "revoked reconnect closed with {reason}"
            );
        }
    }
    drop(conn);
    probe_ep.close().await;

    // A new invitation (another account's, or the same one's) pairs it again.
    let (ticket, pairing_id) = create_invitation(rpc_stream).await;
    let second = pair_device(ticket, &device).await;
    commit_pairing(rpc_stream, &pairing_id, "dev-second").await;
    let link = timeout(Duration::from_secs(15), second)
        .await
        .expect("second pairing timeout")
        .unwrap();
    get_health(&link.conn).await;
}
