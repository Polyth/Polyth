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
const ATTEMPT_WINDOW: Duration = Duration::from_secs(60);
const MAX_CODE_ATTEMPTS: u32 = 5;
const MAX_ENDPOINT_ATTEMPTS: usize = 10;
const MAX_GLOBAL_ATTEMPTS: usize = 100;
const MAX_PENDING_LOGINS: usize = 16;

struct NumericCipherSuite;

impl CipherSuite for NumericCipherSuite {
    type OprfCs = Ristretto255;
    type KeyExchange = TripleDh<Ristretto255, Sha512>;
    type Ksf = Identity;
}

pub struct NumericPairing {
    setup: ServerSetup<NumericCipherSuite>,
    active: Option<NumericInvitation>,
    pending: HashMap<String, PendingLogin>,
    attempts_by_endpoint: HashMap<String, Vec<Instant>>,
    global_attempts: Vec<Instant>,
}

struct NumericInvitation {
    pairing_id: String,
    host_endpoint_id: String,
    credential_id: Vec<u8>,
    password_file: Vec<u8>,
    created: Instant,
    attempts: u32,
    redeemed: bool,
}

struct PendingLogin {
    pairing_id: String,
    device_endpoint_id: String,
    state: ServerLogin<NumericCipherSuite>,
    created: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericPairingCode {
    pub code: String,
    pub pairing_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericServerChallenge {
    pub attempt_id: String,
    pub pairing_id: String,
    pub host_endpoint_id: String,
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
            attempts_by_endpoint: HashMap::new(),
            global_attempts: Vec::new(),
        }
    }

    pub fn create(
        &mut self,
        host_endpoint_id: &str,
        pairing_id: &str,
        now: Instant,
    ) -> Result<NumericPairingCode, LinkError> {
        validate_endpoint(host_endpoint_id)?;
        if pairing_id.is_empty() || pairing_id.len() > 128 {
            return Err(LinkError::PairingInvalid);
        }
        self.invalidate_active();

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
            credential_id,
            password_file,
            created: now,
            attempts: 0,
            redeemed: false,
        });
        self.pending.clear();

        Ok(NumericPairingCode {
            code,
            pairing_id: pairing_id.to_string(),
            expires_at,
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
        request: &[u8],
        now: Instant,
    ) -> Result<NumericServerChallenge, LinkError> {
        validate_endpoint(device_endpoint_id)?;
        self.expire(now);
        self.prune_rate_limits(now);

        if self.global_attempts.len() >= MAX_GLOBAL_ATTEMPTS {
            return Err(LinkError::RequestRateLimited);
        }
        let endpoint_attempts = self
            .attempts_by_endpoint
            .entry(device_endpoint_id.to_string())
            .or_default();
        if endpoint_attempts.len() >= MAX_ENDPOINT_ATTEMPTS {
            return Err(LinkError::RequestRateLimited);
        }
        if self.pending.len() >= MAX_PENDING_LOGINS {
            return Err(LinkError::RequestRateLimited);
        }

        let active = self.active.as_mut().ok_or(LinkError::PairingExpired)?;
        if active.redeemed {
            return Err(LinkError::PairingClaimed);
        }
        if active.attempts >= MAX_CODE_ATTEMPTS {
            return Err(LinkError::RequestRateLimited);
        }
        active.attempts += 1;
        endpoint_attempts.push(now);
        self.global_attempts.push(now);

        let credential_request = CredentialRequest::<NumericCipherSuite>::deserialize(request)
            .map_err(|_| LinkError::PairingInvalid)?;
        let password_file = ServerRegistration::<NumericCipherSuite>::deserialize(
            &active.password_file,
        )
        .map_err(|_| LinkError::PairingInvalid)?;
        let context = context(&active.host_endpoint_id, &active.pairing_id);
        let mut rng = OsRng;
        let started = ServerLogin::start(
            &mut rng,
            &self.setup,
            Some(password_file),
            credential_request,
            &active.credential_id,
            ServerLoginParameters {
                context: Some(&context),
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
            },
        );

        Ok(NumericServerChallenge {
            attempt_id,
            pairing_id: active.pairing_id.clone(),
            host_endpoint_id: active.host_endpoint_id.clone(),
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
            return Err(LinkError::PairingClaimed);
        }
        if now.duration_since(pending.created) >= NUMERIC_TTL {
            return Err(LinkError::PairingExpired);
        }

        let active = self.active.as_mut().ok_or(LinkError::PairingExpired)?;
        if active.pairing_id != pending.pairing_id {
            return Err(LinkError::PairingExpired);
        }
        if active.redeemed {
            return Err(LinkError::PairingClaimed);
        }
        let message = CredentialFinalization::<NumericCipherSuite>::deserialize(finalization)
            .map_err(|_| LinkError::PairingInvalid)?;
        let context = context(&active.host_endpoint_id, &active.pairing_id);
        pending
            .state
            .finish(
                message,
                ServerLoginParameters {
                    context: Some(&context),
                    ..ServerLoginParameters::default()
                },
            )
            .map_err(|_| LinkError::PairingInvalid)?;

        active.redeemed = true;
        active.password_file.zeroize();
        self.pending.clear();
        Ok(NumericPairingRedeemed {
            pairing_id: active.pairing_id.clone(),
        })
    }

    pub fn active_pairing_id(&mut self, now: Instant) -> Option<&str> {
        self.expire(now);
        self.active.as_ref().map(|active| active.pairing_id.as_str())
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
            .retain(|at| now.duration_since(*at) < ATTEMPT_WINDOW);
        self.attempts_by_endpoint.retain(|_, attempts| {
            attempts.retain(|at| now.duration_since(*at) < ATTEMPT_WINDOW);
            !attempts.is_empty()
        });
    }

    fn invalidate_active(&mut self) {
        if let Some(mut active) = self.active.take() {
            active.password_file.zeroize();
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
    ) -> Result<(Self, NumericClientRequest), LinkError> {
        validate_endpoint(expected_host_endpoint_id)?;
        let normalized = normalize_code(code)?;
        let mut rng = OsRng;
        let started = ClientLogin::<NumericCipherSuite>::start(&mut rng, normalized.as_bytes())
            .map_err(|_| LinkError::PairingInvalid)?;
        Ok((
            Self {
                state: started.state,
                code: Zeroizing::new(normalized.into_bytes()),
                expected_host_endpoint_id: expected_host_endpoint_id.to_string(),
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
        let response = CredentialResponse::<NumericCipherSuite>::deserialize(&challenge.response)
            .map_err(|_| LinkError::PairingInvalid)?;
        let context = context(&challenge.host_endpoint_id, &challenge.pairing_id);
        let mut rng = OsRng;
        let finished = self
            .state
            .finish(
                &mut rng,
                &self.code,
                response,
                ClientLoginFinishParameters {
                    context: Some(&context),
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

fn context(host_endpoint_id: &str, pairing_id: &str) -> Vec<u8> {
    format!("polyth-link/numeric-pair/v1/{host_endpoint_id}/{pairing_id}").into_bytes()
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

    #[test]
    fn numeric_code_authenticates_only_the_existing_pairing_id() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "pairing-a", now).unwrap();
        let (client, request) = NumericClientLogin::start(&code.code, HOST).unwrap();
        let challenge = server.start_login(DEVICE, &request.request, now).unwrap();
        let finish = client.finish(&challenge).unwrap();
        let redeemed = server
            .finish_login(DEVICE, &finish.attempt_id, &finish.finalization, now)
            .unwrap();

        assert_eq!(redeemed.pairing_id, "pairing-a");
        assert_eq!(
            server.finish_login(DEVICE, &finish.attempt_id, &finish.finalization, now),
            Err(LinkError::PairingInvalid)
        );
    }

    #[test]
    fn wrong_code_never_authenticates_the_pairing_id() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "pairing-a", now).unwrap();
        let wrong = if code.code == "000000" { "000001" } else { "000000" };
        let (client, request) = NumericClientLogin::start(wrong, HOST).unwrap();
        let challenge = server.start_login(DEVICE, &request.request, now).unwrap();
        assert_eq!(client.finish(&challenge), Err(LinkError::PairingInvalid));
    }

    #[test]
    fn regeneration_invalidates_old_login_and_old_code() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let first = server.create(HOST, "pairing-a", now).unwrap();
        let (client, request) = NumericClientLogin::start(&first.code, HOST).unwrap();
        let challenge = server.start_login(DEVICE, &request.request, now).unwrap();
        server.create(HOST, "pairing-b", now).unwrap();
        let finish = client.finish(&challenge).unwrap();
        assert_eq!(
            server.finish_login(DEVICE, &finish.attempt_id, &finish.finalization, now),
            Err(LinkError::PairingInvalid)
        );
    }

    #[test]
    fn code_expires_and_attempts_are_bounded() {
        let now = Instant::now();
        let mut server = NumericPairing::new();
        let code = server.create(HOST, "pairing-a", now).unwrap();
        for _ in 0..MAX_CODE_ATTEMPTS {
            let (_client, request) = NumericClientLogin::start(&code.code, HOST).unwrap();
            server.start_login(DEVICE, &request.request, now).unwrap();
        }
        let (_client, request) = NumericClientLogin::start(&code.code, HOST).unwrap();
        assert_eq!(
            server.start_login(DEVICE, &request.request, now),
            Err(LinkError::RequestRateLimited)
        );
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
