use std::net::SocketAddr;

use iroh_relay::server::{RelayConfig, Server, ServerConfig};
use serde::Deserialize;

#[derive(Deserialize)]
struct FileConfig {
    #[serde(default = "default_http")]
    http_bind: String,
    #[serde(default)]
    metrics_bind: Option<String>,
}

fn default_http() -> String {
    "127.0.0.1:3340".into()
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "serve".into());
    match cmd.as_str() {
        "serve" => {
            let config_path = args.next();
            let config: FileConfig = if let Some(path) = config_path {
                let text = std::fs::read_to_string(path).expect("relay config");
                serde_json::from_str(&text).expect("relay config json")
            } else {
                FileConfig {
                    http_bind: std::env::var("POLYTH_LINK_RELAY_BIND")
                        .unwrap_or_else(|_| default_http()),
                    metrics_bind: None,
                }
            };
            if let Err(error) = run(config).await {
                eprintln!("polyth-link-relay: {error}");
                std::process::exit(1);
            }
        }
        "version" => {
            println!("iroh-relay=1.1.0");
        }
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(2);
        }
    }
}

async fn run(config: FileConfig) -> Result<(), String> {
    let http_bind: SocketAddr = config
        .http_bind
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    let mut server_config = ServerConfig::default();
    server_config.relay = Some(RelayConfig::new(http_bind));
    if config.metrics_bind.is_some() {
        return Err(
            "metrics_bind is not implemented; omit it from the experimental relay config".into(),
        );
    }
    let server = Server::spawn(server_config)
        .await
        .map_err(|e| e.to_string())?;
    let bind = server
        .http_addr()
        .map(|addr| addr.to_string())
        .unwrap_or(config.http_bind);
    eprintln!(
        "polyth-link-relay listening on {bind} (upstream iroh-relay 1.1.0, no application payload access)"
    );
    tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
    server.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}
