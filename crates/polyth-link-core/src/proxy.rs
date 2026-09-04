use crate::errors::LinkError;
use crate::limits::Limits;

const REQUEST_ALLOW: &[&str] = &[
    "accept",
    "accept-language",
    "content-type",
    "cache-control",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
    "if-range",
    "range",
];

const RESPONSE_ALLOW: &[&str] = &[
    "content-type",
    "cache-control",
    "etag",
    "last-modified",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "content-encoding",
    "vary",
    "x-content-type-options",
];

fn strip_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "forwarded"
            | "x-forwarded-for"
            | "x-forwarded-host"
            | "x-forwarded-proto"
            | "x-real-ip"
            | "cookie"
            | "authorization"
    ) || lower.starts_with("x-polyth-")
        || lower.starts_with("x-forwarded-")
}

fn sanitize(
    headers: &[(String, String)],
    allow: &[&str],
) -> Result<Vec<(String, String)>, LinkError> {
    if headers.len() > Limits::v1().http_header_count {
        return Err(LinkError::RequestHeaderInvalid);
    }
    let mut total = 0usize;
    let mut out = Vec::new();
    for (name, value) in headers {
        if name.as_bytes().iter().any(|b| *b < b' ' || *b == 0x7f)
            || value.as_bytes().iter().any(|b| *b < b' ' || *b == 0x7f)
        {
            return Err(LinkError::RequestHeaderInvalid);
        }
        if name.len() + value.len() > Limits::v1().http_header_bytes {
            return Err(LinkError::RequestHeaderInvalid);
        }
        total += name.len() + value.len();
        if total > 64 * 1024 {
            return Err(LinkError::RequestHeaderInvalid);
        }
        let lower = name.to_ascii_lowercase();
        if strip_name(name) || !allow.contains(&lower.as_str()) {
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    Ok(out)
}

pub fn sanitize_headers(headers: &[(String, String)]) -> Result<Vec<(String, String)>, LinkError> {
    sanitize_request_headers(headers)
}

pub fn sanitize_request_headers(
    headers: &[(String, String)],
) -> Result<Vec<(String, String)>, LinkError> {
    sanitize(headers, REQUEST_ALLOW)
}

pub fn sanitize_response_headers(
    headers: &[(String, String)],
) -> Result<Vec<(String, String)>, LinkError> {
    sanitize(headers, RESPONSE_ALLOW)
}

pub fn allowed_http_path(path: &str) -> bool {
    path.starts_with("/api/")
        && !path.starts_with("/internal/")
        && path != "/metrics"
        && !path.starts_with("/debug")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_identity_and_forwarding_headers() {
        let headers = vec![
            ("Authorization".into(), "Bearer x".into()),
            ("Cookie".into(), "a=b".into()),
            ("X-Forwarded-For".into(), "1.1.1.1".into()),
            ("X-Polyth-Link-Token".into(), "nope".into()),
            ("X-Custom".into(), "nope".into()),
            ("Accept".into(), "application/json".into()),
            ("Content-Type".into(), "application/json".into()),
        ];
        let out = sanitize_headers(&headers).unwrap();
        assert_eq!(
            out,
            vec![
                ("Accept".into(), "application/json".into()),
                ("Content-Type".into(), "application/json".into()),
            ]
        );
    }

    #[test]
    fn response_headers_drop_proxy_and_internal() {
        let headers = vec![
            ("Content-Type".into(), "text/plain".into()),
            ("Transfer-Encoding".into(), "chunked".into()),
            ("Connection".into(), "close".into()),
            ("X-Polyth-Internal-Token".into(), "secret".into()),
            ("Forwarded".into(), "for=1.1.1.1".into()),
        ];
        let out = sanitize_response_headers(&headers).unwrap();
        assert_eq!(out, vec![("Content-Type".into(), "text/plain".into())]);
    }

    #[test]
    fn rejects_crlf_and_connect_paths() {
        assert!(sanitize_headers(&[("X-A".into(), "ok\r\nX-Injected: 1".into())]).is_err());
        assert!(sanitize_headers(&[("Accept".into(), "text/plain\u{7f}".into())]).is_err());
        assert!(sanitize_headers(&[("Accept".into(), "text/plain\tbad".into())]).is_err());
        assert!(!allowed_http_path("/metrics"));
        assert!(allowed_http_path("/api/health"));
    }
}
