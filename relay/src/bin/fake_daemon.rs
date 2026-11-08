//! Launched by the relay's integration tests in place of bun. The mode comes
//! from CLAUDE_PEERS_MCP_DAEMON_FAKE_MODE: `serve` (default), `hang`, or
//! `stdio-echo` for the bun fallback.

use std::io::{BufRead, Write};
use std::net::TcpListener;
use std::path::Path;
use std::thread;
use std::time::Duration;

use claude_peers_relay::auth::load_or_create_key;
use claude_peers_relay::config::Logger;
use claude_peers_relay::discovery::launch_lock_file;
use claude_peers_relay::fake::{FakeDaemon, FakeOptions};
use claude_peers_relay::{paths, sys};
use serde_json::{json, Value};

fn die(msg: &str) -> ! {
    let _ = writeln!(std::io::stderr(), "fake-daemon: {msg}");
    std::process::exit(1)
}

fn stdio_echo() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = v.get("id").filter(|i| !i.is_null()) {
            let _ = writeln!(
                out,
                "{}",
                json!({"jsonrpc": "2.0", "id": id, "result": {"fallback": true}})
            );
            let _ = out.flush();
        }
    }
}

fn main() {
    let script = std::env::args()
        .nth(1)
        .unwrap_or_else(|| die("missing the daemon script argument"));
    let mode =
        std::env::var("CLAUDE_PEERS_MCP_DAEMON_FAKE_MODE").unwrap_or_else(|_| "serve".into());
    if mode == "stdio-echo" {
        return stdio_echo();
    }
    let home = paths::home_dir().unwrap_or_else(|| die("no home directory"));
    let peers_dir = home.join(".claude").join("peers");
    let key =
        load_or_create_key(&peers_dir, &Logger::new("fake-daemon")).unwrap_or_else(|e| die(&e));
    let root_dir = Path::new(&script)
        .parent()
        .unwrap_or_else(|| die("script has no parent"));
    let code_root = paths::code_root_of(root_dir).unwrap_or_else(|e| die(&e.to_string()));
    let port: u16 = std::env::var("CLAUDE_PEERS_MCP_DAEMON_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| die("CLAUDE_PEERS_MCP_DAEMON_PORT is not set"));
    let listener = TcpListener::bind(("127.0.0.1", port))
        .unwrap_or_else(|e| die(&format!("cannot bind {port}: {e}")));

    let pid = std::process::id();
    let env_keys: Vec<String> = std::env::vars().map(|(k, _)| k).collect();
    let state = json!({"pid": pid, "pid_start": sys::start_time(pid).unwrap_or_default(), "port": port, "code_root": code_root, "env_keys": env_keys});
    std::fs::write(
        peers_dir.join(format!("mcp-daemon-{port}.json")),
        state.to_string(),
    )
    .unwrap_or_else(|e| die(&e.to_string()));
    let mut launches = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(peers_dir.join("fake-launches.log"))
        .unwrap_or_else(|e| die(&e.to_string()));
    writeln!(launches, "launch {pid}").unwrap_or_else(|e| die(&e.to_string()));
    let _ = std::fs::remove_file(launch_lock_file(&peers_dir, &code_root));

    let opts = FakeOptions {
        key,
        code_root,
        verify_relay: true,
        tools_hash: "h1".into(),
        send_ticket: true,
        hang: mode == "hang",
    };
    let _daemon = FakeDaemon::start(listener, opts);
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}
