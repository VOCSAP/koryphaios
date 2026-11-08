//! Stdio relay between one Claude Code session and the shared MCP daemon.

pub mod auth;
pub mod bridge;
pub mod config;
pub mod discovery;
pub mod fake;
pub mod fallback;
pub mod frame;
pub mod hello;
pub mod paths;
pub mod seal;
pub mod spawn;
pub mod sys;
#[cfg(windows)]
pub mod winacl;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use bridge::{run_bridge, BridgeArgs};
use config::{Config, Family, Logger};
use discovery::{find_session, Control, Found};
use fallback::{run_fallback, FallbackPlan};
use hello::{build_hello, Facts};
use spawn::{RealSpawner, Spawner};

const USAGE: &str = "usage: claude-peers-relay --family peers|roadmap --fallback <path to server.ts or server-roadmap.ts> [--bun <path>]";

struct Args {
    family: Family,
    fallback: PathBuf,
    bun: Option<PathBuf>,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let (mut family, mut fallback, mut bun) = (None, None, None);
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match flag.as_str() {
            "--family" => {
                family = Some(
                    Family::parse(&value("--family")?)
                        .ok_or("--family must be peers or roadmap")?,
                )
            }
            "--fallback" => fallback = Some(PathBuf::from(value("--fallback")?)),
            "--bun" => bun = Some(PathBuf::from(value("--bun")?)),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Args {
        family: family.ok_or("--family is required")?,
        fallback: fallback.ok_or("--fallback is required")?,
        bun,
    })
}

pub fn run_main(argv: Vec<String>) -> i32 {
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            Logger::new("claude-peers-relay").line(&format!("{e}\n{USAGE}"));
            return 2;
        }
    };
    let cfg = match Config::from_env(args.family, args.fallback.clone(), args.bun.clone()) {
        Ok(c) => c,
        Err(cause) => {
            let log = Logger::new(&format!(
                "claude-peers-relay[{} {}]",
                args.family.as_str(),
                std::process::id()
            ));
            let bun = args.bun.unwrap_or_else(|| {
                paths::find_in_path("bun").unwrap_or_else(|| PathBuf::from("bun"))
            });
            return run_fallback(
                &FallbackPlan {
                    family: args.family,
                    bun: &bun,
                    script: &args.fallback,
                    peers_dir: None,
                    log: &log,
                },
                &cause,
            );
        }
    };
    session(
        cfg,
        Arc::new(RealSpawner),
        Box::new(std::io::BufReader::new(std::io::stdin())),
        Box::new(std::io::stdout()),
    )
}

fn plan_of(cfg: &Config) -> FallbackPlan<'_> {
    FallbackPlan {
        family: cfg.family,
        bun: &cfg.bun,
        script: &cfg.fallback,
        peers_dir: Some(&cfg.peers_dir),
        log: &cfg.logger,
    }
}

/// Opens a daemon session, or hands over to bun, then relays until stdin ends.
pub fn session(
    cfg: Config,
    spawner: Arc<dyn Spawner>,
    input: Box<dyn BufRead + Send>,
    output: Box<dyn Write + Send>,
) -> i32 {
    let key = match auth::load_or_create_key(&cfg.peers_dir, &cfg.logger) {
        Ok(k) => k,
        Err(cause) => return run_fallback(&plan_of(&cfg), &cause),
    };
    let facts = Facts::collect(&cfg.logger);
    let hello = build_hello(&cfg, &facts, None, false);
    match find_session(
        &cfg,
        &key,
        &hello,
        true,
        spawner.as_ref(),
        &Control::default(),
    ) {
        Found::Fallback(cause) => run_fallback(&plan_of(&cfg), &cause),
        Found::Stopped => 0,
        Found::Session(first) => run_bridge(BridgeArgs {
            cfg,
            key,
            facts,
            first: *first,
            spawner,
            input,
            output,
        }),
    }
}
