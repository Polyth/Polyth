use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::errors::LinkError;

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

fn constant_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
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
        assert!(origin_allowed("http://127.0.0.1:9", 9));
        assert!(!origin_allowed("http://evil.test", 9));
    }
}
