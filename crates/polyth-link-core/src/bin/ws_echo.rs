use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use polyth_link_core::ws_local::accept_browser_ws;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ws echo");
    let addr: SocketAddr = listener.local_addr().expect("addr");
    println!("{addr}");
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            break;
        };
        tokio::spawn(async move {
            let Ok(mut ws) = accept_browser_ws(stream, Some("polyth".into())).await else {
                return;
            };
            while let Some(frame) = ws.next().await {
                let Ok(message) = frame else { break };
                match message {
                    Message::Close(_) => {
                        let _ = ws.close(None).await;
                        break;
                    }
                    Message::Ping(data) => {
                        let _ = ws.send(Message::Pong(data)).await;
                    }
                    other => {
                        if ws.send(other).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
}
