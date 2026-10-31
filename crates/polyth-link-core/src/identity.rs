use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use iroh::SecretKey;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

const MAGIC: &[u8; 4] = b"PLI\x01";
const VERSION: u8 = 1;
const SECRET_LEN: usize = 32;
const CHECKSUM_LEN: usize = 16;
const ENVELOPE_LEN: usize = 4 + 1 + SECRET_LEN + CHECKSUM_LEN;

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("host identity file was not found")]
    NotFound,
    #[error("host identity file is not readable")]
    Permission,
    #[error("host identity file is corrupt")]
    Corrupt,
    #[error("host identity file uses an unsupported version")]
    UnsupportedVersion,
    #[error("io error")]
    Io,
}

impl IdentityError {
    pub fn fail_closed(&self) -> bool {
        !matches!(self, Self::NotFound)
    }
}

#[derive(Clone)]
pub struct HostIdentity {
    secret: SecretKey,
    path: PathBuf,
}

impl HostIdentity {
    pub fn endpoint_id(&self) -> String {
        self.secret.public().to_string()
    }

    pub fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"polyth-link-fingerprint-v1");
        hasher.update(self.endpoint_id().as_bytes());
        let digest = hasher.finalize();
        hex::encode(&digest[..8])
    }

    pub fn secret_key(&self) -> SecretKey {
        self.secret.clone()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

static MEMORY_IDENTITIES: OnceLock<Mutex<HashMap<PathBuf, [u8; SECRET_LEN]>>> = OnceLock::new();

fn memory_identities() -> &'static Mutex<HashMap<PathBuf, [u8; SECRET_LEN]>> {
    MEMORY_IDENTITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Scoped, memory-only identity override for trusted native adapters.
///
/// Mobile callers keep the durable secret in Keychain/Keystore and install it
/// only while the shared Rust client opens a pairing/reconnect operation. The
/// normal CLI path never uses this seam and continues to use the identity file.
pub struct MemoryIdentityGuard {
    path: PathBuf,
}

impl Drop for MemoryIdentityGuard {
    fn drop(&mut self) {
        if let Ok(mut identities) = memory_identities().lock() {
            if let Some(mut bytes) = identities.remove(&self.path) {
                bytes.zeroize();
            }
        }
    }
}

pub fn use_memory_identity(
    path: impl AsRef<Path>,
    secret: &[u8],
) -> Result<MemoryIdentityGuard, IdentityError> {
    let bytes: [u8; SECRET_LEN] = secret.try_into().map_err(|_| IdentityError::Corrupt)?;
    let path = path.as_ref().to_path_buf();
    let mut identities = memory_identities().lock().map_err(|_| IdentityError::Io)?;
    if identities.contains_key(&path) {
        return Err(IdentityError::Io);
    }
    identities.insert(path.clone(), bytes);
    Ok(MemoryIdentityGuard { path })
}

fn memory_identity(path: &Path) -> Result<Option<HostIdentity>, IdentityError> {
    let identities = memory_identities().lock().map_err(|_| IdentityError::Io)?;
    let Some(bytes) = identities.get(path) else {
        return Ok(None);
    };
    let secret = SecretKey::from_bytes(bytes);
    Ok(Some(HostIdentity {
        secret,
        path: path.to_path_buf(),
    }))
}

fn checksum(secret: &[u8; 32]) -> [u8; CHECKSUM_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(b"polyth-link-identity-v1");
    hasher.update(secret);
    let digest = hasher.finalize();
    let mut out = [0u8; CHECKSUM_LEN];
    out.copy_from_slice(&digest[..CHECKSUM_LEN]);
    out
}

fn encode(secret: &[u8; 32]) -> [u8; ENVELOPE_LEN] {
    let mut buf = [0u8; ENVELOPE_LEN];
    buf[..4].copy_from_slice(MAGIC);
    buf[4] = VERSION;
    buf[5..5 + SECRET_LEN].copy_from_slice(secret);
    let sum = checksum(secret);
    buf[5 + SECRET_LEN..].copy_from_slice(&sum);
    buf
}

fn decode(bytes: &[u8]) -> Result<[u8; 32], IdentityError> {
    if bytes.len() != ENVELOPE_LEN {
        return Err(IdentityError::Corrupt);
    }
    if &bytes[..4] != MAGIC {
        return Err(IdentityError::Corrupt);
    }
    if bytes[4] != VERSION {
        return Err(IdentityError::UnsupportedVersion);
    }
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&bytes[5..5 + SECRET_LEN]);
    let expected = checksum(&secret);
    if expected != bytes[5 + SECRET_LEN..] {
        secret.zeroize();
        return Err(IdentityError::Corrupt);
    }
    Ok(secret)
}

fn io_err(err: std::io::Error) -> IdentityError {
    match err.kind() {
        std::io::ErrorKind::NotFound => IdentityError::NotFound,
        std::io::ErrorKind::PermissionDenied => IdentityError::Permission,
        _ => IdentityError::Io,
    }
}

fn read_exact_path(path: &Path) -> Result<Vec<u8>, IdentityError> {
    let mut file = File::open(path).map_err(io_err)?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(io_err)?;
    if buf.is_empty() {
        return Err(IdentityError::Corrupt);
    }
    Ok(buf)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), IdentityError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = path.with_extension("identity.tmp");
    {
        let mut opts = OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp).map_err(io_err)?;
        file.write_all(bytes).map_err(io_err)?;
        file.sync_all().map_err(io_err)?;
    }
    fs::rename(&tmp, path).map_err(io_err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        if let Some(parent) = path.parent() {
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }
    Ok(())
}

fn generate_secret() -> SecretKey {
    SecretKey::generate()
}

/// Load a host identity. Generation happens only on an authoritative not-found.
/// Corrupt, truncated, permission, or checksum errors fail closed.
pub fn load_or_create(path: impl AsRef<Path>) -> Result<HostIdentity, IdentityError> {
    let path = path.as_ref().to_path_buf();
    if let Some(identity) = memory_identity(&path)? {
        return Ok(identity);
    }
    match read_exact_path(&path) {
        Ok(bytes) => {
            let mut secret_bytes = decode(&bytes)?;
            let secret = SecretKey::from_bytes(&secret_bytes);
            secret_bytes.zeroize();
            Ok(HostIdentity { secret, path })
        }
        Err(IdentityError::NotFound) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(io_err)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
                }
            }
            let lock_path = path.with_extension("identity.lock");
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(_lock) => {
                    let secret = generate_secret();
                    let bytes = secret.to_bytes();
                    let encoded = encode(&bytes);
                    let result = atomic_write(&path, &encoded);
                    let _ = fs::remove_file(&lock_path);
                    result?;
                    Ok(HostIdentity { secret, path })
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Another process is creating the file. Retry the authoritative read once.
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    let bytes = read_exact_path(&path)?;
                    let mut secret_bytes = decode(&bytes)?;
                    let secret = SecretKey::from_bytes(&secret_bytes);
                    secret_bytes.zeroize();
                    Ok(HostIdentity { secret, path })
                }
                Err(err) => Err(io_err(err)),
            }
        }
        Err(err) => Err(err),
    }
}

pub fn load_existing(path: impl AsRef<Path>) -> Result<HostIdentity, IdentityError> {
    let path = path.as_ref().to_path_buf();
    if let Some(identity) = memory_identity(&path)? {
        return Ok(identity);
    }
    let bytes = read_exact_path(&path)?;
    let mut secret_bytes = decode(&bytes)?;
    let secret = SecretKey::from_bytes(&secret_bytes);
    secret_bytes.zeroize();
    Ok(HostIdentity { secret, path })
}

fn staged_path(path: &Path) -> PathBuf {
    path.with_extension("identity.next")
}

pub fn stage_rotation(path: impl AsRef<Path>) -> Result<HostIdentity, IdentityError> {
    let path = path.as_ref().to_path_buf();
    let secret = generate_secret();
    atomic_write(&staged_path(&path), &encode(&secret.to_bytes()))?;
    Ok(HostIdentity { secret, path })
}

pub fn promote_staged_rotation(identity: &HostIdentity) -> Result<(), IdentityError> {
    fs::rename(staged_path(&identity.path), &identity.path).map_err(io_err)?;
    #[cfg(unix)]
    if let Some(parent) = identity.path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

pub fn discard_staged_rotation(identity: &HostIdentity) {
    let _ = fs::remove_file(staged_path(&identity.path));
}

/// Rotate by writing a new identity atomically. Callers must revoke pairings first.
pub fn rotate(path: impl AsRef<Path>) -> Result<HostIdentity, IdentityError> {
    let identity = stage_rotation(path)?;
    promote_staged_rotation(&identity)?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_nested_directory_generates() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tunnel").join("identity");
        let first = load_or_create(&path).unwrap();
        let id = first.endpoint_id();
        drop(first);
        let second = load_or_create(&path).unwrap();
        assert_eq!(second.endpoint_id(), id);
    }

    #[test]
    fn missing_file_generates_once_and_restart_preserves() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity");
        let first = load_or_create(&path).unwrap();
        let id = first.endpoint_id();
        drop(first);
        let second = load_or_create(&path).unwrap();
        assert_eq!(second.endpoint_id(), id);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn memory_identity_never_materializes_on_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity");
        let secret = SecretKey::generate().to_bytes();
        let expected = SecretKey::from_bytes(&secret).public().to_string();
        {
            let _guard = use_memory_identity(&path, &secret).unwrap();
            assert_eq!(load_or_create(&path).unwrap().endpoint_id(), expected);
            assert_eq!(load_existing(&path).unwrap().endpoint_id(), expected);
            assert!(!path.exists());
        }
        assert!(matches!(load_existing(&path), Err(IdentityError::NotFound)));
    }

    #[test]
    fn memory_identity_is_exclusive_per_path() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity");
        let secret = SecretKey::generate().to_bytes();
        let guard = use_memory_identity(&path, &secret).unwrap();
        assert!(use_memory_identity(&path, &secret).is_err());
        drop(guard);
        assert!(use_memory_identity(&path, &secret).is_ok());
    }

    #[test]
    fn corrupt_truncated_and_checksum_do_not_regenerate() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity");
        load_or_create(&path).unwrap();
        fs::write(&path, b"nope").unwrap();
        assert!(matches!(load_or_create(&path), Err(IdentityError::Corrupt)));
        fs::write(&path, b"PLI").unwrap();
        assert!(matches!(load_or_create(&path), Err(IdentityError::Corrupt)));
        let mut good = encode(&[7u8; 32]);
        good[40] ^= 0xff;
        fs::write(&path, good).unwrap();
        assert!(matches!(load_or_create(&path), Err(IdentityError::Corrupt)));
    }

    #[test]
    fn permission_error_does_not_regenerate() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity");
        load_or_create(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
            let result = load_or_create(&path);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(matches!(result, Err(IdentityError::Permission)));
        }
    }

    #[test]
    fn rotation_changes_endpoint_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity");
        let first = load_or_create(&path).unwrap().endpoint_id();
        let second = rotate(&path).unwrap().endpoint_id();
        assert_ne!(first, second);
    }

    #[test]
    fn staged_rotation_does_not_replace_the_live_identity_before_promotion() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity");
        let first = load_or_create(&path).unwrap().endpoint_id();
        let staged = stage_rotation(&path).unwrap();
        assert_ne!(staged.endpoint_id(), first);
        assert_eq!(load_existing(&path).unwrap().endpoint_id(), first);
        promote_staged_rotation(&staged).unwrap();
        assert_eq!(
            load_existing(&path).unwrap().endpoint_id(),
            staged.endpoint_id()
        );
    }
}
