use std::path::Path;

use polyth_link_client::NativeClient;
use serde_json::{json, Value};
use tempfile::tempdir;

fn write_connections(root: &Path, connections: Value) {
    std::fs::write(
        root.join("connections.json"),
        serde_json::to_vec(&connections).unwrap(),
    )
    .unwrap();
}

fn connection(id: &str, state: &str) -> Value {
    json!({
        "id": id,
        "hostEndpointId": id,
        "hostLabel": id,
        "pairingId": "not-an-invite-secret",
        "pairingState": state,
        "deviceId": if state == "active" { Value::String(format!("device-{id}")) } else { Value::Null },
        "lastUsedAt": 1,
        "lastTransport": Value::Null,
        "revoked": false,
        "hasSecureIdentity": true,
        "activePolicy": "direct-preferred",
        "directAddresses": [],
        "relayUrls": [],
    })
}

#[tokio::test]
async fn prepared_restart_never_masquerades_as_active() {
    let dir = tempdir().unwrap();
    write_connections(dir.path(), json!([connection("host-a", "prepared")]));

    let first = NativeClient::new(dir.path().to_path_buf(), None);
    let before_restart = first
        .invoke("connections.list", json!({}), None)
        .await
        .unwrap();
    assert_eq!(before_restart[0]["pairingState"], "prepared");
    drop(first);

    let restarted = NativeClient::new(dir.path().to_path_buf(), None);
    let after_restart = restarted
        .invoke("connections.list", json!({}), None)
        .await
        .unwrap();
    assert_eq!(after_restart[0]["pairingState"], "prepared");
}

#[tokio::test]
async fn committed_active_record_survives_restart() {
    let dir = tempdir().unwrap();
    write_connections(dir.path(), json!([connection("host-a", "active")]));

    let restarted = NativeClient::new(dir.path().to_path_buf(), None);
    let connections = restarted
        .invoke("connections.list", json!({}), None)
        .await
        .unwrap();
    assert_eq!(connections[0]["pairingState"], "active");
    assert_eq!(connections[0]["hostEndpointId"], "host-a");
}

#[tokio::test]
async fn forgetting_one_host_cannot_mutate_another() {
    let dir = tempdir().unwrap();
    write_connections(
        dir.path(),
        json!([
            connection("host-a", "prepared"),
            connection("host-b", "active")
        ]),
    );

    let client = NativeClient::new(dir.path().to_path_buf(), None);
    client
        .invoke("forget", json!({ "connectionId": "host-a" }), None)
        .await
        .unwrap();

    let connections = client
        .invoke("connections.list", json!({}), None)
        .await
        .unwrap();
    assert_eq!(connections.as_array().unwrap().len(), 1);
    assert_eq!(connections[0]["hostEndpointId"], "host-b");
    assert_eq!(connections[0]["pairingState"], "active");
}
