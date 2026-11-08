use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::config::{Family, Logger};
use crate::sys;

pub struct FallbackPlan<'a> {
    pub family: Family,
    pub bun: &'a Path,
    pub script: &'a Path,
    pub peers_dir: Option<&'a Path>,
    pub log: &'a Logger,
}

/// Hands the session to the stdio server it replaces. The relay has not read
/// stdin yet, so the child inherits the untouched pipes. The cause goes to
/// the log and to `mcp-fallback-<pid>.json`, which `mcp-daemon status` lists.
pub fn run_fallback(plan: &FallbackPlan, cause: &str) -> i32 {
    plan.log.line(&format!(
        "falling back to {} {}: {cause}",
        plan.bun.display(),
        plan.script.display()
    ));
    let state = plan.peers_dir.and_then(|dir| write_state(plan, dir, cause));
    let code = exec_or_wait(plan);
    if let Some(path) = state {
        if let Err(e) = std::fs::remove_file(&path) {
            plan.log
                .line(&format!("cannot remove {}: {e}", path.display()));
        }
    }
    code
}

fn write_state(plan: &FallbackPlan, dir: &Path, cause: &str) -> Option<PathBuf> {
    let pid = std::process::id();
    let path = dir.join(format!("mcp-fallback-{pid}.json"));
    let body = json!({
        "pid": pid,
        "pid_start": sys::start_time(pid).unwrap_or_default(),
        "family": plan.family.as_str(),
        "cause": cause,
        "fallback": plan.script.to_string_lossy(),
        "started_at": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    });
    let written =
        std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&path, body.to_string()));
    match written {
        Ok(()) => Some(path),
        Err(e) => {
            plan.log
                .line(&format!("cannot write {}: {e}", path.display()));
            None
        }
    }
}

#[cfg(unix)]
fn exec_or_wait(plan: &FallbackPlan) -> i32 {
    use std::os::unix::process::CommandExt;
    let err = Command::new(plan.bun).arg(plan.script).exec();
    plan.log.line(&format!("cannot run the fallback: {err}"));
    1
}

#[cfg(not(unix))]
fn exec_or_wait(plan: &FallbackPlan) -> i32 {
    match Command::new(plan.bun).arg(plan.script).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            plan.log.line(&format!("cannot run the fallback: {e}"));
            1
        }
    }
}
