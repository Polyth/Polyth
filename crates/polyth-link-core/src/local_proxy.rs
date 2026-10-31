use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::errors::LinkError;
use crate::http_io::percent_decode_path;
use crate::timefmt::constant_eq;

pub const BOOTSTRAP_COOKIE: &str = "polyth_link_proxy";
pub const BOOTSTRAP_PATH_PREFIX: &str = "/__polyth_boot/";

#[derive(Clone)]
pub struct ProxyBootstrap {
    pub port: u16,
    nonce: [u8; 32],
    session: [u8; 32],
    nonce_consumed: bool,
}

impl ProxyBootstrap {
    pub fn new(port: u16) -> Self {
        let mut nonce = [0u8; 32];
        let mut session = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut nonce);
        rand::thread_rng().fill_bytes(&mut session);
        Self {
            port,
            nonce,
            session,
            nonce_consumed: false,
        }
    }

    pub fn nonce_hex(&self) -> String {
        hex::encode(self.nonce)
    }

    pub fn session_hex(&self) -> String {
        hex::encode(self.session)
    }

    pub fn bootstrap_url(&self) -> String {
        format!(
            "http://127.0.0.1:{}{BOOTSTRAP_PATH_PREFIX}{}",
            self.port,
            self.nonce_hex()
        )
    }

    pub fn consume_nonce(&mut self, nonce_hex: &str) -> Result<String, LinkError> {
        if self.nonce_consumed {
            return Err(LinkError::ProxyBootstrapInvalid);
        }
        let expected = self.nonce_hex();
        if !constant_eq(nonce_hex.as_bytes(), expected.as_bytes()) {
            return Err(LinkError::ProxyBootstrapInvalid);
        }
        self.nonce_consumed = true;
        self.nonce = [0u8; 32];
        Ok(self.session_hex())
    }

    pub fn session_valid(&self, cookie: &str) -> bool {
        constant_eq(cookie.as_bytes(), self.session_hex().as_bytes())
    }

    pub fn mint_fresh_nonce(&mut self) {
        rand::thread_rng().fill_bytes(&mut self.nonce);
        self.nonce_consumed = false;
    }
}

/// Proxy session cookie name. Cookies are scoped by host, not port, so every
/// loopback proxy (one per connection, a new port per reconnect) needs its own
/// name; a shared one lets a newer proxy's bootstrap overwrite the session an
/// open page still needs.
pub fn proxy_session_cookie(port: u16) -> String {
    format!("{BOOTSTRAP_COOKIE}_{port}")
}

/// The proxy session value carried by a `Cookie` header, if any.
pub fn proxy_session_from_cookie_header(header: &str, port: u16) -> Option<&str> {
    let prefix = format!("{}=", proxy_session_cookie(port));
    header
        .split(';')
        .find_map(|part| part.trim().strip_prefix(prefix.as_str()))
}

const BOOTSTRAP_SCRIPT: &str = "fetch(location.pathname,{method:\"POST\",cache:\"no-store\",credentials:\"same-origin\"}).then(function(){},function(){}).then(function(){location.replace(document.getElementById(\"next\").href)})";

/// The launch veil's mark (apps/web/src/index.html): the Polyth mark filling
/// a 336px square, drawn at 112 CSS px — the native launch screen's size.
const LAUNCH_MARK_WEBP: &[u8] = include_bytes!("../assets/launch-mark.webp");

/// The page is on screen between the Connection Hub and the workspace, both
/// of which paint the launch veil (brand night, the 112px mark at the centre
/// of the screen). It paints the same picture so the swap never shows a white
/// or blank document; its link only carries the target for the script.
fn bootstrap_style() -> &'static str {
    static STYLE: OnceLock<String> = OnceLock::new();
    STYLE.get_or_init(|| {
        format!(
            "html,body{{margin:0;height:100%;background:#07091c}}body{{background:#07091c url(data:image/webp;base64,{}) 50% 50%/112px 112px no-repeat}}#next{{display:none}}",
            STANDARD.encode(LAUNCH_MARK_WEBP)
        )
    })
}

/// Page for `GET /__polyth_boot/<nonce>?next=…` (`location` already validated
/// by `bootstrap_redirect_target`). It sets no cookie itself.
///
/// The app enters this URL from its bundled origin, a cross-site navigation,
/// and WebKit does not reliably store or send a `SameSite=Strict` cookie set
/// on that response or on a refresh/redirect that follows it. So the page
/// claims the session with a same-origin `POST` (`bootstrap_claim_response`),
/// an unambiguously same-site context, then replaces itself with `location`.
/// `Referrer-Policy: same-origin` keeps the claim's `Origin` header (under
/// `no-referrer` a POST sends `Origin: null`) without leaking the URL.
pub fn bootstrap_response(location: &str) -> String {
    let target = html_escape(location);
    let style = bootstrap_style();
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><title>Polyth</title><style>{style}</style><a id=\"next\" href=\"{target}\">Continue</a><script>{BOOTSTRAP_SCRIPT}</script>"
    );
    let script_hash = STANDARD.encode(Sha256::digest(BOOTSTRAP_SCRIPT.as_bytes()));
    let style_hash = STANDARD.encode(Sha256::digest(style.as_bytes()));
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: same-origin\r\nContent-Security-Policy: default-src 'none'; script-src 'sha256-{script_hash}'; style-src 'sha256-{style_hash}'; img-src data:; connect-src 'self'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// Response to `POST /__polyth_boot/<nonce>` with a consumed nonce.
pub fn bootstrap_claim_response(port: u16, session_hex: &str) -> String {
    format!(
        "HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\nSet-Cookie: {}={session_hex}; Path=/; HttpOnly; SameSite=Strict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        proxy_session_cookie(port)
    )
}

/// Whether a loopback request needs the bootstrap session cookie.
///
/// Only the public static web shell (the same bundle the app ships) is served
/// without it. WebKit can still withhold the `SameSite=Strict` cookie on the
/// top-level document load that follows the cross-site bootstrap entry, so
/// the document itself is not gated. The shell's same-origin requests do carry
/// the cookie. Every request that reaches the host (`/api`, `/ws`), touches
/// connection-scoped storage (`/__polyth/`) or is not a read still requires
/// the cookie. Without it the shell's local proxy probe fails and the app
/// returns to the connection hub instead of stranding the user on a raw 401.
pub fn requires_proxy_session(method: &str, path: &str) -> bool {
    let public_read = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
    !public_read
        || path == "/api"
        || path.starts_with("/api/")
        || path == "/ws"
        || path.starts_with("/ws/")
        || path == "/__polyth"
        || path.starts_with("/__polyth/")
}

fn html_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn host_allowed(host: &str, port: u16) -> bool {
    let host = host.trim();
    host == format!("127.0.0.1:{port}")
        || host.eq_ignore_ascii_case(&format!("localhost:{port}"))
        || host == format!("[::1]:{port}")
}

pub fn origin_allowed(origin: &str, port: u16) -> bool {
    let allowed = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        format!("http://[::1]:{port}"),
    ];
    allowed.iter().any(|item| item == origin)
}

pub fn fingerprint_session(session_hex: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"polyth-link-proxy-session-v1");
    hasher.update(session_hex.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

pub fn validate_redirect_target(raw: &str) -> Result<String, LinkError> {
    if raw.is_empty() {
        return Ok("/".into());
    }
    if !raw.starts_with('/') || raw.starts_with("//") {
        return Err(LinkError::ProxyOriginDenied);
    }
    if raw.contains('\\')
        || raw.contains('\0')
        || raw.contains("://")
        || raw.contains('\r')
        || raw.contains('\n')
    {
        return Err(LinkError::ProxyOriginDenied);
    }
    let lower = raw.to_ascii_lowercase();
    if lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%00")
        || lower.contains("%2e")
    {
        return Err(LinkError::ProxyOriginDenied);
    }
    let decoded = percent_decode_path(raw)?;
    if decoded.starts_with("//")
        || decoded.contains('\\')
        || decoded.bytes().any(|byte| byte < b' ' || byte == 0x7f)
    {
        return Err(LinkError::ProxyOriginDenied);
    }
    if !decoded.starts_with('/') {
        return Err(LinkError::ProxyOriginDenied);
    }
    Ok(raw.to_string())
}

pub fn bootstrap_redirect_target(query: Option<&str>) -> Result<String, LinkError> {
    let mut next = None;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        if key != "next" {
            continue;
        }
        if next.replace(value.into_owned()).is_some() {
            return Err(LinkError::ProxyOriginDenied);
        }
    }
    validate_redirect_target(next.as_deref().unwrap_or("/"))
}

/// Loopback listener with an owned shutdown handle. Disconnect/forget/revoke
/// must close this so the port is released.
#[derive(Clone)]
pub struct OwnedLoopback {
    pub port: u16,
    shutdown: watch::Sender<bool>,
}

impl OwnedLoopback {
    pub fn close(&self) {
        let _ = self.shutdown.send(true);
    }

    /// True once the listener was closed or its accept loop gave up.
    pub fn is_closed(&self) -> bool {
        *self.shutdown.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }
}

pub async fn bind_owned_loopback() -> Result<(TcpListener, OwnedLoopback), LinkError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    let port = listener
        .local_addr()
        .map_err(|_| LinkError::TransportUnavailable)?
        .port();
    let (shutdown, _) = watch::channel(false);
    Ok((listener, OwnedLoopback { port, shutdown }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_nonce_is_single_use() {
        let mut boot = ProxyBootstrap::new(9);
        let nonce = boot.nonce_hex();
        assert!(boot.consume_nonce(&nonce).is_ok());
        assert!(boot.consume_nonce(&nonce).is_err());
        assert!(host_allowed("127.0.0.1:9", 9));
        assert!(host_allowed("LOCALHOST:9", 9));
        assert!(host_allowed("[::1]:9", 9));
        assert!(!host_allowed("127.0.0.1:10", 9));
        assert!(!host_allowed("evil.test:9", 9));
        assert!(origin_allowed("http://127.0.0.1:9", 9));
        assert!(!origin_allowed("http://evil.test", 9));
        boot.mint_fresh_nonce();
        let fresh = boot.nonce_hex();
        assert_ne!(fresh, nonce);
        assert!(boot.consume_nonce(&fresh).is_ok());
        assert!(validate_redirect_target("/sessions/abc").is_ok());
        assert!(validate_redirect_target("/projects/p1").is_ok());
        assert!(validate_redirect_target("https://evil.test").is_err());
        assert!(validate_redirect_target("//evil.test").is_err());
        assert!(validate_redirect_target("/x%2f../y").is_err());
        assert!(validate_redirect_target("/\\evil").is_err());
        assert!(validate_redirect_target("http://evil.test/x").is_err());
    }

    #[test]
    fn only_the_static_shell_is_public_without_a_proxy_session() {
        for (method, path) in [
            ("GET", "/"),
            ("GET", "/p/project"),
            ("HEAD", "/assets/app.js"),
        ] {
            assert!(!requires_proxy_session(method, path), "{method} {path}");
        }
        for (method, path) in [
            ("GET", "/api"),
            ("GET", "/api/sessions"),
            ("GET", "/ws"),
            ("GET", "/ws/session"),
            ("GET", "/__polyth"),
            ("GET", "/__polyth/client-context"),
            ("GET", "/__polyth/client-context/storage/key"),
            ("POST", "/"),
            ("PUT", "/index.html"),
            ("DELETE", "/assets/app.js"),
            ("OPTIONS", "/"),
        ] {
            assert!(requires_proxy_session(method, path), "{method} {path}");
        }
    }

    #[test]
    fn bootstrap_next_round_trips_once_without_weakening_redirects() {
        for target in ["/sessions/x", "/projects/x", "/sessions/x?tab=files&line=2"] {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("next", target)
                .finish();
            assert_eq!(bootstrap_redirect_target(Some(&query)).unwrap(), target);
        }
        for query in [
            "next=https%3A%2F%2Fevil.test",
            "next=%2F%2Fevil.test",
            "next=%252F%252Fevil.test",
            "next=%2Fsessions%2Fx%255cadmin",
            "next=%2Fsessions%2Fx%2500",
            "next=%2Fsessions%2Fx%250d%250aLocation%3Aevil",
            "next=%2Fa&next=%2Fb",
        ] {
            assert!(
                bootstrap_redirect_target(Some(query)).is_err(),
                "accepted {query:?}"
            );
        }
    }

    #[test]
    fn bootstrap_page_claims_the_session_same_origin_before_continuing() {
        let response = bootstrap_response("/sessions/x?tab=files&line=2");
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        // Not an HTTP redirect, and no cookie on the cross-site entry: the
        // page's same-origin POST claims it.
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(!head.to_ascii_lowercase().contains("\r\nlocation:"));
        assert!(!head.to_ascii_lowercase().contains("set-cookie"));
        assert!(head.contains("\r\nCache-Control: no-store\r\n"));
        assert!(head.contains("\r\nReferrer-Policy: same-origin\r\n"));
        assert!(head.contains(&format!("\r\nContent-Length: {}\r\n", body.len())));
        assert!(body.contains("id=\"next\" href=\"/sessions/x?tab=files&amp;line=2\""));
        assert!(body.contains(&format!("<script>{BOOTSTRAP_SCRIPT}</script>")));
        let hash = STANDARD.encode(Sha256::digest(BOOTSTRAP_SCRIPT.as_bytes()));
        let style = bootstrap_style();
        let style_hash = STANDARD.encode(Sha256::digest(style.as_bytes()));
        assert!(head.contains(&format!(
            "Content-Security-Policy: default-src 'none'; script-src 'sha256-{hash}'; style-src 'sha256-{style_hash}'; img-src data:; connect-src 'self'\r\n"
        )));
        // It paints the launch veil, never a white page with a visible link.
        assert!(body.contains(&format!("<style>{style}</style>")));
        assert!(style.contains("background:#07091c"));
        assert!(style.contains("/112px 112px no-repeat"));
        assert!(style.contains("#next{display:none}"));
        assert!(body.contains("viewport-fit=cover"));

        let hostile = bootstrap_response("/a\"><script>x</script>'");
        let (_, body) = hostile.split_once("\r\n\r\n").unwrap();
        assert!(!body.contains("<script>x"));
        assert!(!body.contains("/a\">"));
        assert!(body.contains("/a&quot;&gt;&lt;script&gt;x&lt;/script&gt;&#39;"));
    }

    #[test]
    fn claim_sets_a_strict_cookie_scoped_to_the_proxy_port() {
        let response = bootstrap_claim_response(9, "ab12");
        assert!(response.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(response.contains(
            "\r\nSet-Cookie: polyth_link_proxy_9=ab12; Path=/; HttpOnly; SameSite=Strict\r\n"
        ));
        // Another proxy's cookie on the same host never satisfies this one.
        let header = "polyth_link_proxy=old; polyth_link_proxy_10=other; polyth_link_proxy_9=ab12";
        assert_eq!(proxy_session_from_cookie_header(header, 9), Some("ab12"));
        assert_eq!(proxy_session_from_cookie_header(header, 10), Some("other"));
        assert_eq!(
            proxy_session_from_cookie_header("polyth_link_proxy=old", 9),
            None
        );
        assert_eq!(
            proxy_session_from_cookie_header("polyth_link_proxy_99=x", 9),
            None
        );
    }

    #[tokio::test]
    async fn closing_owned_loopback_releases_the_port() {
        let (listener, handle) = bind_owned_loopback().await.unwrap();
        let port = handle.port;
        let mut shutdown = handle.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = listener.accept() => {
                        if accepted.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        handle.close();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let rebound = TcpListener::bind(("127.0.0.1", port)).await;
        assert!(rebound.is_ok(), "proxy port remained bound after close");
    }
}
