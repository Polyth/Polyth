use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::{Message, Role, WebSocketConfig};
use tokio_tungstenite::{accept_hdr_async_with_config, WebSocketStream};

use crate::errors::LinkError;
use crate::http_io::ParsedHttpHead;
use crate::limits::Limits;
use crate::protocol::WsFrameType;

pub fn sec_websocket_accept(key: &str) -> String {
    derive_accept_key(key.as_bytes())
}

#[derive(Debug, Clone)]
pub struct BrowserWsRequest {
    pub key: String,
    pub origin: Option<String>,
    pub protocols: Vec<String>,
    pub accept: String,
}

pub fn validate_ws_protocols(protocols: &[String]) -> Result<(), LinkError> {
    if protocols.iter().all(|protocol| {
        !protocol.is_empty()
            && protocol.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#'
                            | b'$'
                            | b'%'
                            | b'&'
                            | b'\''
                            | b'*'
                            | b'+'
                            | b'-'
                            | b'.'
                            | b'^'
                            | b'_'
                            | b'`'
                            | b'|'
                            | b'~'
                    )
            })
    }) {
        Ok(())
    } else {
        Err(LinkError::RequestHeaderInvalid)
    }
}

pub fn validate_browser_websocket(head: &ParsedHttpHead) -> Result<BrowserWsRequest, LinkError> {
    let version = head.header("sec-websocket-version").unwrap_or("");
    if version != "13" {
        return Err(LinkError::TransportProtocolError);
    }
    let key = head
        .header("sec-websocket-key")
        .ok_or(LinkError::TransportProtocolError)?;
    if key.len() < 16 {
        return Err(LinkError::TransportProtocolError);
    }
    let protocols = head
        .header("sec-websocket-protocol")
        .map(|value| {
            value
                .split(',')
                .map(|item| item.trim().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    validate_ws_protocols(&protocols)?;
    Ok(BrowserWsRequest {
        key: key.to_string(),
        origin: head.header("origin").map(str::to_string),
        protocols,
        accept: sec_websocket_accept(key),
    })
}

pub fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(Limits::v1().ws_message_bytes))
        .max_frame_size(Some(Limits::v1().ws_message_bytes))
        .accept_unmasked_frames(false)
}

pub async fn client_from_upgraded<S>(stream: S) -> WebSocketStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    WebSocketStream::from_raw_socket(stream, Role::Client, Some(ws_config())).await
}

pub async fn server_from_upgraded<S>(stream: S) -> WebSocketStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    WebSocketStream::from_raw_socket(stream, Role::Server, Some(ws_config())).await
}

pub async fn accept_browser_ws<S>(
    stream: S,
    selected_protocol: Option<String>,
) -> Result<WebSocketStream<S>, LinkError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if let Some(protocol) = selected_protocol.as_ref() {
        validate_ws_protocols(std::slice::from_ref(protocol))?;
    }
    let selected = selected_protocol;
    accept_hdr_async_with_config(
        stream,
        move |req: &Request, mut response: Response| {
            if let Some(protocol) = selected.clone() {
                let offered = req
                    .headers()
                    .get("Sec-WebSocket-Protocol")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("");
                if !offered
                    .split(',')
                    .map(str::trim)
                    .any(|item| item == protocol)
                {
                    return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(400)
                        .body(Some("unsupported websocket protocol".into()))
                        .unwrap_or_else(|_| {
                            tokio_tungstenite::tungstenite::http::Response::new(Some(
                                "unsupported websocket protocol".into(),
                            ))
                        }));
                }
                let value = protocol.parse().map_err(|_| {
                    tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(400)
                        .body(Some("invalid websocket protocol".into()))
                        .unwrap()
                })?;
                response
                    .headers_mut()
                    .insert("Sec-WebSocket-Protocol", value);
            }
            Ok(response)
        },
        Some(ws_config()),
    )
    .await
    .map_err(|_| LinkError::TransportProtocolError)
}

pub fn message_to_link(message: Message) -> Result<Option<(WsFrameType, Vec<u8>)>, LinkError> {
    match message {
        Message::Text(text) => Ok(Some((WsFrameType::Text, text.as_bytes().to_vec()))),
        Message::Binary(data) => Ok(Some((WsFrameType::Binary, data.to_vec()))),
        Message::Ping(data) => Ok(Some((WsFrameType::Ping, data.to_vec()))),
        Message::Pong(data) => Ok(Some((WsFrameType::Pong, data.to_vec()))),
        Message::Close(frame) => {
            let mut payload = Vec::new();
            if let Some(frame) = frame {
                payload.extend_from_slice(&u16::from(frame.code).to_be_bytes());
                payload.extend_from_slice(frame.reason.as_bytes());
            }
            Ok(Some((WsFrameType::Close, payload)))
        }
        Message::Frame(_) => Ok(None),
    }
}

pub fn link_to_message(kind: WsFrameType, payload: Vec<u8>) -> Result<Message, LinkError> {
    match kind {
        WsFrameType::Text => {
            let text = String::from_utf8(payload).map_err(|_| LinkError::TransportProtocolError)?;
            Ok(Message::text(text))
        }
        WsFrameType::Binary => Ok(Message::binary(payload)),
        WsFrameType::Ping => Ok(Message::Ping(payload.into())),
        WsFrameType::Pong => Ok(Message::Pong(payload.into())),
        WsFrameType::Close => Ok(Message::Close(None)),
        // Inflated by the proxy loop before they reach a socket.
        WsFrameType::TextDeflate | WsFrameType::BinaryDeflate => {
            Err(LinkError::TransportProtocolError)
        }
    }
}

pub fn verify_upstream_switch(
    head: &ParsedHttpHead,
    key: &str,
) -> Result<Option<String>, LinkError> {
    if head.status != Some(101) {
        return Err(LinkError::Forbidden);
    }
    let upgrade = head.header("upgrade").unwrap_or("");
    if !upgrade.eq_ignore_ascii_case("websocket") {
        return Err(LinkError::Forbidden);
    }
    let connection = head.header("connection").unwrap_or("");
    if !connection
        .split(',')
        .map(str::trim)
        .any(|item| item.eq_ignore_ascii_case("upgrade"))
    {
        return Err(LinkError::Forbidden);
    }
    let accept = head
        .header("sec-websocket-accept")
        .ok_or(LinkError::Forbidden)?;
    if accept != sec_websocket_accept(key) {
        return Err(LinkError::Forbidden);
    }
    Ok(head.header("sec-websocket-protocol").map(str::to_string))
}

pub fn ws_idle() -> Duration {
    Duration::from_millis(Limits::v1().idle_body_timeout_ms)
}

/// Pump one WebSocket between a local socket and a link stream. `deflate`
/// is the per-stream negotiation result (`WebSocketOpenV1::deflate` answered
/// with `WS_DEFLATE_HEADER`): large messages cross the link compressed.
pub async fn proxy_tungstenite_to_link<S, LinkSend, LinkRecv>(
    mut ws: WebSocketStream<S>,
    mut link_send: LinkSend,
    mut link_recv: LinkRecv,
    deflate: bool,
) -> Result<(), LinkError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    LinkSend: tokio::io::AsyncWrite + Unpin,
    LinkRecv: tokio::io::AsyncRead + Unpin,
{
    use crate::protocol::{deflate_ws_payload, encode_ws_frame, inflate_ws_payload};
    use crate::wire::{read_link_ws_frame, write_all};
    use futures_util::{SinkExt, StreamExt};

    loop {
        tokio::select! {
            incoming = ws.next() => {
                let Some(frame) = incoming else { break };
                let message = frame.map_err(|_| LinkError::TransportProtocolError)?;
                let Some((kind, payload)) = message_to_link(message)? else { continue };
                let (wire_kind, wire_payload) = deflate_ws_payload(kind, payload, deflate);
                write_all(&mut link_send, &encode_ws_frame(wire_kind, &wire_payload)?).await?;
                if kind == WsFrameType::Close {
                    let _ = ws.close(None).await;
                    break;
                }
            }
            frame = read_link_ws_frame(&mut link_recv) => {
                let (kind, payload) = frame?;
                let (kind, payload) = inflate_ws_payload(kind, payload, deflate)?;
                ws.send(link_to_message(kind, payload)?).await.map_err(|_| LinkError::TransportProtocolError)?;
                if kind == WsFrameType::Close {
                    let _ = ws.close(None).await;
                    break;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_key_matches_rfc6455_sample() {
        assert_eq!(
            sec_websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn websocket_protocols_are_http_tokens() {
        assert!(validate_ws_protocols(&["polyth.v1".into(), "chat+json".into()]).is_ok());
        for invalid in [
            "",
            "chat protocol",
            "chat,admin",
            "chat\r\nX-Evil: 1",
            "chat/1",
            "💥",
        ] {
            assert!(
                validate_ws_protocols(&[invalid.into()]).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[tokio::test]
    async fn large_messages_cross_a_deflate_link_intact_and_compressed() {
        use futures_util::{SinkExt, StreamExt};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{duplex, AsyncWrite};
        use tokio_tungstenite::tungstenite::protocol::Role;
        use tokio_tungstenite::tungstenite::Message;

        /// Counts the bytes one side puts on the link.
        struct Counted<W>(W, Arc<AtomicUsize>);
        impl<W: AsyncWrite + Unpin> AsyncWrite for Counted<W> {
            fn poll_write(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
                buf: &[u8],
            ) -> std::task::Poll<std::io::Result<usize>> {
                let poll = std::pin::Pin::new(&mut self.0).poll_write(cx, buf);
                if let std::task::Poll::Ready(Ok(n)) = &poll {
                    self.1.fetch_add(*n, Ordering::Relaxed);
                }
                poll
            }
            fn poll_flush(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut self.0).poll_flush(cx)
            }
            fn poll_shutdown(
                mut self: std::pin::Pin<&mut Self>,
                cx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
            }
        }

        let (browser_io, client_io) = duplex(1 << 20);
        let (host_io, server_io) = duplex(1 << 20);
        let (link_client, link_host) = duplex(1 << 20);
        let (client_read, client_write) = tokio::io::split(link_client);
        let (host_read, host_write) = tokio::io::split(link_host);
        let downstream = Arc::new(AtomicUsize::new(0));

        let client_ws = WebSocketStream::from_raw_socket(client_io, Role::Server, None).await;
        tokio::spawn(proxy_tungstenite_to_link(
            client_ws,
            client_write,
            client_read,
            true,
        ));
        let host_ws = WebSocketStream::from_raw_socket(host_io, Role::Client, None).await;
        tokio::spawn(proxy_tungstenite_to_link(
            host_ws,
            Counted(host_write, downstream.clone()),
            host_read,
            true,
        ));
        // The Polyth server: echo every message.
        tokio::spawn(async move {
            let mut server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
            while let Some(Ok(message)) = server.next().await {
                if message.is_close() {
                    break;
                }
                server.send(message).await.unwrap();
            }
        });

        let mut browser = WebSocketStream::from_raw_socket(browser_io, Role::Client, None).await;
        let history = format!(
            "{{\"type\":\"events\",\"events\":[{}]}}",
            (1..=300)
                .map(|seq| format!(
                    "{{\"seq\":{seq},\"type\":\"message/part\",\"text\":\"chunk {seq}\"}}"
                ))
                .collect::<Vec<_>>()
                .join(",")
        );
        browser.send(Message::text(history.clone())).await.unwrap();
        let echoed = browser.next().await.unwrap().unwrap();
        assert_eq!(echoed.into_text().unwrap().as_str(), history);
        browser.send(Message::text("small")).await.unwrap();
        assert_eq!(
            browser
                .next()
                .await
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap()
                .as_str(),
            "small"
        );
        let sent = downstream.load(Ordering::Relaxed);
        assert!(
            sent * 4 < history.len(),
            "host put {sent} bytes on the link for {} of history",
            history.len()
        );
    }

    #[tokio::test]
    async fn tungstenite_text_binary_ping_close_round_trip() {
        use futures_util::{SinkExt, StreamExt};
        use tokio::net::{TcpListener, TcpStream};
        use tokio_tungstenite::tungstenite::Message;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_browser_ws(stream, Some("polyth".into()))
                .await
                .unwrap();
            while let Some(frame) = ws.next().await {
                let message = frame.unwrap();
                if matches!(message, Message::Close(_)) {
                    let _ = ws.close(None).await;
                    break;
                }
                if let Message::Ping(data) = message {
                    ws.send(Message::Pong(data)).await.unwrap();
                    continue;
                }
                ws.send(message).await.unwrap();
            }
        });
        let stream = TcpStream::connect(addr).await.unwrap();
        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .method("GET")
            .uri("ws://127.0.0.1/")
            .header("Host", "127.0.0.1")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Protocol", "polyth")
            .body(())
            .unwrap();
        let (mut ws, response) = tokio_tungstenite::client_async(request, stream)
            .await
            .unwrap();
        assert_eq!(
            response.headers().get("sec-websocket-accept").unwrap(),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        ws.send(Message::text("hello")).await.unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_text().unwrap(),
            "hello"
        );
        ws.send(Message::binary(vec![1, 2, 3])).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_data(), vec![1, 2, 3]);
        ws.send(Message::Ping(b"ping".to_vec().into()))
            .await
            .unwrap();
        let pong = ws.next().await.unwrap().unwrap();
        assert!(matches!(pong, Message::Pong(_)));
        ws.close(None).await.unwrap();
        server.await.unwrap();
    }
}
