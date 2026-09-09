use std::collections::HashMap;
use std::time::{Duration, Instant};

use opaque_ke::ksf::Identity;
use opaque_ke::{
    CipherSuite, ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialFinalization, CredentialRequest,
    CredentialResponse, Ristretto255, ServerLogin, ServerLoginParameters, ServerRegistration,
    ServerSetup, TripleDh,
};
use rand::rngs::OsRng;
use rand::{Rng, RngCore};
use sha2::Sha512;
use zeroize::{Zeroize, Zeroizing};

use crate::errors::LinkError;
use crate::timefmt::{now_unix_ms, unix_ms_to_rfc3339};

const NUMERIC_TTL: Duration = Duration::from_secs(120);
const ATTEMPT_WINDOW: Duration = Duration::from_secs(10 * 60);
const COOLDOWN: Duration = Duration::from_secs(10 * 60);
const MAX_CLIENT_ATTEMPTS: usize = 3;
const MAX_ENDPOINT_ATTEMPTS: usize = 6;
const MAX_GLOBAL_ATTEMPTS: usize = 30;
const MAX_PENDING_LOGINS: usize = 16;

struct NumericCipherSuite;

impl CipherSuite for NumericCipherSuite {
    type OprfCs = Ristretto255;
    type KeyExchange = TripleDh<Ristretto255, Sha512>;
    type Ksf = Identity;
}

#[derive(Clone, Copy)]
struct RateAttempt {
    id: u64,
    at: Instant,
}

pub struct NumericPairing {
    setup: ServerSetup<NumericCipherSuite>,
    active: Option<NumericInvitation>,
    pending: HashMap<String, PendingLogin>,
    attempts_by_client: HashMap<(String, String), usize>,
    attempts_by_endpoint: HashMap<String, Vec<RateAttempt>>,
    endpoint_cooldowns: HashMap<String, Instant>,
    global_attempts: Vec<RateAttempt>,
    host_cooldown_until: Option<Instant>,
    next_rate_attempt_id: u64,
}

struct NumericInvitation {
    pairing_id: String,
    host_endpoint_id: String,
    expires_at: String,
    credential_id: Vec<u8>,
    password_file: Vec<u8>,
    created: Instant,
    redeemed: bool,
}

struct PendingLogin {
    pairing_id: String,
    device_endpoint_id: String,
    state: ServerLogin<NumericCipherSuite>,
    created: Instant,
    rate_attempt_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericPairingCode {
    pub code: String,
    pub pairing_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericBootstrap {
    pub pairing_id: String,
    pub host_endpoint_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericServerChallenge {
    pub attempt_id: String,
    pub pairing_id: String,
    pub host_endpoint_id: String,
    pub expires_at: String,
    pub response: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericClientRequest {
    pub request: Vec<u8>,
}

pub struct NumericClientLogin {
    state: ClientLogin<NumericCipherSuite>,
    code: Zeroizing<Vec<u8>>,
    expected_host_endpoint_id: String,
    expected_pairing_id: String,
    expected_expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericClientFinish {
    pub attempt_id: String,
    pub finalization: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericPairingRedeemed {
    pub pairing_id: String,
}

impl NumericPairing {
    pub fn new() -> Self {
        let mut rng = OsRng;
        Self {
            setup: ServerSetup::<NumericCipherSuite>::new(&mut rng),
            active: None,
            pending: HashMap::new(),
            attempts_by_client: HashMap::new(),
            attempts_by_endpoint: HashMap::new(),
            endpoint_cooldowns: HashMap::new(),
            global_attempts: Vec::new(),
            host_cooldown_until: None,
            next_rate_attempt_id: 0,
        }
    }

    pub fn create(
        &mut self,
        host_endpoint_id: &str,
        pairing_id: &str,
        now: Instant,
    ) -> Result<NumericPairingCode, LinkError> {
        validate_endpoint(host_endpoint_id)?;
        validate_pairing_id(pairing_id)?;
        self.invalidate_active();
        self.prune_rate_limits(now);

        let mut rng = OsRng;
        let code = format!("{:06}", rng.gen_range(0..1_000_000u32));
        let credential_id = credential_id(host_endpoint_id, pairing_id);
        let password_file = register_password(&self.setup, code.as_bytes(), &credential_id)?;
        let expires_at = unix_ms_to_rfc3339(
            now_unix_ms().saturating_add(NUMERIC_TTL.as_millis() as u64),
        )
        .map_err(|_| LinkError::PairingInvalid)?;

        self.active = Some(NumericInvitation {
            pairing_id: pairing_id.to_string(),
            host_endpoint_id: host_endpoint_id.to_string(),
            expires_at: expires_at.clone(),
            credential_id,
            password_file,
            created: now,
            redeemed: false,
        });

        Ok(NumericPairingCode {
            code,
            pairing_id: pairing_id.to_string(),
            expires_at,
        })
    }

    pub fn bootstrap(&mut self, now: Instant) -> Result<NumericBootstrap, LinkError> {
        self.expire(now);
        let active = self.active.as_ref().ok_or(LinkError::PairingExpired)?;
        if active.redeemed {
            return Err(LinkError::PairingClaimed);
        }
        Ok(NumericBootstrap {
            pairing_id: active.pairing_id.clone(),
            host_endpoint_id: active.host_endpoint_id.clone(),
            expires_at: active.expires_at.clone(),
        })
    }

    pub fn cancel(&mut self, pairing_id: &str) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.pairing_id == pairing_id)
        {
            self.invalidate_active();
        }
    }

    pub fn invalidate_all(&mut self) {
        self.invalidate_active();
    }

    pub fn start_login(
        &mut self,
        device_endpoint_id: &str,
        pairing_id: &str,
        request: &[u8],
        now: Instant,
    ) -> Result<NumericServerChallenge, LinkError> {
        validate_endpoint(device_endpoint_id)?;
        validate_pairing_id(pairing_id)?;
        self.expire(now);
        self.prune_rate_limits(now);

        let active = self.active.as_ref().ok_or(LinkError::PairingExpired)?;
        if active.pairing_id != pairing_id {
            return Err(LinkError::PairingInvalid);
        }
        if active.redeemed {
            return Err(LinkError::PairingClaimed);
        }
        if self.pending.len() >= MAX_PENDING_LOGINS {
            return Err(LinkError::RequestRateLimited);
        }
        let rate_attempt_id = self.reserve_attempt(device_endpoint_id, pairing_id, now)?;

        let active = self.active.as_ref().ok_or(LinkError::PairingExpired)?;
        let credential_request = CredentialRequest::<NumericCipherSuite>::deserialize(request)
            .map_err(|_| LinkError::PairingInvalid)?;
        let password_file = ServerRegistration::<NumericCipherSuite>::deserialize(
            &active.password_file,
        )
        .map_err(|_| LinkError::PairingInvalid)?;
        let transcript = context(
            &active.host_endpoint_id,
            &active.pairing_id,
            &active.expires_at,
        );
        let mut rng = OsRng;
        let started = ServerLogin::start(
            &mut rng,
            &self.setup,
            Some(password_file),
            credential_request,
            &active.credential_id,
            ServerLoginParameters {
                context: Some(&transcript),
                ..ServerLoginParameters::default()
            },
        )
        .map_err(|_| LinkError::PairingInvalid)?;

        self.pending
            .retain(|_, pending| pending.device_endpoint_id != device_endpoint_id);
        let attempt_id = random_id();
        self.pending.insert(
            attempt_id.clone(),
            PendingLogin {
                pairing_id: active.pairing_id.clone(),
                device_endpoint_id: device_endpoint_id.to_string(),
                state: started.state,
                created: now,
                rate_attempt_id,
            },
        );

        Ok(NumericServerChallenge {
            attempt_id,
            pairing_id: active.pairing_id.clone(),
            host_endpoint_id: active.host_endpoint_id.clone(),
            expires_at: active.expires_at.clone(),
            response: started.message.serialize().to_vec(),
        })
    }

    pub fn finish_login(
        &mut self,
        device_endpoint_id: &str,
        attempt_id: &str,
        finalization: &[u8],
        now: Instant,
    ) -> Result<NumericPairingRedeemed, LinkError> {
        validate_endpoint(device_endpoint_id)?;
        self.expire(now);
        let pending = self
            .pending
            .remove(attempt_id)
            .ok_or(LinkError::PairingInvalid)?;
        if pending.device_endpoint_id != device_endpoint_id {
            return Err(LinkError::PairingInvalid);
        }
        if now.duration_since(pending.created) >= NUMERIC_TTL {
            return Err(LinkError::PairingExpired);
        }
        let rate_attempt_id = pending.rate_attempt_id;

        let pairing_id = {
            let active = self.active.as_mut().ok_or(LinkError::PairingExpired)?;
            if active.pairing_id != pending.pairing_id {
                return Err(LinkError::PairingExpired);
            }
            if active.redeemed {
                return Err(LinkError::PairingClaimed);
            }
            let message = CredentialFinalization::<NumericCipherSuite>::deserialize(finalization)
                .map_err(|_| LinkError::PairingInvalid)?;
            let transcript = context(
                &active.host_endpoint_id,
                &active.pairing_id,
                &active.expires_at,
            );
            pending
                .state
                .finish(
                    message,
                    ServerLoginParameters {
                        context: Some(&transcript),
                        ..ServerLoginParameters::default()
                    },
                )
                .map_err(|_| LinkError::PairingInvalid)?;

            active.redeemed = true;
            active.password_file.zeroize();
            active.pairing_id.clone()
        };

        self.refund_success(device_endpoint_id, &pairing_id, rate_attempt_id);
        self.pending.clear();
        Ok(NumericPairingRedeemed { pairing_id })
    }

    pub fn active_pairing_id(&mut self, now: Instant) -> Option<&str> {
        self.expire(now);
        self.active.as_ref().map(|active| active.pairing_id.as_str())
    }

    fn reserve_attempt(
        &mut self,
        device_endpoint_id: &str,
        pairing_id: &str,
        now: Instant,
    ) -> Result<u64, LinkError> {
        if self.host_cooldown_until.is_some_and(|until| now < until) {
            return Err(LinkError::RequestRateLimited);
        }
        if self
            .endpoint_cooldowns
            .get(device_endpoint_id)
            .is_some_and(|until| now < *until)
        {
            return Err(LinkError::RequestRateLimited);
        }

        let client_key = (pairing_id.to_string(), device_endpoint_id.to_string());
        let client_attempts = self.attempts_by_client.entry(client_key).or_default();
        if *client_attempts >= MAX_CLIENT_ATTEMPTS {
            return Err(LinkError::RequestRateLimited);
        }

        let endpoint_attempts = self
            .attempts_by_endpoint
            .entry(device_endpoint_id.to_string())
            .or_default();
        if endpoint_attempts.len() >= MAX_ENDPOINT_ATTEMPTS {
            self.endpoint_cooldowns
                .insert(device_endpoint_id.to_string(), now + COOLDOWN);
            return Err(LinkError::RequestRateLimited);
        }
        if self.global_attempts.len() >= MAX_GLOBAL_ATTEMPTS {
            self.host_cooldown_until = Some(now + COOLDOWN);
            return Err(LinkError::RequestRateLimited);
        }

        self.next_rate_attempt_id = self.next_rate_attempt_id.wrapping_add(1);
        if self.next_rate_attempt_id == 0 {
            self.next_rate_attempt_id = 1;
        }
        let rate_attempt = RateAttempt {
            id: self.next_rate_attempt_id,
            at: now,
        };
        *client_attempts += 1;
        endpoint_attempts.push(rate_attempt);
        self.global_attempts.push(rate_attempt);
        Ok(rate_attempt.id)
    }

    fn refund_success(
        &mut self,
        device_endpoint_id: &str,
        pairing_id: &str,
        rate_attempt_id: u64,
    ) {
        let key = (pairing_id.to_string(), device_endpoint_id.to_string());
        let remove_client = if let Some(attempts) = self.attempts_by_client.get_mut(&key) {
            *attempts = attempts.saturating_sub(1);
            *attempts == 0
        } else {
            false
        };
        if remove_client {
            self.attempts_by_client.remove(&key);
        }

        let remove_endpoint = if let Some(attempts) = self.attempts_by_endpoint.get_mut(device_endpoint_id) {
            attempts.retain(|attempt| attempt.id != rate_attempt_id);
            attempts.is_empty()
        } else {
            false
        };
        if remove_endpoint {
            self.attempts_by_endpoint.remove(device_endpoint_id);
        }
        self.global_attempts
            .retain(|attempt| attempt.id != rate_attempt_id);
    }

    fn expire(&mut self, now: Instant) {
        let expired = self
            .active
            .as_ref()
            .is_some_and(|active| now.duration_since(active.created) >= NUMERIC_TTL);
        if expired {
            self.invalidate_active();
        }
        self.pending
            .retain(|_, pending| now.duration_since(pending.created) < NUMERIC_TTL);
    }

    fn prune_rate_limits(&mut self, now: Instant) {
        self.global_attempts
            .retain(|attempt| now.duration_since(attempt.at) < ATTEMPT_WINDOW);
        self.attempts_by_endpoint.retain(|_, attempts| {
            attempts.retain(|attempt| now.duration_since(attempt.at) < ATTEMPT_WINDOW);
            !attempts.is_empty()
        });
        self.endpoint_cooldowns.retain(|_, until| now < *until);
        if self.host_cooldown_until.is_some_and(|until| now >= until) {
            self.host_cooldown_until = None;
        }
    }

    fn invalidate_active(&mut self) {
        if let Some(mut active) = self.active.take() {
            let pairing_id = active.pairing_id.clone();
            active.password_file.zeroize();
            self.attempts_by_client
                .retain(|(candidate, _), _| candidate != &pairing_id);
        }
        self.pending.clear();
    }
}

impl Default for NumericPairing {
    fn default() -> Self {
        Self::new()
    }
}

impl NumericClientLogin {
    pub fn start(
        code: &str,
        expected_host_endpoint_id: &str,
        expected_pairing_id: &str,
        expected_expires_at: &str,
    ) -> Result<(Self, NumericClientRequest), LinkError> {
        validate_endpoint(expected_host_endpoint_id)?;
        validate_pairing_id(expected_pairing_id)?;
        if expected_expires_at.is_empty() || expected_expires_at.len() > 64 {
            return Err(LinkError::PairingInvalid);
        }
        let normalized = normalize_code(code)?;
        let mut rng = OsRng;
        let started = ClientLogin::<NumericCipherSuite>::start(&mut rng, normalized.as_bytes())
            .map_err(|_| LinkError::PairingInvalid)?;
        Ok((
            Self {
                state: started.state,
                code: Zeroizing::new(normalized.into_bytes()),
                expected_host_endpoint_id: expected_host_endpoint_id.to_string(),
                expected_pairing_id: expected_pairing_id.to_string(),
                expected_expires_at: expected_expires_at.to_string(),
            },
            NumericClientRequest {
                request: started.message.serialize().to_vec(),
            },
        ))
    }

    pub fn finish(
        self,
        challenge: &NumericServerChallenge,
    ) -> Result<NumericClientFinish, LinkError> {
        if challenge.host_endpoint_id != self.expected_host_endpoint_id {
            return Err(LinkError::HostIdentityMismatch);
        }
        if challenge.pairing_id != self.expected_pairing_id
            || challenge.expires_at != self.expected_expires_at
        {
            return Err(LinkError::PairingInvalid);
        }
        let response = CredentialResponse::<NumericCipherSuite>::deserialize(&challenge.response)
            .map_err(|_| LinkError::PairingInvalid)?;
        let transcript = context(
            &challenge.host_endpoint_id,
            &challenge.pairing_id,
            &challenge.expires_at,
        );
        let mut rng = OsRng;
        let finished = self
            .state
            .finish(
                &mut rng,
                &self.code,
                response,
                ClientLoginFinishParameters {
                    context: Some(&transcript),
                    ..ClientLoginFinishParameters::default()
                },
            )
            .map_err(|_| LinkError::PairingInvalid)?;
        Ok(NumericClientFinish {
            attempt_id: challenge.attempt_id.clone(),
            finalization: finished.message.serialize().to_vec(),
        })
    }
}

pub fn normalize_code(code: &str) -> Result<String, LinkError> {
    let normalized: String = code.chars().filter(|ch| !ch.is_whitespace()).collect();
    if normalized.len() != 6 || !normalized.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(LinkError::PairingInvalid);
    }
    Ok(normalized)
}

fn register_password(
    setup: &ServerSetup<NumericCipherSuite>,
    password: &[u8],
    credential_id: &[u8],
) -> Result<Vec<u8>, LinkError> {
    let mut rng = OsRng;
    let client = ClientRegistration::<NumericCipherSuite>::start(&mut rng, password)
        .map_err(|_| LinkError::PairingInvalid)?;
    let server = ServerRegistration::<NumericCipherSuite>::start(
        setup,
        client.message,
        credential_id,
    )
    .map_err(|_| LinkError::PairingInvalid)?;
    let upload = client
        .state
        .finish(
            &mut rng,
            password,
            server.message,
            ClientRegistrationFinishParameters::default(),
        )
        .map_err(|_| LinkError::PairingInvalid)?;
    Ok(ServerRegistration::<NumericCipherSuite>::finish(upload.message)
        .serialize()
        .to_vec())
}

fn credential_id(host_endpoint_id: &str, pairing_id: &str) -> Vec<u8> {
    format!("polyth-numeric-v1:{host_endpoint_id}:{pairing_id}").into_bytes()
}

fn context(host_endpoint_id: &str, pairing_id: &str, expires_at: &str) -> Vec<u8> {
    format!(
        "polyth-link/numeric-pair/v1/{host_endpoint_id}/{pairing_id}/{expires_at}"
    )
    .into_bytes()
}

fn validate_endpoint(value: &str) -> Result<(), LinkError> {
    if value.len() < 32
        || value.len() > 64
        || !value.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(LinkError::PairingInvalid);
    }
    Ok(())
}

fn validate_pairing_id(value: &str) -> Result<(), LinkError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(LinkError::PairingInvalid);
    }
    Ok(())
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DEVICE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn device(index: usize) -> String {
        format!("{:052}", index)
    }

    #[test]
    fn bootstrap_is_opaque_pairing_id_and_binds_expiry_into_opaque_context() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "bootstrap_A-1", now).unwrap();
        let bootstrap = server.bootstrap(now).unwrap();
        assert_eq!(bootstrap.pairing_id, code.pairing_id);

        let (client, request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        let challenge = server
            .start_login(DEVICE, &bootstrap.pairing_id, &request.request, now)
            .unwrap();
        let finish = client.finish(&challenge).unwrap();
        let redeemed = server
            .finish_login(DEVICE, &finish.attempt_id, &finish.finalization, now)
            .unwrap();
        assert_eq!(redeemed.pairing_id, bootstrap.pairing_id);
    }

    #[test]
    fn successful_login_refunds_only_its_own_rate_limit_slot() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "bootstrap-a", now).unwrap();
        let bootstrap = server.bootstrap(now).unwrap();
        let other_device = device(2);

        let (client, request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        let challenge = server
            .start_login(DEVICE, &bootstrap.pairing_id, &request.request, now)
            .unwrap();
        let (_other_client, other_request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        server
            .start_login(&other_device, &bootstrap.pairing_id, &other_request.request, now)
            .unwrap();

        let own_rate_id = server.pending[&challenge.attempt_id].rate_attempt_id;
        let other_rate_id = server
            .pending
            .values()
            .find(|pending| pending.device_endpoint_id == other_device)
            .unwrap()
            .rate_attempt_id;
        let finish = client.finish(&challenge).unwrap();
        server
            .finish_login(DEVICE, &finish.attempt_id, &finish.finalization, now)
            .unwrap();

        assert!(!server.global_attempts.iter().any(|attempt| attempt.id == own_rate_id));
        assert!(server.global_attempts.iter().any(|attempt| attempt.id == other_rate_id));
    }

    #[test]
    fn successful_edge_attempt_does_not_create_source_cooldown() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let first = server.create(HOST, "bootstrap-a", now).unwrap();
        let first_bootstrap = server.bootstrap(now).unwrap();
        for _ in 0..MAX_CLIENT_ATTEMPTS {
            let (_client, request) = NumericClientLogin::start(
                &first.code,
                HOST,
                &first_bootstrap.pairing_id,
                &first_bootstrap.expires_at,
            )
            .unwrap();
            server
                .start_login(DEVICE, &first_bootstrap.pairing_id, &request.request, now)
                .unwrap();
        }

        let second = server.create(HOST, "bootstrap-b", now).unwrap();
        let second_bootstrap = server.bootstrap(now).unwrap();
        for _ in 0..2 {
            let (_client, request) = NumericClientLogin::start(
                &second.code,
                HOST,
                &second_bootstrap.pairing_id,
                &second_bootstrap.expires_at,
            )
            .unwrap();
            server
                .start_login(DEVICE, &second_bootstrap.pairing_id, &request.request, now)
                .unwrap();
        }
        let (client, request) = NumericClientLogin::start(
            &second.code,
            HOST,
            &second_bootstrap.pairing_id,
            &second_bootstrap.expires_at,
        )
        .unwrap();
        let challenge = server
            .start_login(DEVICE, &second_bootstrap.pairing_id, &request.request, now)
            .unwrap();
        let finish = client.finish(&challenge).unwrap();
        server
            .finish_login(DEVICE, &finish.attempt_id, &finish.finalization, now)
            .unwrap();

        let third = server.create(HOST, "bootstrap-c", now).unwrap();
        let third_bootstrap = server.bootstrap(now).unwrap();
        let (_client, request) = NumericClientLogin::start(
            &third.code,
            HOST,
            &third_bootstrap.pairing_id,
            &third_bootstrap.expires_at,
        )
        .unwrap();
        assert!(server
            .start_login(DEVICE, &third_bootstrap.pairing_id, &request.request, now)
            .is_ok());
    }

    #[test]
    fn wrong_bootstrap_id_is_rejected_before_opaque_login() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "bootstrap-a", now).unwrap();
        let bootstrap = server.bootstrap(now).unwrap();
        let (_client, request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        assert_eq!(
            server.start_login(DEVICE, "bootstrap-b", &request.request, now),
            Err(LinkError::PairingInvalid)
        );
    }

    #[test]
    fn three_attempts_bound_one_client_bootstrap_pair() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "bootstrap-a", now).unwrap();
        let bootstrap = server.bootstrap(now).unwrap();
        for _ in 0..MAX_CLIENT_ATTEMPTS {
            let (_client, request) = NumericClientLogin::start(
                &code.code,
                HOST,
                &bootstrap.pairing_id,
                &bootstrap.expires_at,
            )
            .unwrap();
            server
                .start_login(DEVICE, &bootstrap.pairing_id, &request.request, now)
                .unwrap();
        }
        let (_client, request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        assert_eq!(
            server.start_login(DEVICE, &bootstrap.pairing_id, &request.request, now),
            Err(LinkError::RequestRateLimited)
        );
    }

    #[test]
    fn source_limit_survives_code_regeneration_and_cools_down_for_ten_minutes() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        for pairing in ["bootstrap-a", "bootstrap-b"] {
            let code = server.create(HOST, pairing, now).unwrap();
            let bootstrap = server.bootstrap(now).unwrap();
            for _ in 0..MAX_CLIENT_ATTEMPTS {
                let (_client, request) = NumericClientLogin::start(
                    &code.code,
                    HOST,
                    &bootstrap.pairing_id,
                    &bootstrap.expires_at,
                )
                .unwrap();
                server
                    .start_login(DEVICE, &bootstrap.pairing_id, &request.request, now)
                    .unwrap();
            }
        }
        let code = server.create(HOST, "bootstrap-c", now).unwrap();
        let bootstrap = server.bootstrap(now).unwrap();
        let (_client, request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        assert_eq!(
            server.start_login(DEVICE, &bootstrap.pairing_id, &request.request, now),
            Err(LinkError::RequestRateLimited)
        );

        let later = now + COOLDOWN + Duration::from_secs(1);
        let code = server.create(HOST, "bootstrap-d", later).unwrap();
        let bootstrap = server.bootstrap(later).unwrap();
        let (_client, request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        assert!(server
            .start_login(DEVICE, &bootstrap.pairing_id, &request.request, later)
            .is_ok());
    }

    #[test]
    fn host_limit_is_thirty_attempts_across_sources() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "bootstrap-a", now).unwrap();
        let bootstrap = server.bootstrap(now).unwrap();
        for index in 1..=MAX_GLOBAL_ATTEMPTS {
            let endpoint = device(index);
            let (_client, request) = NumericClientLogin::start(
                &code.code,
                HOST,
                &bootstrap.pairing_id,
                &bootstrap.expires_at,
            )
            .unwrap();
            server
                .start_login(&endpoint, &bootstrap.pairing_id, &request.request, now)
                .unwrap();
        }
        let endpoint = device(MAX_GLOBAL_ATTEMPTS + 1);
        let (_client, request) = NumericClientLogin::start(
            &code.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        assert_eq!(
            server.start_login(&endpoint, &bootstrap.pairing_id, &request.request, now),
            Err(LinkError::RequestRateLimited)
        );
    }

    #[test]
    fn regeneration_invalidates_old_login_and_old_code() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let first = server.create(HOST, "bootstrap-a", now).unwrap();
        let bootstrap = server.bootstrap(now).unwrap();
        let (client, request) = NumericClientLogin::start(
            &first.code,
            HOST,
            &bootstrap.pairing_id,
            &bootstrap.expires_at,
        )
        .unwrap();
        let challenge = server
            .start_login(DEVICE, &bootstrap.pairing_id, &request.request, now)
            .unwrap();
        server.create(HOST, "bootstrap-b", now).unwrap();
        let finish = client.finish(&challenge).unwrap();
        assert_eq!(
            server.finish_login(DEVICE, &finish.attempt_id, &finish.finalization, now),
            Err(LinkError::PairingInvalid)
        );
    }

    #[test]
    fn code_expires() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        server.create(HOST, "bootstrap-a", now).unwrap();
        assert_eq!(server.active_pairing_id(now + NUMERIC_TTL), None);
    }

    #[test]
    fn code_formatting_accepts_human_spacing_only() {
        assert_eq!(normalize_code("482 731").unwrap(), "482731");
        assert_eq!(normalize_code("482\n731").unwrap(), "482731");
        assert_eq!(normalize_code("482-731"), Err(LinkError::PairingInvalid));
        assert_eq!(normalize_code("12345a"), Err(LinkError::PairingInvalid));
    }
}
