use serde::{Deserialize, Serialize};

use crate::IROH_CRATE_VERSION;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SanitizedDiagnostics {
    pub app_version: String,
    pub iroh_version: String,
    pub host_fingerprint: Option<String>,
    pub relay_urls: Vec<String>,
    pub path: Option<String>,
    pub rtt_ms: Option<u32>,
    pub recent_errors: Vec<String>,
    pub grant_revision: Option<u32>,
    pub package_status: String,
}

impl SanitizedDiagnostics {
    pub fn new(app_version: &str) -> Self {
        Self {
            app_version: app_version.to_string(),
            iroh_version: IROH_CRATE_VERSION.to_string(),
            host_fingerprint: None,
            relay_urls: Vec::new(),
            path: None,
            rtt_ms: None,
            recent_errors: Vec::new(),
            grant_revision: None,
            package_status: "unknown".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_do_not_embed_secrets() {
        let json = serde_json::to_string(&SanitizedDiagnostics::new("0.1.0")).unwrap();
        assert!(!json.contains("invite"));
        assert!(!json.contains("secret"));
        assert!(json.contains("1.1.0"));
    }
}
