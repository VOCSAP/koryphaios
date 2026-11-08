#![allow(dead_code)]

use std::collections::VecDeque;
use std::io::{BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use claude_peers_relay::config::{Config, Family, Logger};
use claude_peers_relay::fake::{FakeDaemon, FakeOptions};
use claude_peers_relay::paths::sha256_hex;
use claude_peers_relay::spawn::Spawner;
use claude_peers_relay::{auth, session};
use serde_json::{json, Value};

pub const FAKE_DAEMON_EXE: &str = env!("CARGO_BIN_EXE_fake-daemon");
pub const RELAY_EXE: &str = env!("CARGO_BIN_EXE_claude-peers-relay");

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        let n = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("relay-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create the test directory");
        TempDir(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    /// Windows keeps a stopped program's file busy for a moment after the
    /// process is gone, so the removal is retried for a bounded time.
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match std::fs::remove_dir_all(&self.0) {
                Ok(()) => return,
                Err(e) if Instant::now() >= deadline => {
                    eprintln!("cannot remove {}: {e}", self.0.display());
                    return;
                }
                Err(_) => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

/// Kills the child it owns when a test ends, including by a failed assertion.
pub struct ChildGuard(pub std::process::Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn free_port() -> u16 {
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("bind an ephemeral port");
    l.local_addr().expect("local address").port()
}

pub fn root_hash(label: &str) -> String {
    sha256_hex(label.as_bytes())
}

pub struct Rig {
    pub dir: TempDir,
    pub cfg: Config,
    pub key: Vec<u8>,
    pub log: Arc<Mutex<Vec<String>>>,
}

pub fn rig(candidates: Vec<u16>, code_root: &str) -> Rig {
    let dir = TempDir::new();
    let peers_dir = dir.path().join("peers");
    std::fs::create_dir_all(&peers_dir).expect("create the peers directory");
    let (logger, log) = Logger::capturing("test-relay");
    let key = auth::load_or_create_key(&peers_dir, &logger).expect("create the key");
    let mut cfg = Config::defaults(
        Family::Peers,
        dir.path().join("code").join("server.ts"),
        PathBuf::from(FAKE_DAEMON_EXE),
        peers_dir,
        candidates,
        code_root.to_string(),
        logger,
    );
    cfg.step_timeout = Duration::from_millis(400);
    cfg.connect_timeout = Duration::from_millis(300);
    cfg.poll_interval = Duration::from_millis(10);
    cfg.backoff_min = Duration::from_millis(10);
    cfg.backoff_max = Duration::from_millis(40);
    cfg.lock_retry_ms = (5, 20);
    cfg.opening_deadline = Duration::from_secs(3);
    cfg.stuck_after = Duration::from_millis(300);
    cfg.replay_timeout = Duration::from_secs(2);
    cfg.ping_interval = Duration::from_secs(60);
    cfg.pong_timeout = Duration::from_secs(60);
    Rig { dir, cfg, key, log }
}

impl Rig {
    pub fn logged(&self, needle: &str) -> bool {
        self.log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|l| l.contains(needle))
    }
}

pub fn fake(rig: &Rig, root: &str) -> FakeDaemon {
    let listener =
        TcpListener::bind(("127.0.0.1", rig.cfg.candidates[0])).expect("bind the fake daemon port");
    FakeDaemon::start(
        listener,
        FakeOptions {
            key: rig.key.clone(),
            code_root: root.to_string(),
            verify_relay: true,
            tools_hash: "h1".into(),
            send_ticket: true,
            hang: false,
        },
    )
}

pub struct NoSpawn(pub AtomicUsize);

impl Spawner for NoSpawn {
    fn spawn(&self, _cfg: &Config) -> std::io::Result<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct ChanReader {
    rx: Receiver<Option<String>>,
    pending: VecDeque<u8>,
}

impl Read for ChanReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            match self.rx.recv() {
                Ok(Some(line)) => {
                    self.pending.extend(line.bytes());
                    self.pending.push_back(b'\n');
                }
                Ok(None) | Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len());
        for slot in buf.iter_mut().take(n) {
            *slot = self.pending.pop_front().unwrap_or(0);
        }
        Ok(n)
    }
}

#[derive(Clone)]
struct SharedOut(Arc<Mutex<Vec<u8>>>);

impl Write for SharedOut {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Plays Claude Code: lines in, lines out.
pub struct Client {
    tx: Sender<Option<String>>,
    out: Arc<Mutex<Vec<u8>>>,
    pub handle: Option<JoinHandle<i32>>,
}

pub fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for: {what}");
}

pub fn run_session(cfg: Config, spawner: Arc<dyn Spawner>) -> Client {
    let (tx, rx) = channel();
    let out = Arc::new(Mutex::new(Vec::new()));
    let reader = BufReader::new(ChanReader {
        rx,
        pending: VecDeque::new(),
    });
    let writer = SharedOut(out.clone());
    let handle = thread::spawn(move || session(cfg, spawner, Box::new(reader), Box::new(writer)));
    Client {
        tx,
        out,
        handle: Some(handle),
    }
}

impl Client {
    pub fn send(&self, v: Value) {
        self.tx
            .send(Some(v.to_string()))
            .expect("the relay reads stdin");
    }

    pub fn eof(&self) {
        let _ = self.tx.send(None);
    }

    pub fn lines(&self) -> Vec<Value> {
        let text = String::from_utf8_lossy(&self.out.lock().unwrap_or_else(|e| e.into_inner()))
            .into_owned();
        text.lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).expect("the relay writes JSON lines"))
            .collect()
    }

    pub fn reply_to(&self, id: Value) -> Option<Value> {
        self.lines()
            .into_iter()
            .find(|v| v["id"] == id && v.get("method").is_none())
    }

    pub fn wait_reply(&self, id: Value) -> Value {
        let mut found = None;
        wait_until(&format!("a reply to id {id}"), || {
            found = self.reply_to(id.clone());
            found.is_some()
        });
        found.expect("reply found")
    }

    pub fn finished(&self) -> bool {
        self.handle.as_ref().is_some_and(|h| h.is_finished())
    }

    pub fn join(&mut self) -> i32 {
        wait_until("the relay to exit", || self.finished());
        self.handle
            .take()
            .expect("handle")
            .join()
            .expect("the relay thread did not panic")
    }
}

/// Ends the session before the test's directory goes away, so the relay's
/// reconnect loop cannot recreate files inside a deleted tree.
impl Drop for Client {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        let _ = self.tx.send(None);
        let deadline = Instant::now() + Duration::from_secs(8);
        while !handle.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        if handle.is_finished() {
            let _ = handle.join();
        } else {
            eprintln!("the relay thread did not end within 8 s of EOF");
        }
    }
}

/// `u32le length || body`, as it travels.
pub fn read_raw_frame(stream: &mut std::net::TcpStream) -> Vec<u8> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).expect("a frame header");
    let mut wire = header.to_vec();
    wire.resize(4 + u32::from_le_bytes(header) as usize, 0);
    stream.read_exact(&mut wire[4..]).expect("a frame body");
    wire
}

pub struct Proxy {
    pub port: u16,
    /// Every byte the relay sent and every byte the daemon sent, as seen on the wire.
    pub seen: Arc<Mutex<Vec<u8>>>,
}

fn pump(
    mut from: std::net::TcpStream,
    mut to: std::net::TcpStream,
    seen: Arc<Mutex<Vec<u8>>>,
    flip: Option<usize>,
) {
    let mut index = 0;
    loop {
        let mut header = [0u8; 4];
        if from.read_exact(&mut header).is_err() {
            break;
        }
        let mut body = vec![0u8; u32::from_le_bytes(header) as usize];
        if from.read_exact(&mut body).is_err() {
            break;
        }
        {
            let mut seen = seen.lock().unwrap_or_else(|e| e.into_inner());
            seen.extend_from_slice(&header);
            seen.extend_from_slice(&body);
        }
        if flip == Some(index) {
            if let Some(last) = body.last_mut() {
                *last ^= 1;
            }
        }
        if to
            .write_all(&header)
            .and_then(|_| to.write_all(&body))
            .is_err()
        {
            break;
        }
        index += 1;
    }
    let _ = to.shutdown(std::net::Shutdown::Both);
    let _ = from.shutdown(std::net::Shutdown::Both);
}

/// A forwarding proxy in front of `target`. `flip_c2s` flips one bit of the
/// relay-to-daemon frame with that index (0 is AUTH, 1 the sealed HELLO).
pub fn proxy(target: u16, flip_c2s: Option<usize>) -> Proxy {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind the proxy");
    let port = listener.local_addr().expect("proxy address").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let shared = seen.clone();
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let Ok(server) = std::net::TcpStream::connect(("127.0.0.1", target)) else {
                continue;
            };
            let (Ok(client_back), Ok(server_back)) = (client.try_clone(), server.try_clone())
            else {
                continue;
            };
            let (up, down) = (shared.clone(), shared.clone());
            thread::spawn(move || pump(client, server, up, flip_c2s));
            thread::spawn(move || pump(server_back, client_back, down, None));
        }
    });
    Proxy { port, seen }
}

pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Counts the directories the test helpers leave in the temp directory.
pub fn relay_test_dirs() -> usize {
    std::fs::read_dir(std::env::temp_dir())
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("relay-test-"))
                .count()
        })
        .unwrap_or(0)
}

pub fn initialize(id: u64) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})
}

pub fn initialized() -> Value {
    json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
}

pub fn call(id: u64, name: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": {}}})
}
