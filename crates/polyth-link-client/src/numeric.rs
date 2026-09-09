use std::sync::Arc;

use polyth_link_core::net::{bind_link_endpoint, endpoint_addr_from_discovery};
use polyth_link_core::numeric_pairing::{NumericClientLogin, NumericServerChallenge};
use polyth_link_core::numeric_wire::{read_numeric, write_numeric, NumericWireMessage};
use polyth_link_core::transport::TransportPolicy;
use polyth_link_core::{LinkError, POLYTH_NUMERIC_ALPN};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use super::{begin_pairing, identity, leak_code, ClientState, PRI_CONTROL};

pub(super) async fn begin_numeric_pairing(
    state: Arc<Mutex<ClientState>>,
    params: Value,
) -> Result<Value, &'static str> {
    let host_endpoint_id = params
        .get("hostEndpointId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(LinkError::PairingInvalid.code())?
        .to_string();
    let code = params
        .get("code")
        .and_then(Value::as_str)
        .ok_or(LinkError::PairingInvalid.code())?
        .to_string();
    let label = params
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("Mobile device")
        .chars()
        .take(80)
        .collect::<String>();
    let addresses = params
        .get("addresses")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .take(16)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let port = params
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .map(|port| port as u16);

    let host_addr = endpoint_addr_from_discovery(&host_endpoint_id, &addresses, port)
        .map_err(|error| error.code())?;
    if host_addr.ip_addrs().next().is_none() {
        return Err(LinkError::TransportUnavailable.code());
    }
    let identity_path = {
        let guard = state.lock().await;
        guard
            .data_dir
            .join("hosts")
            .join(&host_endpoint_id)
            .join("identity")
    };
    let identity = identity::load_or_create(&identity_path).map_err(super::identity_error_code)?;
    let endpoint = bind_link_endpoint(identity.secret_key(), TransportPolicy::DirectPreferred)
        .await
        .map_err(|_| LinkError::TransportUnavailable.code())?;
    let connection = match timeout(
        Duration::from_secs(20),
        endpoint.connect(host_addr, POLYTH_NUMERIC_ALPN.as_bytes()),
    )
    .await
    {
        Ok(Ok(connection)) => connection,
        _ => {
            endpoint.close().await;
            return Err(LinkError::TransportUnavailable.code());
        }
    };
    if connection.remote_id().to_string() != host_endpoint_id {
        connection.close(0u32.into(), b"identity-mismatch");
        endpoint.close().await;
        return Err(LinkError::HostIdentityMismatch.code());
    }

    let exchange = async {
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|_| LinkError::TransportProtocolError.code())?;
        let _ = send.set_priority(PRI_CONTROL);
        let (login, request) = NumericClientLogin::start(&code, &host_endpoint_id)
            .map_err(|error| error.code())?;
        write_numeric(
            &mut send,
            &NumericWireMessage::Start {
                request: request.request,
            },
        )
        .await
        .map_err(|error| error.code())?;
        let challenge = match read_numeric(&mut recv).await.map_err(|error| error.code())? {
            NumericWireMessage::Challenge {
                attempt_id,
                pairing_id,
                host_endpoint_id,
                response,
            } => NumericServerChallenge {
                attempt_id,
                pairing_id,
                host_endpoint_id,
                response,
            },
            NumericWireMessage::Rejected { code } => return Err(leak_code(code)),
            _ => return Err(LinkError::TransportProtocolError.code()),
        };
        let finish = login.finish(&challenge).map_err(|error| error.code())?;
        write_numeric(
            &mut send,
            &NumericWireMessage::Finish {
                attempt_id: finish.attempt_id,
                finalization: finish.finalization,
            },
        )
        .await
        .map_err(|error| error.code())?;
        let ticket = match read_numeric(&mut recv).await.map_err(|error| error.code())? {
            NumericWireMessage::Ticket { ticket } => ticket,
            NumericWireMessage::Rejected { code } => return Err(leak_code(code)),
            _ => return Err(LinkError::TransportProtocolError.code()),
        };
        let parsed = polyth_link_core::parse_pairing_ticket(&ticket)
            .map_err(|error| error.code())?;
        if parsed.host.endpoint_id != host_endpoint_id || parsed.pairing_id != challenge.pairing_id {
            return Err(LinkError::HostIdentityMismatch.code());
        }
        let _ = send.finish();
        Ok(ticket)
    }
    .await;

    connection.close(0u32.into(), b"numeric-complete");
    endpoint.close().await;
    let ticket = exchange?;
    begin_pairing(
        state,
        json!({
            "ticket": ticket,
            "label": label,
        }),
    )
    .await
}
