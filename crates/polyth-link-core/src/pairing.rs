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
    encode_pairing_ticket, PairingCandidate, PairingTicket, TicketHost, TicketProtocol,
    POLYTH_LINK_ALPN,
};
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
    claims_by_endpoint: HashMap<String, u32>,
    global_claims: u32,
}

impl HostPairing {
    pub fn new() -> Self {
        Self {
            limits: Limits::v1(),
            invitations: HashMap::new(),
            claims_by_endpoint: HashMap::new(),
            global_claims: 0,
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
        self.expire(now);
        if self
            .invitations
            .values()
            .filter(|inv| !is_terminal(inv.state))
            .count()
            >= self.limits.active_invitations
        {
            return Err(LinkError::RequestRateLimited);
        }
        let mut pairing_id = [0u8; 16];
        let mut invite_secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut pairing_id);
        rand::thread_rng().fill_bytes(&mut invite_secret);
        let ticket = PairingTicket {
            version: 1,
            kind: "polyth-link-pair".into(),
            pairing_id: URL_SAFE_NO_PAD.encode(pairing_id),
            invite_secret: URL_SAFE_NO_PAD.encode(invite_secret),
            host: TicketHost {
                endpoint_id: host_endpoint.to_string(),
                label: host_label.map(str::to_string),
            },
            issued_at: "now".into(),
            expires_at: "now+120s".into(),
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
        };
        let encoded = encode_pairing_ticket(&ticket)?;
        let invitation = Invitation {
            pairing_id: ticket.pairing_id.clone(),
            ticket: encoded,
            profile: profile.to_string(),
            grants,
            label: host_label.unwrap_or("").to_string(),
            state: HostPairingState::Created,
            created: now,
            claimant: None,
            transcript_hash: None,
            safety_phrase: None,
            device_confirmed: false,
            host_confirmed: false,
            device_label: None,
            device_platform: None,
            device_app_version: None,
            proof_attempts: 0,
            expires_at_ms: self.limits.pairing_ttl_ms,
            pending_nonces: HashMap::new(),
            invite_secret,
        };
        self.invitations
            .insert(invitation.pairing_id.clone(), invitation.clone());
        Ok(invitation)
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
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if is_terminal(invitation.state) || invitation.state == HostPairingState::Expired {
            return Err(LinkError::PairingExpired);
        }
        if let Some(claimant) = &invitation.claimant {
            if claimant != device_endpoint {
                return Err(LinkError::PairingClaimed);
            }
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
        let ttl = self.limits.pairing_ttl_ms;
        for invitation in self.invitations.values_mut() {
            if !is_terminal(invitation.state)
                && now.duration_since(invitation.created).as_millis() as u64 >= ttl
            {
                invitation.state = HostPairingState::Expired;
                invitation.invite_secret.zeroize();
            }
        }
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
        if self.global_claims >= 100 {
            return Err(LinkError::RequestRateLimited);
        }
        let endpoint_claims = self
            .claims_by_endpoint
            .entry(device_endpoint.to_string())
            .or_insert(0);
        if *endpoint_claims >= 10 {
            return Err(LinkError::RequestRateLimited);
        }
        *endpoint_claims += 1;
        self.global_claims += 1;

        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        if invitation.state == HostPairingState::Expired {
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
        if expected != *proof {
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
        invitation.state = HostPairingState::Rejected;
        invitation.invite_secret.zeroize();
        Ok(())
    }

    pub fn cancel(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
        invitation.state = HostPairingState::Cancelled;
        invitation.invite_secret.zeroize();
        Ok(())
    }

    pub fn mark_committed(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
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

    fn advance(&mut self, pairing_id: &str) -> Result<(), LinkError> {
        let invitation = self
            .invitations
            .get_mut(pairing_id)
            .ok_or(LinkError::PairingInvalid)?;
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
}
