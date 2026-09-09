include!("runtime.rs");

/// In-process adapter over the same client state machine used by the CLI.
/// Native callers may install a Keychain/Keystore-backed identity only for the
/// duration of an operation; the secret is never serialized through this API.
pub struct NativeClient {
    state: Arc<Mutex<ClientState>>,
}

impl NativeClient {
    pub fn new(data_dir: PathBuf, web_dist: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(Mutex::new(new_state(data_dir, web_dist))),
        }
    }

    pub async fn invoke(
        &self,
        method: &str,
        params: Value,
        identity_secret: Option<&[u8]>,
    ) -> Result<Value, String> {
        if method == "connections.list" {
            if identity_secret.is_some() {
                return Err(LinkError::PairingInvalid.code().to_string());
            }
            let (data_dir, metadata_lock) = {
                let guard = self.state.lock().await;
                (guard.data_dir.clone(), guard.metadata_lock.clone())
            };
            let _metadata = metadata_lock.lock().await;
            return list_native_metadata(&data_dir).map_err(|error| error.code().to_string());
        }

        let _identity = match identity_secret {
            Some(secret) => {
                let host = identity_host(method, &params)?;
                let data_dir = self.state.lock().await.data_dir.clone();
                let path = data_dir.join("hosts").join(host).join("identity");
                Some(
                    identity::use_memory_identity(path, secret)
                        .map_err(|_| LinkError::PairingStorageFailed.code().to_string())?,
                )
            }
            None => None,
        };
        dispatch(self.state.clone(), method, params)
            .await
            .map_err(str::to_string)
    }
}

fn list_native_metadata(data_dir: &Path) -> Result<Value, LinkError> {
    let list = read_metadata(&metadata_path(data_dir))?;
    Ok(json!(
        list.into_iter()
            .map(|item| {
                json!({
                    "id": item.get("id").cloned().unwrap_or(Value::Null),
                    "hostEndpointId": item.get("hostEndpointId").cloned().unwrap_or(Value::Null),
                    "hostLabel": item.get("hostLabel").cloned().unwrap_or(Value::String(String::new())),
                    "pairingState": item.get("pairingState").cloned().unwrap_or(Value::String("active".into())),
                    "lastUsedAt": item.get("lastUsedAt").cloned().unwrap_or(Value::from(0)),
                    "lastTransport": item.get("lastTransport").cloned().unwrap_or(Value::Null),
                    "revoked": item.get("revoked").cloned().unwrap_or(Value::Bool(false)),
                    "hasSecureIdentity": item.get("hasSecureIdentity").cloned().unwrap_or(Value::Bool(false)),
                })
            })
            .collect::<Vec<_>>()
    ))
}

fn identity_host(method: &str, params: &Value) -> Result<String, String> {
    match method {
        "pairing.begin" => {
            let raw = params
                .get("ticket")
                .and_then(Value::as_str)
                .ok_or_else(|| LinkError::PairingInvalid.code().to_string())?;
            parse_pairing_ticket(raw)
                .map(|ticket| ticket.host.endpoint_id)
                .map_err(|error| error.code().to_string())
        }
        "connect" => params
            .get("connectionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| LinkError::DeviceUnknown.code().to_string()),
        _ => Err(LinkError::PairingInvalid.code().to_string()),
    }
}

/// Generate a device identity for immediate storage by trusted native code.
/// Do not expose this function to JavaScript-facing bindings.
pub fn generate_identity_secret() -> Vec<u8> {
    iroh::SecretKey::generate().to_bytes().to_vec()
}

/// Native-only helper used to verify that a secure-store record belongs to the
/// expected device endpoint before reconnecting.
pub fn identity_endpoint_id(secret: &[u8]) -> Result<String, String> {
    let mut bytes: [u8; 32] = secret
        .try_into()
        .map_err(|_| LinkError::PairingStorageFailed.code().to_string())?;
    let endpoint = iroh::SecretKey::from_bytes(&bytes).public().to_string();
    bytes.zeroize();
    Ok(endpoint)
}

pub fn run_cli() {
    main();
}

#[cfg(test)]
mod native_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generated_identity_round_trips_without_serialization() {
        let mut secret = generate_identity_secret();
        assert_eq!(secret.len(), 32);
        assert!(!identity_endpoint_id(&secret).unwrap().is_empty());
        secret.zeroize();
    }

    #[test]
    fn identity_secret_is_rejected_for_non_identity_operations() {
        let params = serde_json::json!({});
        assert_eq!(
            identity_host("connections.list", &params),
            Err(LinkError::PairingInvalid.code().to_string())
        );
    }

    #[test]
    fn native_connection_list_exposes_recoverable_state_without_pairing_material() {
        let dir = tempdir().unwrap();
        persist_metadata(
            dir.path(),
            "host-endpoint",
            "Polyth",
            None,
            "pairing-secret-reference",
            "prepared",
            None,
        )
        .unwrap();
        let public = list_native_metadata(dir.path()).unwrap();
        assert_eq!(public[0]["pairingState"], "prepared");
        let text = public.to_string();
        assert!(!text.contains("pairing-secret-reference"));
        assert!(!text.contains("pairingId"));
        assert!(!text.contains("deviceId"));
        assert!(!text.contains("directAddresses"));
        assert!(!text.contains("relayUrls"));
    }
}
