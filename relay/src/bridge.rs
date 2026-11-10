use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::config::Config;
use crate::discovery::{find_session, Control, Found, Opened};
use crate::frame;
use crate::hello::{build_hello, Facts};
use crate::seal::Sealer;
use crate::spawn::Spawner;

const MAX_IN_FLIGHT: usize = 256;
const MAX_QUEUED: usize = 64;
const LOST: &str =
    "claude-peers daemon connection lost; this call may or may not have been executed";
const UNREACHABLE: &str =
    "claude-peers daemon unreachable: this call was NOT executed, retry it once the daemon is back";

enum Event {
    Stdin(String),
    StdinEof,
    StdinError(String),
    Frame { conn: u64, ty: u8, payload: Vec<u8> },
    Closed { conn: u64, why: String },
    Connected(Box<Opened>),
}

/// `Err(code)` ends the relay with that exit code.
type Flow = Result<(), i32>;

enum Msg {
    Request(Value),
    Notification,
    Other,
}

fn classify(v: &Value) -> Msg {
    let id = v.get("id").filter(|i| !i.is_null());
    match (v.get("method").and_then(Value::as_str), id) {
        (Some(_), Some(id)) => Msg::Request(id.clone()),
        (Some(_), None) => Msg::Notification,
        _ => Msg::Other,
    }
}

struct Conn {
    id: u64,
    writer: TcpStream,
    sealer: Sealer,
}

struct Replay {
    id: String,
    deadline: Instant,
    tools_hash: String,
}

struct Queued {
    at: Instant,
    line: String,
    msg: Msg,
}

struct Bridge {
    cfg: Config,
    key: Arc<Vec<u8>>,
    facts: Arc<Facts>,
    spawner: Arc<dyn Spawner>,
    ctl: Arc<Control>,
    tx: Sender<Event>,
    out: Box<dyn Write + Send>,
    init_req: Option<String>,
    initialized_note: Option<String>,
    inflight: HashMap<String, Value>,
    conn: Option<Conn>,
    next_conn: u64,
    connecting: bool,
    ticket: Option<String>,
    tools_hash: Option<String>,
    replay: Option<Replay>,
    replay_seq: u64,
    queued: VecDeque<Queued>,
    dropped: u64,
    lost_at: Option<Instant>,
    last_ping: Instant,
    ping_outstanding: Option<Instant>,
}

pub struct BridgeArgs {
    pub cfg: Config,
    pub key: Vec<u8>,
    pub facts: Facts,
    pub first: Opened,
    pub spawner: Arc<dyn Spawner>,
    pub input: Box<dyn BufRead + Send>,
    pub output: Box<dyn Write + Send>,
}

pub fn run_bridge(args: BridgeArgs) -> i32 {
    let (tx, rx) = channel();
    let tick = [
        args.cfg.ping_interval,
        args.cfg.pong_timeout,
        args.cfg.replay_timeout,
    ]
    .into_iter()
    .min()
    .unwrap_or(Duration::from_secs(1))
        / 4;
    let tick = tick.clamp(Duration::from_millis(5), Duration::from_millis(250));
    let mut bridge = Bridge {
        cfg: args.cfg,
        key: Arc::new(args.key),
        facts: Arc::new(args.facts),
        spawner: args.spawner,
        ctl: Arc::new(Control::default()),
        tx: tx.clone(),
        out: args.output,
        init_req: None,
        initialized_note: None,
        inflight: HashMap::new(),
        conn: None,
        next_conn: 0,
        connecting: false,
        ticket: None,
        tools_hash: None,
        replay: None,
        replay_seq: 0,
        queued: VecDeque::new(),
        dropped: 0,
        lost_at: None,
        last_ping: Instant::now(),
        ping_outstanding: None,
    };
    spawn_stdin_reader(args.input, tx);
    let code = match bridge.install(args.first) {
        Err(code) => code,
        Ok(()) => loop {
            let step = match rx.recv_timeout(tick) {
                Ok(event) => bridge.handle(event),
                Err(RecvTimeoutError::Timeout) => Ok(()),
                Err(RecvTimeoutError::Disconnected) => Err(1),
            };
            if let Err(code) = step.and_then(|_| bridge.tick()) {
                break code;
            }
        },
    };
    bridge
        .ctl
        .stop
        .store(true, std::sync::atomic::Ordering::SeqCst);
    code
}

fn spawn_stdin_reader(mut input: Box<dyn BufRead + Send>, tx: Sender<Event>) {
    thread::spawn(move || loop {
        let mut line = String::new();
        let event = match input.read_line(&mut line) {
            Ok(0) => Event::StdinEof,
            Ok(_) => Event::Stdin(line.trim_end_matches(['\n', '\r']).to_string()),
            Err(e) => Event::StdinError(e.to_string()),
        };
        let last = matches!(event, Event::StdinEof | Event::StdinError(_));
        if tx.send(event).is_err() || last {
            return;
        }
    });
}

impl Bridge {
    fn log(&self, msg: &str) {
        self.cfg.logger.line(msg);
    }

    fn emit(&mut self, line: &str) -> Flow {
        let written = self
            .out
            .write_all(line.as_bytes())
            .and_then(|_| self.out.write_all(b"\n"))
            .and_then(|_| self.out.flush());
        written.map_err(|e| {
            self.log(&format!("cannot write to stdout, the session is gone: {e}"));
            1
        })
    }

    fn emit_error(&mut self, id: &Value, message: &str) -> Flow {
        let line =
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": message}})
                .to_string();
        self.emit(&line)
    }

    fn handle(&mut self, event: Event) -> Flow {
        match event {
            Event::Stdin(line) if line.trim().is_empty() => Ok(()),
            Event::Stdin(line) => self.on_stdin(line),
            Event::StdinEof => self.finish("stdin_eof"),
            Event::StdinError(e) => {
                self.log(&format!("cannot read stdin: {e}"));
                let _ = self.finish("stdin_eof");
                Err(1)
            }
            Event::Connected(opened) => {
                self.connecting = false;
                self.install(*opened)
            }
            Event::Frame { conn, ty, payload } => {
                if self.conn.as_ref().map(|c| c.id) != Some(conn) {
                    return Ok(());
                }
                self.on_frame(ty, payload)
            }
            Event::Closed { conn, why } => {
                if self.conn.as_ref().map(|c| c.id) != Some(conn) {
                    return Ok(());
                }
                self.connection_lost(&why)
            }
        }
    }

    fn finish(&mut self, reason: &str) -> Flow {
        if let Some(mut conn) = self.conn.take() {
            let body = json!({ "reason": reason }).to_string();
            if let Err(e) = conn
                .sealer
                .write(&mut conn.writer, frame::BYE, body.as_bytes())
            {
                self.log(&format!("cannot send BYE: {e}"));
            }
            let _ = conn.writer.shutdown(Shutdown::Both);
        }
        Err(0)
    }

    fn on_stdin(&mut self, line: String) -> Flow {
        let value: Value = serde_json::from_str(&line).unwrap_or_else(|e| {
            self.log(&format!("stdin line is not JSON ({e}), forwarded as is"));
            Value::Null
        });
        let method = value.get("method").and_then(Value::as_str);
        if method == Some("initialize") && self.init_req.is_none() && value.get("id").is_some() {
            self.init_req = Some(line.clone());
        }
        if method == Some("notifications/initialized") && self.initialized_note.is_none() {
            self.initialized_note = Some(line.clone());
        }
        if method == Some("notifications/cancelled") {
            if let Some(request_id) = value["params"].get("requestId") {
                self.inflight.remove(&request_id.to_string());
            }
        }
        let msg = classify(&value);
        if self.conn.is_none() {
            return match msg {
                Msg::Request(id) => {
                    let why = match self.ctl.refusal() {
                        Some(cause) => format!(
                            "{UNREACHABLE} (a daemon is running but refuses this session: {cause})"
                        ),
                        None => UNREACHABLE.to_string(),
                    };
                    self.emit_error(&id, &why)
                }
                _ => {
                    self.dropped += 1;
                    Ok(())
                }
            };
        }
        if self.replay.is_some() {
            if self.queued.len() >= MAX_QUEUED {
                return match msg {
                    Msg::Request(id) => self.emit_error(&id, LOST),
                    _ => {
                        self.log(
                            "queue full during the initialize replay, a notification was dropped",
                        );
                        Ok(())
                    }
                };
            }
            self.queued.push_back(Queued {
                at: Instant::now(),
                line,
                msg,
            });
            return Ok(());
        }
        self.forward(line, msg)
    }

    fn forward(&mut self, line: String, msg: Msg) -> Flow {
        if line.len() > frame::MAX_PAYLOAD {
            let why = format!(
                "request of {} bytes exceeds the {} byte limit of the daemon channel",
                line.len(),
                frame::MAX_PAYLOAD
            );
            return match msg {
                Msg::Request(id) => self.emit_error(&id, &why),
                _ => {
                    self.log(&format!("dropped a message: {why}"));
                    Ok(())
                }
            };
        }
        if let Msg::Request(id) = &msg {
            if self.inflight.len() >= MAX_IN_FLIGHT {
                let id = id.clone();
                return self.emit_error(&id, "too many requests in flight");
            }
            self.inflight.insert(id.to_string(), id.clone());
        }
        self.send_mcp(&line)
    }

    fn send_mcp(&mut self, line: &str) -> Flow {
        let Some(conn) = self.conn.as_mut() else {
            return Ok(());
        };
        match conn
            .sealer
            .write(&mut conn.writer, frame::MCP, line.as_bytes())
        {
            Ok(()) => Ok(()),
            Err(e) => self.connection_lost(&format!("write failed: {e}")),
        }
    }

    fn on_frame(&mut self, ty: u8, payload: Vec<u8>) -> Flow {
        match ty {
            frame::MCP => self.on_mcp(payload),
            frame::PONG => {
                self.ping_outstanding = None;
                Ok(())
            }
            frame::TICKET => {
                match serde_json::from_slice::<Value>(&payload)
                    .ok()
                    .and_then(|v| v["ticket"].as_str().map(str::to_string))
                {
                    Some(t) => self.ticket = Some(t),
                    None => self.log("TICKET frame without a ticket, ignored"),
                }
                Ok(())
            }
            frame::ERROR => {
                self.log(&format!(
                    "daemon error: {}",
                    String::from_utf8_lossy(&payload)
                ));
                Ok(())
            }
            other => {
                self.log(&format!(
                    "unexpected frame type {other:#04x} from the daemon, ignored"
                ));
                Ok(())
            }
        }
    }

    fn on_mcp(&mut self, payload: Vec<u8>) -> Flow {
        let Ok(text) = String::from_utf8(payload) else {
            self.log("MCP frame is not UTF-8, dropped");
            return Ok(());
        };
        let v = match serde_json::from_str::<Value>(&text) {
            Ok(v) => v,
            Err(e) => {
                self.log(&format!(
                    "MCP frame from the daemon is not JSON ({e}), dropped"
                ));
                return Ok(());
            }
        };
        let is_response = v.get("method").is_none() && v.get("id").is_some_and(|i| !i.is_null());
        if is_response {
            if self.replay.as_ref().is_some_and(|r| v["id"] == json!(r.id)) {
                return self.finish_replay();
            }
            self.inflight.remove(&v["id"].to_string());
        }
        // Re-serialised: the text may span several lines, and stdio frames are lines.
        self.emit(&v.to_string())
    }

    fn install(&mut self, opened: Opened) -> Flow {
        let writer = match opened.stream.try_clone() {
            Ok(w) => w,
            Err(e) => {
                self.log(&format!("cannot clone the daemon socket: {e}"));
                return self.connection_lost("socket clone failed");
            }
        };
        self.next_conn += 1;
        let id = self.next_conn;
        let tx = self.tx.clone();
        let mut reader = opened.stream;
        let mut opener = opened.opener;
        thread::spawn(move || loop {
            match opener.read(&mut reader) {
                Ok((ty, payload)) => {
                    if tx
                        .send(Event::Frame {
                            conn: id,
                            ty,
                            payload,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Event::Closed {
                        conn: id,
                        why: e.to_string(),
                    });
                    return;
                }
            }
        });
        self.conn = Some(Conn {
            id,
            writer,
            sealer: opened.sealer,
        });
        self.last_ping = Instant::now();
        self.ping_outstanding = None;
        let tools_hash = opened.welcome.tools_hash;
        let Some(init) = self.init_req.clone() else {
            self.tools_hash = Some(tools_hash);
            return Ok(());
        };
        self.replay_seq += 1;
        let replay_id = format!("kory-relay-replay-{}", self.replay_seq);
        let mut request: Value = match serde_json::from_str(&init) {
            Ok(v) => v,
            Err(e) => {
                self.log(&format!(
                    "saved initialize is not JSON ({e}), cannot replay"
                ));
                return Ok(());
            }
        };
        request["id"] = json!(replay_id);
        self.replay = Some(Replay {
            id: replay_id,
            deadline: Instant::now() + self.cfg.replay_timeout,
            tools_hash,
        });
        self.send_mcp(&request.to_string())
    }

    fn finish_replay(&mut self) -> Flow {
        let Some(replay) = self.replay.take() else {
            return Ok(());
        };
        if let Some(note) = self.initialized_note.clone() {
            self.send_mcp(&note)?;
        }
        let changed = self
            .tools_hash
            .as_deref()
            .is_some_and(|h| h != replay.tools_hash);
        self.tools_hash = Some(replay.tools_hash);
        if changed {
            self.emit(
                &json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
                    .to_string(),
            )?;
        }
        let after = self
            .lost_at
            .take()
            .map(|t| t.elapsed().as_millis())
            .unwrap_or(0);
        self.log(&format!("reconnected to the daemon after {after} ms; {} notification(s) dropped while it was away", self.dropped));
        self.dropped = 0;
        while let Some(q) = self.queued.pop_front() {
            if q.at.elapsed() > self.cfg.replay_timeout {
                if let Msg::Request(id) = &q.msg {
                    self.emit_error(id, LOST)?;
                }
                continue;
            }
            self.forward(q.line, q.msg)?;
        }
        Ok(())
    }

    fn connection_lost(&mut self, why: &str) -> Flow {
        if let Some(conn) = self.conn.take() {
            let _ = conn.writer.shutdown(Shutdown::Both);
        }
        self.log(&format!("lost the daemon connection: {why}"));
        self.replay = None;
        self.ping_outstanding = None;
        self.lost_at.get_or_insert_with(Instant::now);
        for (_, id) in std::mem::take(&mut self.inflight) {
            self.emit_error(&id, LOST)?;
        }
        while let Some(q) = self.queued.pop_front() {
            if let Msg::Request(id) = &q.msg {
                self.emit_error(id, LOST)?;
            }
        }
        self.start_connector();
        Ok(())
    }

    fn start_connector(&mut self) {
        if self.connecting {
            return;
        }
        self.connecting = true;
        let (cfg, key, facts, spawner, tx, ctl) = (
            self.cfg.clone(),
            self.key.clone(),
            self.facts.clone(),
            self.spawner.clone(),
            self.tx.clone(),
            self.ctl.clone(),
        );
        let hello = build_hello(
            &cfg,
            &facts,
            self.ticket.as_deref(),
            self.init_req.is_some(),
        );
        thread::spawn(move || {
            match find_session(&cfg, &key, &hello, false, spawner.as_ref(), &ctl) {
                Found::Session(opened) => {
                    let _ = tx.send(Event::Connected(opened));
                }
                Found::Stopped => {}
                Found::Fallback(cause) => cfg
                    .logger
                    .line(&format!("reconnect loop ended unexpectedly: {cause}")),
            }
        });
    }

    fn tick(&mut self) -> Flow {
        let now = Instant::now();
        if self.conn.is_none() {
            return Ok(());
        }
        if let Some(since) = self.ping_outstanding {
            if now.duration_since(since) >= self.cfg.pong_timeout {
                return self.connection_lost("no PONG from the daemon");
            }
        } else if now.duration_since(self.last_ping) >= self.cfg.ping_interval {
            self.last_ping = now;
            self.ping_outstanding = Some(now);
            let sent = self
                .conn
                .as_mut()
                .map(|c| c.sealer.write(&mut c.writer, frame::PING, &[]));
            if let Some(Err(e)) = sent {
                return self.connection_lost(&format!("PING failed: {e}"));
            }
        }
        if self.replay.as_ref().is_some_and(|r| now >= r.deadline) {
            return self.connection_lost("the initialize replay got no answer");
        }
        while self
            .queued
            .front()
            .is_some_and(|q| now.duration_since(q.at) > self.cfg.replay_timeout)
        {
            if let Some(q) = self.queued.pop_front() {
                if let Msg::Request(id) = &q.msg {
                    self.emit_error(id, LOST)?;
                }
            }
        }
        Ok(())
    }
}
