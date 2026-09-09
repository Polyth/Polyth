use std::sync::Arc;

use polyth_link_core::{POLYTH_LINK_ALPN, POLYTH_NUMERIC_ALPN};
use tokio::sync::Mutex;

use crate::HostState;

#[path = "numeric.rs"]
mod numeric;

#[allow(dead_code)]
mod transport {
    include!("conn_transport.rs");
}

pub(crate) use numeric::{cancel_code, create_code, invalidate_codes};
pub(crate) use transport::close_device_connections;

pub async fn accept_loop(state: Arc<Mutex<HostState>>, endpoint: iroh::Endpoint) {
    let _advertisement = if lan_advertising_enabled() {
        match iroh_http_discovery::advertise_peer(&endpoint, "polyth") {
            Ok(session) => Some(session),
            Err(error) => {
                eprintln!("polyth-link-host: LAN discovery unavailable: {error}");
                None
            }
        }
    } else {
        None
    };

    loop {
        let incoming = match endpoint.accept().await {
            Some(incoming) => incoming,
            None => break,
        };
        let connecting = match incoming.accept() {
            Ok(connecting) => connecting,
            Err(_) => continue,
        };
        let connection = match connecting.await {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        let peer = connection.remote_id().to_string();
        let state = state.clone();
        match connection.alpn() {
            alpn if alpn == POLYTH_LINK_ALPN.as_bytes() => {
                tokio::spawn(async move {
                    let _ = transport::handle_connection(state, connection, peer).await;
                });
            }
            alpn if alpn == POLYTH_NUMERIC_ALPN.as_bytes() => {
                tokio::spawn(async move {
                    let _ = numeric::handle_connection(state, connection, peer).await;
                });
            }
            _ => connection.close(0u32.into(), b"alpn"),
        }
    }
}

fn lan_advertising_enabled() -> bool {
    std::env::var("POLYTH_LINK_DISABLE_LAN_DISCOVERY").as_deref() != Ok("1")
}
