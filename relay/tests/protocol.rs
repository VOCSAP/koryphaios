mod common;

use std::ffi::OsString;
use std::io::Cursor;

use claude_peers_relay::auth::{self, mac, verify};
use claude_peers_relay::config::Logger;
use claude_peers_relay::frame;
use claude_peers_relay::hello::filter_env;
use claude_peers_relay::paths::{code_root_of, hex_decode, sha256_hex};
use claude_peers_relay::seal::{self, Opener, Sealer};
use claude_peers_relay::spawn::{daemon_env, spawn_with_breakaway_fallback};
use common::TempDir;
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../protocol-fixtures/frames.json")).expect("fixtures parse")
}

fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

#[test]
fn frame_layout_and_type_numbers_match_the_fixture() {
    let f = fixtures();
    let ex = &f["frame"]["example"];
    let payload = ex["payload"].as_str().expect("payload");
    let bytes = frame::encode(ex["type"].as_u64().expect("type") as u8, payload.as_bytes())
        .expect("encode");
    assert_eq!(
        claude_peers_relay::paths::hex_encode(&bytes),
        ex["bytes_hex"].as_str().expect("hex")
    );

    let types = &f["frame"]["types"];
    for (name, ours) in [
        ("CHALLENGE", frame::CHALLENGE),
        ("AUTH", frame::AUTH),
        ("AUTH_OK", frame::AUTH_OK),
        ("HELLO", frame::HELLO),
        ("WELCOME", frame::WELCOME),
        ("MCP", frame::MCP),
        ("TICKET", frame::TICKET),
        ("BYE", frame::BYE),
        ("PING", frame::PING),
        ("PONG", frame::PONG),
        ("ERROR", frame::ERROR),
    ] {
        assert_eq!(
            types[name].as_u64(),
            Some(ours as u64),
            "type number of {name}"
        );
    }
    assert_eq!(
        f["frame"]["max_payload_bytes"].as_u64(),
        Some(frame::MAX_PAYLOAD as u64)
    );

    let (ty, back) = frame::read_frame(&mut Cursor::new(bytes)).expect("decode");
    assert_eq!((ty, back.as_slice()), (frame::MCP, payload.as_bytes()));
}

#[test]
fn an_oversize_or_empty_frame_is_a_protocol_violation() {
    let too_big = vec![0u8; frame::MAX_PAYLOAD + 1];
    assert!(frame::encode(frame::MCP, &too_big).is_err());
    let mut header = ((frame::MAX_PAYLOAD as u32) + 2).to_le_bytes().to_vec();
    header.push(frame::MCP);
    let err = frame::read_frame(&mut Cursor::new(header)).expect_err("oversize length");
    assert!(err.to_string().contains("protocol violation"));
    let err =
        frame::read_frame(&mut Cursor::new(0u32.to_le_bytes().to_vec())).expect_err("zero length");
    assert!(err.to_string().contains("protocol violation"));
}

fn handshake() -> (Vec<u8>, Value) {
    let h = fixtures()["handshake"].clone();
    (
        hex_decode(h["key_hex"].as_str().expect("key")).expect("hex key"),
        h,
    )
}

#[test]
fn handshake_macs_match_the_values_bun_computed() {
    let (key, h) = handshake();
    let (d, r) = (
        h["daemon_nonce"].as_str().expect("dn"),
        h["relay_nonce"].as_str().expect("rn"),
    );
    let (challenge, auth) = (
        h["challenge_payload"]
            .as_str()
            .expect("challenge")
            .as_bytes(),
        h["auth_payload"].as_str().expect("auth").as_bytes(),
    );
    assert_eq!(
        auth::transcript_hash(challenge),
        h["hC"].as_str().expect("hC")
    );
    assert_eq!(auth::transcript_hash(auth), h["hA"].as_str().expect("hA"));
    assert_eq!(
        auth::relay_mac(&key, d, r, challenge, 1, 1),
        h["relay_mac"].as_str().expect("relay_mac")
    );
    assert_eq!(
        auth::daemon_mac(&key, r, d, challenge, auth, 1),
        h["daemon_mac"].as_str().expect("daemon_mac")
    );
}

#[test]
fn handshake_macs_are_bound_to_the_transcript_the_role_and_the_versions() {
    let (key, h) = handshake();
    let (d, r) = (
        h["daemon_nonce"].as_str().expect("dn"),
        h["relay_nonce"].as_str().expect("rn"),
    );
    let (challenge, auth) = (
        h["challenge_payload"]
            .as_str()
            .expect("challenge")
            .as_bytes(),
        h["auth_payload"].as_str().expect("auth").as_bytes(),
    );
    let (relay_mac, daemon_mac) = (
        h["relay_mac"].as_str().expect("relay_mac"),
        h["daemon_mac"].as_str().expect("daemon_mac"),
    );
    assert!(auth::verify_relay_mac(
        &key, d, r, challenge, 1, 1, relay_mac
    ));
    assert!(auth::verify_daemon_mac(
        &key, r, d, challenge, auth, 1, daemon_mac
    ));
    assert!(
        !auth::verify_relay_mac(&key, d, r, b"{\"another\":\"challenge\"}", 1, 1, relay_mac),
        "the relay MAC must cover the CHALLENGE it answers"
    );
    assert!(
        !auth::verify_relay_mac(&key, d, r, challenge, 1, 2, relay_mac),
        "the relay MAC must cover the versions it offers"
    );
    assert!(
        !auth::verify_daemon_mac(
            &key,
            r,
            d,
            challenge,
            b"{\"another\":\"auth\"}",
            1,
            daemon_mac
        ),
        "the daemon MAC must cover the AUTH payload"
    );
    assert!(
        !auth::verify_daemon_mac(&key, r, d, challenge, auth, 2, daemon_mac),
        "the daemon MAC must cover the selected version"
    );
    assert!(
        !auth::verify_daemon_mac(&key, d, r, challenge, auth, 1, daemon_mac),
        "swapped nonces must fail"
    );
    assert!(!auth::verify_daemon_mac(
        &key,
        r,
        d,
        challenge,
        auth,
        1,
        "not base64 !"
    ));
    let control = h["control_mac_of_relay_message"].as_str().expect("control");
    assert_eq!(
        mac(
            &key,
            "control",
            &[d, r, h["hC"].as_str().expect("hC"), "1", "1"]
        ),
        control
    );
    assert!(
        !auth::verify_relay_mac(&key, d, r, challenge, 1, 1, control),
        "a control MAC must not pass as a relay MAC"
    );
    assert!(!verify(&key, "relay", &[r, d], daemon_mac));
}

#[test]
fn session_keys_and_sealed_frames_match_the_bytes_bun_produced() {
    let (key, h) = handshake();
    let s = &fixtures()["sealed"];
    let raw =
        |name: &str| auth::b64_decode(h[name].as_str().expect(name)).expect("base64url nonce");
    let payload = |name: &str| h[name].as_str().expect(name).as_bytes().to_vec();
    let keys = auth::derive_keys(
        &key,
        &raw("daemon_nonce"),
        &raw("relay_nonce"),
        &payload("challenge_payload"),
        &payload("auth_payload"),
        &payload("auth_ok_payload"),
    )
    .expect("derive");
    assert_eq!(
        claude_peers_relay::paths::hex_encode(&keys.r2d),
        s["k_r2d_hex"].as_str().expect("k_r2d")
    );
    assert_eq!(
        claude_peers_relay::paths::hex_encode(&keys.d2r),
        s["k_d2r_hex"].as_str().expect("k_d2r")
    );
    assert_ne!(keys.r2d, keys.d2r, "each direction needs its own key");

    let mut r2d = Sealer::new(&keys.r2d).expect("sealer");
    let mut d2r = Sealer::new(&keys.d2r).expect("sealer");
    for f in s["frames"].as_array().expect("frames") {
        let (ty, text) = (
            f["type"].as_u64().expect("type") as u8,
            f["payload"].as_str().expect("payload"),
        );
        let sealer = if f["direction"] == "r2d" {
            &mut r2d
        } else {
            &mut d2r
        };
        let wire = sealer.seal(ty, text.as_bytes()).expect("seal");
        assert_eq!(
            claude_peers_relay::paths::hex_encode(&wire),
            f["wire_hex"].as_str().expect("wire"),
            "{} frame {}",
            f["direction"],
            f["counter"]
        );
    }

    for (direction, key) in [("r2d", &keys.r2d), ("d2r", &keys.d2r)] {
        let mut opener = Opener::new(key).expect("opener");
        for f in s["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .filter(|f| f["direction"] == direction)
        {
            let wire = hex_decode(f["wire_hex"].as_str().expect("wire")).expect("hex");
            let (ty, body) = opener
                .read(&mut Cursor::new(wire))
                .unwrap_or_else(|e| panic!("bun's {direction} frame {} opens: {e}", f["counter"]));
            assert_eq!(
                (ty as u64, body.as_slice()),
                (
                    f["type"].as_u64().expect("type"),
                    f["payload"].as_str().expect("payload").as_bytes()
                )
            );
        }
    }
}

fn sealed_pair() -> (Sealer, Opener) {
    (
        Sealer::new(&[7u8; 32]).expect("sealer"),
        Opener::new(&[7u8; 32]).expect("opener"),
    )
}

#[test]
fn a_sealed_frame_hides_its_content_and_round_trips() {
    let (mut s, mut o) = sealed_pair();
    let wire = s
        .seal(
            frame::MCP,
            b"{\"jsonrpc\":\"2.0\",\"secret\":\"canary-value\"}",
        )
        .expect("seal");
    assert!(
        !String::from_utf8_lossy(&wire).contains("canary-value")
            && !String::from_utf8_lossy(&wire).contains("jsonrpc")
    );
    assert_eq!(o.read(&mut Cursor::new(wire)).expect("open").0, frame::MCP);
}

#[test]
fn a_flipped_bit_a_replay_and_a_reordering_are_each_refused() {
    let (mut s, mut o) = sealed_pair();
    let first = s.seal(frame::MCP, b"one").expect("seal");
    let second = s.seal(frame::MCP, b"two").expect("seal");
    let mut flipped = first.clone();
    *flipped.last_mut().expect("tag byte") ^= 1;
    assert!(o
        .read(&mut Cursor::new(flipped))
        .expect_err("tag")
        .to_string()
        .contains("sealed frame rejected"));
    let mut header = first.clone();
    header[0] ^= 1;
    assert!(
        o.read(&mut Cursor::new(header)).is_err(),
        "the length is authenticated as AAD, or refused as a length"
    );
    assert!(
        o.read(&mut Cursor::new(second.clone()))
            .expect_err("out of order")
            .to_string()
            .contains("sealed frame rejected"),
        "frame 1 cannot open at counter 0"
    );
    assert!(
        o.read(&mut Cursor::new(first.clone())).is_ok(),
        "a refused frame must not advance the counter"
    );
    assert!(
        o.read(&mut Cursor::new(first)).is_err(),
        "a replay of an opened frame is refused"
    );
    assert!(o.read(&mut Cursor::new(second)).is_ok());
}

#[test]
fn sealed_lengths_below_17_or_above_the_limit_are_refused_before_the_body_is_read() {
    let (_, mut o) = sealed_pair();
    for len in [0u32, 1, 16, frame::MAX_PAYLOAD as u32 + 17 + 1] {
        let err = o
            .read(&mut Cursor::new(len.to_le_bytes().to_vec()))
            .expect_err("length");
        assert!(
            err.to_string().contains("sealed frame rejected"),
            "length {len}: {err}"
        );
    }
    let tiny = o
        .read_max(
            &mut Cursor::new(
                ((frame::PRE_AUTH_MAX_PAYLOAD + 17 + 1) as u32)
                    .to_le_bytes()
                    .to_vec(),
            ),
            frame::PRE_AUTH_MAX_PAYLOAD,
        )
        .expect_err("pre-auth cap");
    assert!(tiny.to_string().contains("sealed frame rejected"));
}

#[test]
fn the_frame_counter_stops_at_two_to_the_48th() {
    let key = [9u8; 32];
    let mut s = Sealer::starting_at(&key, seal::COUNTER_LIMIT - 1).expect("sealer");
    let last = s.seal(frame::MCP, b"x").expect("the last allowed counter");
    assert!(s
        .seal(frame::MCP, b"x")
        .expect_err("exhausted")
        .to_string()
        .contains("2^48"));
    let mut o = Opener::starting_at(&key, seal::COUNTER_LIMIT - 1).expect("opener");
    assert!(o.read(&mut Cursor::new(last)).is_ok());
    assert!(o
        .read(&mut Cursor::new(vec![0u8; 64]))
        .expect_err("exhausted")
        .to_string()
        .contains("2^48"));
}

#[test]
fn code_root_hash_matches_the_fixture_and_drops_the_verbatim_prefix() {
    for case in fixtures()["code_root"]["cases"].as_array().expect("cases") {
        let path = case["path"].as_str().expect("path");
        assert_eq!(
            sha256_hex(path.as_bytes()),
            case["sha256"].as_str().expect("sha")
        );
    }
    let dir = TempDir::new();
    let canon = std::fs::canonicalize(dir.path()).expect("canonicalize");
    let plain = canon
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();
    assert!(!plain.starts_with(r"\\?\"));
    assert_eq!(
        code_root_of(dir.path()).expect("code root"),
        sha256_hex(plain.as_bytes())
    );
}

#[test]
fn the_key_is_created_once_and_a_malformed_key_is_refused() {
    let dir = TempDir::new();
    let (log, _) = Logger::capturing("t");
    let first = auth::load_or_create_key(dir.path(), &log).expect("create");
    assert_eq!(first.len(), 32);
    assert_eq!(
        auth::load_or_create_key(dir.path(), &log).expect("reread"),
        first,
        "a second call must read the same key"
    );
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .expect("list")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        leftovers,
        vec!["mcp-daemon.key".to_string()],
        "no temporary file may remain"
    );

    std::fs::write(dir.path().join("mcp-daemon.key"), "zz").expect("corrupt");
    let err = auth::load_or_create_key(dir.path(), &log).expect_err("malformed key");
    assert!(err.contains("64 hexadecimal"), "got {err}");
}

#[test]
fn hello_env_keeps_session_variables_and_drops_empty_and_unrelated_ones() {
    let (log, lines) = Logger::capturing("t");
    let vars = os(&[
        ("CLAUDE_PEERS_FORCE_GROUP", "g"),
        ("CLAUDE_PEERS_NEW_FLAG", "1"),
        ("CLAUDE_PEERS_EMPTY", ""),
        ("CLAUDE_CODE_SESSION_ID", "s"),
        ("PATH", "/bin"),
        ("UNRELATED", "x"),
        ("http_proxy", "p"),
    ]);
    let env = filter_env(vars, false, &log);
    assert_eq!(
        env.get("CLAUDE_PEERS_FORCE_GROUP").map(String::as_str),
        Some("g")
    );
    assert_eq!(
        env.get("CLAUDE_PEERS_NEW_FLAG").map(String::as_str),
        Some("1"),
        "a CLAUDE_PEERS_ variable added later must travel"
    );
    assert!(
        !env.contains_key("CLAUDE_PEERS_EMPTY"),
        "an empty value reads as absent on Windows"
    );
    assert!(!env.contains_key("UNRELATED"));
    assert_eq!(env.get("http_proxy").map(String::as_str), Some("p"));
    assert!(lines.lock().expect("log").is_empty());
}

#[test]
fn hello_env_on_windows_reports_canonical_upper_case_names() {
    let (log, _) = Logger::capturing("t");
    let env = filter_env(
        os(&[
            ("Path", "C:\\bin"),
            ("claude_peers_group", "g"),
            ("Temp", "x"),
        ]),
        true,
        &log,
    );
    assert_eq!(env.get("PATH").map(String::as_str), Some("C:\\bin"));
    assert_eq!(env.get("CLAUDE_PEERS_GROUP").map(String::as_str), Some("g"));
    assert!(!env.contains_key("TEMP"));
}

#[test]
fn a_non_utf8_variable_is_reported_not_dropped_silently() {
    #[cfg(windows)]
    let bad = {
        use std::os::windows::ffi::OsStringExt;
        OsString::from_wide(&[0xD800, 0x41])
    };
    #[cfg(unix)]
    let bad = {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(vec![0xff, 0x41])
    };
    let (log, lines) = Logger::capturing("t");
    let env = filter_env(vec![(OsString::from("CLAUDE_PEERS_BAD"), bad)], false, &log);
    assert!(env.is_empty());
    assert!(lines
        .lock()
        .expect("log")
        .iter()
        .any(|l| l.contains("not valid UTF-8")));
}

#[test]
fn the_daemon_environment_never_carries_a_session_variable() {
    let vars = os(&[
        ("CLAUDE_PEERS_FORCE_GROUP", "secret"),
        ("CLAUDE_PEERS_GROUP", "g"),
        ("CLAUDE_PEERS_DESK_SESSION", "d"),
        ("CLAUDE_CODE_SESSION_ID", "s"),
        ("CLAUDE_PEERS_LOG_DIR", "/l"),
        ("CLAUDE_PEERS_MCP_DAEMON_PORT", "1"),
        ("PATH", "/bin"),
        ("XDG_CONFIG_HOME", "/x"),
        ("HTTP_PROXY", "p"),
        ("ANTHROPIC_API_KEY", "k"),
    ]);
    let (log, _) = Logger::capturing("t");
    let kept: Vec<String> = daemon_env(vars, false, &log)
        .into_iter()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    for want in [
        "CLAUDE_PEERS_LOG_DIR",
        "CLAUDE_PEERS_MCP_DAEMON_PORT",
        "PATH",
        "XDG_CONFIG_HOME",
        "HTTP_PROXY",
    ] {
        assert!(
            kept.iter().any(|k| k == want),
            "{want} must reach the daemon, got {kept:?}"
        );
    }
    for banned in [
        "CLAUDE_PEERS_FORCE_GROUP",
        "CLAUDE_PEERS_GROUP",
        "CLAUDE_PEERS_DESK_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "ANTHROPIC_API_KEY",
    ] {
        assert!(
            !kept.iter().any(|k| k == banned),
            "{banned} must not reach the daemon"
        );
    }
    let windows_names = daemon_env(os(&[("Path", "x"), ("SystemRoot", "y")]), true, &log);
    assert_eq!(
        windows_names.len(),
        2,
        "Windows variable names are matched case-insensitively"
    );
}

#[test]
fn a_refused_breakaway_launch_is_retried_without_the_flag_and_logged() {
    let (log, lines) = Logger::capturing("t");
    let mut calls = Vec::new();
    let out: std::io::Result<&str> = spawn_with_breakaway_fallback(&log, |breakaway| {
        calls.push(breakaway);
        if breakaway {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        } else {
            Ok("started")
        }
    });
    assert_eq!(out.expect("second attempt"), "started");
    if cfg!(windows) {
        assert_eq!(calls, vec![true, false]);
        assert!(lines
            .lock()
            .expect("log")
            .iter()
            .any(|l| l.contains("CREATE_BREAKAWAY_FROM_JOB")));
    } else {
        assert_eq!(calls, vec![false]);
    }
}

#[test]
fn key_file_must_be_closed_to_others_while_its_directory_may_be_readable() {
    for (mode, is_dir, ok) in [
        (0o600, false, true),
        (0o400, false, true),
        (0o640, false, false),
        (0o604, false, false),
        (0o660, false, false),
        (0o700, true, true),
        (0o755, true, true),
        (0o750, true, true),
        (0o775, true, false),
        (0o757, true, false),
        (0o770, true, false),
    ] {
        assert_eq!(
            auth::permission_verdict(mode, is_dir).is_ok(),
            ok,
            "mode {mode:o}, directory: {is_dir}"
        );
    }
}

#[test]
fn a_failure_to_remove_a_file_is_logged_and_an_absent_file_is_not() {
    let dir = TempDir::new();
    let (log, lines) = Logger::capturing("t");
    auth::remove_file_logged(&dir.path().join("absent"), &log);
    assert!(
        lines.lock().expect("log").is_empty(),
        "an already-gone file is not an error"
    );
    auth::remove_file_logged(dir.path(), &log);
    assert!(
        lines
            .lock()
            .expect("log")
            .iter()
            .any(|l| l.contains("cannot remove")),
        "removing a directory as a file must be reported"
    );
}

#[test]
fn a_daemon_environment_variable_with_a_non_utf8_name_is_logged() {
    #[cfg(windows)]
    let bad = {
        use std::os::windows::ffi::OsStringExt;
        OsString::from_wide(&[0xD800, 0x41])
    };
    #[cfg(unix)]
    let bad = {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(vec![0xff, 0x41])
    };
    let (log, lines) = Logger::capturing("t");
    let kept = daemon_env(
        vec![
            (bad, OsString::from("x")),
            (OsString::from("PATH"), OsString::from("/bin")),
        ],
        false,
        &log,
    );
    assert_eq!(kept.len(), 1);
    assert!(lines
        .lock()
        .expect("log")
        .iter()
        .any(|l| l.contains("not valid UTF-8")));
}

#[test]
fn terminate_refuses_a_pid_that_would_address_a_process_group() {
    for pid in [0u32, u32::MAX, i32::MAX as u32 + 1] {
        let err = claude_peers_relay::sys::terminate(pid).expect_err("refused");
        assert!(
            err.to_string().contains("refusing to stop pid"),
            "pid {pid}: the guard must answer, not the OS ({err})"
        );
    }
}

#[test]
fn pid_start_has_the_documented_format_and_the_linux_parser_matches_the_fixture() {
    let f = &fixtures()["pid_start"];
    let line = f["linux"]["stat_line"].as_str().expect("stat line");
    assert_eq!(
        claude_peers_relay::sys::proc_stat_start_time(line).as_deref(),
        f["linux"]["expected"].as_str(),
        "field 22 must be read after the last ')'"
    );

    let live = claude_peers_relay::sys::start_time(std::process::id())
        .expect("start time of this process");
    if cfg!(windows) {
        let ticks: u64 = live.parse().expect("a decimal FILETIME");
        let (min, max) = (
            f["windows"]["min"].as_u64().expect("min"),
            f["windows"]["max"].as_u64().expect("max"),
        );
        assert!(
            (min..max).contains(&ticks),
            "{ticks} is not a plausible FILETIME"
        );
        assert!(f["windows"]["example"]
            .as_str()
            .expect("example")
            .parse::<u64>()
            .is_ok());
    } else if cfg!(target_os = "linux") {
        assert!(
            live.chars().all(|c| c.is_ascii_digit()),
            "clock ticks, got {live:?}"
        );
    } else {
        assert!(!live.is_empty());
    }
}

#[test]
fn a_launch_that_fails_both_ways_is_an_error() {
    let (log, _) = Logger::capturing("t");
    let out: std::io::Result<()> = spawn_with_breakaway_fallback(&log, |_| {
        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
    });
    assert!(out.is_err());
}
