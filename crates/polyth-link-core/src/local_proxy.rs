use rand::RngCore;
use sha2::{Digest, Sha256};

use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::errors::LinkError;
use crate::http_io::percent_decode_path;
use crate::timefmt::constant_eq;

pub const BOOTSTRAP_COOKIE: &str = "polyth_link_proxy";
pub const BOOTSTRAP_PATH_PREFIX: &str = "/__polyth_boot/";

#[derive(Clone)]
pub struct ProxyBootstrap {
    pub port: u16,
    nonce: [u8; 32],
    session: [u8; 32],
    nonce_consumed: bool,
}

impl ProxyBootstrap {
    pub fn new(port: u16) -> Self {
        let mut nonce = [0u8; 32];
        let mut session = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut nonce);
        rand::thread_rng().fill_bytes(&mut session);
        Self {
            port,
            nonce,
            session,
            nonce_consumed: false,
        }
    }

    pub fn nonce_hex(&self) -> String {
        hex::encode(self.nonce)
    }

    pub fn session_hex(&self) -> String {
        hex::encode(self.session)
    }

    pub fn bootstrap_url(&self) -> String {
        format!(
            "http://127.0.0.1:{}{BOOTSTRAP_PATH_PREFIX}{}",
            self.port,
            self.nonce_hex()
        )
    }

    pub fn consume_nonce(&mut self, nonce_hex: &str) -> Result<String, LinkError> {
        if self.nonce_consumed {
            return Err(LinkError::ProxyBootstrapInvalid);
        }
        let expected = self.nonce_hex();
        if !constant_eq(nonce_hex.as_bytes(), expected.as_bytes()) {
            return Err(LinkError::ProxyBootstrapInvalid);
        }
        self.nonce_consumed = true;
        self.nonce = [0u8; 32];
        Ok(self.session_hex())
    }

    pub fn session_valid(&self, cookie: &str) -> bool {
        constant_eq(cookie.as_bytes(), self.session_hex().as_bytes())
    }

    pub fn mint_fresh_nonce(&mut self) {
        rand::thread_rng().fill_bytes(&mut self.nonce);
        self.nonce_consumed = false;
    }
}

pub fn host_allowed(host: &str, port: u16) -> bool {
    let host = host.trim();
    host == format!("127.0.0.1:{port}")
        || host.eq_ignore_ascii_case(&format!("localhost:{port}"))
        || host == format!("[::1]:{port}")
}

pub fn origin_allowed(origin: &str, port: u16) -> bool {
    let allowed = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        format!("http://[::1]:{port}"),
    ];
    allowed.iter().any(|item| item == origin)
}

pub fn fingerprint_session(session_hex: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"polyth-link-proxy-session-v1");
    hasher.update(session_hex.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

pub fn validate_redirect_target(raw: &str) -> Result<String, LinkError> {
    if raw.is_empty() {
        return Ok("/".into());
    }
    if !raw.starts_with('/') || raw.starts_with("//") {
        return Err(LinkError::ProxyOriginDenied);
    }
    if raw.contains('\\')
        || raw.contains('\0')
        || raw.contains("://")
        || raw.contains('\r')
        || raw.contains('\n')
    {
        return Err(LinkError::ProxyOriginDenied);
    }
    let lower = raw.to_ascii_lowercase();
    if lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%00")
        || lower.contains("%2e")
    {
        return Err(LinkError::ProxyOriginDenied);
    }
    let decoded = percent_decode_path(raw)?;
    if decoded.starts_with("//")
        || decoded.contains('\\')
        || decoded.bytes().any(|byte| byte < b' ' || byte == 0x7f)
    {
        return Err(LinkError::ProxyOriginDenied);
    }
    if !decoded.starts_with('/') {
        return Err(LinkError::ProxyOriginDenied);
    }
    Ok(raw.to_string())
}

pub fn bootstrap_redirect_target(query: Option<&str>) -> Result<String, LinkError> {
    let mut next = None;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        if key != "next" {
            continue;
        }
        if next.replace(value.into_owned()).is_some() {
            return Err(LinkError::ProxyOriginDenied);
        }
    }
    validate_redirect_target(next.as_deref().unwrap_or("/"))
}

/// Loopback listener with an owned shutdown handle. Disconnect/forget/revoke
/// must close this so the port is released.
#[derive(Clone)]
pub struct OwnedLoopback {
    pub port: u16,
    shutdown: watch::Sender<bool>,
}

impl OwnedLoopback {
    pub fn close(&self) {
        let _ = self.shutdown.send(true);
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }
}

pub async fn bind_owned_loopback() -> Result<(TcpListener, OwnedLoopback), LinkError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    let port = listener
        .local_addr()
        .map_err(|_| LinkError::TransportUnavailable)?
        .port();
    let (shutdown, _) = watch::channel(false);
    Ok((listener, OwnedLoopback { port, shutdown }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_nonce_is_single_use() {
        let mut boot = ProxyBootstrap::new(9);
        let nonce = boot.nonce_hex();
        assert!(boot.consume_nonce(&nonce).is_ok());
        assert!(boot.consume_nonce(&nonce).is_err());
        assert!(host_allowed("127.0.0.1:9", 9));
        assert!(host_allowed("LOCALHOST:9", 9));
        assert!(host_allowed("[::1]:9", 9));
        assert!(!host_allowed("127.0.0.1:10", 9));
        assert!(!host_allowed("evil.test:9", 9));
        assert!(origin_allowed("http://127.0.0.1:9", 9));
        assert!(!origin_allowed("http://evil.test", 9));
        boot.mint_fresh_nonce();
        let fresh = boot.nonce_hex();
        assert_ne!(fresh, nonce);
        assert!(boot.consume_nonce(&fresh).is_ok());
        assert!(validate_redirect_target("/sessions/abc").is_ok());
        assert!(validate_redirect_target("/projects/p1").is_ok());
        assert!(validate_redirect_target("https://evil.test").is_err());
        assert!(validate_redirect_target("//evil.test").is_err());
        assert!(validate_redirect_target("/x%2f../y").is_err());
        assert!(validate_redirect_target("/\\evil").is_err());
        assert!(validate_redirect_target("http://evil.test/x").is_err());
    }

    #[test]
    fn bootstrap_next_round_trips_once_without_weakening_redirects() {
        for target in ["/sessions/x", "/projects/x", "/sessions/x?tab=files&line=2"] {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("next", target)
                .finish();
            assert_eq!(bootstrap_redirect_target(Some(&query)).unwrap(), target);
        }
        for query in [
            "next=https%3A%2F%2Fevil.test",
            "next=%2F%2Fevil.test",
            "next=%252F%252Fevil.test",
            "next=%2Fsessions%2Fx%255cadmin",
            "next=%2Fsessions%2Fx%2500",
            "next=%2Fsessions%2Fx%250d%250aLocation%3Aevil",
            "next=%2Fa&next=%2Fb",
        ] {
            assert!(
                bootstrap_redirect_target(Some(query)).is_err(),
                "accepted {query:?}"
            );
        }
    }

    #[tokio::test]
    async fn closing_owned_loopback_releases_the_port() {
        let (listener, handle) = bind_owned_loopback().await.unwrap();
        let port = handle.port;
        let mut shutdown = handle.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = listener.accept() => {
                        if accepted.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        handle.close();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let rebound = TcpListener::bind(("127.0.0.1", port)).await;
        assert!(rebound.is_ok(), "proxy port remained bound after close");
    }
}
