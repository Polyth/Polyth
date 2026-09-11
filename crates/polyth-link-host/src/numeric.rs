use std::sync::Arc;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Instant;

use iroh::endpoint::{Connection, SendStream};
use polyth_link_core::errors::LinkError;
use polyth_link_core::numeric_pairing::{NumericPairing, NumericPairingCode};
use polyth_link_core::numeric_wire::{read_numeric, write_numeric, NumericWireMessage};
use polyth_link_core::pairing::HostPairingState;
use tokio::sync::Mutex;

use crate::HostState;

static NUMERIC_PAIRING: OnceLock<StdMutex<NumericPairing>> = OnceLock::new();

fn manager() -> &'static StdMutex<NumericPairing> {
    NUMERIC_PAIRING.get_or_init(|| StdMutex::new(NumericPairing::new()))
}

pub(crate) fn create_code(
    host_endpoint_id: &str,
    pairing_id: &str,
    now: Instant,
) -> Result<NumericPairingCode, LinkError> {
    manager()
        .lock()
        .map_err(|_| LinkError::TransportProtocolError)?
        .create(host_endpoint_id, pairing_id, now)
}

pub(crate) fn cancel_code(pairing_id: &str) {
    if let Ok(mut pairing) = manager().lock() {
        pairing.cancel(pairing_id);
    }
}

pub(crate) fn invalidate_codes() {
    if let Ok(mut pairing) = manager().lock() {
        pairing.invalidate_all();
    }
}

pub(crate) async fn handle_connection(
    state: Arc<Mutex<HostState>>,
    connection: Connection,
    peer: String,
) -> Result<(), LinkError> {
    let (mut send, mut recv) = connection
        .accept_bi()
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    if recv.is_0rtt() {
        connection.close(0u32.into(), b"0rtt");
        return Err(LinkError::TransportProtocolError);
    }

    let result = handle_exchange(&state, &peer, &mut send, &mut recv).await;
    if let Err(error) = &result {
        let _ = write_numeric(
            &mut send,
            &NumericWireMessage::Rejected {
                code: public_error_code(error).to_string(),
            },
        )
        .await;
    }
    let _ = send.finish();
    connection.close(0u32.into(), b"done");
    result
}

fn public_error_code(error: &LinkError) -> &'static str {
    match error {
        LinkError::RequestRateLimited => LinkError::RequestRateLimited.code(),
        LinkError::HostIdentityMismatch => LinkError::HostIdentityMismatch.code(),
        LinkError::TransportProtocolError => LinkError::TransportProtocolError.code(),
        _ => LinkError::PairingInvalid.code(),
    }
}

async fn handle_exchange(
    state: &Arc<Mutex<HostState>>,
    peer: &str,
    send: &mut SendStream,
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<(), LinkError> {
    match read_numeric(recv).await? {
        NumericWireMessage::BootstrapRequest => {}
        _ => return Err(LinkError::TransportProtocolError),
    }

    let bootstrap = manager()
        .lock()
        .map_err(|_| LinkError::TransportProtocolError)?
        .bootstrap(Instant::now())?;
    {
        let guard = state.lock().await;
        if guard.identity.endpoint_id() != bootstrap.host_endpoint_id {
            return Err(LinkError::HostIdentityMismatch);
        }
    }
    write_numeric(
        send,
        &NumericWireMessage::Bootstrap {
            pairing_id: bootstrap.pairing_id.clone(),
            host_endpoint_id: bootstrap.host_endpoint_id.clone(),
            expires_at: bootstrap.expires_at.clone(),
        },
    )
    .await?;

    let (pairing_id, request) = match read_numeric(recv).await? {
        NumericWireMessage::Start {
            pairing_id,
            request,
        } => (pairing_id, request),
        _ => return Err(LinkError::TransportProtocolError),
    };
    if pairing_id != bootstrap.pairing_id {
        return Err(LinkError::PairingInvalid);
    }

    let challenge = manager()
        .lock()
        .map_err(|_| LinkError::TransportProtocolError)?
        .start_login(peer, &pairing_id, &request, Instant::now())?;
    write_numeric(
        send,
        &NumericWireMessage::Challenge {
            attempt_id: challenge.attempt_id.clone(),
            pairing_id: challenge.pairing_id.clone(),
            host_endpoint_id: challenge.host_endpoint_id.clone(),
            expires_at: challenge.expires_at.clone(),
            response: challenge.response.clone(),
        },
    )
    .await?;

    let (attempt_id, finalization) = match read_numeric(recv).await? {
        NumericWireMessage::Finish {
            attempt_id,
            finalization,
        } => (attempt_id, finalization),
        _ => return Err(LinkError::TransportProtocolError),
    };
    if attempt_id != challenge.attempt_id {
        return Err(LinkError::PairingInvalid);
    }

    let redeemed = manager()
        .lock()
        .map_err(|_| LinkError::TransportProtocolError)?
        .finish_login(peer, &attempt_id, &finalization, Instant::now())?;

    let ticket = {
        let mut guard = state.lock().await;
        if guard.identity.endpoint_id() != challenge.host_endpoint_id {
            return Err(LinkError::HostIdentityMismatch);
        }
        guard.pairing.expire(Instant::now());
        let invitation = guard
            .pairing
            .get(&redeemed.pairing_id)
            .ok_or(LinkError::PairingExpired)?;
        match invitation.state {
            HostPairingState::Created => invitation.ticket.clone(),
            HostPairingState::Expired => return Err(LinkError::PairingExpired),
            HostPairingState::Cancelled => return Err(LinkError::PairingCancelled),
            HostPairingState::Rejected => return Err(LinkError::PairingRejected),
            _ => return Err(LinkError::PairingClaimed),
        }
    };

    write_numeric(send, &NumericWireMessage::Ticket { ticket }).await
}
