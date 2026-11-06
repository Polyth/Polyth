use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tempfile::tempdir;

struct Client {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    stdout: BufReader<std::process::ChildStdout>,
}

impl Client {
    fn start(data_dir: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_polyth-link-client"))
            .arg("stdio")
            .arg(data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(&json!({ "id": id, "method": method, "params": params }).to_string());
        let response = self.receive();
        assert_eq!(response["id"], id);
        response
    }
}

#[test]
fn answers_requests_on_stdout() {
    let dir = tempdir().unwrap();
    let mut client = Client::start(dir.path());
    let listed = client.call(1, "connections.list", json!({}));
    assert_eq!(listed["result"], json!([]));
    let invalid = client.call(2, "pairing.parse", json!({ "ticket": "not a ticket" }));
    assert!(invalid["error"]["code"].is_string(), "{invalid}");
    assert!(invalid.get("result").is_none(), "{invalid}");
}

#[test]
fn a_malformed_line_gets_an_error_and_the_client_keeps_serving() {
    let dir = tempdir().unwrap();
    let mut client = Client::start(dir.path());
    client.send("{not json");
    let refused = client.receive();
    assert_eq!(refused["id"], 0);
    assert!(refused["error"]["code"].is_string(), "{refused}");
    assert_eq!(
        client.call(3, "connections.list", json!({}))["result"],
        json!([])
    );
}

#[test]
fn the_process_ends_when_its_owner_closes_stdin() {
    let dir = tempdir().unwrap();
    let mut client = Client::start(dir.path());
    assert_eq!(
        client.call(1, "connections.list", json!({}))["result"],
        json!([])
    );
    drop(client.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = client.child.try_wait().unwrap() {
            assert!(status.success(), "{status}");
            return;
        }
        assert!(Instant::now() < deadline, "client outlived its owner");
        std::thread::sleep(Duration::from_millis(50));
    }
}
