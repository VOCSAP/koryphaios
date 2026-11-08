use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::config::{Config, Logger};

pub trait Spawner: Send + Sync {
    fn spawn(&self, cfg: &Config) -> io::Result<()>;
}

pub struct RealSpawner;

impl Spawner for RealSpawner {
    fn spawn(&self, cfg: &Config) -> io::Result<()> {
        let image = prepare_image(cfg);
        let script = cfg.daemon_script();
        std::fs::create_dir_all(&cfg.log_dir)?;
        let out_log = cfg.log_dir.join("mcp-daemon.out.log");
        let attempt = |breakaway: bool| -> io::Result<()> {
            let out = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&out_log)?;
            let err = out.try_clone()?;
            let mut cmd = Command::new(&image);
            cmd.arg(&script)
                .env_clear()
                .envs(daemon_env(
                    std::env::vars_os().collect(),
                    cfg!(windows),
                    &cfg.logger,
                ))
                .current_dir(&cfg.peers_dir)
                .stdin(Stdio::null())
                .stdout(out)
                .stderr(err);
            detach(&mut cmd, breakaway);
            cmd.spawn().map(|_| ())
        };
        spawn_with_breakaway_fallback(&cfg.logger, attempt)
    }
}

/// Tries with `CREATE_BREAKAWAY_FROM_JOB`; a job that forbids breakaway
/// refuses the flag, and the daemon is then launched without it.
pub fn spawn_with_breakaway_fallback<T>(
    log: &Logger,
    mut attempt: impl FnMut(bool) -> io::Result<T>,
) -> io::Result<T> {
    if !cfg!(windows) {
        return attempt(false);
    }
    match attempt(true) {
        Ok(v) => Ok(v),
        Err(e) => {
            log.line(&format!("launch with CREATE_BREAKAWAY_FROM_JOB refused ({e}); retrying without it, the daemon will end with the job that holds this relay"));
            attempt(false)
        }
    }
}

#[cfg(windows)]
fn detach(cmd: &mut Command, breakaway: bool) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let mut flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    if breakaway {
        flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    cmd.creation_flags(flags);
}

#[cfg(unix)]
fn detach(cmd: &mut Command, _breakaway: bool) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

const OS_AND_PROXY_NAMES: &[&str] = &[
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];
const DAEMON_NAMES: &[&str] = &[
    "CLAUDE_PEERS_LOG_DIR",
    "CLAUDE_PEERS_POLL_FALLBACK_SEC",
    "CLAUDE_PEERS_CONTEXT_RESUME_KEY_TTL_MS",
];

/// The daemon gets OS basics, proxies and its own global settings, never a
/// session variable: the first relay to start it must not lend its group.
pub fn daemon_env(
    vars: Vec<(OsString, OsString)>,
    case_insensitive: bool,
    log: &Logger,
) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(k, _)| {
            let Some(name) = k.to_str() else {
                log.line(&format!("environment variable {k:?} is not valid UTF-8, left out of the daemon environment"));
                return false;
            };
            let n = if case_insensitive { name.to_ascii_uppercase() } else { name.to_string() };
            OS_AND_PROXY_NAMES.contains(&n.as_str()) || n.starts_with("XDG_") || DAEMON_NAMES.contains(&n.as_str()) || n.starts_with("CLAUDE_PEERS_MCP_DAEMON_")
        })
        .collect()
}

/// The daemon runs under the name `kory-mcp-daemon` so it is told apart from
/// the other bun processes; when the copy fails, the bun binary itself runs.
fn prepare_image(cfg: &Config) -> PathBuf {
    let name = if cfg!(windows) {
        "kory-mcp-daemon.exe"
    } else {
        "kory-mcp-daemon"
    };
    let dest = cfg.peers_dir.join("bin").join(name);
    match link_image(&cfg.bun, &dest) {
        Ok(()) => dest,
        Err(e) => {
            cfg.logger.line(&format!(
                "cannot prepare {} ({e}); launching {} under its own name",
                dest.display(),
                cfg.bun.display()
            ));
            cfg.bun.clone()
        }
    }
}

#[cfg(windows)]
fn link_image(src: &Path, dest: &Path) -> io::Result<()> {
    let src_md = std::fs::metadata(src)?;
    if let Ok(md) = std::fs::metadata(dest) {
        if md.len() == src_md.len() && md.modified()? == src_md.modified()? {
            return Ok(());
        }
    }
    std::fs::create_dir_all(dest.parent().unwrap_or(Path::new(".")))?;
    std::fs::copy(src, dest)?;
    OpenOptions::new()
        .write(true)
        .open(dest)?
        .set_modified(src_md.modified()?)
}

#[cfg(unix)]
fn link_image(src: &Path, dest: &Path) -> io::Result<()> {
    if std::fs::read_link(dest).map(|t| t == src).unwrap_or(false) {
        return Ok(());
    }
    std::fs::create_dir_all(dest.parent().unwrap_or(Path::new(".")))?;
    let _ = std::fs::remove_file(dest);
    std::os::unix::fs::symlink(src, dest)
}
