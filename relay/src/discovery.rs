use std::io::{self, ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread::{self, sleep};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::auth::{self, ConnectError, Welcome};
use crate::config::Config;
use crate::seal::{Opener, Sealer};
use crate::spawn::Spawner;
use crate::sys;

pub fn fnv1a32(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// 47000 + fnv1a32(lowercase user name) mod 1000, then the 9 following ports.
/// An override replaces the whole list.
pub fn candidate_ports(username: &str, override_port: Option<u16>) -> Vec<u16> {
    if let Some(p) = override_port {
        return vec![p];
    }
    let base = 47000 + (fnv1a32(&username.to_lowercase()) % 1000) as u16;
    (0..10).map(|i| base + i).collect()
}

pub struct Opened {
    pub stream: TcpStream,
    pub welcome: Welcome,
    pub sealer: Sealer,
    pub opener: Opener,
}

#[derive(Default)]
pub struct Sweep {
    pub session: Option<Opened>,
    pub free_ports: usize,
    pub silent_ports: Vec<u16>,
    pub fatal: Option<String>,
}

#[cfg(windows)]
pub mod loopback {
    use std::io;
    use std::net::{SocketAddr, TcpStream};
    use std::os::windows::io::AsRawSocket;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use socket2::{Domain, Protocol, Socket, Type};
    use windows_sys::Win32::Networking::WinSock::{
        WSAIoctl, SIO_TCP_INITIAL_RTO, TCP_INITIAL_RTO_PARAMETERS,
    };

    use crate::config::Logger;

    const UNSPECIFIED_RTT: u16 = 0xFFFF;
    const NO_SYN_RETRANSMISSIONS: u8 = 0xFE;
    static FAILURE_LOGGED: AtomicBool = AtomicBool::new(false);

    fn no_syn_retransmission(socket: &Socket) -> io::Result<()> {
        let params = TCP_INITIAL_RTO_PARAMETERS {
            Rtt: UNSPECIFIED_RTT,
            MaxSynRetransmissions: NO_SYN_RETRANSMISSIONS,
        };
        let mut returned = 0u32;
        let rc = unsafe {
            WSAIoctl(
                socket.as_raw_socket() as usize,
                SIO_TCP_INITIAL_RTO,
                &params as *const _ as *const _,
                std::mem::size_of::<TCP_INITIAL_RTO_PARAMETERS>() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
                None,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Windows re-sends the SYN twice after a reset, so a refused loopback
    /// connect takes about two seconds and `connect_timeout` ends it first
    /// with `TimedOut`. Without SYN retransmission the refusal is immediate.
    /// When the option cannot be set, the connect is the plain one.
    pub fn connect(addr: SocketAddr, timeout: Duration, log: &Logger) -> io::Result<TcpStream> {
        connect_with(addr, timeout, log, no_syn_retransmission, &FAILURE_LOGGED)
    }

    /// `set` prepares the socket before the connect; its failure is logged
    /// once per `logged` flag and never fails the connect.
    pub fn connect_with(
        addr: SocketAddr,
        timeout: Duration,
        log: &Logger,
        set: impl Fn(&Socket) -> io::Result<()>,
        logged: &AtomicBool,
    ) -> io::Result<TcpStream> {
        let socket = match Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) {
            Ok(s) => s,
            Err(_) => return TcpStream::connect_timeout(&addr, timeout),
        };
        if let Err(e) = set(&socket) {
            if !logged.swap(true, Ordering::Relaxed) {
                log.line(&format!(
                    "cannot disable SYN retransmission ({e}), a free port will cost a full connect timeout"
                ));
            }
        }
        socket.connect_timeout(&addr.into(), timeout)?;
        Ok(socket.into())
    }
}

#[cfg(not(windows))]
pub mod loopback {
    use std::io;
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    use crate::config::Logger;

    pub fn connect(addr: SocketAddr, timeout: Duration, _log: &Logger) -> io::Result<TcpStream> {
        TcpStream::connect_timeout(&addr, timeout)
    }
}

/// Bounds the second connect to a port found free: a refusal is immediate once
/// SYN retransmission is off, and a socket on which it could not be turned off
/// must not cost a full `connect_timeout` at every port.
const REPROBE_CONNECT_CAP: Duration = Duration::from_millis(50);

fn is_free(e: &io::Error) -> bool {
    matches!(e.kind(), ErrorKind::ConnectionRefused | ErrorKind::TimedOut)
}

fn probe_is_stale(cfg: &Config, probed_at: Instant) -> bool {
    probed_at.elapsed() >= cfg.connect_timeout
}

type ConnectResult = (usize, io::Result<()>);

/// The probe results of the candidates, handed out in port order, each one
/// as soon as it and every lower port are settled.
pub struct OrderedConnects {
    rx: Receiver<ConnectResult>,
    ports: Vec<u16>,
    settled: Vec<Option<io::Result<()>>>,
    next: usize,
}

impl OrderedConnects {
    pub fn new(ports: Vec<u16>, rx: Receiver<ConnectResult>) -> OrderedConnects {
        let settled = ports.iter().map(|_| None).collect();
        OrderedConnects {
            rx,
            ports,
            settled,
            next: 0,
        }
    }

    pub fn remaining(&self) -> usize {
        self.ports.len() - self.next
    }
}

impl Iterator for OrderedConnects {
    type Item = (u16, io::Result<()>);

    fn next(&mut self) -> Option<Self::Item> {
        let port = *self.ports.get(self.next)?;
        while self.settled[self.next].is_none() {
            match self.rx.recv() {
                Ok((index, result)) => self.settled[index] = Some(result),
                Err(_) => {
                    self.settled[self.next] = Some(Err(io::Error::other("connect thread panicked")))
                }
            }
        }
        let result = self.settled[self.next].take()?;
        self.next += 1;
        Some((port, result))
    }
}

/// Probes every candidate at once and closes each probe connection. On
/// Windows a closed loopback port can answer "refused" only after about two
/// seconds, so a sequential pass over ten free ports would outlast the opening
/// deadline. The handshake runs on a connection opened at the candidate's own
/// turn: a daemon starts its handshake clock at accept, and a mute listener
/// ahead in the order would let that clock run out before the turn comes.
fn connect_all(cfg: &Config) -> OrderedConnects {
    let (tx, rx) = mpsc::channel();
    for (index, &port) in cfg.candidates.iter().enumerate() {
        let tx = tx.clone();
        let (timeout, log) = (cfg.connect_timeout, cfg.logger.clone());
        thread::spawn(move || {
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
            let _ = tx.send((index, loopback::connect(addr, timeout, &log).map(drop)));
        });
    }
    OrderedConnects::new(cfg.candidates.clone(), rx)
}

/// One pass over the candidates, in port order. The first WELCOME ends it.
/// A listener completes the loopback handshake in the kernel at once, so a
/// connect that is refused or still unanswered at `connect_timeout` means no
/// listener: the port is free. Each candidate gets three step timeouts in
/// total for its whole handshake, and no candidate runs past `overall`.
/// A port the probe found free is tried once more at its turn when the probe
/// is older than `connect_timeout`: a daemon may have started to listen while
/// the sweep waited on a lower candidate.
pub fn sweep(cfg: &Config, key: &[u8], hello: &[u8], overall: Option<Instant>) -> Sweep {
    let mut out = Sweep::default();
    let mut connects = connect_all(cfg);
    let probed_at = Instant::now();
    loop {
        let unexamined = connects.remaining();
        let Some((port, attempt)) = connects.next() else {
            break;
        };
        let mut deadline = Instant::now() + cfg.step_timeout * 3;
        if let Some(limit) = overall {
            if Instant::now() >= limit {
                cfg.logger.line(&format!(
                    "opening deadline reached at port {port}, {unexamined} candidates not examined"
                ));
                break;
            }
            deadline = deadline.min(limit);
        }
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let left = deadline.saturating_duration_since(Instant::now());
        let opened = match attempt {
            Ok(()) => loopback::connect(addr, cfg.connect_timeout.min(left), &cfg.logger),
            Err(e) if probe_is_stale(cfg, probed_at) && is_free(&e) => {
                loopback::connect(addr, REPROBE_CONNECT_CAP.min(left), &cfg.logger)
            }
            Err(e) => Err(e),
        };
        let mut stream = match opened {
            Ok(s) => s,
            Err(e) if is_free(&e) => {
                out.free_ports += 1;
                continue;
            }
            Err(e) => {
                cfg.logger
                    .line(&format!("port {port}: cannot connect ({e}), skipped"));
                continue;
            }
        };
        let step = cfg.step_timeout;
        let handshake_began = Instant::now();
        let result =
            auth::authenticate(&mut stream, key, step, deadline).and_then(|mut channel| {
                let welcome = auth::exchange_hello(
                    &mut stream,
                    &mut channel,
                    hello,
                    step,
                    deadline,
                    &cfg.logger,
                )?;
                Ok((welcome, channel))
            });
        match result {
            Ok((welcome, channel)) => {
                out.session = Some(Opened {
                    stream,
                    welcome,
                    sealer: channel.sealer,
                    opener: channel.opener,
                });
                return out;
            }
            Err(ConnectError::Silent) => {
                cfg.logger.line(&format!(
                    "port {port}: no CHALLENGE within {} ms, skipped (silent listener)",
                    handshake_began.elapsed().as_millis()
                ));
                out.silent_ports.push(port);
            }
            Err(ConnectError::Skip(why)) => {
                cfg.logger.line(&format!("port {port}: {why}, skipped"))
            }
            Err(ConnectError::RootMismatch) => cfg.logger.line(&format!(
                "port {port}: daemon serves another code root, skipped"
            )),
            Err(ConnectError::Fatal(cause)) => {
                cfg.logger.line(&format!("port {port}: {cause}"));
                out.fatal.get_or_insert(cause);
            }
        }
    }
    out
}

pub fn launch_lock_file(peers_dir: &std::path::Path, code_root: &str) -> PathBuf {
    peers_dir.join(format!(
        "mcp-daemon-{}.launch",
        &code_root[..8.min(code_root.len())]
    ))
}

fn launch_lock_path(cfg: &Config) -> PathBuf {
    launch_lock_file(&cfg.peers_dir, &cfg.code_root)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn lock_is_stale(cfg: &Config, path: &PathBuf) -> bool {
    let aged = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age >= cfg.launch_lock_stale)
        .unwrap_or(false);
    let owner_dead = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| {
            t.split_whitespace()
                .next()
                .and_then(|p| p.parse::<u32>().ok())
        })
        .map(|pid| !sys::is_alive(pid))
        .unwrap_or(false);
    aged || owner_dead
}

fn create_exclusive(path: &PathBuf) -> io::Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    write!(f, "{} {}", std::process::id(), now_ms())
}

/// Removes a stale lock. Only the relay that creates the takeover marker may
/// do it, and it judges staleness again once it holds the marker: a relay that
/// decided "stale" a moment ago must not delete the fresh lock another relay
/// has made since. The stale file is renamed to a name of its own before it is
/// deleted. Returns whether the lock is gone and the caller may try to create it.
pub fn take_over_stale(cfg: &Config, path: &PathBuf) -> io::Result<bool> {
    let marker = path.with_extension("takeover");
    match create_exclusive(&marker) {
        Ok(()) => {
            let outcome = if lock_is_stale(cfg, path) {
                let graveyard = path.with_extension(format!(
                    "stale-{}-{}",
                    std::process::id(),
                    auth::random_b64(6)?
                ));
                match std::fs::rename(path, &graveyard) {
                    Ok(()) => {
                        cfg.logger
                            .line(&format!("removed a stale launch lock {}", path.display()));
                        auth::remove_file_logged(&graveyard, &cfg.logger);
                        true
                    }
                    Err(e) => {
                        cfg.logger.line(&format!(
                            "cannot take over the stale launch lock {}: {e}",
                            path.display()
                        ));
                        false
                    }
                }
            } else {
                false
            };
            auth::remove_file_logged(&marker, &cfg.logger);
            Ok(outcome)
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            if lock_is_stale(cfg, &marker) {
                clear_stale_marker(cfg, &marker);
            }
            Ok(false)
        }
        Err(e) if cfg!(windows) && e.kind() == ErrorKind::PermissionDenied => {
            cfg.logger.line(&format!(
                "takeover marker {} is busy: {e}",
                marker.display()
            ));
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

/// Clears a takeover marker left by a relay that died. Two relays may judge
/// the same marker stale and a third may have replaced it since, so the marker
/// is moved away first and judged again: a fresh one is put back. A file
/// cannot be compared and deleted in one step, so a third relay creating the
/// marker inside that window is the one case left; its cost is two relays
/// launching a daemon, and the port rule leaves one.
pub fn clear_stale_marker(cfg: &Config, marker: &PathBuf) -> bool {
    let Ok(suffix) = auth::random_b64(6) else {
        cfg.logger
            .line("cannot clear the takeover marker: no random source");
        return false;
    };
    let graveyard = marker.with_extension(format!("stale-{}-{suffix}", std::process::id()));
    if let Err(e) = std::fs::rename(marker, &graveyard) {
        if e.kind() != ErrorKind::NotFound {
            cfg.logger.line(&format!(
                "cannot move the takeover marker {} away: {e}",
                marker.display()
            ));
        }
        return false;
    }
    if !lock_is_stale(cfg, &graveyard) {
        match std::fs::hard_link(&graveyard, marker) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => cfg.logger.line(&format!(
                "cannot put the live takeover marker {} back: {e}",
                marker.display()
            )),
        }
        auth::remove_file_logged(&graveyard, &cfg.logger);
        return false;
    }
    cfg.logger.line(&format!(
        "removed a stale takeover marker {}",
        marker.display()
    ));
    auth::remove_file_logged(&graveyard, &cfg.logger);
    true
}

/// True when this relay holds the launch lock and must start the daemon.
pub fn acquire_launch_lock(cfg: &Config) -> io::Result<bool> {
    std::fs::create_dir_all(&cfg.peers_dir)?;
    let path = launch_lock_path(cfg);
    for _ in 0..2 {
        match create_exclusive(&path) {
            Ok(()) => return Ok(true),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                if !lock_is_stale(cfg, &path) || !take_over_stale(cfg, &path)? {
                    return Ok(false);
                }
            }
            // Windows answers "access denied", not "exists", while another
            // relay's delete or rename of the same file is still settling.
            Err(e) if cfg!(windows) && e.kind() == ErrorKind::PermissionDenied => {
                cfg.logger
                    .line(&format!("launch lock {} is busy: {e}", path.display()));
                return Ok(false);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

pub fn release_launch_lock(cfg: &Config) {
    let path = launch_lock_path(cfg);
    if let Err(e) = std::fs::remove_file(&path) {
        if e.kind() != ErrorKind::NotFound {
            cfg.logger.line(&format!(
                "cannot remove the launch lock {}: {e}",
                path.display()
            ));
        }
    }
}

fn jitter_ms(lo: u64, hi: u64) -> u64 {
    let mut b = [0u8; 4];
    if getrandom::fill(&mut b).is_err() || hi <= lo {
        return lo;
    }
    lo + (u32::from_le_bytes(b) as u64) % (hi - lo + 1)
}

/// Stops a daemon that accepts connections and never answers, only when its
/// state file matches the live process on pid, start time, code root and
/// image name. A reused pid fails the start-time test and is left alone.
pub fn stop_stuck(cfg: &Config, ports: &[u16]) {
    for port in ports {
        let path = cfg.peers_dir.join(format!("mcp-daemon-{port}.json"));
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                cfg.logger.line(&format!(
                    "port {port} is silent and {} is unreadable ({e}); nothing stopped",
                    path.display()
                ));
                continue;
            }
        };
        let state: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                cfg.logger.line(&format!(
                    "{} is not valid JSON ({e}); nothing stopped",
                    path.display()
                ));
                continue;
            }
        };
        let (Some(pid), Some(pid_start)) = (
            state["pid"].as_u64().map(|p| p as u32),
            state["pid_start"].as_str(),
        ) else {
            cfg.logger.line(&format!(
                "{} lacks pid or pid_start; nothing stopped",
                path.display()
            ));
            continue;
        };
        if state["code_root"].as_str() != Some(cfg.code_root.as_str()) {
            cfg.logger.line(&format!(
                "silent daemon on port {port} belongs to another code root; nothing stopped"
            ));
            continue;
        }
        if !sys::is_alive(pid) {
            cfg.logger.line(&format!(
                "silent daemon on port {port}: pid {pid} is not running; nothing stopped"
            ));
            continue;
        }
        if sys::start_time(pid).as_deref() != Some(pid_start) {
            cfg.logger.line(&format!(
                "pid {pid} was reused since {} was written; nothing stopped",
                path.display()
            ));
            continue;
        }
        let image = sys::image_stem(pid).unwrap_or_default();
        if !cfg.accepted_images.contains(&image) {
            cfg.logger.line(&format!(
                "pid {pid} runs image {image:?}, not a daemon image; nothing stopped"
            ));
            continue;
        }
        match sys::terminate(pid) {
            Ok(()) => cfg.logger.line(&format!(
                "stopped the silent daemon on port {port} (pid {pid})"
            )),
            Err(e) => cfg
                .logger
                .line(&format!("cannot stop the silent daemon pid {pid}: {e}")),
        }
    }
}

pub enum Found {
    Session(Box<Opened>),
    Fallback(String),
    /// `Control::stop` was raised: the session is over.
    Stopped,
}

/// Shared between a session and its reconnect thread.
#[derive(Default)]
pub struct Control {
    /// Raised when the session ends, so the reconnect loop stops launching
    /// daemons and touching the peers directory.
    pub stop: AtomicBool,
    /// Why the last pass was refused by a daemon that does exist (a protocol
    /// or hello refusal), cleared by the next pass that is not.
    pub refusal: Mutex<Option<String>>,
}

impl Control {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub fn refusal(&self) -> Option<String> {
        self.refusal
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set_refusal(&self, cause: Option<String>) {
        *self.refusal.lock().unwrap_or_else(|e| e.into_inner()) = cause;
    }

    fn sleep(&self, total: Duration) {
        let end = Instant::now() + total;
        while !self.stopped() {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            sleep(left.min(Duration::from_millis(25)));
        }
    }
}

fn remember_silent(seen: &mut Vec<u16>, ports: &[u16]) {
    for port in ports {
        if !seen.contains(port) {
            seen.push(*port);
        }
    }
}

fn opening_timeout_cause(cfg: &Config, silent: &[u16]) -> String {
    let mut cause = format!(
        "no daemon session opened within {} ms",
        cfg.opening_deadline.as_millis()
    );
    if !silent.is_empty() {
        let ports: Vec<String> = silent.iter().map(u16::to_string).collect();
        cause.push_str(&format!(
            " (silent listeners seen on ports {})",
            ports.join(", ")
        ));
    }
    cause
}

/// Looks for a daemon session; starts the daemon when no candidate answers.
/// With `opening` set it gives up after `opening_deadline` or on a fatal
/// refusal, and the caller falls back to bun. Without it, it retries with
/// backoff for as long as the session lives, never starting another daemon
/// while an existing one refuses the session.
pub fn find_session(
    cfg: &Config,
    key: &[u8],
    hello: &[u8],
    opening: bool,
    spawner: &dyn Spawner,
    ctl: &Control,
) -> Found {
    let started = Instant::now();
    let overall = opening.then(|| started + cfg.opening_deadline);
    let mut backoff = cfg.backoff_min;
    let mut silent_since: Option<Instant> = None;
    let mut silent_seen: Vec<u16> = Vec::new();
    loop {
        if ctl.stopped() {
            return Found::Stopped;
        }
        let pass = sweep(cfg, key, hello, overall);
        if ctl.stopped() {
            return Found::Stopped;
        }
        if let Some(s) = pass.session {
            return Found::Session(Box::new(s));
        }
        remember_silent(&mut silent_seen, &pass.silent_ports);
        ctl.set_refusal(pass.fatal.clone());
        if let Some(cause) = pass.fatal.clone() {
            if opening {
                return Found::Fallback(cause);
            }
        }
        if opening && started.elapsed() >= cfg.opening_deadline {
            return Found::Fallback(opening_timeout_cause(cfg, &silent_seen));
        }
        if pass.silent_ports.is_empty() {
            silent_since = None;
        } else {
            let since = *silent_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= cfg.stuck_after {
                stop_stuck(cfg, &pass.silent_ports);
                silent_since = None;
            }
        }
        let mut wait = if opening {
            cfg.poll_interval
        } else {
            backoff + Duration::from_millis(jitter_ms(0, backoff.as_millis() as u64 / 4))
        };
        if pass.free_ports == 0 && pass.silent_ports.is_empty() && opening {
            return Found::Fallback(
                "every candidate port is held by another program or another code root".into(),
            );
        }
        if pass.free_ports > 0 && pass.fatal.is_none() {
            match acquire_launch_lock(cfg) {
                Ok(true) => {
                    let recheck = sweep(cfg, key, hello, overall);
                    if let Some(s) = recheck.session {
                        release_launch_lock(cfg);
                        return Found::Session(Box::new(s));
                    }
                    remember_silent(&mut silent_seen, &recheck.silent_ports);
                    if opening && started.elapsed() >= cfg.opening_deadline {
                        release_launch_lock(cfg);
                        return Found::Fallback(opening_timeout_cause(cfg, &silent_seen));
                    }
                    if recheck.free_ports == 0 || recheck.fatal.is_some() {
                        release_launch_lock(cfg);
                        match recheck.fatal {
                            Some(cause) => {
                                cfg.logger.line(&format!(
                                    "a daemon refused the session under the launch lock ({cause}); not starting another"
                                ));
                                ctl.set_refusal(Some(cause.clone()));
                                if opening {
                                    return Found::Fallback(cause);
                                }
                            }
                            None => cfg.logger.line(
                                "every candidate port became occupied since the first sweep; not starting a daemon",
                            ),
                        }
                    } else {
                        cfg.logger.line("starting the shared MCP daemon");
                        if let Err(e) = spawner.spawn(cfg) {
                            cfg.logger.line(&format!("cannot start the daemon: {e}"));
                            release_launch_lock(cfg);
                            if opening {
                                return Found::Fallback(format!("cannot start the daemon: {e}"));
                            }
                        }
                    }
                }
                Ok(false) => {
                    wait =
                        Duration::from_millis(jitter_ms(cfg.lock_retry_ms.0, cfg.lock_retry_ms.1))
                }
                Err(e) => {
                    cfg.logger
                        .line(&format!("cannot take the launch lock: {e}"));
                    if opening {
                        return Found::Fallback(format!("cannot take the launch lock: {e}"));
                    }
                }
            }
        }
        ctl.sleep(wait);
        backoff = (backoff * 2).min(cfg.backoff_max);
    }
}
