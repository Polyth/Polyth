use std::collections::HashMap;
use std::time::Instant;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::errors::LinkError;
use crate::limits::Limits;
use crate::ticket::{
    decode_invite_secret, encode_pairing_ticket, parse_pairing_ticket, PairingCandidate,
    PairingTicket, TicketHost, TicketProtocol, POLYTH_LINK_ALPN,
};
use crate::timefmt::{constant_eq, now_unix_ms, unix_ms_to_rfc3339};
use crate::words::safety_phrase;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPairingState {
    Created,
    Claimed,
    ProofVerified,
    WaitingDeviceConfirmation,
    WaitingHostConfirmation,
    Committing,
    Committed,
    Expired,
    Cancelled,
    Rejected,
    Failed,
}

impl HostPairingState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Claimed => "claimed",
            Self::ProofVerified => "proof-verified",
            Self::WaitingDeviceConfirmation => "waiting-device-confirmation",
            Self::WaitingHostConfirmation => "waiting-host-confirmation",
            Self::Committing => "committing",
            Self::Committed => "committed",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Invitation {
    pub pairing_id: String,
    pub ticket: String,
    pub profile: String,
    pub grants: Vec<String>,
    pub label: String,
    pub state: HostPairingState,
    pub created: Instant,
    /// A one-time invitation link rather than a two-minute on-screen code.
    pub invitation: bool,
    pub claimant: Option<String>,
    pub transcript_hash: Option<[u8; 32]>,
    pub safety_phrase: Option<[String; 4]>,
    pub device_confirmed: bool,
    pub host_confirmed: bool,
    pub device_label: Option<String>,
    pub device_platform: Option<String>,
    pub device_app_version: Option<String>,
    pub proof_attempts: u32,
    pub expires_at_ms: u64,
    pub issued_at: String,
    pub expires_at: String,
    pending_nonces: HashMap<String, ([u8; 32], [u8; 32])>,
    invite_secret: [u8; 32],
}

#[derive(Debug, Clone)]
pub enum PairingEvent {
    Created {
        pairing_id: String,
    },
    Claimed {
        pairing_id: String,
        device_endpoint: String,
    },
    Updated {
        pairing_id: String,
    },
    Finished {
        pairing_id: String,
        state: HostPairingState,
    },
}

pub struct HostPairing {
    limits: Limits,
    invitations: HashMap<String, Invitation>,
    claims_by_endpoint: HashMap<String, Vec<Instant>>,
    global_claims: Vec<Instant>,
}

impl HostPairing {
    pub fn new() -> Self {
        Self {
            limits: Limits::v1(),
            invitations: HashMap::new(),
            claims_by_endpoint: HashMap::new(),
            global_claims: Vec::new(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &mut self,
        host_endpoint: &str,
        host_label: Option<&str>,
        profile: &str,
        grants: Vec<String>,
        relay_urls: Vec<String>,
        direct_addresses: Option<Vec<String>>,
        policy: &str,
        now: Instant,
    ) -> Result<Invitation, LinkError> {
        self.create_kind(
            host_endpoint,
            host_label,
            profile,
            grants,
            relay_urls,
            direct_addresses,
            policy,
            now,
            false,
            None,
        )
    }

    /// A one-time invitation link that may wait days for the person it was sent
    /// to. Its lifetime is clamped to the invitation window and it is confirmed
    /// by the host once the device proves the invite secret, so nobody has to
    /// press Approve.
    #[allow(clippy::too_many_arguments)]
    pub fn create_invitation(
        &mut self,
        host_endpoint: &str,
        host_label: Option<&str>,
        profile: &str,
        grants: Vec<String>,
        relay_urls: Vec<String>,
        direct_addresses: Option<Vec<String>>,
        policy: &str,
        now: Instant,
        ttl_ms: Option<u64>,
    ) -> Result<Invitation, LinkError> {
        self.create_kind(
            host_endpoint,
            host_label,
            profile,
            grants,
            relay_urls,
            direct_addresses,
            policy,
            now,
            true,
            ttl_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create_kind(
        &mut self,
        host_endpoint: &str,
        host_label: Option<&str>,
        profile: &str,
        grants: Vec<String>,
        relay_urls: Vec<String>,
        direct_addresses: Option<Vec<String>>,
        policy: &str,
        now: Instant,
        invitation: bool,
        ttl_ms: Option<u64>,
    ) -> Result<Invitation, LinkError> {
        self.expire(now);
        let cap = if invitation {
            self.limits.active_long_invitations
        } else {
            self.limits.active_invitations
        };
        if self.active_count(invitation, now) >= cap {
            return Err(LinkError::RequestRateLimited);
        }
        let mut pairing_id = [0u8; 16];
        let mut invite_secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut pairing_id);
        rand::thread_rng().fill_bytes(&mut invite_secret);
        let issued_ms = now_unix_ms();
        let ttl = if invitation {
            ttl_ms
                .unwrap_or(self.limits.invitation_ttl_ms)
                .clamp(60_000, self.limits.invitation_ttl_ms)
        } else {
            self.limits.pairing_ttl_ms
        };
        let expires_ms = issued_ms.saturating_add(ttl);
        let issued_at = unix_ms_to_rfc3339(issued_ms).map_err(|_| LinkError::PairingInvalid)?;
        let expires_at = unix_ms_to_rfc3339(expires_ms).map_err(|_| LinkError::PairingInvalid)?;
        let ticket = PairingTicket {
            version: 1,
            kind: "polyth-link-pair".into(),
            pairing_id: URL_SAFE_NO_PAD.encode(pairing_id),
            invite_secret: URL_SAFE_NO_PAD.encode(invite_secret),
            host: TicketHost {
                endpoint_id: host_endpoint.to_string(),
                label: host_label.map(str::to_string),
            },
            issued_at: issued_at.clone(),
            expires_at: expires_at.clone(),
            protocol: TicketProtocol {
                alpn: POLYTH_LINK_ALPN.into(),
                min_version: 1,
                max_version: 1,
            },
            candidates: vec![PairingCandidate {
                kind: "iroh".into(),
                endpoint_id: host_endpoint.to_string(),
                relay_urls: if policy == "air-gapped" {
                    Vec::new()
                } else {
                    relay_urls
                },
                direct_addresses: if policy == "relay-only" {
                    None
                } else {
                    direct_addresses
                },
                priority: 0,
                policy: policy.to_string(),
            }],
            profile: profile.to_string(),
            invitation,
        };
        let encoded = encode_pairing_ticket(&ticket)?;
        let invitation_entry = Invitation {
            pairing_id: ticket.pairing_id.clone(),
            ticket: encoded,
            profile: profile.to_string(),
            grants,
            label: host_label.unwrap_or("").to_string(),
            state: HostPairingState::Created,
            created: now,
            invitation,
            claimant: None,
            transcript_hash: None,
            safety_phrase: None,
            device_confirmed: false,
            host_confirmed: false,
            device_label: None,
            device_platform: None,
            device_app_version: None,
            proof_attempts: 0,
            expires_at_ms: expires_ms,
            issued_at,
            expires_at,
            pending_nonces: HashMap::new(),
            invite_secret,
        };
        self.invitations.insert(
            invitation_entry.pairing_id.clone(),
            invitation_entry.clone(),
        );
        Ok(invitation_entry)
    }

    pub fn get(&self, pairing_id: &str) -> Option<&Invitation> {
        self.invitations.get(pairing_id)
    }

    pub fn challenge(
        &mut self,
        pairing_id: &str,
        device_endpoint: &str,
        client_nonce: [u8; 32],
        now: Instant,
    ) -> Result<[u8; 32], LinkError> {
        self.expire(now);
        let limits = self.limits;
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if is_terminal(invitation.state)
            || invitation.state == HostPairingState::Expired
            || expired(invitation, now, limits)
        {
            return Err(LinkError::PairingExpired);
        }
        if let Some(claimant) = &invitation.claimant {
            if claimant != device_endpoint {
                return Err(LinkError::PairingClaimed);
            }
        }
        if invitation.pending_nonces.len() >= self.limits.pending_nonces_per_invitation
            && !invitation.pending_nonces.contains_key(device_endpoint)
        {
            return Err(LinkError::RequestRateLimited);
        }
        let mut server_nonce = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut server_nonce);
        invitation
            .pending_nonces
            .insert(device_endpoint.to_string(), (client_nonce, server_nonce));
        Ok(server_nonce)
    }

    pub fn note_device(
        &mut self,
        pairing_id: &str,
        device_endpoint: &str,
        label: &str,
        platform: &str,
        app_version: &str,
    ) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if let Some(claimant) = &invitation.claimant {
            if claimant != device_endpoint {
                return Err(LinkError::PairingClaimed);
            }
        }
        invitation.device_label = Some(label.chars().take(80).collect());
        invitation.device_platform = Some(platform.chars().take(32).collect());
        invitation.device_app_version = Some(app_version.chars().take(32).collect());
        Ok(())
    }

    pub fn expire(&mut self, now: Instant) {
        let limits = self.limits;
        for invitation in self.invitations.values_mut() {
            if !is_terminal(invitation.state) && expired(invitation, now, limits) {
                invitation.state = HostPairingState::Expired;
                invitation.invite_secret.zeroize();
            }
        }
    }

    /// Non-terminal, unexpired entries of one kind; the two caps never share
    /// a slot.
    fn active_count(&self, invitation: bool, now: Instant) -> usize {
        let limits = self.limits;
        self.invitations
            .values()
            .filter(|inv| {
                inv.invitation == invitation
                    && !is_terminal(inv.state)
                    && !expired(inv, now, limits)
            })
            .count()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn verify_proof(
        &mut self,
        pairing_id: &str,
        host_endpoint: &str,
        device_endpoint: &str,
        client_nonce: &[u8; 32],
        server_nonce: &[u8; 32],
        proof: &[u8; 32],
        now: Instant,
    ) -> Result<[String; 4], LinkError> {
        self.expire(now);
        self.prune_rate_limits(now);
        if self.global_claims.len() >= 100 {
            return Err(LinkError::RequestRateLimited);
        }
        let endpoint_claims = self
            .claims_by_endpoint
            .entry(device_endpoint.to_string())
            .or_default();
        if endpoint_claims.len() >= 10 {
            return Err(LinkError::RequestRateLimited);
        }
        endpoint_claims.push(now);
        self.global_claims.push(now);

        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if invitation.state == HostPairingState::Expired || expired(invitation, now, self.limits) {
            return Err(LinkError::PairingExpired);
        }
        if is_terminal(invitation.state) {
            return Err(LinkError::PairingInvalid);
        }
        if invitation.proof_attempts >= self.limits.proof_attempts as u32 {
            invitation.state = HostPairingState::Failed;
            return Err(LinkError::PairingInvalid);
        }
        invitation.proof_attempts += 1;
        if let Some(claimant) = &invitation.claimant {
            if claimant != device_endpoint {
                return Err(LinkError::PairingClaimed);
            }
        }
        let stored = invitation
            .pending_nonces
            .get(device_endpoint)
            .copied()
            .ok_or(LinkError::PairingInvalid)?;
        if stored.0 != *client_nonce || stored.1 != *server_nonce {
            return Err(LinkError::PairingInvalid);
        }

        let transcript = transcript_hash(
            pairing_id,
            host_endpoint,
            device_endpoint,
            client_nonce,
            server_nonce,
            &invitation.profile,
        );
        let expected = hmac_proof(&invitation.invite_secret, &transcript);
        if !constant_eq(&expected, proof) {
            return Err(LinkError::PairingInvalid);
        }
        invitation.claimant = Some(device_endpoint.to_string());
        invitation
            .pending_nonces
            .retain(|endpoint, _| endpoint == device_endpoint);
        invitation.state = HostPairingState::Claimed;
        let phrase = safety_phrase(&transcript, proof)?;
        invitation.transcript_hash = Some(transcript);
        invitation.safety_phrase = Some(phrase.clone());
        invitation.state = HostPairingState::ProofVerified;
        // An invitation link carries its authority in the invite secret the
        // person chose to send, so proving it is the host's confirmation. A
        // live code still waits for the owner to press Approve.
        if invitation.invitation {
            invitation.host_confirmed = true;
        }
        Ok(phrase)
    }

    pub fn confirm_device(
        &mut self,
        pairing_id: &str,
        device_endpoint: &str,
        now: Instant,
    ) -> Result<(), LinkError> {
        self.expire(now);
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if invitation.device_confirmed {
            return Ok(());
        }
        if is_terminal(invitation.state) {
            return Err(LinkError::PairingInvalid);
        }
        if invitation.claimant.as_deref() != Some(device_endpoint) {
            return Err(LinkError::PairingInvalid);
        }
        if invitation.transcript_hash.is_none() {
            return Err(LinkError::PairingInvalid);
        }
        invitation.device_confirmed = true;
        self.advance(pairing_id)
    }

    pub fn confirm_host(&mut self, pairing_id: &str, now: Instant) -> Result<(), LinkError> {
        self.expire(now);
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if invitation.host_confirmed {
            return Ok(());
        }
        if is_terminal(invitation.state) {
            return Err(LinkError::PairingInvalid);
        }
        if invitation.transcript_hash.is_none() {
            return Err(LinkError::PairingConfirmationRequired);
        }
        invitation.host_confirmed = true;
        self.advance(pairing_id)
    }

    pub fn reject(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if is_terminal(invitation.state) {
            return Err(LinkError::PairingInvalid);
        }
        invitation.state = HostPairingState::Rejected;
        invitation.invite_secret.zeroize();
        Ok(())
    }

    pub fn cancel(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if is_terminal(invitation.state) {
            return Err(LinkError::PairingInvalid);
        }
        invitation.state = HostPairingState::Cancelled;
        invitation.invite_secret.zeroize();
        Ok(())
    }

    /// Give a one-time invitation back to `created` when the device that
    /// claimed it went away before committing, so the person can open the same
    /// link again. `proof_attempts` survives, so a released link cannot be
    /// brute-forced by reconnecting. Live codes and committing invitations are
    /// never released.
    pub fn release_claim(&mut self, pairing_id: &str, endpoint: &str) -> bool {
        let Some(invitation) = self.invitations.get_mut(pairing_id) else {
            return false;
        };
        if !invitation.invitation
            || invitation.state == HostPairingState::Committing
            || is_terminal(invitation.state)
            || invitation.claimant.as_deref() != Some(endpoint)
        {
            return false;
        }
        invitation.claimant = None;
        invitation.transcript_hash = None;
        invitation.safety_phrase = None;
        invitation.device_confirmed = false;
        invitation.host_confirmed = false;
        invitation.pending_nonces.clear();
        invitation.device_label = None;
        invitation.device_platform = None;
        invitation.device_app_version = None;
        invitation.state = HostPairingState::Created;
        true
    }

    /// Re-admit an invitation link this host issued earlier (for example after
    /// a host restart). The ticket is fully revalidated, so an expired link
    /// stays expired; the profile and secret come from the ticket itself.
    pub fn restore(
        &mut self,
        ticket: &str,
        host_endpoint_id: &str,
        grants: Vec<String>,
        label: Option<&str>,
        now: Instant,
    ) -> Result<String, LinkError> {
        let parsed = parse_pairing_ticket(ticket)?;
        if !parsed.invitation || parsed.host.endpoint_id != host_endpoint_id {
            return Err(LinkError::PairingInvalid);
        }
        if self.invitations.contains_key(&parsed.pairing_id) {
            return Ok(parsed.pairing_id);
        }
        self.expire(now);
        if self.active_count(true, now) >= self.limits.active_long_invitations {
            return Err(LinkError::RequestRateLimited);
        }
        let invite_secret = decode_invite_secret(&parsed)?;
        let expires_at_ms = crate::timefmt::parse_rfc3339_to_unix_ms(&parsed.expires_at)?;
        let encoded = encode_pairing_ticket(&parsed)?;
        let restored = Invitation {
            pairing_id: parsed.pairing_id.clone(),
            ticket: encoded,
            profile: parsed.profile.clone(),
            grants,
            label: label
                .map(str::to_string)
                .or_else(|| parsed.host.label.clone())
                .unwrap_or_default(),
            state: HostPairingState::Created,
            created: now,
            invitation: true,
            claimant: None,
            transcript_hash: None,
            safety_phrase: None,
            device_confirmed: false,
            host_confirmed: false,
            device_label: None,
            device_platform: None,
            device_app_version: None,
            proof_attempts: 0,
            expires_at_ms,
            issued_at: parsed.issued_at.clone(),
            expires_at: parsed.expires_at.clone(),
            pending_nonces: HashMap::new(),
            invite_secret,
        };
        let pairing_id = restored.pairing_id.clone();
        self.invitations.insert(pairing_id.clone(), restored);
        Ok(pairing_id)
    }

    pub fn mark_committed(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if invitation.state == HostPairingState::Committed {
            return Ok(());
        }
        if invitation.state != HostPairingState::Committing {
            return Err(LinkError::PairingInvalid);
        }
        invitation.state = HostPairingState::Committed;
        invitation.invite_secret.zeroize();
        Ok(())
    }

    pub fn mark_storage_failed(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if invitation.state == HostPairingState::Committed {
            return Err(LinkError::PairingInvalid);
        }
        invitation.state = HostPairingState::Failed;
        invitation.invite_secret.zeroize();
        Err(LinkError::PairingStorageFailed)
    }

    pub fn invalidate_all(&mut self) {
        for invitation in self.invitations.values_mut() {
            if !is_terminal(invitation.state) {
                invitation.state = HostPairingState::Expired;
            }
            invitation.invite_secret.zeroize();
        }
        self.invitations.clear();
    }

    fn prune_rate_limits(&mut self, now: Instant) {
        let window = std::time::Duration::from_secs(60);
        self.global_claims
            .retain(|stamp| now.duration_since(*stamp) < window);
        self.claims_by_endpoint.retain(|_, stamps| {
            stamps.retain(|stamp| now.duration_since(*stamp) < window);
            !stamps.is_empty()
        });
    }

    fn advance(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if is_terminal(invitation.state) && invitation.state != HostPairingState::Committing {
            return Err(LinkError::PairingInvalid);
        }
        if invitation.state == HostPairingState::Committing {
            return Ok(());
        }
        if invitation.device_confirmed && invitation.host_confirmed {
            invitation.state = HostPairingState::Committing;
        } else if invitation.device_confirmed {
            invitation.state = HostPairingState::WaitingHostConfirmation;
        } else if invitation.host_confirmed {
            invitation.state = HostPairingState::WaitingDeviceConfirmation;
        }
        Ok(())
    }
}

impl Default for HostPairing {
    fn default() -> Self {
        Self::new()
    }
}

fn is_terminal(state: HostPairingState) -> bool {
    matches!(
        state,
        HostPairingState::Committed
            | HostPairingState::Expired
            | HostPairingState::Cancelled
            | HostPairingState::Rejected
            | HostPairingState::Failed
    )
}

/// One expiry decision for every check. An invitation link lives on the wall
/// clock, so an entry restored after a restart expires when its ticket says it
/// does; a live on-screen code keeps the monotonic clock it was created on.
fn expired(invitation: &Invitation, now: Instant, limits: Limits) -> bool {
    if invitation.invitation {
        now_unix_ms() >= invitation.expires_at_ms
    } else {
        now.duration_since(invitation.created).as_millis() as u64 >= limits.pairing_ttl_ms
    }
}

pub fn transcript_hash(
    pairing_id: &str,
    host_endpoint: &str,
    device_endpoint: &str,
    client_nonce: &[u8; 32],
    server_nonce: &[u8; 32],
    profile: &str,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"polyth-link-transcript-v1");
    hasher.update(1u16.to_be_bytes());
    hasher.update(pairing_id.as_bytes());
    hasher.update(host_endpoint.as_bytes());
    hasher.update(device_endpoint.as_bytes());
    hasher.update(client_nonce);
    hasher.update(server_nonce);
    hasher.update(profile.as_bytes());
    hasher.finalize().into()
}

pub fn hmac_proof(secret: &[u8; 32], transcript: &[u8; 32]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC-SHA256 accepts 32-byte keys");
    mac.update(transcript);
    mac.finalize().into_bytes().into()
}

pub fn client_proof(
    invite_secret: &[u8; 32],
    pairing_id: &str,
    host_endpoint: &str,
    device_endpoint: &str,
    client_nonce: &[u8; 32],
    server_nonce: &[u8; 32],
    profile: &str,
) -> [u8; 32] {
    hmac_proof(
        invite_secret,
        &transcript_hash(
            pairing_id,
            host_endpoint,
            device_endpoint,
            client_nonce,
            server_nonce,
            profile,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(now: Instant) -> (HostPairing, Invitation, String) {
        let mut host = HostPairing::new();
        let invitation = host
            .create(
                &"aa".repeat(32),
                Some("Desk"),
                "interact",
                vec!["core.sessions.read".into()],
                vec!["https://relay.example/".into()],
                None,
                "direct-preferred",
                now,
            )
            .unwrap();
        (host, invitation, "bb".repeat(32))
    }

    #[test]
    fn both_confirmations_required_before_commit() {
        let now = Instant::now();
        let (mut host, invitation, device) = ready(now);
        let client_nonce = [3u8; 32];
        let secret = decode_secret(&invitation.ticket);
        let server_nonce = host
            .challenge(&invitation.pairing_id, &device, client_nonce, now)
            .unwrap();
        let proof = client_proof(
            &secret,
            &invitation.pairing_id,
            &"aa".repeat(32),
            &device,
            &client_nonce,
            &server_nonce,
            "interact",
        );
        host.verify_proof(
            &invitation.pairing_id,
            &"aa".repeat(32),
            &device,
            &client_nonce,
            &server_nonce,
            &proof,
            now,
        )
        .unwrap();
        host.confirm_device(&invitation.pairing_id, &device, now)
            .unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::WaitingHostConfirmation
        );
        host.confirm_host(&invitation.pairing_id, now).unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committing
        );
        host.mark_committed(&invitation.pairing_id).unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committed
        );
    }

    #[test]
    fn second_claimant_is_rejected() {
        let now = Instant::now();
        let (mut host, invitation, device) = ready(now);
        let client_nonce = [3u8; 32];
        let secret = decode_secret(&invitation.ticket);
        let server_nonce = host
            .challenge(&invitation.pairing_id, &device, client_nonce, now)
            .unwrap();
        let proof = client_proof(
            &secret,
            &invitation.pairing_id,
            &"aa".repeat(32),
            &device,
            &client_nonce,
            &server_nonce,
            "interact",
        );
        host.verify_proof(
            &invitation.pairing_id,
            &"aa".repeat(32),
            &device,
            &client_nonce,
            &server_nonce,
            &proof,
            now,
        )
        .unwrap();
        let other = "cc".repeat(32);
        assert_eq!(
            host.challenge(&invitation.pairing_id, &other, client_nonce, now)
                .unwrap_err(),
            LinkError::PairingClaimed
        );
    }

    #[test]
    fn wrong_secret_and_replay_after_commit_fail() {
        let now = Instant::now();
        let (mut host, invitation, device) = ready(now);
        let client_nonce = [3u8; 32];
        let server_nonce = host
            .challenge(&invitation.pairing_id, &device, client_nonce, now)
            .unwrap();
        assert!(host
            .verify_proof(
                &invitation.pairing_id,
                &"aa".repeat(32),
                &device,
                &client_nonce,
                &server_nonce,
                &[9u8; 32],
                now
            )
            .is_err());
    }

    #[test]
    fn restart_invalidates_invitations() {
        let now = Instant::now();
        let (mut host, invitation, _) = ready(now);
        host.invalidate_all();
        assert!(host.get(&invitation.pairing_id).is_none());
    }

    fn decode_secret(ticket: &str) -> [u8; 32] {
        let parsed = crate::ticket::parse_pairing_ticket(ticket).unwrap();
        let bytes = URL_SAFE_NO_PAD.decode(parsed.invite_secret).unwrap();
        bytes.try_into().unwrap()
    }

    #[test]
    fn air_gapped_ticket_has_no_public_relays() {
        let now = Instant::now();
        let mut host = HostPairing::new();
        let invitation = host
            .create(
                &"aa".repeat(32),
                Some("Desk"),
                "interact",
                vec!["core.sessions.read".into()],
                vec!["https://relay.example/".into()],
                Some(vec!["127.0.0.1:9".into()]),
                "air-gapped",
                now,
            )
            .unwrap();
        let ticket = crate::ticket::parse_pairing_ticket(&invitation.ticket).unwrap();
        assert!(ticket.candidates[0].relay_urls.is_empty());
        assert_eq!(ticket.candidates[0].policy, "air-gapped");
        assert_eq!(
            ticket.candidates[0].direct_addresses.as_deref(),
            Some(["127.0.0.1:9".to_string()].as_slice())
        );
    }

    #[test]
    fn expired_invitation_cannot_commit() {
        let now = Instant::now();
        let (mut host, invitation, device) = ready(now);
        host.expire(now + std::time::Duration::from_secs(121));
        assert_eq!(
            host.challenge(
                &invitation.pairing_id,
                &device,
                [1u8; 32],
                now + std::time::Duration::from_secs(121)
            )
            .unwrap_err(),
            LinkError::PairingExpired
        );
    }

    #[test]
    fn duplicate_confirmations_and_committed_finish_are_idempotent() {
        let now = Instant::now();
        let (mut host, invitation, device) = ready(now);
        let client_nonce = [3u8; 32];
        let secret = decode_secret(&invitation.ticket);
        let server_nonce = host
            .challenge(&invitation.pairing_id, &device, client_nonce, now)
            .unwrap();
        let proof = client_proof(
            &secret,
            &invitation.pairing_id,
            &"aa".repeat(32),
            &device,
            &client_nonce,
            &server_nonce,
            "interact",
        );
        host.verify_proof(
            &invitation.pairing_id,
            &"aa".repeat(32),
            &device,
            &client_nonce,
            &server_nonce,
            &proof,
            now,
        )
        .unwrap();
        host.confirm_host(&invitation.pairing_id, now).unwrap();
        host.confirm_device(&invitation.pairing_id, &device, now)
            .unwrap();
        host.confirm_device(&invitation.pairing_id, &device, now)
            .unwrap();
        host.confirm_host(&invitation.pairing_id, now).unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committing
        );
        host.mark_committed(&invitation.pairing_id).unwrap();
        host.mark_committed(&invitation.pairing_id).unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committed
        );
        assert!(host.mark_storage_failed(&invitation.pairing_id).is_err());
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committed
        );
    }

    #[test]
    fn pairing_get_keeps_original_expiration() {
        let now = Instant::now();
        let (host, invitation, _) = ready(now);
        let first = host.get(&invitation.pairing_id).unwrap();
        let issued = first.issued_at.clone();
        let expires = first.expires_at.clone();
        let again = host.get(&invitation.pairing_id).unwrap();
        assert_eq!(again.issued_at, issued);
        assert_eq!(again.expires_at, expires);
        assert_ne!(issued, expires);
    }

    #[test]
    fn rate_limit_clears_after_its_window() {
        let now = Instant::now();
        let (mut host, invitation, device) = ready(now);
        for _ in 0..10 {
            host.global_claims.push(now);
            host.claims_by_endpoint
                .entry(device.clone())
                .or_default()
                .push(now);
        }
        assert_eq!(
            host.verify_proof(
                &invitation.pairing_id,
                &"aa".repeat(32),
                &device,
                &[1u8; 32],
                &[2u8; 32],
                &[3u8; 32],
                now
            )
            .unwrap_err(),
            LinkError::RequestRateLimited
        );
        let later = now + std::time::Duration::from_secs(61);
        let err = host
            .verify_proof(
                &invitation.pairing_id,
                &"aa".repeat(32),
                &device,
                &[1u8; 32],
                &[2u8; 32],
                &[3u8; 32],
                later,
            )
            .unwrap_err();
        assert_ne!(err, LinkError::RequestRateLimited);
    }

    fn live(now: Instant) -> (HostPairing, Invitation, String) {
        let mut host = HostPairing::new();
        let invitation = host
            .create(
                &"aa".repeat(32),
                Some("Desk"),
                "interact",
                vec!["core.sessions.read".into()],
                vec!["https://relay.example/".into()],
                None,
                "direct-preferred",
                now,
            )
            .unwrap();
        (host, invitation, "bb".repeat(32))
    }

    fn invited(now: Instant, ttl_ms: Option<u64>) -> (HostPairing, Invitation, String) {
        let mut host = HostPairing::new();
        let invitation = host
            .create_invitation(
                &"aa".repeat(32),
                Some("Desk"),
                "interact",
                vec!["core.sessions.read".into()],
                vec!["https://relay.example/".into()],
                None,
                "direct-preferred",
                now,
                ttl_ms,
            )
            .unwrap();
        (host, invitation, "bb".repeat(32))
    }

    fn prove(host: &mut HostPairing, invitation: &Invitation, device: &str, now: Instant) {
        let client_nonce = [3u8; 32];
        let secret = decode_secret(&invitation.ticket);
        let server_nonce = host
            .challenge(&invitation.pairing_id, device, client_nonce, now)
            .unwrap();
        let proof = client_proof(
            &secret,
            &invitation.pairing_id,
            &"aa".repeat(32),
            device,
            &client_nonce,
            &server_nonce,
            "interact",
        );
        host.verify_proof(
            &invitation.pairing_id,
            &"aa".repeat(32),
            device,
            &client_nonce,
            &server_nonce,
            &proof,
            now,
        )
        .unwrap();
    }

    fn wrong_proof(host: &mut HostPairing, pairing_id: &str, device: &str, now: Instant) {
        let client_nonce = [7u8; 32];
        let server_nonce = host
            .challenge(pairing_id, device, client_nonce, now)
            .unwrap();
        let _ = host.verify_proof(
            pairing_id,
            &"aa".repeat(32),
            device,
            &client_nonce,
            &server_nonce,
            &[9u8; 32],
            now,
        );
    }

    #[test]
    fn invitation_commits_after_proof_and_device_confirmation_only() {
        let now = Instant::now();
        let (mut host, invitation, device) = invited(now, Some(3_600_000));
        assert!(invitation.invitation);
        prove(&mut host, &invitation, &device, now);
        assert!(host.get(&invitation.pairing_id).unwrap().host_confirmed);
        host.confirm_device(&invitation.pairing_id, &device, now)
            .unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committing
        );
        host.mark_committed(&invitation.pairing_id).unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committed
        );
    }

    #[test]
    fn live_code_still_waits_for_the_owner() {
        let now = Instant::now();
        let (mut host, invitation, device) = live(now);
        prove(&mut host, &invitation, &device, now);
        assert!(!host.get(&invitation.pairing_id).unwrap().host_confirmed);
        host.confirm_device(&invitation.pairing_id, &device, now)
            .unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::WaitingHostConfirmation
        );
        assert!(!host.release_claim(&invitation.pairing_id, &device));
    }

    #[test]
    fn a_dropped_device_releases_its_invitation_claim() {
        let now = Instant::now();
        let (mut host, invitation, device) = invited(now, None);
        prove(&mut host, &invitation, &device, now);
        let other = "cc".repeat(32);
        assert!(!host.release_claim(&invitation.pairing_id, &other));
        assert!(host.release_claim(&invitation.pairing_id, &device));
        let released = host.get(&invitation.pairing_id).unwrap();
        assert_eq!(released.state, HostPairingState::Created);
        assert!(released.claimant.is_none());
        assert!(released.transcript_hash.is_none());
        assert!(released.safety_phrase.is_none());
        assert!(!released.host_confirmed && !released.device_confirmed);
        assert!(released.device_label.is_none());
        assert_eq!(released.proof_attempts, 1);
        // The same link can then be claimed by another device.
        prove(&mut host, &invitation, &other, now);
        assert_eq!(
            host.get(&invitation.pairing_id)
                .unwrap()
                .claimant
                .as_deref(),
            Some(other.as_str())
        );
        // Committing is past the point of no return.
        let (mut host, invitation, device) = invited(now, None);
        prove(&mut host, &invitation, &device, now);
        host.confirm_device(&invitation.pairing_id, &device, now)
            .unwrap();
        assert!(!host.release_claim(&invitation.pairing_id, &device));
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Committing
        );
    }

    #[test]
    fn brute_force_cap_survives_a_release() {
        let now = Instant::now();
        let (mut host, invitation, device) = invited(now, None);
        prove(&mut host, &invitation, &device, now);
        wrong_proof(&mut host, &invitation.pairing_id, &device, now);
        wrong_proof(&mut host, &invitation.pairing_id, &device, now);
        assert_eq!(host.get(&invitation.pairing_id).unwrap().proof_attempts, 3);
        assert!(host.release_claim(&invitation.pairing_id, &device));
        assert_eq!(host.get(&invitation.pairing_id).unwrap().proof_attempts, 3);
        wrong_proof(&mut host, &invitation.pairing_id, &device, now);
        assert_eq!(host.get(&invitation.pairing_id).unwrap().proof_attempts, 4);
        wrong_proof(&mut host, &invitation.pairing_id, &device, now);
        assert_eq!(host.get(&invitation.pairing_id).unwrap().proof_attempts, 5);
        wrong_proof(&mut host, &invitation.pairing_id, &device, now);
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Failed
        );
    }

    #[test]
    fn invitation_and_live_caps_are_independent() {
        let now = Instant::now();
        let host_endpoint = "aa".repeat(32);
        let relays = || vec!["https://relay.example/".to_string()];
        let mut host = HostPairing::new();
        for _ in 0..Limits::v1().active_invitations {
            host.create(
                &host_endpoint,
                Some("Desk"),
                "interact",
                Vec::new(),
                relays(),
                None,
                "direct-preferred",
                now,
            )
            .unwrap();
        }
        assert_eq!(
            host.create(
                &host_endpoint,
                Some("Desk"),
                "interact",
                Vec::new(),
                relays(),
                None,
                "direct-preferred",
                now,
            )
            .unwrap_err(),
            LinkError::RequestRateLimited
        );
        // A long invitation does not consume a live slot and vice versa.
        host.create_invitation(
            &host_endpoint,
            Some("Desk"),
            "interact",
            Vec::new(),
            relays(),
            None,
            "direct-preferred",
            now,
            None,
        )
        .unwrap();
        let mut fresh = HostPairing::new();
        for _ in 0..Limits::v1().active_long_invitations {
            fresh
                .create_invitation(
                    &host_endpoint,
                    Some("Desk"),
                    "interact",
                    Vec::new(),
                    relays(),
                    None,
                    "direct-preferred",
                    now,
                    None,
                )
                .unwrap();
        }
        assert_eq!(
            fresh
                .create_invitation(
                    &host_endpoint,
                    Some("Desk"),
                    "interact",
                    Vec::new(),
                    relays(),
                    None,
                    "direct-preferred",
                    now,
                    None,
                )
                .unwrap_err(),
            LinkError::RequestRateLimited
        );
        fresh
            .create(
                &host_endpoint,
                Some("Desk"),
                "interact",
                Vec::new(),
                relays(),
                None,
                "direct-preferred",
                now,
            )
            .unwrap();
    }

    #[test]
    fn invitation_ttl_is_clamped() {
        let now = Instant::now();
        let (_, short, _) = invited(now, Some(1_000));
        let (_, long, _) = invited(now, Some(u64::MAX));
        let lifetime = |ticket: &str| {
            let parsed = crate::ticket::parse_pairing_ticket(ticket).unwrap();
            assert!(parsed.invitation);
            crate::timefmt::parse_rfc3339_to_unix_ms(&parsed.expires_at).unwrap()
                - crate::timefmt::parse_rfc3339_to_unix_ms(&parsed.issued_at).unwrap()
        };
        // RFC3339 keeps whole seconds, so a boundary reads one second short.
        assert!((59_000..=60_000).contains(&lifetime(&short.ticket)));
        assert!(
            (Limits::v1().invitation_ttl_ms - 1_000..=Limits::v1().invitation_ttl_ms)
                .contains(&lifetime(&long.ticket))
        );
    }

    #[test]
    fn invitations_expire_on_the_wall_clock() {
        let now = Instant::now();
        let (mut host, invitation, device) = invited(now, None);
        // Move the entry's wall-clock expiry into the past, as a restored
        // invitation would be once its ticket runs out.
        host.invitations
            .get_mut(&invitation.pairing_id)
            .unwrap()
            .expires_at_ms = now_unix_ms() - 1;
        host.expire(now);
        let expired = host.get(&invitation.pairing_id).unwrap();
        assert_eq!(expired.state, HostPairingState::Expired);
        assert!(expired.invite_secret.iter().all(|byte| *byte == 0));
        assert_eq!(
            host.challenge(&invitation.pairing_id, &device, [1u8; 32], now)
                .unwrap_err(),
            LinkError::PairingExpired
        );
        assert!(!host.release_claim(&invitation.pairing_id, &device));
    }

    #[test]
    fn restore_revalidates_invitation_tickets() {
        let now = Instant::now();
        let (_, invitation, _) = invited(now, Some(3_600_000));
        let host_endpoint = "aa".repeat(32);
        let mut host = HostPairing::new();
        let id = host
            .restore(
                &invitation.ticket,
                &host_endpoint,
                vec!["core.sessions.read".into()],
                Some("Desk"),
                now,
            )
            .unwrap();
        assert_eq!(id, invitation.pairing_id);
        let restored = host.get(&id).unwrap();
        assert!(restored.invitation);
        assert_eq!(restored.state, HostPairingState::Created);
        assert_eq!(restored.profile, "interact");
        assert_eq!(restored.grants, vec!["core.sessions.read".to_string()]);
        // Restoring twice is idempotent.
        assert_eq!(
            host.restore(&invitation.ticket, &host_endpoint, Vec::new(), None, now)
                .unwrap(),
            id
        );
        // A foreign host id and a live ticket are refused.
        assert_eq!(
            host.restore(&invitation.ticket, &"cd".repeat(32), Vec::new(), None, now)
                .unwrap_err(),
            LinkError::PairingInvalid
        );
        let (_, live_ticket, _) = live(now);
        assert_eq!(
            host.restore(&live_ticket.ticket, &host_endpoint, Vec::new(), None, now)
                .unwrap_err(),
            LinkError::PairingInvalid
        );
        // An expired ticket stays expired.
        let mut old = crate::ticket::parse_pairing_ticket(&invitation.ticket).unwrap();
        old.issued_at = "2020-01-01T00:00:00Z".into();
        old.expires_at = "2020-01-02T00:00:00Z".into();
        assert_eq!(
            host.restore(
                &crate::ticket::encode_pairing_ticket(&old).unwrap(),
                &host_endpoint,
                Vec::new(),
                None,
                now
            )
            .unwrap_err(),
            LinkError::PairingExpired
        );
        host.invalidate_all();
        assert!(host.get(&id).is_none());
    }

    #[test]
    fn reject_and_cancel_are_terminal() {
        let now = Instant::now();
        let (mut host, invitation, _) = ready(now);
        host.reject(&invitation.pairing_id).unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Rejected
        );
        assert!(host.cancel(&invitation.pairing_id).is_err());
        assert!(host.confirm_host(&invitation.pairing_id, now).is_err());
        let (mut host, invitation, _) = ready(now);
        host.cancel(&invitation.pairing_id).unwrap();
        assert_eq!(
            host.get(&invitation.pairing_id).unwrap().state,
            HostPairingState::Cancelled
        );
        assert!(host.reject(&invitation.pairing_id).is_err());
    }
}
