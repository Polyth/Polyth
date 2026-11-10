//! Local IPC between the host and its one owning Polyth process.
//!
//! Two channels cross it: the control channel (the owner connects to the
//! host) and the server ingress (the host connects to the owner's HTTP/WS
//! listener). Unix uses filesystem sockets inside the 0700 data directory.
//! Windows uses named pipes: the owner picks a random `\\.\pipe\…` name per
//! start, the host's control pipe refuses remote clients, is created as the
//! first instance (a squatter makes startup fail instead of intercepting it)
//! and carries a DACL that admits only LocalSystem and the pipe's owner.

use std::io;
use std::path::Path;

#[cfg(unix)]
pub type LocalStream = tokio::net::UnixStream;
#[cfg(windows)]
pub type LocalStream = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(unix)]
pub type ControlStream = tokio::net::UnixStream;
#[cfg(windows)]
pub type ControlStream = tokio::net::windows::named_pipe::NamedPipeServer;

/// Connect to the owner's ingress listener.
#[cfg(unix)]
pub async fn connect(path: &Path) -> io::Result<LocalStream> {
    tokio::net::UnixStream::connect(path).await
}

/// Connect to the owner's ingress pipe. Every listening instance may be busy
/// for a moment while the server re-arms the next one; that is retried, any
/// other error is returned. Callers bound the whole attempt with a timeout.
#[cfg(windows)]
pub async fn connect(path: &Path) -> io::Result<LocalStream> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    loop {
        // ClientOptions defaults to SECURITY_IDENTIFICATION, so the pipe's
        // server cannot impersonate this process.
        match ClientOptions::new().open(path.as_os_str()) {
            Ok(client) => return Ok(client),
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(unix)]
pub struct ControlListener {
    listener: tokio::net::UnixListener,
}

#[cfg(unix)]
impl ControlListener {
    pub fn bind(path: &Path) -> io::Result<Self> {
        let _ = std::fs::remove_file(path);
        let listener = tokio::net::UnixListener::bind(path)?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        Ok(Self { listener })
    }

    pub async fn accept(&mut self) -> io::Result<ControlStream> {
        self.listener.accept().await.map(|(stream, _)| stream)
    }
}

#[cfg(windows)]
pub struct ControlListener {
    name: std::ffi::OsString,
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl ControlListener {
    pub fn bind(path: &Path) -> io::Result<Self> {
        let name = path.as_os_str().to_os_string();
        let next = windows_pipe::create(&name, true)?;
        Ok(Self { name, next })
    }

    /// Wait for a client on the armed instance, then arm the next one before
    /// handing the connected instance out, so the name never disappears.
    pub async fn accept(&mut self) -> io::Result<ControlStream> {
        self.next.connect().await?;
        let fresh = windows_pipe::create(&self.name, false)?;
        Ok(std::mem::replace(&mut self.next, fresh))
    }
}

#[cfg(windows)]
mod windows_pipe {
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::os::windows::ffi::OsStrExt;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    /// SYSTEM and the pipe's owner (the user running Polyth) get full
    /// access; nobody else, not even read access, which the default pipe DACL
    /// grants to Everyone. `P` blocks inherited ACEs.
    const OWNER_ONLY_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;OW)";
    const SDDL_REVISION_1: u32 = 1;

    #[repr(C)]
    struct SecurityAttributes {
        n_length: u32,
        lp_security_descriptor: *mut c_void,
        b_inherit_handle: i32,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string_security_descriptor: *const u16,
            string_sd_revision: u32,
            security_descriptor: *mut *mut c_void,
            security_descriptor_size: *mut u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    struct Descriptor(*mut c_void);

    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn owner_only_descriptor() -> io::Result<Descriptor> {
        let wide: Vec<u16> = OsStr::new(OWNER_ONLY_SDDL)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor: *mut c_void = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || descriptor.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Descriptor(descriptor))
    }

    pub fn create(name: &OsStr, first: bool) -> io::Result<NamedPipeServer> {
        let descriptor = owner_only_descriptor()?;
        let mut attributes = SecurityAttributes {
            n_length: std::mem::size_of::<SecurityAttributes>() as u32,
            lp_security_descriptor: descriptor.0,
            b_inherit_handle: 0,
        };
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .access_inbound(true)
            .access_outbound(true);
        // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES whose descriptor
        // outlives the call; CreateNamedPipeW copies the descriptor.
        unsafe {
            options.create_with_security_attributes_raw(
                name,
                &mut attributes as *mut SecurityAttributes as *mut c_void,
            )
        }
    }
}

/// Whether the host must treat end-of-stdin as its owner's death. Windows has
/// no parent-death signal, so the owner keeps a stdin pipe open for the
/// host's whole life; the OS closes it when the owner exits by any means.
#[cfg(windows)]
pub fn exit_when_owner_closes_stdin() {
    std::thread::spawn(|| {
        use std::io::Read;
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 64];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => std::process::exit(0),
                Ok(_) => {}
            }
        }
    });
}

#[cfg(not(windows))]
pub fn exit_when_owner_closes_stdin() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[cfg(unix)]
    fn control_path(dir: &Path) -> PathBuf {
        dir.join("host.sock")
    }

    #[cfg(windows)]
    fn control_path(_dir: &Path) -> PathBuf {
        use rand::RngCore;
        let mut nonce = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut nonce);
        PathBuf::from(format!(
            r"\\.\pipe\polyth-link-ipc-test-{}",
            hex::encode(nonce)
        ))
    }

    #[tokio::test]
    async fn control_listener_accepts_and_connect_reaches_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = control_path(dir.path());
        let mut listener = ControlListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            // Two clients in turn: the listener re-arms after each accept.
            for _ in 0..2 {
                let mut stream = listener.accept().await.unwrap();
                let mut buf = [0u8; 4];
                stream.read_exact(&mut buf).await.unwrap();
                stream.write_all(&buf).await.unwrap();
            }
        });
        for _ in 0..2 {
            let mut client = connect(&path).await.unwrap();
            client.write_all(b"ping").await.unwrap();
            let mut buf = [0u8; 4];
            client.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"ping");
        }
        server.await.unwrap();
    }

    /// A process that already holds the pipe name must make startup fail,
    /// never become the host's control channel.
    #[cfg(windows)]
    #[tokio::test]
    async fn control_pipe_refuses_a_name_already_taken() {
        let path = control_path(Path::new("."));
        let _squatter = tokio::net::windows::named_pipe::ServerOptions::new()
            .create(path.as_os_str())
            .unwrap();
        assert!(ControlListener::bind(&path).is_err());
    }
}
