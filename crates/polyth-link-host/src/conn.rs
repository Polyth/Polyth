use std::sync::Arc;

use tokio::sync::Mutex;

use crate::HostState;

mod transport {
    include!("conn_transport.rs");
}

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
    transport::accept_loop(state, endpoint).await;
}

fn lan_advertising_enabled() -> bool {
    std::env::var("POLYTH_LINK_DISABLE_LAN_DISCOVERY").as_deref() != Ok("1")
}
