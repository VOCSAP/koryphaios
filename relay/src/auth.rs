use std::io::{self, ErrorKind, Read};
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::Logger;
use crate::frame;
use crate::paths::{hex_decode, hex_encode};
use crate::seal::{Opener, Sealer};

type HmacSha256 = Hmac<Sha256>;

pub const PROTO_MIN: u64 = 1;
pub const PROTO_MAX: u64 = 1;
const KEY_FILE: &str = "mcp-daemon.key";

fn mac_message(role: &str, parts: &[&str]) -> String {
    format!("kory-mcp-v1|{role}|{}", parts.join("|"))
}

pub fn mac(key: &[u8], role: &str, parts: &[&str]) -> String {
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    m.update(mac_message(role, parts).as_bytes());
    URL_SAFE_NO_PAD.encode(m.finalize().into_bytes())
}

pub fn verify(key: &[u8], role: &str, parts: &[&str], presented: &str) -> bool {
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(presented) else {
        return false;
    };
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    m.update(mac_message(role, parts).as_bytes());
    m.verify_slice(&bytes).is_ok()
}

/// base64url, no padding, of the SHA-256 of the exact payload bytes.
pub fn transcript_hash(payload: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(payload))
}

/// The relay's MAC covers the CHALLENGE it answers and the versions it offers.
/// The role `control` is reserved for the daemon's own control client and is
/// never signed with the `relay` role.
pub fn relay_mac(
    key: &[u8],
    daemon_nonce: &str,
    relay_nonce: &str,
    challenge: &[u8],
    proto_min: u64,
    proto_max: u64,
) -> String {
    let (hc, lo, hi) = (
        transcript_hash(challenge),
        proto_min.to_string(),
        proto_max.to_string(),
    );
    mac(key, "relay", &[daemon_nonce, relay_nonce, &hc, &lo, &hi])
}

pub fn verify_relay_mac(
    key: &[u8],
    daemon_nonce: &str,
    relay_nonce: &str,
    challenge: &[u8],
    proto_min: u64,
    proto_max: u64,
    presented: &str,
) -> bool {
    let (hc, lo, hi) = (
        transcript_hash(challenge),
        proto_min.to_string(),
        proto_max.to_string(),
    );
    verify(
        key,
        "relay",
        &[daemon_nonce, relay_nonce, &hc, &lo, &hi],
        presented,
    )
}

/// The daemon's MAC covers CHALLENGE, the whole AUTH payload (relay MAC
/// included) and the version it selected.
pub fn daemon_mac(
    key: &[u8],
    relay_nonce: &str,
    daemon_nonce: &str,
    challenge: &[u8],
    auth: &[u8],
    proto: u64,
) -> String {
    let (hc, ha, p) = (
        transcript_hash(challenge),
        transcript_hash(auth),
        proto.to_string(),
    );
    mac(key, "daemon", &[relay_nonce, daemon_nonce, &hc, &ha, &p])
}

pub fn verify_daemon_mac(
    key: &[u8],
    relay_nonce: &str,
    daemon_nonce: &str,
    challenge: &[u8],
    auth: &[u8],
    proto: u64,
    presented: &str,
) -> bool {
    let (hc, ha, p) = (
        transcript_hash(challenge),
        transcript_hash(auth),
        proto.to_string(),
    );
    verify(
        key,
        "daemon",
        &[relay_nonce, daemon_nonce, &hc, &ha, &p],
        presented,
    )
}

pub struct SessionKeys {
    pub r2d: [u8; 32],
    pub d2r: [u8; 32],
}

/// One key per direction, bound to the three handshake payloads and to both
/// nonces: `HKDF-SHA256(ikm = key file, salt = daemon_nonce || relay_nonce,
/// info = label || SHA-256(CHALLENGE || AUTH || AUTH_OK))`.
pub fn derive_keys(
    ikm: &[u8],
    daemon_nonce: &[u8],
    relay_nonce: &[u8],
    challenge: &[u8],
    auth: &[u8],
    auth_ok: &[u8],
) -> Result<SessionKeys, String> {
    let mut transcript = Sha256::new();
    transcript.update(challenge);
    transcript.update(auth);
    transcript.update(auth_ok);
    let th = transcript.finalize();
    let mut salt = daemon_nonce.to_vec();
    salt.extend_from_slice(relay_nonce);
    let hk = Hkdf::<Sha256>::new(Some(&salt), ikm);
    let expand = |label: &str| -> Result<[u8; 32], String> {
        let mut info = label.as_bytes().to_vec();
        info.extend_from_slice(&th);
        let mut okm = [0u8; 32];
        hk.expand(&info, &mut okm)
            .map_err(|e| format!("key derivation failed: {e}"))?;
        Ok(okm)
    };
    Ok(SessionKeys {
        r2d: expand("kory-mcp-v1 r2d")?,
        d2r: expand("kory-mcp-v1 d2r")?,
    })
}

pub fn random_bytes(n: usize) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf)
        .map_err(|e| io::Error::other(format!("random source failed: {e}")))?;
    Ok(buf)
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn b64_decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

pub fn random_b64(n: usize) -> io::Result<String> {
    Ok(b64(&random_bytes(n)?))
}

/// Removes a file, writing any failure other than "already gone" to the log.
pub fn remove_file_logged(path: &Path, log: &Logger) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != ErrorKind::NotFound {
            log.line(&format!("cannot remove {}: {e}", path.display()));
        }
    }
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)
}

/// Reads the shared key, creating it when absent. The file appears fully
/// written or not at all: it is written under a temporary name, then hard
/// linked, and a hard link fails when the target exists.
pub fn load_or_create_key(peers_dir: &Path, log: &Logger) -> Result<Vec<u8>, String> {
    let path = peers_dir.join(KEY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => return parse_key(&path, &text, log),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    }
    create_private_dir(peers_dir)
        .map_err(|e| format!("cannot create {}: {e}", peers_dir.display()))?;
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|e| format!("random source failed: {e}"))?;
    let tmp = peers_dir.join(format!(
        "{KEY_FILE}.{}.tmp",
        random_b64(8).map_err(|e| e.to_string())?
    ));
    if let Err(e) = write_private(&tmp, hex_encode(&raw).as_bytes()) {
        remove_file_logged(&tmp, log);
        return Err(format!("cannot write {}: {e}", tmp.display()));
    }
    let linked = std::fs::hard_link(&tmp, &path);
    remove_file_logged(&tmp, log);
    match linked {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("cannot publish {}: {e}", path.display())),
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    parse_key(&path, &text, log)
}

fn parse_key(path: &Path, text: &str, log: &Logger) -> Result<Vec<u8>, String> {
    check_permissions(path, log)?;
    match hex_decode(text.trim()) {
        Some(k) if k.len() == 32 => Ok(k),
        _ => Err(format!(
            "{} does not hold 64 hexadecimal characters",
            path.display()
        )),
    }
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(data)
}

#[cfg(windows)]
fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    write_private_with(path, data, &mut |_| {})
}

/// Creates `path` closed to every other account, runs `before_write` on the
/// empty file, then writes `data`.
#[cfg(windows)]
pub fn write_private_with(
    path: &Path,
    data: &[u8],
    before_write: &mut dyn FnMut(&Path),
) -> io::Result<()> {
    use std::io::Write;
    let mut f = crate::winacl::create_private(path)?;
    before_write(path);
    f.write_all(data)
}

/// The key file must be closed to group and others. Its directory may be
/// readable (`~/.claude/peers` is created 0755 under a 022 umask by the
/// daemon's other writers) but not writable by them: a writable directory
/// lets another account swap the key file.
pub fn permission_verdict(mode: u32, is_dir: bool) -> Result<(), String> {
    let (forbidden, what) = if is_dir {
        (0o022, "is writable by group or others")
    } else {
        (0o077, "grants rights to group or others")
    };
    if mode & forbidden != 0 {
        return Err(format!("{what} (mode {:o})", mode & 0o777));
    }
    Ok(())
}

#[cfg(unix)]
fn check_permissions(path: &Path, _log: &Logger) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::getuid() };
    let dir = path.parent().unwrap_or(Path::new("."));
    for p in [path, dir] {
        let md = std::fs::metadata(p).map_err(|e| format!("cannot stat {}: {e}", p.display()))?;
        permission_verdict(md.mode(), p == dir).map_err(|why| format!("{} {why}", p.display()))?;
        if p == path && md.uid() != uid {
            return Err(format!("{} is not owned by the current user", p.display()));
        }
    }
    Ok(())
}

/// A key whose access list is open is repaired once and logged; one that stays
/// open is refused, so the session falls back to bun.
#[cfg(windows)]
fn check_permissions(path: &Path, log: &Logger) -> Result<(), String> {
    check_permissions_with(path, log, &crate::winacl::protect)
}

/// `check_permissions` with the repair injected.
#[cfg(windows)]
pub fn check_permissions_with(
    path: &Path,
    log: &Logger,
    repair: &dyn Fn(&Path) -> io::Result<()>,
) -> Result<(), String> {
    use crate::winacl::audit;
    let read = |p: &Path| {
        audit(p).map_err(|e| format!("cannot read the access list of {}: {e}", p.display()))
    };
    let Err(why) = read(path)? else {
        return Ok(());
    };
    repair(path).map_err(|e| {
        format!(
            "{} {why} and its access list cannot be repaired: {e}",
            path.display()
        )
    })?;
    if let Err(still) = read(path)? {
        return Err(format!("{} {still} after the repair", path.display()));
    }
    log.line(&format!(
        "repaired the access list of {}: it {why}",
        path.display()
    ));
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Welcome {
    pub session_id: String,
    pub family: String,
    pub tools_hash: String,
    pub resumed: bool,
}

#[derive(Debug)]
pub enum ConnectError {
    /// Connected but no CHALLENGE within the step timeout.
    Silent,
    /// Not a usable daemon for this relay; try the next candidate.
    Skip(String),
    RootMismatch,
    /// The daemon cannot serve this relay at all; start-up falls back to bun.
    Fatal(String),
}

fn timed_out(e: &io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

fn error_frame(payload: &[u8]) -> (String, String) {
    let v: Value = serde_json::from_slice(payload).unwrap_or(Value::Null);
    (
        v["code"].as_str().unwrap_or("unknown").to_string(),
        v["message"].as_str().unwrap_or("").to_string(),
    )
}

/// Reads under one absolute deadline: each `read` is given only the time that
/// is left, so a peer sending a byte now and then cannot stretch a frame.
struct DeadlineReader<'a> {
    stream: &'a TcpStream,
    deadline: Instant,
}

impl Read for DeadlineReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| io::Error::from(ErrorKind::TimedOut))?;
        self.stream.set_read_timeout(Some(left))?;
        let mut stream = self.stream;
        stream.read(buf)
    }
}

fn read_pre_auth(stream: &TcpStream, deadline: Instant) -> io::Result<(u8, Vec<u8>)> {
    frame::read_frame_max(
        &mut DeadlineReader { stream, deadline },
        frame::PRE_AUTH_MAX_PAYLOAD,
    )
}

fn time_left(deadline: Instant) -> Result<Duration, ConnectError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(ConnectError::Silent)
}

/// The two directions of an authenticated connection.
pub struct Channel {
    pub proto: u64,
    pub sealer: Sealer,
    pub opener: Opener,
}

/// Mutual authentication. Each step (CHALLENGE, then AUTH_OK) gets one
/// absolute deadline of `step`, never later than `limit`. Nothing but the AUTH
/// frame leaves the relay before the daemon's MAC has been verified, and an
/// ERROR frame at this stage is only ever "try the next candidate": it
/// carries no proof of who sent it.
pub fn authenticate(
    stream: &mut TcpStream,
    key: &[u8],
    step: Duration,
    limit: Instant,
) -> Result<Channel, ConnectError> {
    let io_err = |what: &str, e: io::Error| ConnectError::Skip(format!("{what}: {e}"));
    let step_end = || (Instant::now() + step).min(limit);
    stream
        .set_write_timeout(Some(time_left(step_end())?))
        .map_err(|e| io_err("set timeout", e))?;
    let (ty, challenge_raw) = match read_pre_auth(stream, step_end()) {
        Ok(f) => f,
        Err(e) if timed_out(&e) => return Err(ConnectError::Silent),
        Err(e) => return Err(io_err("no CHALLENGE", e)),
    };
    if ty != frame::CHALLENGE {
        return Err(ConnectError::Skip(format!(
            "expected CHALLENGE, got frame type {ty:#04x}"
        )));
    }
    let challenge: Value = serde_json::from_slice(&challenge_raw)
        .map_err(|e| ConnectError::Skip(format!("CHALLENGE is not JSON: {e}")))?;
    let daemon_nonce = challenge["daemon_nonce"]
        .as_str()
        .ok_or_else(|| ConnectError::Skip("CHALLENGE has no daemon_nonce".into()))?
        .to_string();
    let daemon_nonce_raw = b64_decode(&daemon_nonce)
        .filter(|n| n.len() == 32)
        .ok_or_else(|| ConnectError::Skip("CHALLENGE daemon_nonce is not 32 bytes".into()))?;
    let relay_nonce_raw = random_bytes(32).map_err(|e| ConnectError::Fatal(e.to_string()))?;
    let relay_nonce = b64(&relay_nonce_raw);
    let auth_raw = json!({
        "proto_min": PROTO_MIN,
        "proto_max": PROTO_MAX,
        "relay_nonce": relay_nonce,
        "mac": relay_mac(key, &daemon_nonce, &relay_nonce, &challenge_raw, PROTO_MIN, PROTO_MAX),
    })
    .to_string()
    .into_bytes();
    frame::write_frame(stream, frame::AUTH, &auth_raw).map_err(|e| io_err("send AUTH", e))?;
    let (ty, ok_raw) = read_pre_auth(stream, step_end()).map_err(|e| io_err("no AUTH_OK", e))?;
    match ty {
        frame::AUTH_OK => {}
        frame::ERROR => {
            let (code, _) = error_frame(&ok_raw);
            return Err(ConnectError::Skip(format!(
                "unauthenticated ERROR {code} instead of AUTH_OK"
            )));
        }
        other => {
            return Err(ConnectError::Skip(format!(
                "expected AUTH_OK, got frame type {other:#04x}"
            )))
        }
    }
    let ok: Value = serde_json::from_slice(&ok_raw)
        .map_err(|e| ConnectError::Skip(format!("AUTH_OK is not JSON: {e}")))?;
    let proto = ok["proto"].as_u64().unwrap_or(0);
    if !verify_daemon_mac(
        key,
        &relay_nonce,
        &daemon_nonce,
        &challenge_raw,
        &auth_raw,
        proto,
        ok["mac"].as_str().unwrap_or(""),
    ) {
        return Err(ConnectError::Skip(
            "the listener did not prove it knows the shared key".into(),
        ));
    }
    if !(PROTO_MIN..=PROTO_MAX).contains(&proto) {
        return Err(ConnectError::Fatal(format!(
            "daemon selected protocol {proto}, this relay speaks {PROTO_MIN}..{PROTO_MAX}"
        )));
    }
    let keys = derive_keys(
        key,
        &daemon_nonce_raw,
        &relay_nonce_raw,
        &challenge_raw,
        &auth_raw,
        &ok_raw,
    )
    .map_err(ConnectError::Fatal)?;
    let seal_err =
        |e: io::Error| ConnectError::Fatal(format!("cannot set up the sealed channel: {e}"));
    Ok(Channel {
        proto,
        sealer: Sealer::new(&keys.r2d).map_err(seal_err)?,
        opener: Opener::new(&keys.d2r).map_err(seal_err)?,
    })
}

/// Sends HELLO and waits for WELCOME on the sealed channel, under one absolute
/// deadline of `step`, never later than `limit`. `ticket_refused` is not fatal.
pub fn exchange_hello(
    stream: &mut TcpStream,
    channel: &mut Channel,
    hello: &[u8],
    step: Duration,
    limit: Instant,
    log: &Logger,
) -> Result<Welcome, ConnectError> {
    let deadline = (Instant::now() + step).min(limit);
    stream
        .set_write_timeout(Some(time_left(deadline)?))
        .map_err(|e| ConnectError::Skip(format!("set timeout: {e}")))?;
    channel
        .sealer
        .write(stream, frame::HELLO, hello)
        .map_err(|e| ConnectError::Skip(format!("send HELLO: {e}")))?;
    loop {
        let (ty, payload) = channel
            .opener
            .read_max(
                &mut DeadlineReader { stream, deadline },
                frame::PRE_AUTH_MAX_PAYLOAD,
            )
            .map_err(|e| ConnectError::Skip(format!("no WELCOME: {e}")))?;
        match ty {
            frame::WELCOME => {
                let v: Value = serde_json::from_slice(&payload)
                    .map_err(|e| ConnectError::Skip(format!("WELCOME is not JSON: {e}")))?;
                stream
                    .set_read_timeout(None)
                    .and_then(|_| stream.set_write_timeout(None))
                    .map_err(|e| ConnectError::Skip(format!("clear timeouts: {e}")))?;
                return Ok(Welcome {
                    session_id: v["session_id"].as_str().unwrap_or("").to_string(),
                    family: v["family"].as_str().unwrap_or("").to_string(),
                    tools_hash: v["tools_hash"].as_str().unwrap_or("").to_string(),
                    resumed: v["resumed"].as_bool().unwrap_or(false),
                });
            }
            frame::ERROR => {
                let (code, message) = error_frame(&payload);
                match code.as_str() {
                    "ticket_refused" => {
                        log.line(&format!("daemon refused the resume ticket: {message}"))
                    }
                    "root_mismatch" => return Err(ConnectError::RootMismatch),
                    "shutting_down" => {
                        return Err(ConnectError::Skip("daemon is shutting down".into()))
                    }
                    other => {
                        return Err(ConnectError::Fatal(format!(
                            "daemon answered {other}: {message}"
                        )))
                    }
                }
            }
            other => {
                return Err(ConnectError::Skip(format!(
                    "expected WELCOME, got frame type {other:#04x}"
                )))
            }
        }
    }
}
