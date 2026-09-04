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
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
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
                if let Ok(value) = protocol.parse() {
                    response
                        .headers_mut()
                        .insert("Sec-WebSocket-Protocol", value);
                }
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

pub async fn proxy_tungstenite_to_link<S, LinkSend, LinkRecv>(
    mut ws: WebSocketStream<S>,
    mut link_send: LinkSend,
    mut link_recv: LinkRecv,
) -> Result<(), LinkError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    LinkSend: tokio::io::AsyncWrite + Unpin,
    LinkRecv: tokio::io::AsyncRead + Unpin,
{
    use crate::protocol::encode_ws_frame;
    use crate::wire::{read_link_ws_frame, write_all};
    use futures_util::{SinkExt, StreamExt};

    loop {
        tokio::select! {
            incoming = ws.next() => {
                let Some(frame) = incoming else { break };
                let message = frame.map_err(|_| LinkError::TransportProtocolError)?;
                let Some((kind, payload)) = message_to_link(message)? else { continue };
                write_all(&mut link_send, &encode_ws_frame(kind, &payload)?).await?;
                if kind == WsFrameType::Close {
                    let _ = ws.close(None).await;
                    break;
                }
            }
            frame = read_link_ws_frame(&mut link_recv) => {
                let (kind, payload) = frame?;
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
