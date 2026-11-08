mod common;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::Duration;

use claude_peers_relay::sys;
use common::*;
use serde_json::Value;

struct Spawned {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

fn relay(home: &Path, port: u16, extra_env: &[(&str, &str)], args: &[&str]) -> Spawned {
    let mut cmd = Command::new(RELAY_EXE);
    cmd.args(args)
        .env_clear()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("APPDATA", home.join("appdata"))
        .env(
            "SystemRoot",
            std::env::var("SystemRoot").unwrap_or_default(),
        )
        .env("CLAUDE_PEERS_MCP_DAEMON_PORT", port.to_string())
        .env("CLAUDE_PEERS_FORCE_GROUP", "test-group-secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("start the relay");
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout");
    let (tx, lines) = channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    Spawned {
        child,
        stdin,
        lines,
    }
}

impl Spawned {
    fn send(&mut self, v: Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{v}").expect("write to the relay");
        stdin.flush().expect("flush");
    }

    fn reply(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(Duration::from_secs(15))
            .expect("a line from the relay within 15 s");
        serde_json::from_str(&line).expect("JSON line")
    }

    fn finish(&mut self) -> i32 {
        self.stdin.take();
        wait_until("the relay to exit", || {
            self.child.try_wait().expect("try_wait").is_some()
        });
        self.child
            .try_wait()
            .expect("try_wait")
            .and_then(|s| s.code())
            .expect("exit code")
    }
}

fn setup() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let dir = TempDir::new();
    let code = dir.path().join("code");
    std::fs::create_dir_all(&code).expect("code dir");
    let peers = dir.path().join(".claude").join("peers");
    (dir, code.join("server.ts"), peers)
}

/// Stops the daemon a relay started, by the pid in its state file, and waits
/// until the process is gone. Declare it after the `TempDir`: the daemon runs
/// with the peers directory as its working directory, and the directory cannot
/// be deleted while it lives. It stops nothing when the test fails before the
/// daemon has written its state file.
struct DaemonGuard {
    peers: std::path::PathBuf,
    port: u16,
}

impl DaemonGuard {
    fn pid(&self) -> Option<u32> {
        let state =
            std::fs::read_to_string(self.peers.join(format!("mcp-daemon-{}.json", self.port)))
                .ok()?;
        serde_json::from_str::<Value>(&state).ok()?["pid"]
            .as_u64()
            .map(|p| p as u32)
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let Some(pid) = self.pid() else { return };
        if let Err(e) = sys::terminate(pid) {
            eprintln!("cannot stop the fake daemon pid {pid}: {e}");
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while sys::is_alive(pid) && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if sys::is_alive(pid) {
            eprintln!("the fake daemon pid {pid} did not exit within 5 s");
        }
    }
}

impl Drop for Spawned {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn the_binary_starts_the_daemon_once_serves_the_session_and_leaves_the_daemon_running() {
    let (dir, fallback, peers) = setup();
    let port = free_port();
    let args = [
        "--family",
        "peers",
        "--fallback",
        fallback.to_str().expect("utf8"),
        "--bun",
        FAKE_DAEMON_EXE,
    ];
    let _daemon = DaemonGuard {
        peers: peers.clone(),
        port,
    };
    let mut session = relay(dir.path(), port, &[], &args);
    session.send(initialize(1));
    let reply = session.reply();
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"]["serverInfo"]["name"], "fake");
    assert_eq!(session.finish(), 0, "stdin EOF ends the relay with 0");

    let launches = std::fs::read_to_string(peers.join("fake-launches.log")).expect("launch log");
    assert_eq!(
        launches.lines().count(),
        1,
        "exactly one daemon launch: {launches}"
    );
    let image = peers.join("bin").join(if cfg!(windows) {
        "kory-mcp-daemon.exe"
    } else {
        "kory-mcp-daemon"
    });
    assert!(
        image.exists(),
        "the daemon must run under its own image name"
    );
    let state: Value = serde_json::from_str(
        &std::fs::read_to_string(peers.join(format!("mcp-daemon-{port}.json"))).expect("state"),
    )
    .expect("json");
    let keys: Vec<&str> = state["env_keys"]
        .as_array()
        .expect("env_keys")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        !keys
            .iter()
            .any(|k| k.starts_with("CLAUDE_PEERS_FORCE_GROUP")),
        "a session variable leaked into the daemon: {keys:?}"
    );
    assert!(
        sys::is_alive(state["pid"].as_u64().expect("pid") as u32),
        "the daemon must outlive the session that started it"
    );

    let mut second = relay(dir.path(), port, &[], &args);
    second.send(initialize(1));
    assert_eq!(second.reply()["id"], 1);
    assert_eq!(second.finish(), 0);
    let launches = std::fs::read_to_string(peers.join("fake-launches.log")).expect("launch log");
    assert_eq!(
        launches.lines().count(),
        1,
        "a second session must reuse the running daemon: {launches}"
    );
}

#[test]
fn the_binary_falls_back_to_bun_when_every_candidate_is_foreign_and_records_why() {
    let (dir, fallback, peers) = setup();
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    thread::spawn(move || {
        for s in listener.incoming().flatten() {
            drop(s);
        }
    });
    let args = [
        "--family",
        "roadmap",
        "--fallback",
        fallback.to_str().expect("utf8"),
        "--bun",
        FAKE_DAEMON_EXE,
    ];
    let mut session = relay(
        dir.path(),
        port,
        &[("CLAUDE_PEERS_MCP_DAEMON_FAKE_MODE", "stdio-echo")],
        &args,
    );
    session.send(initialize(5));
    let reply = session.reply();
    assert_eq!(reply["id"], 5);
    assert_eq!(
        reply["result"]["fallback"], true,
        "the bun fallback must receive the untouched stdin"
    );

    let state_file = std::fs::read_dir(&peers)
        .expect("peers dir")
        .flatten()
        .find(|e| e.file_name().to_string_lossy().starts_with("mcp-fallback-"))
        .expect("a fallback state file while the session runs");
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(state_file.path()).expect("read"))
            .expect("json");
    assert_eq!(state["family"], "roadmap");
    assert!(
        state["cause"]
            .as_str()
            .unwrap_or("")
            .contains("every candidate port"),
        "got {state}"
    );
    assert_eq!(session.finish(), 0);
    assert!(
        !state_file.path().exists() || !cfg!(windows),
        "the state file is removed when the session ends"
    );
}

#[test]
fn the_binary_refuses_missing_arguments_with_exit_2() {
    let (dir, _fallback, _peers) = setup();
    let mut session = relay(dir.path(), free_port(), &[], &["--family", "peers"]);
    assert_eq!(session.finish(), 2);
    let mut bad = relay(
        dir.path(),
        free_port(),
        &[],
        &["--family", "nobody", "--fallback", "x"],
    );
    assert_eq!(bad.finish(), 2);
}
