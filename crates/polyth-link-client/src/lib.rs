mod numeric;

include!("runtime.rs");

const NATIVE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const NATIVE_PAIRING_TIMEOUT: Duration = Duration::from_secs(120);
const NATIVE_CANCEL_TIMEOUT: Duration = Duration::from_secs(5);

struct NativeInflightOperation {
    generation: u64,
    cancel: tokio::sync::watch::Sender<bool>,
    done: tokio::sync::watch::Receiver<bool>,
    target_connection_id: Option<String>,
    kind: NativeOperationKind,
}

struct NativeOperationLease {
    key: String,
    generation: u64,
    cancel: tokio::sync::watch::Receiver<bool>,
    done: tokio::sync::watch::Sender<bool>,
    target_connection_id: Option<String>,
    previous_session_generation: Option<u64>,
}

struct NativeOperationSpec {
    key: String,
    timeout: Duration,
    cancelled: &'static str,
    target_connection_id: Option<String>,
    kind: NativeOperationKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeOperationKind {
    Other,
    Pairing,
    Recovery,
}

/// In-process adapter over the same client state machine used by the CLI.
/// Native callers may install a Keychain/Keystore-backed identity only for the
/// duration of an operation; the secret is never serialized through this API.
pub struct NativeClient {
    state: Arc<Mutex<ClientState>>,
    inflight: Mutex<HashMap<String, NativeInflightOperation>>,
    next_operation_generation: std::sync::atomic::AtomicU64,
}

impl NativeClient {
    pub fn new(data_dir: PathBuf, web_dist: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(Mutex::new(new_state(data_dir, web_dist))),
            inflight: Mutex::new(HashMap::new()),
            next_operation_generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub async fn invoke(
        &self,
        method: &str,
        params: Value,
        identity_secret: Option<&[u8]>,
    ) -> Result<Value, String> {
        if method == "pairing.begin_numeric" {
            let secret = identity_secret
                .ok_or_else(|| LinkError::PairingStorageFailed.code().to_string())?;
            let host = params
                .get("hostEndpointId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| LinkError::PairingInvalid.code().to_string())?
                .to_string();
            let data_dir = self.state.lock().await.data_dir.clone();
            let path = data_dir.join("hosts").join(&host).join("identity");
            let identity = identity::use_memory_identity(path, secret)
                .map_err(|_| LinkError::PairingStorageFailed.code().to_string())?;
            let spec = NativeOperationSpec {
                key: format!("pairing-begin:{host}"),
                timeout: NATIVE_CONNECT_TIMEOUT,
                cancelled: LinkError::PairingCancelled.code(),
                target_connection_id: Some(host),
                kind: NativeOperationKind::Pairing,
            };
            let lease = self.begin_operation(&spec).await?;
            let result = self
                .run_operation(
                    lease,
                    spec.timeout,
                    spec.cancelled,
                    numeric::begin_numeric_pairing(self.state.clone(), params),
                )
                .await;
            drop(identity);
            return result;
        }

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

        if method == "pairing.cancel" {
            if identity_secret.is_some() {
                return Err(LinkError::PairingInvalid.code().to_string());
            }
            return self.cancel_pairing(&params).await;
        }

        if matches!(method, "disconnect" | "forget") {
            if identity_secret.is_some() {
                return Err(LinkError::PairingInvalid.code().to_string());
            }
            let connection_id = connection_id(&params)?;
            self.interrupt_operation(&connect_operation_key(&connection_id))
                .await?;
            self.interrupt_operation(&format!("recover:{connection_id}"))
                .await?;
            return dispatch(self.state.clone(), method, params)
                .await
                .map_err(str::to_string);
        }

        let spec = self.native_operation_spec(method, &params).await?;
        let lease = match spec.as_ref() {
            Some(spec) => Some(self.begin_operation(spec).await?),
            None => None,
        };

        let identity = match identity_secret {
            Some(secret) => {
                let host = match identity_host(method, &params) {
                    Ok(host) => host,
                    Err(error) => {
                        if let Some(lease) = lease {
                            self.finish_operation(lease).await;
                        }
                        return Err(error);
                    }
                };
                let data_dir = self.state.lock().await.data_dir.clone();
                let path = data_dir.join("hosts").join(host).join("identity");
                match identity::use_memory_identity(path, secret) {
                    Ok(identity) => Some(identity),
                    Err(_) => {
                        if let Some(lease) = lease {
                            self.finish_operation(lease).await;
                        }
                        return Err(LinkError::PairingStorageFailed.code().to_string());
                    }
                }
            }
            None => None,
        };

        let operation = async {
            if method == "connection.recover" {
                connect_existing(
                    self.state.clone(),
                    params,
                    ExistingConnectionMode::RecoverPrepared,
                )
                .await
            } else {
                dispatch(self.state.clone(), method, params).await
            }
        };
        let result = match (spec, lease) {
            (Some(spec), Some(lease)) => {
                self.run_operation(lease, spec.timeout, spec.cancelled, operation)
                    .await
            }
            _ => operation.await.map_err(str::to_string),
        };
        drop(identity);
        result
    }

    async fn native_operation_spec(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Option<NativeOperationSpec>, String> {
        match method {
            "pairing.begin" => {
                let host = identity_host(method, params)?;
                Ok(Some(NativeOperationSpec {
                    key: format!("pairing-begin:{host}"),
                    timeout: NATIVE_CONNECT_TIMEOUT,
                    cancelled: LinkError::PairingCancelled.code(),
                    target_connection_id: Some(host),
                    kind: NativeOperationKind::Pairing,
                }))
            }
            "pairing.confirm" => {
                let attempt_id = params
                    .get("attemptId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| LinkError::PairingInvalid.code().to_string())?;
                let connection_id = self
                    .state
                    .lock()
                    .await
                    .pairing
                    .get(attempt_id)
                    .map(|attempt| attempt.ticket.host.endpoint_id.clone())
                    .ok_or_else(|| LinkError::PairingInvalid.code().to_string())?;
                Ok(Some(NativeOperationSpec {
                    key: pairing_confirm_operation_key(attempt_id),
                    timeout: NATIVE_PAIRING_TIMEOUT,
                    cancelled: LinkError::PairingCancelled.code(),
                    target_connection_id: Some(connection_id),
                    kind: NativeOperationKind::Pairing,
                }))
            }
            "connect" => {
                let id = connection_id(params)?;
                Ok(Some(NativeOperationSpec {
                    key: connect_operation_key(&id),
                    timeout: NATIVE_CONNECT_TIMEOUT,
                    cancelled: LinkError::TransportCancelled.code(),
                    target_connection_id: Some(id),
                    kind: NativeOperationKind::Other,
                }))
            }
            "connection.recover" => {
                let id = connection_id(params)?;
                let pairing_pending = self
                    .state
                    .lock()
                    .await
                    .pairing
                    .values()
                    .any(|attempt| attempt.ticket.host.endpoint_id == id);
                if pairing_pending {
                    return Err(LinkError::PairingConfirmationRequired.code().to_string());
                }
                Ok(Some(NativeOperationSpec {
                    key: format!("recover:{id}"),
                    timeout: NATIVE_CONNECT_TIMEOUT,
                    cancelled: LinkError::TransportCancelled.code(),
                    target_connection_id: Some(id),
                    kind: NativeOperationKind::Recovery,
                }))
            }
            _ => Ok(None),
        }
    }

    async fn begin_operation(
        &self,
        spec: &NativeOperationSpec,
    ) -> Result<NativeOperationLease, String> {
        let generation = self
            .next_operation_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .wrapping_add(1);
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (done_tx, done_rx) = tokio::sync::watch::channel(false);
        let mut inflight = self.inflight.lock().await;
        if spec.target_connection_id.as_ref().is_some_and(|target| {
            inflight.values().any(|operation| {
                operation.target_connection_id.as_ref() == Some(target)
                    && matches!(
                        (spec.kind, operation.kind),
                        (NativeOperationKind::Recovery, NativeOperationKind::Pairing)
                            | (NativeOperationKind::Pairing, NativeOperationKind::Recovery)
                    )
            })
        }) {
            return Err(LinkError::PairingConfirmationRequired.code().to_string());
        }
        let previous = inflight.insert(
            spec.key.clone(),
            NativeInflightOperation {
                generation,
                cancel: cancel_tx,
                done: done_rx,
                target_connection_id: spec.target_connection_id.clone(),
                kind: spec.kind,
            },
        );
        drop(inflight);
        if let Some(previous) = previous {
            let _ = previous.cancel.send(true);
            if let Err(error) = wait_done(previous.done).await {
                self.finish_operation(NativeOperationLease {
                    key: spec.key.clone(),
                    generation,
                    cancel: cancel_rx,
                    done: done_tx,
                    target_connection_id: spec.target_connection_id.clone(),
                    previous_session_generation: None,
                })
                .await;
                return Err(error);
            }
        }

        let current = self
            .inflight
            .lock()
            .await
            .get(&spec.key)
            .is_some_and(|operation| operation.generation == generation);
        if !current || *cancel_rx.borrow() {
            let lease = NativeOperationLease {
                key: spec.key.clone(),
                generation,
                cancel: cancel_rx,
                done: done_tx,
                target_connection_id: spec.target_connection_id.clone(),
                previous_session_generation: None,
            };
            self.finish_operation(lease).await;
            return Err(spec.cancelled.to_string());
        }

        let previous_session_generation = match spec.target_connection_id.as_deref() {
            Some(connection_id) => self
                .state
                .lock()
                .await
                .sessions
                .get(connection_id)
                .map(|session| session.generation),
            None => None,
        };
        if *cancel_rx.borrow() {
            let lease = NativeOperationLease {
                key: spec.key.clone(),
                generation,
                cancel: cancel_rx,
                done: done_tx,
                target_connection_id: spec.target_connection_id.clone(),
                previous_session_generation,
            };
            self.finish_operation(lease).await;
            return Err(spec.cancelled.to_string());
        }

        Ok(NativeOperationLease {
            key: spec.key.clone(),
            generation,
            cancel: cancel_rx,
            done: done_tx,
            target_connection_id: spec.target_connection_id.clone(),
            previous_session_generation,
        })
    }

    async fn run_operation<F>(
        &self,
        mut lease: NativeOperationLease,
        timeout: Duration,
        cancelled: &'static str,
        future: F,
    ) -> Result<Value, String>
    where
        F: std::future::Future<Output = Result<Value, &'static str>>,
    {
        let result = tokio::select! {
            biased;
            changed = lease.cancel.changed() => {
                let _ = changed;
                Err(cancelled.to_string())
            }
            result = tokio::time::timeout(timeout, future) => match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err(LinkError::TransportTimeout.code().to_string()),
            }
        };
        let rollback = matches!(
            &result,
            Err(error)
                if error == cancelled || error == LinkError::TransportTimeout.code()
        );
        if rollback {
            self.rollback_session(&lease).await;
        }
        self.finish_operation(lease).await;
        result
    }

    async fn rollback_session(&self, lease: &NativeOperationLease) {
        let Some(connection_id) = lease.target_connection_id.as_deref() else {
            return;
        };
        let session = {
            let mut state = self.state.lock().await;
            let current_generation = state
                .sessions
                .get(connection_id)
                .map(|session| session.generation);
            if session_generation_changed(lease.previous_session_generation, current_generation) {
                state.sessions.remove(connection_id)
            } else {
                None
            }
        };
        if let Some(session) = session {
            let _ = tokio::time::timeout(
                NATIVE_CANCEL_TIMEOUT,
                close_session(session, b"operation-cancelled"),
            )
            .await;
        }
    }

    async fn finish_operation(&self, lease: NativeOperationLease) {
        let _ = lease.done.send(true);
        let mut inflight = self.inflight.lock().await;
        let current = inflight
            .get(&lease.key)
            .is_some_and(|operation| operation.generation == lease.generation);
        if current {
            inflight.remove(&lease.key);
        }
    }

    async fn interrupt_operation(&self, key: &str) -> Result<(), String> {
        let operation = {
            let inflight = self.inflight.lock().await;
            inflight.get(key).map(|operation| {
                let _ = operation.cancel.send(true);
                operation.done.clone()
            })
        };
        if let Some(done) = operation {
            wait_done(done).await?;
        }
        Ok(())
    }

    async fn cancel_pairing(&self, params: &Value) -> Result<Value, String> {
        let attempt_id = params
            .get("attemptId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| LinkError::PairingInvalid.code().to_string())?;
        self.interrupt_operation(&pairing_confirm_operation_key(attempt_id))
            .await?;
        let attempt = self.state.lock().await.pairing.remove(attempt_id);
        if let Some(attempt) = attempt {
            attempt.connection.close(0u32.into(), b"cancel");
            let _ = tokio::time::timeout(NATIVE_CANCEL_TIMEOUT, attempt.endpoint.close()).await;
        }
        Ok(json!({ "ok": true }))
    }

    /// Stop every in-flight pairing and live tunnel owned by this native
    /// client. Cancellation is signalled before transport teardown so shutdown
    /// never queues behind a blocked pairing/connect operation.
    pub async fn shutdown(&self) {
        let operations = {
            let inflight = self.inflight.lock().await;
            inflight
                .values()
                .map(|operation| {
                    let _ = operation.cancel.send(true);
                    operation.done.clone()
                })
                .collect::<Vec<_>>()
        };
        for done in operations {
            let _ = wait_done(done).await;
        }

        let (pairing, sessions) = {
            let mut state = self.state.lock().await;
            (
                std::mem::take(&mut state.pairing),
                std::mem::take(&mut state.sessions),
            )
        };
        for attempt in pairing.into_values() {
            attempt.connection.close(0u32.into(), b"client-free");
            let _ = tokio::time::timeout(NATIVE_CANCEL_TIMEOUT, attempt.endpoint.close()).await;
        }
        for session in sessions.into_values() {
            let _ = tokio::time::timeout(
                NATIVE_CANCEL_TIMEOUT,
                close_session(session, b"client-free"),
            )
            .await;
        }
    }
}

async fn wait_done(mut done: tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
    if *done.borrow() {
        return Ok(());
    }
    tokio::time::timeout(NATIVE_CANCEL_TIMEOUT, async {
        while !*done.borrow() {
            if done.changed().await.is_err() {
                break;
            }
        }
    })
    .await
    .map_err(|_| LinkError::TransportTimeout.code().to_string())?;
    Ok(())
}

fn pairing_confirm_operation_key(attempt_id: &str) -> String {
    format!("pairing-confirm:{attempt_id}")
}

fn connect_operation_key(connection_id: &str) -> String {
    format!("connect:{connection_id}")
}

fn connection_id(params: &Value) -> Result<String, String> {
    params
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| LinkError::DeviceUnknown.code().to_string())
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
        "connect" | "connection.recover" => connection_id(params),
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

fn session_generation_changed(previous: Option<u64>, current: Option<u64>) -> bool {
    current.is_some() && current != previous
}

#[cfg(test)]
mod native_tests {
    use super::*;
    use tempfile::tempdir;

    fn spec(key: &str, cancelled: &'static str) -> NativeOperationSpec {
        NativeOperationSpec {
            key: key.into(),
            timeout: Duration::from_secs(1),
            cancelled,
            target_connection_id: None,
            kind: NativeOperationKind::Other,
        }
    }

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

    #[tokio::test]
    async fn native_operation_deadline_terminates_a_silent_future() {
        let dir = tempdir().unwrap();
        let client = NativeClient::new(dir.path().to_path_buf(), None);
        let mut spec = spec("test:timeout", LinkError::TransportCancelled.code());
        spec.timeout = Duration::from_millis(5);
        let lease = client.begin_operation(&spec).await.unwrap();
        let result = client
            .run_operation(
                lease,
                spec.timeout,
                spec.cancelled,
                std::future::pending::<Result<Value, &'static str>>(),
            )
            .await;
        assert_eq!(result, Err(LinkError::TransportTimeout.code().to_string()));
        assert!(client.inflight.lock().await.is_empty());
    }

    #[tokio::test]
    async fn cancel_reaches_pairing_confirm_while_host_approval_is_pending() {
        let dir = tempdir().unwrap();
        let client = Arc::new(NativeClient::new(dir.path().to_path_buf(), None));
        let key = pairing_confirm_operation_key("attempt-a");
        let spec = spec(&key, LinkError::PairingCancelled.code());
        let lease = client.begin_operation(&spec).await.unwrap();
        let worker = client.clone();
        let task = tokio::spawn(async move {
            worker
                .run_operation(
                    lease,
                    Duration::from_secs(1),
                    LinkError::PairingCancelled.code(),
                    std::future::pending::<Result<Value, &'static str>>(),
                )
                .await
        });
        tokio::task::yield_now().await;
        client.interrupt_operation(&key).await.unwrap();
        assert_eq!(
            task.await.unwrap(),
            Err(LinkError::PairingCancelled.code().to_string())
        );
        assert!(client.inflight.lock().await.is_empty());
    }

    #[tokio::test]
    async fn disconnect_reaches_connect_while_transport_is_pending() {
        let dir = tempdir().unwrap();
        let client = Arc::new(NativeClient::new(dir.path().to_path_buf(), None));
        let key = connect_operation_key("host-a");
        let spec = spec(&key, LinkError::TransportCancelled.code());
        let lease = client.begin_operation(&spec).await.unwrap();
        let worker = client.clone();
        let task = tokio::spawn(async move {
            worker
                .run_operation(
                    lease,
                    Duration::from_secs(1),
                    LinkError::TransportCancelled.code(),
                    std::future::pending::<Result<Value, &'static str>>(),
                )
                .await
        });
        tokio::task::yield_now().await;
        client.interrupt_operation(&key).await.unwrap();
        assert_eq!(
            task.await.unwrap(),
            Err(LinkError::TransportCancelled.code().to_string())
        );
        assert!(client.inflight.lock().await.is_empty());
    }

    #[tokio::test]
    async fn shutdown_interrupts_a_pending_operation() {
        let dir = tempdir().unwrap();
        let client = Arc::new(NativeClient::new(dir.path().to_path_buf(), None));
        let spec = spec(
            &connect_operation_key("host-a"),
            LinkError::TransportCancelled.code(),
        );
        let lease = client.begin_operation(&spec).await.unwrap();
        let worker = client.clone();
        let task = tokio::spawn(async move {
            worker
                .run_operation(
                    lease,
                    Duration::from_secs(1),
                    LinkError::TransportCancelled.code(),
                    std::future::pending::<Result<Value, &'static str>>(),
                )
                .await
        });
        tokio::task::yield_now().await;
        client.shutdown().await;
        assert_eq!(
            task.await.unwrap(),
            Err(LinkError::TransportCancelled.code().to_string())
        );
        assert!(client.inflight.lock().await.is_empty());
    }

    #[tokio::test]
    async fn repeated_pairing_cancel_is_idempotent() {
        let dir = tempdir().unwrap();
        let client = NativeClient::new(dir.path().to_path_buf(), None);
        let params = json!({ "attemptId": "missing-attempt" });
        assert_eq!(
            client.invoke("pairing.cancel", params.clone(), None).await,
            Ok(json!({ "ok": true }))
        );
        assert_eq!(
            client.invoke("pairing.cancel", params, None).await,
            Ok(json!({ "ok": true }))
        );
    }

    #[tokio::test]
    async fn replacement_generation_cancels_old_completion_without_removing_new() {
        let dir = tempdir().unwrap();
        let client = Arc::new(NativeClient::new(dir.path().to_path_buf(), None));
        let spec = spec("connect:host-a", LinkError::TransportCancelled.code());
        let first = client.begin_operation(&spec).await.unwrap();
        let first_generation = first.generation;
        let client_for_first = client.clone();
        let first_task = tokio::spawn(async move {
            client_for_first
                .run_operation(
                    first,
                    Duration::from_secs(1),
                    LinkError::TransportCancelled.code(),
                    std::future::pending::<Result<Value, &'static str>>(),
                )
                .await
        });
        tokio::task::yield_now().await;
        let second = client.begin_operation(&spec).await.unwrap();
        assert_eq!(
            first_task.await.unwrap(),
            Err(LinkError::TransportCancelled.code().to_string())
        );
        assert!(second.generation > first_generation || first_generation == u64::MAX);
        assert_eq!(
            client
                .inflight
                .lock()
                .await
                .get(&spec.key)
                .map(|operation| operation.generation),
            Some(second.generation)
        );
        client.finish_operation(second).await;
    }

    #[tokio::test]
    async fn cancellation_is_idempotent_and_host_scoped() {
        let dir = tempdir().unwrap();
        let client = NativeClient::new(dir.path().to_path_buf(), None);
        let host_a = spec("connect:host-a", LinkError::TransportCancelled.code());
        let host_b = spec("connect:host-b", LinkError::TransportCancelled.code());
        let mut a = client.begin_operation(&host_a).await.unwrap();
        let b = client.begin_operation(&host_b).await.unwrap();
        {
            let inflight = client.inflight.lock().await;
            let _ = inflight.get(&host_a.key).unwrap().cancel.send(true);
            let _ = inflight.get(&host_a.key).unwrap().cancel.send(true);
        }
        a.cancel.changed().await.unwrap();
        assert!(*a.cancel.borrow());
        assert!(!*b.cancel.borrow());
        client.finish_operation(a).await;
        client.finish_operation(b).await;
    }

    #[tokio::test]
    async fn recovery_and_pairing_are_mutually_exclusive_per_host() {
        let dir = tempdir().unwrap();
        let client = NativeClient::new(dir.path().to_path_buf(), None);
        let pairing = NativeOperationSpec {
            key: "pairing-confirm:attempt".into(),
            timeout: Duration::from_secs(1),
            cancelled: LinkError::PairingCancelled.code(),
            target_connection_id: Some("host-a".into()),
            kind: NativeOperationKind::Pairing,
        };
        let recovery = NativeOperationSpec {
            key: "recover:host-a".into(),
            timeout: Duration::from_secs(1),
            cancelled: LinkError::TransportCancelled.code(),
            target_connection_id: Some("host-a".into()),
            kind: NativeOperationKind::Recovery,
        };
        let pairing_lease = client.begin_operation(&pairing).await.unwrap();
        assert_eq!(
            client.begin_operation(&recovery).await.err(),
            Some(LinkError::PairingConfirmationRequired.code().to_string())
        );
        client.finish_operation(pairing_lease).await;
    }

    #[test]
    fn rollback_only_targets_a_changed_session_generation() {
        assert!(!session_generation_changed(None, None));
        assert!(!session_generation_changed(Some(7), Some(7)));
        assert!(session_generation_changed(None, Some(8)));
        assert!(session_generation_changed(Some(7), Some(8)));
    }

    #[tokio::test]
    async fn native_shutdown_is_idempotent_without_live_state() {
        let dir = tempdir().unwrap();
        let client = NativeClient::new(dir.path().to_path_buf(), None);
        client.shutdown().await;
        client.shutdown().await;
    }
}
