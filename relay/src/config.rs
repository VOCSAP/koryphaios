use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::{discovery, paths, sys};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    Peers,
    Roadmap,
}

impl Family {
    pub fn parse(s: &str) -> Option<Family> {
        match s {
            "peers" => Some(Family::Peers),
            "roadmap" => Some(Family::Roadmap),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Family::Peers => "peers",
            Family::Roadmap => "roadmap",
        }
    }
}

type LogObserver = Arc<dyn Fn(&str) + Send + Sync>;

/// The relay's only log sink is stderr, which Claude Code captures in its MCP
/// logs. `capture` lets a test read the same lines.
#[derive(Clone)]
pub struct Logger {
    tag: String,
    capture: Option<Arc<Mutex<Vec<String>>>>,
    observer: Option<LogObserver>,
}

impl Logger {
    pub fn new(tag: &str) -> Logger {
        Logger {
            tag: tag.to_string(),
            capture: None,
            observer: None,
        }
    }

    pub fn capturing(tag: &str) -> (Logger, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        (
            Logger {
                tag: tag.to_string(),
                capture: Some(lines.clone()),
                observer: None,
            },
            lines,
        )
    }

    /// `observer` runs on the logging thread for every line, so a test can act
    /// at an exact point of the code that logs.
    pub fn observed_by(mut self, observer: impl Fn(&str) + Send + Sync + 'static) -> Logger {
        self.observer = Some(Arc::new(observer));
        self
    }

    pub fn line(&self, msg: &str) {
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), "{}: {}", self.tag, msg);
        if let Some(c) = &self.capture {
            c.lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(msg.to_string());
        }
        if let Some(o) = &self.observer {
            o(msg);
        }
    }
}

#[derive(Clone)]
pub struct Config {
    pub family: Family,
    pub fallback: PathBuf,
    pub bun: PathBuf,
    pub peers_dir: PathBuf,
    pub log_dir: PathBuf,
    pub candidates: Vec<u16>,
    pub code_root: String,
    pub accepted_images: Vec<String>,
    pub opening_deadline: Duration,
    pub stuck_after: Duration,
    pub step_timeout: Duration,
    pub connect_timeout: Duration,
    pub ping_interval: Duration,
    pub pong_timeout: Duration,
    pub replay_timeout: Duration,
    pub poll_interval: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub launch_lock_stale: Duration,
    pub lock_retry_ms: (u64, u64),
    pub logger: Logger,
}

impl Config {
    /// Design values; tests shrink the durations and inject the candidate list.
    pub fn defaults(
        family: Family,
        fallback: PathBuf,
        bun: PathBuf,
        peers_dir: PathBuf,
        candidates: Vec<u16>,
        code_root: String,
        logger: Logger,
    ) -> Config {
        Config {
            family,
            fallback,
            bun,
            log_dir: peers_dir.join("logs"),
            peers_dir,
            candidates,
            code_root,
            accepted_images: vec!["kory-mcp-daemon".into(), "bun".into()],
            opening_deadline: Duration::from_secs(10),
            stuck_after: Duration::from_secs(30),
            step_timeout: Duration::from_secs(3),
            connect_timeout: Duration::from_secs(1),
            ping_interval: Duration::from_secs(15),
            pong_timeout: Duration::from_secs(10),
            replay_timeout: Duration::from_secs(5),
            poll_interval: Duration::from_millis(100),
            backoff_min: Duration::from_millis(100),
            backoff_max: Duration::from_secs(5),
            launch_lock_stale: Duration::from_secs(15),
            lock_retry_ms: (200, 800),
            logger,
        }
    }

    pub fn from_env(
        family: Family,
        fallback: PathBuf,
        bun: Option<PathBuf>,
    ) -> Result<Config, String> {
        let home = paths::home_dir().ok_or("neither HOME nor USERPROFILE is set")?;
        let peers_dir = home.join(".claude").join("peers");
        let dir = fallback
            .parent()
            .ok_or("--fallback has no parent directory")?;
        let code_root = paths::code_root_of(dir)
            .map_err(|e| format!("cannot canonicalize the --fallback directory: {e}"))?;
        let override_port = match std::env::var("CLAUDE_PEERS_MCP_DAEMON_PORT") {
            Ok(v) if !v.trim().is_empty() => Some(
                v.trim()
                    .parse::<u16>()
                    .ok()
                    .filter(|p| *p != 0)
                    .ok_or_else(|| {
                        format!("CLAUDE_PEERS_MCP_DAEMON_PORT is not a valid port: {v:?}")
                    })?,
            ),
            _ => None,
        };
        let username = sys::username().ok_or("cannot read the OS user name")?;
        let candidates = discovery::candidate_ports(&username, override_port);
        let bun = bun
            .unwrap_or_else(|| paths::find_in_path("bun").unwrap_or_else(|| PathBuf::from("bun")));
        let log_dir = paths::core_log_dir(&|k| std::env::var(k).ok(), &home);
        let logger = Logger::new(&format!(
            "claude-peers-relay[{} {}]",
            family.as_str(),
            std::process::id()
        ));
        let mut cfg = Config::defaults(
            family, fallback, bun, peers_dir, candidates, code_root, logger,
        );
        cfg.log_dir = log_dir;
        Ok(cfg)
    }

    pub fn daemon_script(&self) -> PathBuf {
        self.fallback
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
            .join("mcp-daemon.ts")
    }
}
