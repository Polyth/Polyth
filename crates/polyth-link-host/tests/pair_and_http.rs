use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use polyth_link_core::identity;
use polyth_link_core::net::{bind_link_endpoint, endpoint_addr_from_ticket};
use polyth_link_core::pairing::client_proof;
use polyth_link_core::protocol::{
    decode_head, encode_head, ControlMessage, HttpRequestHeadV1, HttpResponseHeadV1, STREAM_HTTP,
};
use polyth_link_core::ticket::{decode_invite_secret, parse_pairing_ticket, POLYTH_LINK_ALPN};
use polyth_link_core::transport::TransportPolicy;
use polyth_link_core::wire::{
    open_control, read_control, read_len_prefixed, write_all, write_control, write_stream_kind,
};
use rand::RngCore;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
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

async fn rpc(stream: &mut BufReader<UnixStream>, id: u64, method: &str, params: Value) -> Value {
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
        assert!(bytes > 0, "rpc {method} id={id}: host closed the control socket");
        let parsed: Value = serde_json::from_str(response.trim())
            .unwrap_or_else(|error| panic!("rpc {method} id={id}: malformed response {response:?}: {error}"));
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

async fn rpc_try(stream: &mut BufReader<UnixStream>, id: u64, method: &str, params: Value) -> Value {
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
        assert!(bytes > 0, "rpc {method} id={id}: host closed the control socket");
        let parsed: Value = serde_json::from_str(response.trim())
            .unwrap_or_else(|error| panic!("rpc {method} id={id}: malformed response {response:?}: {error}"));
        if parsed.get("method").and_then(Value::as_str) == Some("event") {
            continue;
        }
        if parsed.get("id").and_then(Value::as_u64) == Some(id) {
            return parsed;
        }
    }
}

async fn serve_ingress(socket: PathBuf) {
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap();
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            break;
        };
        tokio::spawn(async move {
            let mut buf = vec![0u8; 16 * 1024];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            let body = br#"{"ok":true,"via":"polyth-link"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.write_all(body).await;
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_binary_pairs_and_proxies_http() {
    let dir = tempfile::tempdir().unwrap();
    let control = dir.path().join("host.sock");
    let ingress = dir.path().join("ingress.sock");
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();

    let child = Command::new(host_bin())
        .args(["serve", data.to_str().unwrap(), control.to_str().unwrap()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn host");
    let _host = HostProc(child);

    let started = std::time::Instant::now();
    while !control.exists() {
        if started.elapsed() > Duration::from_secs(8) {
            panic!("host socket missing");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    tokio::spawn(serve_ingress(ingress.clone()));
    tokio::time::sleep(Duration::from_millis(50)).await;

    let rpc_socket = UnixStream::connect(&control).await.unwrap();
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
    let status = rpc(&mut rpc_stream, 20, "status", json!({})).await;
    assert_eq!(
        status.get("activePolicy").and_then(Value::as_str),
        Some("direct-preferred")
    );
    assert_eq!(
        status.get("endpointBound").and_then(Value::as_bool),
        Some(true)
    );
    let rejected = rpc_try(
        &mut rpc_stream,
        21,
        "pairing.create",
        json!({ "profile": "interact", "mode": "relay-only" }),
    )
    .await;
    assert!(rejected.get("error").is_some());
    let policy_rejected = rpc_try(
        &mut rpc_stream,
        22,
        "endpoint.set_policy",
        json!({ "policy": "air-gapped" }),
    )
    .await;
    assert!(policy_rejected.get("error").is_some());
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

    let created = rpc(
        &mut rpc_stream,
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
    let ticket = parse_pairing_ticket(&ticket_text).unwrap();
    assert_eq!(ticket.candidates[0].policy, "direct-preferred");
    let status = rpc(&mut rpc_stream, 23, "status", json!({})).await;
    assert_eq!(
        status.get("activePolicy").and_then(Value::as_str),
        Some(ticket.candidates[0].policy.as_str())
    );

    let device_dir = dir.path().join("device");
    let device_id = identity::load_or_create(device_dir.join("identity")).unwrap();
    let device_ep = bind_link_endpoint(device_id.secret_key(), TransportPolicy::DirectPreferred)
        .await
        .unwrap();
    let secret = decode_invite_secret(&ticket).unwrap();
    let addr = endpoint_addr_from_ticket(&ticket).unwrap();
    let device_endpoint = device_id.endpoint_id();

    let device_task = tokio::spawn(async move {
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
        conn
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut approved = false;
    let mut finished = false;
    while std::time::Instant::now() < deadline {
        let status = rpc(
            &mut rpc_stream,
            10,
            "pairing.get",
            json!({"id": pairing_id}),
        )
        .await;
        let state = status.get("state").and_then(Value::as_str).unwrap_or("");
        if status
            .get("safetyPhrase")
            .and_then(Value::as_array)
            .is_some()
            && !approved
        {
            rpc(
                &mut rpc_stream,
                11,
                "pairing.approve",
                json!({"id": pairing_id}),
            )
            .await;
            approved = true;
        }
        if (state == "committing" || status.get("deviceConfirmed") == Some(&json!(true)))
            && approved
            && !finished
        {
            if let Some(endpoint_id) = status.get("endpointId").and_then(Value::as_str) {
                if !endpoint_id.is_empty() {
                    rpc(
                        &mut rpc_stream,
                        12,
                        "trust.sync",
                        json!({
                            "devices": [{
                                "endpointId": endpoint_id,
                                "deviceId": "dev-e2e",
                                "grants": ["core.sessions.read"],
                                "grantRevision": 1,
                                "revoked": false
                            }]
                        }),
                    )
                    .await;
                    rpc(
                        &mut rpc_stream,
                        13,
                        "pairing.finish",
                        json!({"id": pairing_id}),
                    )
                    .await;
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

    timeout(Duration::from_secs(15), device_task)
        .await
        .expect("device timeout")
        .unwrap();
}
