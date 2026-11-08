use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::IsTerminal;

use serde_json::json;

use crate::config::{Config, Logger};
use crate::sys;

const EXACT_NAMES: &[&str] = &[
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

const PEERS_PREFIX: &str = "CLAUDE_PEERS_";

/// Keeps the variables the daemon may read for a session. An empty value is
/// dropped: Windows hands an empty variable to a child as absent, so the
/// daemon must see what a directly launched server would. With
/// `case_insensitive` (Windows) a match is reported under its canonical
/// upper-case name, because the daemon indexes a plain object.
pub fn filter_env(
    vars: Vec<(OsString, OsString)>,
    case_insensitive: bool,
    log: &Logger,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (k, v) in vars {
        let (Some(name), Some(value)) = (k.to_str(), v.to_str()) else {
            log.line(&format!(
                "environment variable {k:?} is not valid UTF-8, left out of the hello"
            ));
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let canonical = if case_insensitive {
            let upper = name.to_ascii_uppercase();
            if upper.starts_with(PEERS_PREFIX)
                || EXACT_NAMES.iter().any(|n| n.eq_ignore_ascii_case(&upper))
            {
                Some(upper)
            } else {
                None
            }
        } else if name.starts_with(PEERS_PREFIX) || EXACT_NAMES.contains(&name) {
            Some(name.to_string())
        } else {
            None
        };
        if let Some(c) = canonical {
            out.insert(c, value.to_string());
        }
    }
    out
}

pub struct Facts {
    pub pid: u32,
    pub ppid: u32,
    pub pid_start: String,
    pub ppid_start: String,
    pub cwd: String,
    pub stdin_is_tty: bool,
    pub env: BTreeMap<String, String>,
}

impl Facts {
    pub fn collect(log: &Logger) -> Facts {
        let pid = std::process::id();
        let ppid = sys::parent_pid().unwrap_or_else(|| {
            log.line("cannot read the parent pid, sending 0");
            0
        });
        let measure = |p: u32, what: &str| {
            sys::start_time(p).unwrap_or_else(|| {
                log.line(&format!(
                    "cannot read the start time of the {what} (pid {p})"
                ));
                String::new()
            })
        };
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|e| {
                log.line(&format!("cannot read the working directory: {e}"));
                String::new()
            });
        Facts {
            pid,
            ppid,
            pid_start: measure(pid, "relay"),
            ppid_start: if ppid == 0 {
                String::new()
            } else {
                measure(ppid, "parent")
            },
            cwd,
            stdin_is_tty: std::io::stdin().is_terminal(),
            env: filter_env(std::env::vars_os().collect(), cfg!(windows), log),
        }
    }
}

pub fn build_hello(
    cfg: &Config,
    facts: &Facts,
    resume_ticket: Option<&str>,
    replay: bool,
) -> Vec<u8> {
    let mut hello = json!({
        "proto": crate::auth::PROTO_MAX,
        "family": cfg.family.as_str(),
        "relay_version": env!("CARGO_PKG_VERSION"),
        "code_root": cfg.code_root,
        "pid": facts.pid,
        "ppid": facts.ppid,
        "pid_start": facts.pid_start,
        "ppid_start": facts.ppid_start,
        "cwd": facts.cwd,
        "stdin_is_tty": facts.stdin_is_tty,
        "env": facts.env,
        "replay": replay,
    });
    if let Some(t) = resume_ticket {
        hello["resume_ticket"] = json!(t);
    }
    hello.to_string().into_bytes()
}
