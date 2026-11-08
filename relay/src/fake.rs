//! Test double of the daemon, used by the integration tests and by the
//! `fake-daemon` binary. The relay itself never calls it.

use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::auth::{b64, b64_decode, daemon_mac, derive_keys, random_bytes, verify_relay_mac};
use crate::frame;
use crate::seal::{Opener, Sealer};

#[derive(Clone)]
pub struct FakeOptions {
    pub key: Vec<u8>,
    pub code_root: String,
    /// False makes an impostor that accepts any AUTH.
    pub verify_relay: bool,
    pub tools_hash: String,
    pub send_ticket: bool,
    /// Accept connections and never send CHALLENGE.
    pub hang: bool,
}

#[derive(Default)]
struct Shared {
    hellos: Mutex<Vec<Value>>,
    mcp: Mutex<Vec<String>>,
    byes: Mutex<Vec<String>>,
    conns: Mutex<Vec<Arc<Conn>>>,
    tools_hash: Mutex<String>,
    refuse_hello: Mutex<Option<String>>,
    refuse_auth: Mutex<Option<String>>,
    ignore_pings: AtomicBool,
    pings: AtomicUsize,
    rejected: AtomicUsize,
    initialize_delay_ms: AtomicU64,
    stop: AtomicBool,
    sessions: AtomicUsize,
}

/// The write half of a connection. Once the channel is sealed every send goes
/// through `sealer`, under one lock so frames and counters stay in order.
struct Conn {
    stream: Mutex<TcpStream>,
    sealer: Mutex<Option<Sealer>>,
}

impl Conn {
    fn send(&self, ty: u8, payload: &[u8]) -> io::Result<()> {
        let mut sealer = self.sealer.lock().unwrap_or_else(|e| e.into_inner());
        let sealer = sealer
            .as_mut()
            .ok_or_else(|| io::Error::other("channel not sealed yet"))?;
        let mut stream = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        sealer.write(&mut *stream, ty, payload)
    }

    fn close(&self) {
        let _ = self
            .stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shutdown(Shutdown::Both);
    }
}

pub struct FakeDaemon {
    pub port: u16,
    shared: Arc<Shared>,
}

impl FakeDaemon {
    pub fn start(listener: TcpListener, opts: FakeOptions) -> FakeDaemon {
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let shared = Arc::new(Shared {
            tools_hash: Mutex::new(opts.tools_hash.clone()),
            ..Shared::default()
        });
        let accept_shared = shared.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                if accept_shared.stop.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { continue };
                let Ok(writer) = stream.try_clone() else {
                    continue;
                };
                let conn = Arc::new(Conn {
                    stream: Mutex::new(writer),
                    sealer: Mutex::new(None),
                });
                accept_shared
                    .conns
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(conn.clone());
                let (opts, shared) = (opts.clone(), accept_shared.clone());
                thread::spawn(move || serve(stream, &conn, &opts, &shared));
            }
        });
        FakeDaemon { port, shared }
    }

    pub fn hellos(&self) -> Vec<Value> {
        self.shared
            .hellos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn mcp_received(&self) -> Vec<String> {
        self.shared
            .mcp
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn byes(&self) -> Vec<String> {
        self.shared
            .byes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn pings(&self) -> usize {
        self.shared.pings.load(Ordering::SeqCst)
    }

    /// Sealed frames the daemon refused (bad tag, wrong counter or length).
    pub fn rejected(&self) -> usize {
        self.shared.rejected.load(Ordering::SeqCst)
    }

    pub fn set_tools_hash(&self, hash: &str) {
        *self
            .shared
            .tools_hash
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = hash.to_string();
    }

    /// Answers every HELLO with an ERROR frame carrying this code.
    pub fn set_refuse_hello(&self, code: Option<&str>) {
        *self
            .shared
            .refuse_hello
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = code.map(str::to_string);
    }

    /// Answers every AUTH with a plain, unauthenticated ERROR frame.
    pub fn set_refuse_auth(&self, code: Option<&str>) {
        *self
            .shared
            .refuse_auth
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = code.map(str::to_string);
    }

    /// Sends one raw MCP frame to every sealed connection.
    pub fn push_mcp(&self, raw: &str) {
        for c in self
            .shared
            .conns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            let _ = c.send(frame::MCP, raw.as_bytes());
        }
    }

    pub fn set_initialize_delay_ms(&self, ms: u64) {
        self.shared.initialize_delay_ms.store(ms, Ordering::SeqCst);
    }

    pub fn set_ignore_pings(&self, ignore: bool) {
        self.shared.ignore_pings.store(ignore, Ordering::SeqCst);
    }

    /// Closes every open connection, as a daemon crash does.
    pub fn drop_connections(&self) {
        for c in self
            .shared
            .conns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            c.close();
        }
    }

    /// Stops accepting and closes every connection.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        self.drop_connections();
    }
}

fn plain_error(stream: &mut TcpStream, code: &str) {
    let body = json!({ "code": code, "message": code }).to_string();
    let _ = frame::write_frame(stream, frame::ERROR, body.as_bytes());
}

fn serve(mut stream: TcpStream, conn: &Conn, opts: &FakeOptions, shared: &Shared) {
    if opts.hang {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
        let _ = frame::read_frame(&mut stream);
        return;
    }
    let Ok(daemon_nonce_raw) = random_bytes(32) else {
        return;
    };
    let daemon_nonce = b64(&daemon_nonce_raw);
    let challenge_raw = json!({"proto_min": 1, "proto_max": 1, "daemon_nonce": daemon_nonce, "daemon_instance": "fake", "daemon_version": "0"}).to_string().into_bytes();
    if frame::write_frame(&mut stream, frame::CHALLENGE, &challenge_raw).is_err() {
        return;
    }
    let Ok((frame::AUTH, auth_raw)) =
        frame::read_frame_max(&mut stream, frame::PRE_AUTH_MAX_PAYLOAD)
    else {
        return;
    };
    let refusal = shared
        .refuse_auth
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(code) = refusal {
        plain_error(&mut stream, &code);
        return;
    }
    let auth: Value = serde_json::from_slice(&auth_raw).unwrap_or(Value::Null);
    let relay_nonce = auth["relay_nonce"].as_str().unwrap_or("").to_string();
    let (proto_min, proto_max) = (
        auth["proto_min"].as_u64().unwrap_or(0),
        auth["proto_max"].as_u64().unwrap_or(0),
    );
    if opts.verify_relay
        && !verify_relay_mac(
            &opts.key,
            &daemon_nonce,
            &relay_nonce,
            &challenge_raw,
            proto_min,
            proto_max,
            auth["mac"].as_str().unwrap_or(""),
        )
    {
        plain_error(&mut stream, "auth_failed");
        return;
    }
    let ok_raw = json!({"proto": 1, "mac": daemon_mac(&opts.key, &relay_nonce, &daemon_nonce, &challenge_raw, &auth_raw, 1)}).to_string().into_bytes();
    if frame::write_frame(&mut stream, frame::AUTH_OK, &ok_raw).is_err() {
        return;
    }
    let relay_nonce_raw = b64_decode(&relay_nonce).unwrap_or_default();
    let Ok(keys) = derive_keys(
        &opts.key,
        &daemon_nonce_raw,
        &relay_nonce_raw,
        &challenge_raw,
        &auth_raw,
        &ok_raw,
    ) else {
        return;
    };
    let (Ok(sealer), Ok(mut opener)) = (Sealer::new(&keys.d2r), Opener::new(&keys.r2d)) else {
        return;
    };
    *conn.sealer.lock().unwrap_or_else(|e| e.into_inner()) = Some(sealer);

    let read = |opener: &mut Opener, stream: &mut TcpStream| match opener.read(stream) {
        Ok(f) => Some(f),
        Err(e) => {
            if e.to_string().contains("sealed frame rejected") {
                shared.rejected.fetch_add(1, Ordering::SeqCst);
            }
            None
        }
    };
    let Some((frame::HELLO, payload)) = read(&mut opener, &mut stream) else {
        return;
    };
    let hello: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
    shared
        .hellos
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(hello.clone());
    let refusal = shared
        .refuse_hello
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(code) = refusal {
        let _ = conn.send(
            frame::ERROR,
            json!({ "code": code, "message": code })
                .to_string()
                .as_bytes(),
        );
        return;
    }
    if hello["code_root"].as_str() != Some(opts.code_root.as_str()) {
        let _ = conn.send(
            frame::ERROR,
            json!({ "code": "root_mismatch", "message": "root_mismatch" })
                .to_string()
                .as_bytes(),
        );
        return;
    }
    let n = shared.sessions.fetch_add(1, Ordering::SeqCst) + 1;
    let tools_hash = shared
        .tools_hash
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let welcome = json!({"session_id": format!("fake-{n}"), "family": hello["family"], "tools_hash": tools_hash, "resumed": hello.get("resume_ticket").is_some()});
    if conn
        .send(frame::WELCOME, welcome.to_string().as_bytes())
        .is_err()
    {
        return;
    }
    if opts.send_ticket {
        let _ = conn.send(
            frame::TICKET,
            json!({ "ticket": format!("ticket-{n}") })
                .to_string()
                .as_bytes(),
        );
    }
    let mut saw_initialize = false;
    loop {
        let Some((ty, payload)) = read(&mut opener, &mut stream) else {
            return;
        };
        match ty {
            frame::MCP => {
                let text = String::from_utf8_lossy(&payload).into_owned();
                shared
                    .mcp
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(text.clone());
                if method_of(&text).as_deref() == Some("initialize") {
                    saw_initialize = true;
                    thread::sleep(Duration::from_millis(
                        shared.initialize_delay_ms.load(Ordering::SeqCst),
                    ));
                }
                if let Some(reply) = answer(&text, saw_initialize) {
                    if conn.send(frame::MCP, reply.as_bytes()).is_err() {
                        return;
                    }
                }
            }
            frame::PING => {
                shared.pings.fetch_add(1, Ordering::SeqCst);
                if !shared.ignore_pings.load(Ordering::SeqCst)
                    && conn.send(frame::PONG, &[]).is_err()
                {
                    return;
                }
            }
            frame::BYE => {
                let v: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
                shared
                    .byes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(v["reason"].as_str().unwrap_or("").to_string());
                return;
            }
            _ => {}
        }
    }
}

fn method_of(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text).ok()?["method"]
        .as_str()
        .map(str::to_string)
}

/// `initialize` and `tools/call` get a result; a call named `hold` gets none,
/// so it stays in flight. A call on a connection that has not seen
/// `initialize` gets an error, as a real server would answer.
fn answer(text: &str, saw_initialize: bool) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let id = v.get("id").filter(|i| !i.is_null())?;
    match v["method"].as_str()? {
        "initialize" => Some(json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake", "version": "0"}}}).to_string()),
        "tools/call" if !saw_initialize => Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32002, "message": "not initialized"}}).to_string()),
        "tools/call" if v["params"]["name"] == "hold" => None,
        "tools/call" => Some(json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": "echo"}]}}).to_string()),
        _ => None,
    }
}
