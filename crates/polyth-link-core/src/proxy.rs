use crate::errors::LinkError;
use crate::limits::Limits;

const STRIP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "cookie",
    "authorization",
];

pub fn sanitize_headers(headers: &[(String, String)]) -> Result<Vec<(String, String)>, LinkError> {
    if headers.len() > Limits::v1().http_header_count {
        return Err(LinkError::RequestHeaderInvalid);
    }
    let mut total = 0usize;
    let mut out = Vec::new();
    for (name, value) in headers {
        if name
            .as_bytes()
            .iter()
            .any(|b| *b == b'\r' || *b == b'\n' || *b == 0)
            || value
                .as_bytes()
                .iter()
                .any(|b| *b == b'\r' || *b == b'\n' || *b == 0)
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
        if STRIP.contains(&lower.as_str()) || lower.starts_with("x-polyth-") {
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    Ok(out)
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
            ("Accept".into(), "application/json".into()),
        ];
        let out = sanitize_headers(&headers).unwrap();
        assert_eq!(out, vec![("Accept".into(), "application/json".into())]);
    }

    #[test]
    fn rejects_crlf_and_connect_paths() {
        assert!(sanitize_headers(&[("X-A".into(), "ok\r\nX-Injected: 1".into())]).is_err());
        assert!(!allowed_http_path("/metrics"));
        assert!(allowed_http_path("/api/health"));
    }
}
