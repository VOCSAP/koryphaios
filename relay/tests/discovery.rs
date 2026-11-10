mod common;

use std::io::Write;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use claude_peers_relay::auth;
use claude_peers_relay::config::Config;
use claude_peers_relay::discovery::{
    acquire_launch_lock, candidate_ports, clear_stale_marker, find_session, fnv1a32,
    launch_lock_file, release_launch_lock, stop_stuck, sweep, take_over_stale, Control, Found,
    OrderedConnects,
};
use claude_peers_relay::fake::{FakeDaemon, FakeOptions};
use claude_peers_relay::frame;
use claude_peers_relay::hello::{build_hello, Facts};
use claude_peers_relay::paths::code_root_of;
use claude_peers_relay::spawn::Spawner;
use claude_peers_relay::sys;
use common::*;
use serde_json::{json, Value};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../protocol-fixtures/frames.json")).expect("fixtures parse")
}

fn hello_for(r: &Rig) -> Vec<u8> {
    build_hello(&r.cfg, &Facts::collect(&r.cfg.logger), None, false)
}

#[test]
fn port_derivation_matches_the_values_bun_computed() {
    for case in fixtures()["port"]["cases"].as_array().expect("cases") {
        let name = case["username"].as_str().expect("username");
        assert_eq!(
            fnv1a32(&name.to_lowercase()) as u64,
            case["fnv1a32"].as_u64().expect("fnv"),
            "fnv1a32 of {name}"
        );
        let ports = candidate_ports(name, None);
        let base = case["base_port"].as_u64().expect("base") as u16;
        assert_eq!(
            ports,
            (base..base + 10).collect::<Vec<_>>(),
            "candidates of {name}"
        );
    }
    assert_eq!(
        candidate_ports("anyone", Some(5555)),
        vec![5555],
        "the override replaces the whole list"
    );
}

#[test]
fn username_case_does_not_change_the_candidates() {
    assert_eq!(
        candidate_ports("Alice", None),
        candidate_ports("alice", None)
    );
}

fn foreign_listener() -> (u16, thread::JoinHandle<()>) {
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = l.local_addr().expect("addr").port();
    let h = thread::spawn(move || {
        for mut s in l.incoming().take(4).flatten() {
            let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        }
    });
    (port, h)
}

#[test]
fn foreign_listener_and_other_root_daemon_are_skipped_for_the_third_candidate() {
    let (foreign_port, _h) = foreign_listener();
    let r = rig(
        vec![foreign_port, free_port(), free_port()],
        &root_hash("mine"),
    );
    let other_root = fake_on(&r, 1, &root_hash("someone-else"));
    let mine = fake_on(&r, 2, &root_hash("mine"));
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    assert!(
        found.session.is_some(),
        "the relay must reach the third candidate"
    );
    assert_eq!(
        other_root.hellos().len(),
        1,
        "the other-root daemon must have been tried"
    );
    assert_eq!(mine.hellos().len(), 1);
    assert_eq!(found.free_ports, 0);
}

fn fake_on(r: &Rig, index: usize, root: &str) -> FakeDaemon {
    let listener = TcpListener::bind(("127.0.0.1", r.cfg.candidates[index])).expect("bind");
    FakeDaemon::start(
        listener,
        FakeOptions {
            key: r.key.clone(),
            code_root: root.to_string(),
            verify_relay: true,
            tools_hash: "h".into(),
            send_ticket: false,
            hang: false,
        },
    )
}

#[test]
fn a_free_port_is_counted_and_a_silent_listener_is_reported() {
    let r = rig(vec![free_port(), free_port()], &root_hash("mine"));
    let listener = TcpListener::bind(("127.0.0.1", r.cfg.candidates[1])).expect("bind");
    let hang = FakeDaemon::start(
        listener,
        FakeOptions {
            key: r.key.clone(),
            code_root: root_hash("mine"),
            verify_relay: true,
            tools_hash: "h".into(),
            send_ticket: false,
            hang: true,
        },
    );
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    assert!(found.session.is_none());
    assert_eq!(found.free_ports, 1);
    assert_eq!(found.silent_ports, vec![hang.port]);
}

#[test]
fn a_mute_listener_ahead_does_not_spend_the_handshake_window_of_the_daemon_behind_it() {
    let r = rig(vec![free_port(), free_port()], &root_hash("mine"));
    let mute = FakeDaemon::start(
        TcpListener::bind(("127.0.0.1", r.cfg.candidates[0])).expect("bind"),
        FakeOptions {
            key: r.key.clone(),
            code_root: root_hash("mine"),
            verify_relay: true,
            tools_hash: "h".into(),
            send_ticket: false,
            hang: true,
        },
    );
    let daemon = Arc::new(fake_on(&r, 1, &root_hash("mine")));
    // The real daemon closes a connection whose handshake has not started within its stage window:
    // a connection opened at probe time would be cut before the mute candidate runs out.
    let stage_window = r.cfg.step_timeout / 4;
    let cutter = daemon.clone();
    thread::spawn(move || {
        thread::sleep(stage_window);
        cutter.drop_connections();
    });
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    assert!(
        found.session.is_some(),
        "the daemon behind a mute listener must still answer WELCOME"
    );
    assert_eq!(found.silent_ports, vec![mute.port]);
    assert_eq!(daemon.hellos().len(), 1);
}

#[test]
fn a_daemon_that_starts_listening_while_the_sweep_waits_on_a_mute_candidate_is_found_in_the_same_pass(
) {
    let r = rig(vec![free_port(), free_port()], &root_hash("mine"));
    let accepted = Arc::new(AtomicUsize::new(0));
    let mute_listener = TcpListener::bind(("127.0.0.1", r.cfg.candidates[0])).expect("bind");
    let mute_port = r.cfg.candidates[0];
    let counter = accepted.clone();
    thread::spawn(move || {
        let held: Vec<_> = mute_listener
            .incoming()
            .take(2)
            .flatten()
            .inspect(|_| {
                counter.fetch_add(1, Ordering::SeqCst);
            })
            .collect();
        thread::sleep(Duration::from_secs(3));
        drop(held);
    });
    let (late_port, key) = (r.cfg.candidates[1], r.key.clone());
    let starter = thread::spawn(move || {
        // The second connection to the mute candidate is the sweep's handshake at its turn, after
        // the probe of every candidate: the late port is free when it is probed.
        let began = std::time::Instant::now();
        while accepted.load(Ordering::SeqCst) < 2 && began.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(1));
        }
        FakeDaemon::start(
            TcpListener::bind(("127.0.0.1", late_port)).expect("bind"),
            FakeOptions {
                key,
                code_root: root_hash("mine"),
                verify_relay: true,
                tools_hash: "h".into(),
                send_ticket: false,
                hang: false,
            },
        )
    });
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    let late = starter.join().expect("the late daemon starts");
    assert!(
        found.session.is_some(),
        "a port found free by the probe must be tried again at its turn"
    );
    assert_eq!(late.hellos().len(), 1);
    assert_eq!(found.silent_ports, vec![mute_port]);
}

#[test]
fn a_silent_listener_is_traced_when_it_is_skipped_and_named_in_the_fallback_cause() {
    let mut r = rig(vec![free_port()], &root_hash("mine"));
    r.cfg.opening_deadline = Duration::from_millis(700);
    let mute = FakeDaemon::start(
        TcpListener::bind(("127.0.0.1", r.cfg.candidates[0])).expect("bind"),
        FakeOptions {
            key: r.key.clone(),
            code_root: root_hash("mine"),
            verify_relay: true,
            tools_hash: "h".into(),
            send_ticket: false,
            hang: true,
        },
    );
    let spawner = NoSpawn(AtomicUsize::new(0));
    let found = find_session(
        &r.cfg,
        &r.key,
        &hello_for(&r),
        true,
        &spawner,
        &Control::default(),
    );
    let Found::Fallback(cause) = found else {
        panic!("a daemon that never answers must end in a fallback")
    };
    assert!(
        cause.contains(&format!("silent listeners seen on ports {}", mute.port)),
        "the fallback cause must name the silent port: {cause}"
    );
    assert_eq!(
        cause.matches(&mute.port.to_string()).count(),
        1,
        "a port seen in several passes is named once: {cause}"
    );
    assert!(
        r.logged(&format!("port {}: no CHALLENGE within", mute.port)) && r.logged("(silent listener)"),
        "the skip of a silent listener must leave a log line"
    );
}

#[test]
fn a_listener_that_does_not_know_the_key_never_receives_the_hello() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let listener = TcpListener::bind(("127.0.0.1", r.cfg.candidates[0])).expect("bind");
    let impostor = FakeDaemon::start(
        listener,
        FakeOptions {
            key: vec![9u8; 32],
            code_root: root_hash("mine"),
            verify_relay: false,
            tools_hash: "h".into(),
            send_ticket: false,
            hang: false,
        },
    );
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    assert!(
        found.session.is_none(),
        "the relay must reject a daemon whose MAC does not verify"
    );
    assert!(
        impostor.hellos().is_empty(),
        "the HELLO, which carries session secrets, reached an unauthenticated listener"
    );
    assert!(r.logged("did not prove it knows the shared key"));
}

struct StartsDaemon {
    launches: AtomicUsize,
    port: u16,
    daemon: Mutex<Option<FakeDaemon>>,
    key: Vec<u8>,
    root: String,
}

impl Spawner for StartsDaemon {
    fn spawn(&self, cfg: &Config) -> std::io::Result<()> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        let listener = TcpListener::bind(("127.0.0.1", self.port))?;
        let opts = FakeOptions {
            key: self.key.clone(),
            code_root: self.root.clone(),
            verify_relay: true,
            tools_hash: "h".into(),
            send_ticket: false,
            hang: false,
        };
        *self.daemon.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(FakeDaemon::start(listener, opts));
        release_launch_lock(cfg);
        Ok(())
    }
}

#[test]
fn many_relays_starting_together_launch_the_daemon_once() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let spawner = Arc::new(StartsDaemon {
        launches: AtomicUsize::new(0),
        port: r.cfg.candidates[0],
        daemon: Mutex::new(None),
        key: r.key.clone(),
        root: root_hash("mine"),
    });
    let hello = hello_for(&r);
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let (cfg, key, hello, spawner) =
                (r.cfg.clone(), r.key.clone(), hello.clone(), spawner.clone());
            thread::spawn(move || {
                matches!(
                    find_session(
                        &cfg,
                        &key,
                        &hello,
                        true,
                        spawner.as_ref(),
                        &Control::default()
                    ),
                    Found::Session(_)
                )
            })
        })
        .collect();
    for h in handles {
        assert!(
            h.join().expect("relay thread"),
            "every relay must end with a session"
        );
    }
    assert_eq!(
        spawner.launches.load(Ordering::SeqCst),
        1,
        "only the holder of the launch lock may start the daemon"
    );
}

#[test]
fn no_daemon_is_started_when_the_resweep_under_the_launch_lock_finds_no_free_port() {
    let mut r = rig(vec![free_port()], &root_hash("mine"));
    let port = r.cfg.candidates[0];
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);
    std::fs::write(&lock, "4000000000 0").expect("write a lock whose owner is dead");

    // The stale-lock takeover logs after the first sweep and before the re-sweep.
    let silent: Arc<Mutex<Option<FakeDaemon>>> = Arc::new(Mutex::new(None));
    let (slot, key, root) = (silent.clone(), r.key.clone(), root_hash("mine"));
    r.cfg.logger = r.cfg.logger.clone().observed_by(move |line| {
        if !line.contains("removed a stale launch lock") {
            return;
        }
        let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind the late daemon port");
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(FakeDaemon::start(
            listener,
            FakeOptions {
                key: key.clone(),
                code_root: root.clone(),
                verify_relay: true,
                tools_hash: "h".into(),
                send_ticket: false,
                hang: true,
            },
        ));
    });
    r.cfg.step_timeout = Duration::from_millis(100);
    r.cfg.opening_deadline = Duration::from_millis(900);

    let spawner = NoSpawn(AtomicUsize::new(0));
    let found = find_session(
        &r.cfg,
        &r.key,
        &hello_for(&r),
        true,
        &spawner,
        &Control::default(),
    );

    assert!(
        silent.lock().unwrap_or_else(|e| e.into_inner()).is_some(),
        "the late daemon must have appeared between the two sweeps"
    );
    assert_eq!(
        spawner.0.load(Ordering::SeqCst),
        0,
        "a re-sweep that finds every candidate occupied must not start another daemon"
    );
    assert!(r.logged("every candidate port became occupied since the first sweep"));
    assert!(matches!(found, Found::Fallback(_)));
    assert!(
        !lock.exists(),
        "the launch lock must be released when no daemon is started"
    );
}

#[test]
fn no_daemon_is_started_when_the_resweep_finds_a_daemon_that_refuses_the_session() {
    let mut r = rig(vec![free_port(), free_port()], &root_hash("mine"));
    let port = r.cfg.candidates[0];
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);
    std::fs::write(&lock, "4000000000 0").expect("write a lock whose owner is dead");

    // The stale-lock takeover logs after the first sweep and before the re-sweep.
    let refuser: Arc<Mutex<Option<FakeDaemon>>> = Arc::new(Mutex::new(None));
    let (slot, key, root) = (refuser.clone(), r.key.clone(), root_hash("mine"));
    r.cfg.logger = r.cfg.logger.clone().observed_by(move |line| {
        if !line.contains("removed a stale launch lock") {
            return;
        }
        let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind the late daemon port");
        let daemon = FakeDaemon::start(
            listener,
            FakeOptions {
                key: key.clone(),
                code_root: root.clone(),
                verify_relay: true,
                tools_hash: "h".into(),
                send_ticket: false,
                hang: false,
            },
        );
        daemon.set_refuse_hello(Some("proto_mismatch"));
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(daemon);
    });

    let spawner = NoSpawn(AtomicUsize::new(0));
    let control = Control::default();
    let found = find_session(&r.cfg, &r.key, &hello_for(&r), true, &spawner, &control);

    assert!(
        refuser.lock().unwrap_or_else(|e| e.into_inner()).is_some(),
        "the refusing daemon must have appeared between the two sweeps"
    );
    assert_eq!(
        spawner.0.load(Ordering::SeqCst),
        0,
        "a daemon that refuses the session exists: no other daemon may be started"
    );
    match found {
        Found::Fallback(cause) => assert!(
            cause.contains("proto_mismatch"),
            "the fallback must carry the refusal, got {cause:?}"
        ),
        _ => panic!("the opening must end in fallback"),
    }
    assert!(
        control
            .refusal()
            .is_some_and(|c| c.contains("proto_mismatch")),
        "the refusal must be recorded for the caller"
    );
    let sweeps_that_met_the_refusal = r
        .log
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|l| l.starts_with(&format!("port {port}: daemon answered")))
        .count();
    assert_eq!(
        sweeps_that_met_the_refusal, 1,
        "the opening must end on the re-sweep that met the refusal, not sweep again"
    );
    assert!(
        !lock.exists(),
        "the launch lock must be released when no daemon is started"
    );
}

#[test]
fn a_stale_launch_lock_is_replaced_and_a_live_fresh_one_is_respected() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);

    std::fs::write(&lock, format!("{} 0", std::process::id())).expect("write lock");
    assert!(
        !acquire_launch_lock(&r.cfg).expect("acquire"),
        "a fresh lock held by a live process must be respected"
    );

    std::fs::write(&lock, "4000000000 0").expect("write lock");
    assert!(
        acquire_launch_lock(&r.cfg).expect("acquire"),
        "a lock whose owner is dead must be replaced"
    );
    assert!(r.logged("stale launch lock"));

    let mut aged = r.cfg.clone();
    aged.launch_lock_stale = Duration::from_millis(0);
    std::fs::write(&lock, format!("{} 0", std::process::id())).expect("write lock");
    assert!(
        acquire_launch_lock(&aged).expect("acquire"),
        "a lock older than the limit must be replaced"
    );
}

fn hang_daemon(r: &Rig, port: u16) -> Child {
    let code = r.dir.path().join("code");
    std::fs::create_dir_all(&code).expect("code dir");
    let mut cmd = Command::new(FAKE_DAEMON_EXE);
    cmd.arg(code.join("mcp-daemon.ts"))
        .env_clear()
        .env("HOME", r.dir.path())
        .env("USERPROFILE", r.dir.path())
        .env(
            "SystemRoot",
            std::env::var("SystemRoot").unwrap_or_default(),
        )
        .env("CLAUDE_PEERS_MCP_DAEMON_PORT", port.to_string())
        .env("CLAUDE_PEERS_MCP_DAEMON_FAKE_MODE", "hang")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().expect("start the hanging fake daemon")
}

fn stuck_rig() -> (Rig, ChildGuard, u16) {
    let port = free_port();
    let mut r = rig(vec![port], "placeholder");
    let code = r.dir.path().join("code");
    std::fs::create_dir_all(&code).expect("code dir");
    r.cfg.code_root = code_root_of(&code).expect("code root");
    r.cfg.accepted_images = vec!["fake-daemon".into()];
    // The fake daemon locates the peers dir from HOME/USERPROFILE = dir, so state files land in dir/.claude/peers.
    r.cfg.peers_dir = r.dir.path().join(".claude").join("peers");
    std::fs::create_dir_all(&r.cfg.peers_dir).expect("peers dir");
    let child = hang_daemon(&r, port);
    let state = r.cfg.peers_dir.join(format!("mcp-daemon-{port}.json"));
    wait_until("the hanging daemon to publish its state file", || {
        state.exists()
            && std::fs::read_to_string(&state)
                .map(|t| t.contains("env_keys"))
                .unwrap_or(false)
    });
    (r, ChildGuard(child), port)
}

fn exited(child: &mut Child) -> bool {
    child.try_wait().expect("try_wait").is_some()
}

#[test]
fn a_silent_daemon_is_stopped_after_the_delay_and_the_relay_goes_on() {
    let (r, mut child, port) = stuck_rig();
    let spawner = NoSpawn(AtomicUsize::new(0));
    let mut cfg = r.cfg.clone();
    cfg.opening_deadline = Duration::from_secs(2);
    let hello = hello_for(&r);
    let found = find_session(&cfg, &r.key, &hello, true, &spawner, &Control::default());
    assert!(
        matches!(found, Found::Fallback(_)),
        "no daemon exists, the opening ends in fallback"
    );
    wait_until("the silent daemon to be stopped", || exited(&mut child.0));
    assert!(r.logged(&format!("stopped the silent daemon on port {port}")));
    assert!(
        spawner.0.load(Ordering::SeqCst) >= 1,
        "once the port is free the relay must start a daemon"
    );
}

#[test]
fn a_reused_pid_is_never_stopped() {
    let (r, mut child, port) = stuck_rig();
    let state_path = r.cfg.peers_dir.join(format!("mcp-daemon-{port}.json"));
    let mut state: Value =
        serde_json::from_str(&std::fs::read_to_string(&state_path).expect("read state"))
            .expect("parse state");
    state["pid_start"] = json!("1");
    std::fs::write(&state_path, state.to_string()).expect("write state");
    stop_stuck(&r.cfg, &[port]);
    thread::sleep(Duration::from_millis(150));
    assert!(
        !exited(&mut child.0),
        "a process whose start time differs from the state file must survive"
    );
    assert!(r.logged("was reused"));
}

#[test]
fn a_process_with_a_foreign_image_name_is_never_stopped() {
    let (mut r, mut child, port) = stuck_rig();
    r.cfg.accepted_images = vec!["bun".into(), "kory-mcp-daemon".into()];
    stop_stuck(&r.cfg, &[port]);
    thread::sleep(Duration::from_millis(150));
    assert!(
        !exited(&mut child.0),
        "an image outside the accepted names must survive"
    );
    assert!(r.logged("not a daemon image"));
}

#[test]
fn a_daemon_of_another_code_root_is_never_stopped() {
    let (mut r, mut child, port) = stuck_rig();
    r.cfg.code_root = root_hash("another-root");
    stop_stuck(&r.cfg, &[port]);
    thread::sleep(Duration::from_millis(150));
    assert!(!exited(&mut child.0));
    assert!(r.logged("another code root"));
}

#[test]
fn a_takeover_never_removes_a_lock_that_is_fresh_once_the_marker_is_held() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);
    std::fs::write(&lock, format!("{} 0", std::process::id())).expect("write a live lock");
    assert!(
        !take_over_stale(&r.cfg, &lock).expect("take over"),
        "a relay that judged the lock stale earlier must not delete one made since"
    );
    assert!(lock.exists(), "the live lock must still be there");
    assert!(
        !lock.with_extension("takeover").exists(),
        "the marker must be released"
    );
}

#[test]
fn a_lock_path_the_system_refuses_to_create_is_busy_not_an_error() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);
    std::fs::create_dir(&lock).expect("a directory where the lock goes");
    assert!(
        !acquire_launch_lock(&r.cfg).expect("busy is not an error"),
        "contention on the lock must read as 'not acquired'"
    );
    if cfg!(windows) {
        assert!(
            r.logged("is busy"),
            "Windows answers access denied, and the refusal is logged"
        );
    }
}

#[test]
fn a_takeover_marker_that_is_fresh_when_it_is_moved_is_put_back() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let marker = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root).with_extension("takeover");
    std::fs::write(&marker, format!("{} 0", std::process::id())).expect("write a live marker");
    assert!(
        !clear_stale_marker(&r.cfg, &marker),
        "a relay that judged the marker stale earlier must not delete one made since"
    );
    assert!(marker.exists(), "the live marker must be back in place");
    let leftovers = std::fs::read_dir(&r.cfg.peers_dir)
        .expect("list")
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".stale-"))
        .count();
    assert_eq!(leftovers, 0, "the moved copy must be removed");
}

#[test]
fn a_takeover_marker_left_by_a_dead_relay_does_not_block_the_launch_lock_forever() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);
    std::fs::write(&lock, "4000000000 0").expect("write a stale lock");
    std::fs::write(lock.with_extension("takeover"), "4000000000 0").expect("write a stale marker");
    assert!(
        !acquire_launch_lock(&r.cfg).expect("acquire"),
        "the first attempt only clears the dead relay's marker"
    );
    assert!(
        acquire_launch_lock(&r.cfg).expect("acquire"),
        "the next attempt takes over the stale lock"
    );
    assert!(r.logged("stale takeover marker"));
}

fn raw_login(r: &Rig, port: u16) -> (std::net::TcpStream, auth::Channel) {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let channel = auth::authenticate(
        &mut s,
        &r.key,
        Duration::from_secs(1),
        std::time::Instant::now() + Duration::from_secs(3),
    )
    .expect("authenticate");
    s.set_read_timeout(Some(Duration::from_secs(3)))
        .expect("read timeout");
    (s, channel)
}

#[test]
fn a_bit_flipped_in_the_first_sealed_frame_ends_the_connection_without_a_session() {
    let mut r = rig(vec![free_port()], &root_hash("mine"));
    let daemon = fake(&r, &root_hash("mine"));
    let proxy = proxy(daemon.port, Some(1));
    r.cfg.candidates = vec![proxy.port];
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    assert!(
        found.session.is_none(),
        "a HELLO altered on the wire must not open a session"
    );
    wait_until("the daemon to refuse the altered frame", || {
        daemon.rejected() == 1
    });
    assert!(
        daemon.hellos().is_empty(),
        "the daemon must not have acted on the altered HELLO"
    );
}

#[test]
fn a_frame_the_daemon_sent_cannot_be_reflected_back_at_it() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let daemon = fake(&r, &root_hash("mine"));
    let (mut s, mut channel) = raw_login(&r, daemon.port);
    channel
        .sealer
        .write(&mut s, frame::HELLO, &hello_for(&r))
        .expect("send HELLO");
    let welcome = read_raw_frame(&mut s);
    let ticket = read_raw_frame(&mut s);
    assert_eq!(
        channel
            .opener
            .read(&mut std::io::Cursor::new(welcome))
            .expect("genuine WELCOME")
            .0,
        frame::WELCOME
    );
    assert_eq!(
        channel
            .opener
            .read(&mut std::io::Cursor::new(ticket.clone()))
            .expect("genuine TICKET")
            .0,
        frame::TICKET
    );
    s.write_all(&ticket).expect("reflect");
    wait_until("the daemon to refuse its own frame", || {
        daemon.rejected() == 1
    });
}

#[test]
fn a_frame_the_relay_sent_cannot_be_replayed() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let daemon = fake(&r, &root_hash("mine"));
    let (mut s, mut channel) = raw_login(&r, daemon.port);
    let hello = channel
        .sealer
        .seal(frame::HELLO, &hello_for(&r))
        .expect("seal HELLO");
    s.write_all(&hello).expect("send HELLO");
    read_raw_frame(&mut s);
    read_raw_frame(&mut s);
    s.write_all(&hello).expect("replay HELLO");
    wait_until("the daemon to refuse the replay", || daemon.rejected() == 1);
    assert_eq!(
        daemon.hellos().len(),
        1,
        "the replayed HELLO must not be acted on twice"
    );
}

#[test]
fn an_unauthenticated_error_on_the_lowest_port_makes_the_relay_try_the_next_candidate() {
    let r = rig(vec![free_port(), free_port()], &root_hash("mine"));
    let impostor = fake_on(&r, 0, &root_hash("mine"));
    impostor.set_refuse_auth(Some("proto_mismatch"));
    let spawner = StartsDaemon {
        launches: AtomicUsize::new(0),
        port: r.cfg.candidates[1],
        daemon: Mutex::new(None),
        key: r.key.clone(),
        root: root_hash("mine"),
    };
    let found = find_session(
        &r.cfg,
        &r.key,
        &hello_for(&r),
        true,
        &spawner,
        &Control::default(),
    );
    assert!(
        matches!(found, Found::Session(_)),
        "an ERROR nobody authenticated must not push the relay to the bun fallback"
    );
    assert_eq!(spawner.launches.load(Ordering::SeqCst), 1);
}

#[test]
fn free_ports_are_refused_long_before_the_connect_timeout() {
    // Below both OS ephemeral ranges: a parallel test cannot be handed one of these.
    let ports: Vec<u16> = (24_100u16..)
        .filter(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .take(10)
        .collect();
    let mut r = rig(ports, &root_hash("mine"));
    r.cfg.connect_timeout = Duration::from_secs(3);
    let started = std::time::Instant::now();
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    assert_eq!(found.free_ports, 10);
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "a refused loopback connect waited for the connect timeout: {:?}",
        started.elapsed()
    );
}

fn refused(index: usize) -> std::io::Result<()> {
    Err(std::io::Error::other(index.to_string()))
}

#[test]
fn connect_results_come_out_in_port_order_whatever_the_order_they_settle_in() {
    let (tx, rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let out: Vec<(u16, String)> = OrderedConnects::new(vec![11, 12, 13], rx)
            .map(|(p, r)| (p, r.expect_err("an error").to_string()))
            .collect();
        let _ = done_tx.send(out);
    });
    for index in [2, 1, 0] {
        tx.send((index, refused(index))).expect("send");
    }
    let out = done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("every settled result must be handed out");
    assert_eq!(
        out,
        vec![(11, "0".into()), (12, "1".into()), (13, "2".into())]
    );
}

#[test]
fn the_lowest_connect_result_is_handed_out_without_waiting_for_the_higher_ports() {
    let (tx, rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut connects = OrderedConnects::new(vec![11, 12, 13], rx);
        let first = connects.next().map(|(p, _)| p);
        let _ = done_tx.send((first, connects.remaining()));
    });
    tx.send((0, refused(0))).expect("send");
    let (first, remaining) = done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the lowest port must be handed out without waiting for the slower ones");
    assert_eq!(first, Some(11));
    assert_eq!(remaining, 2);
    drop(tx);
}

#[test]
fn a_connect_thread_that_died_costs_its_own_port_only() {
    let (tx, rx) = std::sync::mpsc::channel();
    tx.send((1, refused(1))).expect("send");
    drop(tx);
    let out: Vec<(u16, String)> = OrderedConnects::new(vec![11, 12], rx)
        .map(|(p, r)| (p, r.expect_err("an error").to_string()))
        .collect();
    assert_eq!(
        out,
        vec![(11, "connect thread panicked".into()), (12, "1".into())]
    );
}

#[cfg(windows)]
#[test]
fn a_refused_socket_option_is_logged_once_and_the_connect_still_succeeds() {
    use claude_peers_relay::config::Logger;
    use claude_peers_relay::discovery::loopback::connect_with;
    use std::sync::atomic::AtomicBool;

    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let addr = listener.local_addr().expect("address");
    let (logger, lines) = Logger::capturing("test-relay");
    let logged = AtomicBool::new(false);
    for _ in 0..2 {
        connect_with(
            addr,
            Duration::from_secs(1),
            &logger,
            |_| Err(std::io::Error::other("refused")),
            &logged,
        )
        .expect("a failed option must not fail the connect");
    }
    let lines = lines.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(
        lines
            .iter()
            .filter(|l| l.contains("cannot disable SYN retransmission"))
            .count(),
        1,
        "{lines:?}"
    );
}

#[test]
fn no_daemon_is_started_once_the_opening_deadline_passed_during_the_recheck() {
    let mut r = rig(vec![free_port(), free_port()], &root_hash("mine"));
    r.cfg.opening_deadline = Duration::from_millis(300);
    let listener = TcpListener::bind(("127.0.0.1", r.cfg.candidates[0])).expect("bind");
    thread::spawn(move || {
        let mut held = Vec::new();
        for (n, s) in listener.incoming().flatten().enumerate() {
            if n > 0 {
                held.push(s);
            }
        }
    });
    let spawner = NoSpawn(AtomicUsize::new(0));
    let found = find_session(
        &r.cfg,
        &r.key,
        &hello_for(&r),
        true,
        &spawner,
        &Control::default(),
    );
    assert!(matches!(found, Found::Fallback(_)));
    assert_eq!(
        spawner.0.load(Ordering::SeqCst),
        0,
        "a daemon was started after the opening deadline"
    );
    assert!(
        r.logged("1 candidates not examined"),
        "the log must name the candidates left unexamined"
    );
}

/// Accepts connections and writes `first` at once, then `drip` one byte at a time.
fn hostile_listener(first: Vec<u8>, drip: Vec<u8>, gap: Duration) -> u16 {
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = l.local_addr().expect("addr").port();
    thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let (first, drip) = (first.clone(), drip.clone());
            thread::spawn(move || {
                if s.write_all(&first).is_err() {
                    return;
                }
                for b in drip {
                    thread::sleep(gap);
                    if s.write_all(&[b]).is_err() {
                        return;
                    }
                }
                thread::sleep(Duration::from_secs(30));
            });
        }
    });
    port
}

#[test]
fn a_listener_that_drips_one_byte_at_a_time_cannot_hold_the_opening_open() {
    let port = hostile_listener(
        1000u32.to_le_bytes().to_vec(),
        vec![1u8; 500],
        Duration::from_millis(40),
    );
    let mut r = rig(vec![port], &root_hash("mine"));
    r.cfg.step_timeout = Duration::from_millis(300);
    r.cfg.opening_deadline = Duration::from_millis(1500);
    let (cfg, key, hello) = (r.cfg.clone(), r.key.clone(), hello_for(&r));
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let found = find_session(
            &cfg,
            &key,
            &hello,
            true,
            &NoSpawn(AtomicUsize::new(0)),
            &Control::default(),
        );
        let _ = tx.send(matches!(found, Found::Fallback(_)));
    });
    let fell_back = rx
        .recv_timeout(Duration::from_secs(6))
        .expect("the opening must end near its deadline, not follow the dripping listener");
    assert!(
        fell_back,
        "a candidate that never completes its handshake leaves no session: fallback"
    );
}

#[test]
fn a_declared_frame_over_64_kib_before_authentication_is_refused_without_reading_it() {
    let port = hostile_listener(
        1_048_577u32.to_le_bytes().to_vec(),
        Vec::new(),
        Duration::from_millis(1),
    );
    let mut r = rig(vec![port], &root_hash("mine"));
    r.cfg.step_timeout = Duration::from_secs(1);
    let started = std::time::Instant::now();
    let found = sweep(&r.cfg, &r.key, &hello_for(&r), None);
    assert!(found.session.is_none());
    assert!(
        started.elapsed() < Duration::from_millis(800),
        "the oversize header must be refused at once, took {:?}",
        started.elapsed()
    );
    assert!(r.logged("protocol violation"), "the refusal must be logged");
}

#[test]
fn a_reconnect_loop_ends_when_the_session_stops() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let spawner = Arc::new(NoSpawn(AtomicUsize::new(0)));
    let ctl = Arc::new(Control::default());
    let (cfg, key, hello, s, c) = (
        r.cfg.clone(),
        r.key.clone(),
        hello_for(&r),
        spawner.clone(),
        ctl.clone(),
    );
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let found = find_session(&cfg, &key, &hello, false, s.as_ref(), &c);
        let _ = tx.send(matches!(found, Found::Stopped));
    });
    wait_until("the loop to try launching a daemon", || {
        spawner.0.load(Ordering::SeqCst) >= 1
    });
    ctl.stop.store(true, Ordering::SeqCst);
    assert!(
        rx.recv_timeout(Duration::from_secs(3))
            .expect("the loop must end after the stop flag"),
        "it must report Stopped"
    );
}

#[test]
fn only_one_of_many_relays_takes_over_a_stale_launch_lock() {
    let r = rig(vec![free_port()], &root_hash("mine"));
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);
    for round in 0..40 {
        std::fs::write(&lock, "4000000000 0").expect("write a stale lock");
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (cfg, barrier) = (r.cfg.clone(), barrier.clone());
                thread::spawn(move || {
                    barrier.wait();
                    acquire_launch_lock(&cfg).expect("acquire")
                })
            })
            .collect();
        let winners = handles
            .into_iter()
            .map(|h| h.join().expect("thread"))
            .filter(|won| *won)
            .count();
        assert_eq!(
            winners, 1,
            "round {round}: exactly one relay may take over a stale lock"
        );
    }
}

#[test]
fn start_time_and_image_are_measured_for_a_live_process() {
    let pid = std::process::id();
    assert!(sys::is_alive(pid));
    assert!(sys::start_time(pid).is_some_and(|s| !s.is_empty()));
    assert!(sys::image_stem(pid).is_some_and(|s| !s.is_empty()));
    assert!(!sys::is_alive(4_000_000_000));
    assert!(sys::username().is_some_and(|u| !u.is_empty()));
}
