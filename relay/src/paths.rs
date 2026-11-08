use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub fn home_dir() -> Option<PathBuf> {
    let order: [&str; 2] = if cfg!(windows) {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    };
    order.iter().find_map(|k| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    })
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// sha256 of the canonical directory path, without the Windows `\\?\` prefix
/// that `canonicalize` adds and Node's `realpath` does not.
pub fn code_root_of(dir: &Path) -> std::io::Result<String> {
    let canon = std::fs::canonicalize(dir)?;
    let text = canon.to_string_lossy();
    let text = match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_string(),
    };
    Ok(sha256_hex(text.as_bytes()))
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&Sha256::digest(data))
}

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Same resolution as `coreLogDir` in `shared/logger.ts`.
pub fn core_log_dir(get: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if let Some(v) = get("CLAUDE_PEERS_LOG_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(v);
    }
    if cfg!(windows) {
        let base = match get("APPDATA").filter(|v| !v.is_empty()) {
            Some(a) => PathBuf::from(a).join("claude-peers"),
            None => home.join("AppData").join("Roaming").join("claude-peers"),
        };
        return base.join("logs");
    }
    let base = match get("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x).join("claude-peers"),
        None => home.join(".config").join("claude-peers"),
    };
    base.join("logs")
}
