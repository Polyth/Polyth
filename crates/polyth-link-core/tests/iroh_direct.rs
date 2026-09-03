use std::time::{Duration, Instant};

use polyth_link_core::identity;
use polyth_link_core::net::bind_link_endpoint;
use polyth_link_core::pairing::{client_proof, HostPairing};
use polyth_link_core::protocol::{
    decode_head, encode_head, ControlMessage, HttpRequestHeadV1, HttpResponseHeadV1,
    STREAM_CONTROL, STREAM_HTTP,
};
use polyth_link_core::ticket::{decode_invite_secret, POLYTH_LINK_ALPN};
use polyth_link_core::transport::TransportPolicy;
use polyth_link_core::wire::{
    open_control, read_control, read_len_prefixed, read_stream_kind, write_all, write_control,
    write_stream_kind,
};
use rand::RngCore;
use tokio::time::timeout;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_pairing_and_http_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let host_id = identity::load_or_create(dir.path().join("host")).unwrap();
    let device_id = identity::load_or_create(dir.path().join("device")).unwrap();
    let host_ep = bind_link_endpoint(host_id.secret_key(), TransportPolicy::AirGapped)
        .await
        .expect("host bind");
    let device_ep = bind_link_endpoint(device_id.secret_key(), TransportPolicy::AirGapped)
        .await
        .expect("device bind");

    let mut pairing = HostPairing::new();
    let now = Instant::now();
    let invitation = pairing
        .create(
            &host_id.endpoint_id(),
            Some("Desk"),
            "interact",
            vec!["core.sessions.read".into()],
            vec![],
            Some(polyth_link_core::net::current_direct_addresses(&host_ep)),
            "air-gapped",
            now,
        )
        .unwrap();
    let host_endpoint = host_id.endpoint_id();
    let device_endpoint = device_id.endpoint_id();
    let ticket_text = invitation.ticket.clone();
    let ticket = polyth_link_core::parse_pairing_ticket(&ticket_text).unwrap();
    let secret = decode_invite_secret(&ticket).unwrap();
    let addr = polyth_link_core::net::endpoint_addr_from_ticket(&ticket).unwrap();

    let host_task = {
        let host_ep = host_ep.clone();
        let host_endpoint = host_endpoint.clone();
        let device_endpoint = device_endpoint.clone();
        tokio::spawn(async move {
            let incoming = timeout(Duration::from_secs(15), host_ep.accept())
                .await
                .expect("accept wait")
                .expect("incoming");
            let conn = incoming.accept().unwrap().await.unwrap();
            assert_eq!(conn.remote_id().to_string(), device_endpoint);
            let (mut send, mut recv) = conn.accept_bi().await.unwrap();
            assert!(!recv.is_0rtt());
            assert_eq!(read_stream_kind(&mut recv).await.unwrap(), STREAM_CONTROL);
            let ControlMessage::PairingHello {
                pairing_id,
                client_nonce,
                device_label,
                platform,
                app_version,
                ..
            } = read_control(&mut recv).await.unwrap()
            else {
                panic!("expected hello");
            };
            let server_nonce = pairing
                .challenge(
                    &pairing_id,
                    &conn.remote_id().to_string(),
                    client_nonce,
                    Instant::now(),
                )
                .unwrap();
            pairing
                .note_device(
                    &pairing_id,
                    &conn.remote_id().to_string(),
                    &device_label,
                    &platform,
                    &app_version,
                )
                .unwrap();
            write_control(
                &mut send,
                &ControlMessage::PairingChallenge { server_nonce },
            )
            .await
            .unwrap();
            let ControlMessage::PairingProof { proof } = read_control(&mut recv).await.unwrap()
            else {
                panic!("expected proof");
            };
            let phrase = pairing
                .verify_proof(
                    &pairing_id,
                    &host_endpoint,
                    &conn.remote_id().to_string(),
                    &client_nonce,
                    &server_nonce,
                    &proof,
                    Instant::now(),
                )
                .unwrap();
            write_control(&mut send, &ControlMessage::PairingSafety { phrase })
                .await
                .unwrap();
            let ControlMessage::PairingDeviceConfirmed = read_control(&mut recv).await.unwrap()
            else {
                panic!("expected device confirm");
            };
            pairing
                .confirm_device(&pairing_id, &conn.remote_id().to_string(), Instant::now())
                .unwrap();
            pairing.confirm_host(&pairing_id, Instant::now()).unwrap();
            pairing.mark_committed(&pairing_id).unwrap();
            write_control(
                &mut send,
                &ControlMessage::PairingCommitted {
                    device_id: "dev-1".into(),
                    grant_revision: 1,
                    grants: vec!["core.sessions.read".into()],
                },
            )
            .await
            .unwrap();
            let (mut http_send, mut http_recv) = conn.accept_bi().await.unwrap();
            assert_eq!(read_stream_kind(&mut http_recv).await.unwrap(), STREAM_HTTP);
            let payload = read_len_prefixed(&mut http_recv, 64 * 1024).await.unwrap();
            let mut framed = Vec::new();
            framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            framed.extend_from_slice(&payload);
            let (head, _): (HttpRequestHeadV1, usize) = decode_head(&framed).unwrap();
            assert_eq!(head.path_and_query, "/api/health");
            assert_eq!(head.method, "GET");
            let body = br#"{"ok":true}"#;
            let encoded = encode_head(&HttpResponseHeadV1 {
                version: 1,
                request_id: head.request_id,
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body_length: Some(body.len() as u64),
            })
            .unwrap();
            write_all(&mut http_send, &encoded).await.unwrap();
            write_all(&mut http_send, body).await.unwrap();
            http_send.finish().unwrap();
            conn
        })
    };

    let device_task = async {
        let conn = timeout(
            Duration::from_secs(15),
            device_ep.connect(addr, POLYTH_LINK_ALPN.as_bytes()),
        )
        .await
        .expect("connect wait")
        .expect("connect");
        assert_eq!(conn.remote_id().to_string(), host_endpoint);
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
        let ControlMessage::PairingCommitted {
            device_id: committed,
            ..
        } = read_control(&mut recv).await.unwrap()
        else {
            panic!("committed");
        };
        assert_eq!(committed, "dev-1");
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
        let body = http_recv.read_to_end(1024).await.unwrap();
        assert_eq!(body, br#"{"ok":true}"#);
        conn
    };

    let (host_conn, device_conn) = tokio::join!(host_task, device_task);
    host_conn.unwrap();
    device_conn.close(0u32.into(), b"done");
}
