use std::io::{self, ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Connects to every candidate at once. On Windows a closed loopback port
/// answers "refused" only after about two seconds, so a sequential pass over
/// ten free ports would outlast the opening deadline.
fn connect_all(cfg: &Config) -> Vec<(u16, io::Result<TcpStream>)> {
    thread::scope(|s| {
        let handles: Vec<_> = cfg
            .candidates
            .iter()
            .map(|&port| {
                (
                    port,
                    s.spawn(move || {
                        TcpStream::connect_timeout(
                            &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
                            cfg.connect_timeout,
                        )
                    }),
                )
            })
            .collect();
        handles
            .into_iter()
            .map(|(port, h)| {
                (
                    port,
                    h.join()
                        .unwrap_or_else(|_| Err(io::Error::other("connect thread panicked"))),
                )
            })
            .collect()
    })
}

/// One pass over the candidates, in port order. The first WELCOME ends it.
/// A listener completes the loopback handshake in the kernel at once, so a
/// connect that is refused or still unanswered at `connect_timeout` means no
/// listener: the port is free. Each candidate gets three step timeouts in
/// total for its whole handshake, and no candidate runs past `overall`.
pub fn sweep(cfg: &Config, key: &[u8], hello: &[u8], overall: Option<Instant>) -> Sweep {
    let mut out = Sweep::default();
    for (port, attempt) in connect_all(cfg) {
        let mut deadline = Instant::now() + cfg.step_timeout * 3;
        if let Some(limit) = overall {
            if Instant::now() >= limit {
                cfg.logger
                    .line(&format!("port {port}: opening deadline reached, not tried"));
                break;
            }
            deadline = deadline.min(limit);
        }
        let mut stream = match attempt {
            Ok(s) => s,
            Err(e) if matches!(e.kind(), ErrorKind::ConnectionRefused | ErrorKind::TimedOut) => {
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
            Err(ConnectError::Silent) => out.silent_ports.push(port),
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
        ctl.set_refusal(pass.fatal.clone());
        if let Some(cause) = pass.fatal.clone() {
            if opening {
                return Found::Fallback(cause);
            }
        }
        if opening && started.elapsed() >= cfg.opening_deadline {
            return Found::Fallback(format!(
                "no daemon session opened within {} ms",
                cfg.opening_deadline.as_millis()
            ));
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
                    cfg.logger.line("starting the shared MCP daemon");
                    if let Err(e) = spawner.spawn(cfg) {
                        cfg.logger.line(&format!("cannot start the daemon: {e}"));
                        release_launch_lock(cfg);
                        if opening {
                            return Found::Fallback(format!("cannot start the daemon: {e}"));
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
