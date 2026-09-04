use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::errors::LinkError;
use crate::limits::Limits;
use crate::protocol::{decode_head, encode_head, mutation_method, HttpResponseHeadV1};
use crate::proxy::{sanitize_request_headers, sanitize_response_headers};
use crate::PROTOCOL_VERSION;

const CRLF2: &[u8] = b"\r\n\r\n";

#[derive(Debug, Clone)]
pub struct ParsedHttpHead {
    pub header_block: Vec<u8>,
    pub leftover: Vec<u8>,
    pub method: Option<String>,
    pub path: Option<String>,
    pub status: Option<u16>,
    pub headers: Vec<(String, String)>,
}

impl ParsedHttpHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn is_websocket_upgrade(&self) -> bool {
        self.header("upgrade")
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    }

    pub fn transfer_encoding_chunked(&self) -> Result<bool, LinkError> {
        let mut chunked = false;
        for (name, value) in &self.headers {
            if !name.eq_ignore_ascii_case("transfer-encoding") {
                continue;
            }
            for token in value.split(',') {
                let token = token.trim();
                if token.eq_ignore_ascii_case("chunked") {
                    chunked = true;
                } else if !token.eq_ignore_ascii_case("identity") && !token.is_empty() {
                    return Err(LinkError::RequestHeaderInvalid);
                }
            }
        }
        Ok(chunked)
    }

    pub fn content_length(&self) -> Result<Option<u64>, LinkError> {
        let mut found: Option<u64> = None;
        for (name, value) in &self.headers {
            if !name.eq_ignore_ascii_case("content-length") {
                continue;
            }
            let parsed = value
                .trim()
                .parse::<u64>()
                .map_err(|_| LinkError::RequestHeaderInvalid)?;
            if let Some(existing) = found {
                if existing != parsed {
                    return Err(LinkError::RequestHeaderInvalid);
                }
            }
            found = Some(parsed);
        }
        Ok(found)
    }
}

pub async fn read_http_head<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<ParsedHttpHead, LinkError> {
    let timeout = Duration::from_millis(Limits::v1().header_read_timeout_ms);
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = tokio::time::timeout(timeout, reader.read(&mut tmp))
            .await
            .map_err(|_| LinkError::TransportUnavailable)?
            .map_err(|_| LinkError::TransportProtocolError)?;
        if n == 0 {
            return Err(LinkError::TransportProtocolError);
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > max_bytes {
            return Err(LinkError::RequestTooLarge);
        }
        if let Some(end) = find_header_end(&buf) {
            let leftover = buf.split_off(end);
            return parse_http_head(buf, leftover);
        }
    }
}

pub fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == CRLF2)
        .map(|i| i + 4)
}

fn parse_http_head(header_block: Vec<u8>, leftover: Vec<u8>) -> Result<ParsedHttpHead, LinkError> {
    if header_block.starts_with(b"HTTP/") {
        let (status, headers) = {
            let mut headers = [httparse::EMPTY_HEADER; 128];
            let mut parsed = httparse::Response::new(&mut headers);
            match parsed.parse(&header_block) {
                Ok(httparse::Status::Complete(_)) => {
                    let status = parsed.code.ok_or(LinkError::TransportProtocolError)?;
                    (status, collect_headers(parsed.headers)?)
                }
                _ => return Err(LinkError::TransportProtocolError),
            }
        };
        Ok(ParsedHttpHead {
            header_block,
            leftover,
            method: None,
            path: None,
            status: Some(status),
            headers,
        })
    } else {
        let (method, path, headers) = {
            let mut headers = [httparse::EMPTY_HEADER; 128];
            let mut parsed = httparse::Request::new(&mut headers);
            match parsed.parse(&header_block) {
                Ok(httparse::Status::Complete(_)) => (
                    parsed.method.unwrap_or("GET").to_string(),
                    parsed.path.unwrap_or("/").to_string(),
                    collect_headers(parsed.headers)?,
                ),
                _ => return Err(LinkError::TransportProtocolError),
            }
        };
        Ok(ParsedHttpHead {
            header_block,
            leftover,
            method: Some(method),
            path: Some(path),
            status: None,
            headers,
        })
    }
}

fn collect_headers(headers: &[httparse::Header<'_>]) -> Result<Vec<(String, String)>, LinkError> {
    if headers.len() > Limits::v1().http_header_count {
        return Err(LinkError::RequestHeaderInvalid);
    }
    let mut out = Vec::with_capacity(headers.len());
    for header in headers {
        let name = header.name.to_string();
        let value = std::str::from_utf8(header.value)
            .map_err(|_| LinkError::RequestHeaderInvalid)?
            .to_string();
        if name.as_bytes().contains(&0) || value.as_bytes().contains(&0) {
            return Err(LinkError::RequestHeaderInvalid);
        }
        out.push((name, value));
    }
    Ok(out)
}

pub async fn copy_exact<R, W>(
    reader: &mut R,
    writer: &mut W,
    limit: u64,
    on_eof: LinkError,
) -> Result<(), LinkError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let copied = copy_limited_inner(reader, writer, limit, true, on_eof.clone()).await?;
    if copied != limit {
        return Err(on_eof);
    }
    Ok(())
}

pub async fn copy_until_eof<R, W>(
    reader: &mut R,
    writer: &mut W,
    max: u64,
) -> Result<u64, LinkError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let copied = copy_limited_inner(
        reader,
        writer,
        max,
        false,
        LinkError::TransportProtocolError,
    )
    .await?;
    if copied == max {
        let mut probe = [0u8; 1];
        let read = tokio::time::timeout(
            Duration::from_millis(Limits::v1().idle_body_timeout_ms),
            reader.read(&mut probe),
        )
        .await
        .map_err(|_| LinkError::TransportUnavailable)?
        .map_err(|_| LinkError::TransportProtocolError)?;
        if read != 0 {
            return Err(LinkError::RequestTooLarge);
        }
    }
    Ok(copied)
}

async fn copy_limited_inner<R, W>(
    reader: &mut R,
    writer: &mut W,
    limit: u64,
    exact: bool,
    on_eof: LinkError,
) -> Result<u64, LinkError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let idle = Duration::from_millis(Limits::v1().idle_body_timeout_ms);
    let write_timeout = Duration::from_millis(Limits::v1().local_write_timeout_ms);
    let mut remaining = limit;
    let mut buf = vec![0u8; 16 * 1024];
    let mut copied = 0u64;
    while remaining > 0 {
        let want = buf.len().min(remaining as usize);
        let n = tokio::time::timeout(idle, reader.read(&mut buf[..want]))
            .await
            .map_err(|_| LinkError::TransportUnavailable)?
            .map_err(|_| on_eof.clone())?;
        if n == 0 {
            if exact {
                return Err(on_eof);
            }
            break;
        }
        tokio::time::timeout(write_timeout, writer.write_all(&buf[..n]))
            .await
            .map_err(|_| LinkError::TransportUnavailable)?
            .map_err(|_| LinkError::TransportOutcomeUnknown)?;
        copied += n as u64;
        remaining -= n as u64;
    }
    Ok(copied)
}

pub async fn copy_chunked_decoded<R, W>(
    reader: &mut R,
    writer: &mut W,
    max_total: u64,
) -> Result<u64, LinkError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let idle = Duration::from_millis(Limits::v1().idle_body_timeout_ms);
    let write_timeout = Duration::from_millis(Limits::v1().local_write_timeout_ms);
    let mut total = 0u64;
    loop {
        let size_line = read_line(reader, idle).await?;
        let size_line = size_line.trim();
        if size_line.contains(';') {
            return Err(LinkError::RequestHeaderInvalid);
        }
        let size =
            u64::from_str_radix(size_line, 16).map_err(|_| LinkError::TransportProtocolError)?;
        if size == 0 {
            consume_trailers(reader, idle).await?;
            return Ok(total);
        }
        if total.saturating_add(size) > max_total {
            return Err(LinkError::RequestTooLarge);
        }
        copy_exact(reader, writer, size, LinkError::TransportProtocolError).await?;
        total += size;
        let mut crlf = [0u8; 2];
        tokio::time::timeout(idle, reader.read_exact(&mut crlf))
            .await
            .map_err(|_| LinkError::TransportUnavailable)?
            .map_err(|_| LinkError::TransportProtocolError)?;
        if &crlf != b"\r\n" {
            return Err(LinkError::TransportProtocolError);
        }
        let _ = write_timeout;
    }
}

async fn read_line<R: AsyncRead + Unpin>(
    reader: &mut R,
    idle: Duration,
) -> Result<String, LinkError> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        tokio::time::timeout(idle, reader.read_exact(&mut byte))
            .await
            .map_err(|_| LinkError::TransportUnavailable)?
            .map_err(|_| LinkError::TransportProtocolError)?;
        line.push(byte[0]);
        if line.len() > 4096 {
            return Err(LinkError::RequestTooLarge);
        }
        if line.ends_with(b"\r\n") {
            let text = std::str::from_utf8(&line[..line.len() - 2])
                .map_err(|_| LinkError::TransportProtocolError)?;
            return Ok(text.to_string());
        }
    }
}

async fn consume_trailers<R: AsyncRead + Unpin>(
    reader: &mut R,
    idle: Duration,
) -> Result<(), LinkError> {
    loop {
        let line = read_line(reader, idle).await?;
        if line.is_empty() {
            return Ok(());
        }
    }
}

fn response_has_body(method: &str, status: u16) -> bool {
    if method.eq_ignore_ascii_case("HEAD") {
        return false;
    }
    !matches!(status, 100..=199 | 204 | 304)
}

pub fn validate_http_response_head(
    head: &HttpResponseHeadV1,
    request_id: &[u8; 16],
) -> Result<(), LinkError> {
    if head.version != PROTOCOL_VERSION {
        return Err(LinkError::TransportVersionUnsupported);
    }
    if &head.request_id != request_id {
        return Err(LinkError::TransportProtocolError);
    }
    if !(100..600).contains(&head.status) {
        return Err(LinkError::TransportProtocolError);
    }
    if let Some(len) = head.body_length {
        if len > Limits::v1().http_body_bytes {
            return Err(LinkError::RequestTooLarge);
        }
    }
    Ok(())
}

pub async fn pump_local_http_response<R, W>(
    local: &mut R,
    remote: &mut W,
    request_id: [u8; 16],
    request_method: &str,
) -> Result<(), LinkError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let parsed = read_http_head(local, Limits::v1().http_head_bytes).await?;
    let status = parsed.status.ok_or(LinkError::TransportProtocolError)?;
    let headers = sanitize_response_headers(&parsed.headers)?;
    let chunked = parsed.transfer_encoding_chunked()?;
    let content_length = parsed.content_length()?;
    if chunked && content_length.is_some() {
        return Err(LinkError::RequestHeaderInvalid);
    }
    let has_body = response_has_body(request_method, status);
    let body_length = if !has_body {
        Some(0)
    } else if chunked {
        None
    } else {
        content_length
    };
    if let Some(len) = body_length {
        if len > Limits::v1().http_body_bytes {
            return Err(LinkError::RequestTooLarge);
        }
    }
    let head = HttpResponseHeadV1 {
        version: PROTOCOL_VERSION,
        request_id,
        status,
        headers,
        body_length,
    };
    let encoded = encode_head(&head)?;
    write_with_timeout(remote, &encoded).await?;
    if !has_body {
        return Ok(());
    }
    let leftover = parsed.leftover;
    let mut chained = Cursor::new(leftover).chain(local);
    let max = Limits::v1().http_body_bytes;
    if chunked {
        copy_chunked_decoded(&mut chained, remote, max).await?;
    } else if let Some(len) = content_length {
        copy_exact(
            &mut chained,
            remote,
            len,
            if mutation_method(request_method) {
                LinkError::TransportOutcomeUnknown
            } else {
                LinkError::TransportProtocolError
            },
        )
        .await?;
    } else {
        copy_until_eof(&mut chained, remote, max).await?;
    }
    Ok(())
}

pub async fn pump_remote_http_to_client<R, W>(
    remote: &mut R,
    client: &mut W,
    request_id: [u8; 16],
    request_method: &str,
) -> Result<(), LinkError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let payload = crate::wire::read_len_prefixed(remote, Limits::v1().http_head_bytes).await?;
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(&payload);
    let (response, _): (HttpResponseHeadV1, usize) = decode_head(&framed)?;
    validate_http_response_head(&response, &request_id)?;
    let headers = sanitize_response_headers(&response.headers)?;
    let mut out = format!("HTTP/1.1 {} \r\nConnection: close\r\n", response.status);
    for (name, value) in &headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(len) = response.body_length {
        out.push_str(&format!("Content-Length: {len}\r\n"));
    }
    out.push_str("\r\n");
    write_with_timeout(client, out.as_bytes()).await?;
    if !response_has_body(request_method, response.status) {
        return Ok(());
    }
    if let Some(len) = response.body_length {
        copy_exact(
            remote,
            client,
            len,
            if mutation_method(request_method) {
                LinkError::TransportOutcomeUnknown
            } else {
                LinkError::TransportProtocolError
            },
        )
        .await?;
    } else {
        copy_until_eof(remote, client, Limits::v1().http_body_bytes).await?;
    }
    Ok(())
}

pub async fn write_with_timeout<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
) -> Result<(), LinkError> {
    tokio::time::timeout(
        Duration::from_millis(Limits::v1().local_write_timeout_ms),
        writer.write_all(bytes),
    )
    .await
    .map_err(|_| LinkError::TransportUnavailable)?
    .map_err(|_| LinkError::TransportProtocolError)
}

pub fn percent_decode_path(path: &str) -> Result<String, LinkError> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(LinkError::RequestPathDenied);
            }
            let decoded = hex_byte(bytes[i + 1], bytes[i + 2])?;
            if decoded == 0 {
                return Err(LinkError::RequestPathDenied);
            }
            out.push(decoded);
            i += 3;
        } else if bytes[i] == 0 {
            return Err(LinkError::RequestPathDenied);
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| LinkError::RequestPathDenied)
}

fn hex_byte(hi: u8, lo: u8) -> Result<u8, LinkError> {
    Ok((hex_nibble(hi)? << 4) | hex_nibble(lo)?)
}

fn hex_nibble(byte: u8) -> Result<u8, LinkError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(LinkError::RequestPathDenied),
    }
}

pub fn resolve_static_path(web_dist: &Path, request_path: &str) -> Result<PathBuf, LinkError> {
    if request_path.contains('\\') || request_path.contains('\0') {
        return Err(LinkError::RequestPathDenied);
    }
    let decoded = percent_decode_path(request_path)?;
    if decoded.contains('\\') || decoded.contains('\0') || !decoded.starts_with('/') {
        return Err(LinkError::RequestPathDenied);
    }
    let mut parts = Vec::new();
    for part in decoded.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(LinkError::RequestPathDenied);
        }
        parts.push(part.to_string());
    }
    let root = web_dist
        .canonicalize()
        .map_err(|_| LinkError::RequestPathDenied)?;
    let mut candidate = root.clone();
    if parts.is_empty() {
        candidate.push("index.html");
    } else {
        for part in &parts {
            candidate.push(part);
        }
    }
    if candidate.is_file() {
        let canon = candidate
            .canonicalize()
            .map_err(|_| LinkError::RequestPathDenied)?;
        if !canon.starts_with(&root) {
            return Err(LinkError::RequestPathDenied);
        }
        return Ok(canon);
    }
    let mut probe = root.clone();
    for part in &parts {
        probe.push(part);
        if probe.exists() {
            let canon = probe
                .canonicalize()
                .map_err(|_| LinkError::RequestPathDenied)?;
            if !canon.starts_with(&root) {
                return Err(LinkError::RequestPathDenied);
            }
            probe = canon;
        }
    }
    let index = root.join("index.html");
    let index = index
        .canonicalize()
        .map_err(|_| LinkError::RequestPathDenied)?;
    if !index.starts_with(&root) {
        return Err(LinkError::RequestPathDenied);
    }
    Ok(index)
}

pub fn request_headers_from_parsed(
    head: &ParsedHttpHead,
) -> Result<Vec<(String, String)>, LinkError> {
    sanitize_request_headers(&head.headers)
}

pub struct PrefixedIo<S> {
    prefix: Cursor<Vec<u8>>,
    inner: S,
}

impl<S> PrefixedIo<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix: Cursor::new(prefix),
            inner,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedIo<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.prefix.position() < self.prefix.get_ref().len() as u64 {
            return std::pin::Pin::new(&mut self.prefix).poll_read(cx, buf);
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedIo<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;
    use tokio::io::duplex;

    struct OneByte<R> {
        inner: R,
    }

    impl<R: AsyncRead + Unpin> AsyncRead for OneByte<R> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if buf.remaining() == 0 {
                return std::task::Poll::Ready(Ok(()));
            }
            let mut tmp = [0u8; 1];
            let mut small = tokio::io::ReadBuf::new(&mut tmp);
            match std::pin::Pin::new(&mut self.inner).poll_read(cx, &mut small) {
                std::task::Poll::Ready(Ok(())) => {
                    let filled = small.filled();
                    if !filled.is_empty() {
                        buf.put_slice(filled);
                    }
                    std::task::Poll::Ready(Ok(()))
                }
                other => other,
            }
        }
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[tokio::test]
    async fn reads_headers_one_byte_at_a_time() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nabcd";
        let mut reader = OneByte {
            inner: Cursor::new(raw.to_vec()),
        };
        let parsed = read_http_head(&mut reader, 1024).await.unwrap();
        assert_eq!(parsed.status, Some(200));
        assert_eq!(parsed.content_length().unwrap(), Some(4));
        let mut rest = parsed.leftover;
        reader.read_to_end(&mut rest).await.unwrap();
        assert_eq!(rest, b"abcd");
    }

    #[tokio::test]
    async fn preserves_body_bytes_co_read_with_headers() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd";
        let mut reader = Cursor::new(raw.to_vec());
        let parsed = read_http_head(&mut reader, 1024).await.unwrap();
        assert_eq!(parsed.leftover, b"abcd");
    }

    #[tokio::test]
    async fn copy_exact_rejects_premature_eof() {
        let mut src = Cursor::new(b"abc".to_vec());
        let mut dst = Vec::new();
        let err = copy_exact(&mut src, &mut dst, 8, LinkError::TransportProtocolError)
            .await
            .unwrap_err();
        assert_eq!(err, LinkError::TransportProtocolError);
        assert_eq!(dst, b"abc");
    }

    #[tokio::test]
    async fn post_body_split_across_reads_matches_declared_length() {
        let (mut client, mut server) = duplex(64);
        tokio::spawn(async move {
            server
                .write_all(b"POST /api/x HTTP/1.1\r\nContent-Length: 8\r\n\r\nab")
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            server.write_all(b"cd").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            server.write_all(b"efghEXTRA").await.unwrap();
        });
        let parsed = read_http_head(&mut client, 1024).await.unwrap();
        assert_eq!(parsed.content_length().unwrap(), Some(8));
        let mut chained = std::io::Cursor::new(parsed.leftover).chain(&mut client);
        let mut body = Vec::new();
        copy_exact(
            &mut chained,
            &mut body,
            8,
            LinkError::TransportProtocolError,
        )
        .await
        .unwrap();
        assert_eq!(body, b"abcdefgh");
    }

    #[tokio::test]
    async fn short_post_body_fails_exact_copy() {
        let mut src = std::io::Cursor::new(b"ab".to_vec());
        let mut dst = Vec::new();
        assert!(
            copy_exact(&mut src, &mut dst, 8, LinkError::TransportProtocolError)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn copy_exact_does_not_consume_extra_bytes() {
        let mut src = Cursor::new(b"abcdef".to_vec());
        let mut dst = Vec::new();
        copy_exact(&mut src, &mut dst, 4, LinkError::TransportProtocolError)
            .await
            .unwrap();
        assert_eq!(dst, b"abcd");
        let mut rest = Vec::new();
        src.read_to_end(&mut rest).await.unwrap();
        assert_eq!(rest, b"ef");
    }

    #[tokio::test]
    async fn copy_until_eof_proves_the_size_limit() {
        for (body, expected) in [
            (b"ab".as_slice(), Ok(2)),
            (b"abc".as_slice(), Ok(3)),
            (b"abcd".as_slice(), Err(LinkError::RequestTooLarge)),
        ] {
            let mut src = Cursor::new(body.to_vec());
            let mut dst = Vec::new();
            assert_eq!(copy_until_eof(&mut src, &mut dst, 3).await, expected);
            assert_eq!(dst, &body[..body.len().min(3)]);
        }
    }

    async fn roundtrip_response(status_line: &[u8], body: &[u8]) -> (HttpResponseHeadV1, Vec<u8>) {
        let (mut client, mut server) = duplex(64 * 1024);
        let request_id = [9u8; 16];
        let body = body.to_vec();
        let status_line = status_line.to_vec();
        let expected_len = body.len();
        tokio::spawn(async move {
            server.write_all(&status_line).await.unwrap();
            let mut offset = 0;
            while offset < body.len() {
                let n = (body.len() - offset).min(1024);
                server.write_all(&body[offset..offset + n]).await.unwrap();
                offset += n;
            }
            server.shutdown().await.unwrap();
        });
        let mut remote = Vec::new();
        pump_local_http_response(&mut client, &mut remote, request_id, "GET")
            .await
            .unwrap();
        let (head, consumed): (HttpResponseHeadV1, usize) = decode_head(&remote).unwrap();
        let payload = remote[consumed..].to_vec();
        assert_eq!(payload.len(), expected_len);
        (head, payload)
    }

    #[tokio::test]
    async fn streams_content_length_bodies() {
        for size in [1usize, 128 * 1024, 5 * 1024 * 1024] {
            let body = vec![0x5a; size];
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {size}\r\nConnection: close\r\nX-Polyth-Internal-Token: secret\r\n\r\n"
            );
            let (head, payload) = roundtrip_response(header.as_bytes(), &body).await;
            assert_eq!(head.status, 200);
            assert_eq!(head.body_length, Some(size as u64));
            assert_eq!(payload.len(), size);
            assert_eq!(sha(&payload), sha(&body));
            assert!(head
                .headers
                .iter()
                .all(|(name, _)| !name.eq_ignore_ascii_case("x-polyth-internal-token")));
            assert!(head
                .headers
                .iter()
                .any(|(name, value)| name.eq_ignore_ascii_case("content-type")
                    && value == "application/octet-stream"));
        }
    }

    #[tokio::test]
    async fn decodes_chunked_bodies() {
        let payload = vec![b'q'; 3000];
        let mut chunked = Vec::new();
        chunked.extend_from_slice(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n",
        );
        for part in payload.chunks(700) {
            chunked.extend_from_slice(format!("{:x}\r\n", part.len()).as_bytes());
            chunked.extend_from_slice(part);
            chunked.extend_from_slice(b"\r\n");
        }
        chunked.extend_from_slice(b"0\r\nX-Trailer: no\r\n\r\n");
        let (mut client, mut server) = duplex(64 * 1024);
        tokio::spawn(async move {
            server.write_all(&chunked).await.unwrap();
            server.shutdown().await.unwrap();
        });
        let mut remote = Vec::new();
        pump_local_http_response(&mut client, &mut remote, [1u8; 16], "GET")
            .await
            .unwrap();
        let (head, consumed): (HttpResponseHeadV1, usize) = decode_head(&remote).unwrap();
        assert_eq!(head.body_length, None);
        assert!(!remote[consumed..].starts_with(b"bb8"));
        assert_eq!(&remote[consumed..], payload.as_slice());
        assert!(head
            .headers
            .iter()
            .all(|(name, _)| !name.eq_ignore_ascii_case("transfer-encoding")));
    }

    #[tokio::test]
    async fn streams_until_eof_without_length() {
        let body = vec![7u8; 50_000];
        let header = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n";
        let (head, payload) = roundtrip_response(header, &body).await;
        assert_eq!(head.body_length, None);
        assert_eq!(payload, body);
    }

    #[tokio::test]
    async fn premature_content_length_eof_fails() {
        let (mut client, mut server) = duplex(1024);
        tokio::spawn(async move {
            server
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nabc")
                .await
                .unwrap();
            server.shutdown().await.unwrap();
        });
        let mut remote = Vec::new();
        let err = pump_local_http_response(&mut client, &mut remote, [2u8; 16], "GET")
            .await
            .unwrap_err();
        assert_eq!(err, LinkError::TransportProtocolError);
    }

    #[tokio::test]
    async fn response_id_and_version_are_validated() {
        let mut bad = encode_head(&HttpResponseHeadV1 {
            version: 2,
            request_id: [1u8; 16],
            status: 200,
            headers: vec![],
            body_length: Some(0),
        })
        .unwrap();
        let mut src = Cursor::new(bad.clone());
        let mut dst = Vec::new();
        let err = pump_remote_http_to_client(&mut src, &mut dst, [1u8; 16], "GET")
            .await
            .unwrap_err();
        assert_eq!(err, LinkError::TransportVersionUnsupported);

        bad = encode_head(&HttpResponseHeadV1 {
            version: 1,
            request_id: [3u8; 16],
            status: 200,
            headers: vec![],
            body_length: Some(0),
        })
        .unwrap();
        let mut src = Cursor::new(bad);
        let err = pump_remote_http_to_client(&mut src, &mut dst, [1u8; 16], "GET")
            .await
            .unwrap_err();
        assert_eq!(err, LinkError::TransportProtocolError);
    }

    #[test]
    fn static_path_rejects_traversal_and_spa_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), b"spa").unwrap();
        std::fs::write(dir.path().join("app.js"), b"js").unwrap();
        let js = resolve_static_path(dir.path(), "/app.js").unwrap();
        assert_eq!(std::fs::read(js).unwrap(), b"js");
        let spa = resolve_static_path(dir.path(), "/missing/route").unwrap();
        assert_eq!(std::fs::read(spa).unwrap(), b"spa");
        assert!(resolve_static_path(dir.path(), "/../etc/passwd").is_err());
        assert!(resolve_static_path(dir.path(), "/%2e%2e/etc/passwd").is_err());
        assert!(resolve_static_path(dir.path(), "/%00secret").is_err());
        assert!(resolve_static_path(dir.path(), "http://evil/").is_err());
    }
}
