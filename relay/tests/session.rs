mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use claude_peers_relay::discovery::launch_lock_file;
use common::*;
use serde_json::json;

const ROOT: &str = "root-a";

fn start() -> (
    Rig,
    claude_peers_relay::fake::FakeDaemon,
    Client,
    Arc<NoSpawn>,
) {
    let r = rig(vec![free_port()], &root_hash(ROOT));
    let daemon = fake(&r, &root_hash(ROOT));
    let spawner = Arc::new(NoSpawn(AtomicUsize::new(0)));
    let client = run_session(r.cfg.clone(), spawner.clone());
    (r, daemon, client, spawner)
}

#[test]
fn calls_round_trip_and_hello_carries_the_session() {
    let (_r, daemon, client, _s) = start();
    client.send(initialize(1));
    assert_eq!(
        client.wait_reply(json!(1))["result"]["serverInfo"]["name"],
        "fake"
    );
    client.send(initialized());
    client.send(call(2, "x"));
    assert_eq!(
        client.wait_reply(json!(2))["result"]["content"][0]["text"],
        "echo"
    );

    let hello = &daemon.hellos()[0];
    assert_eq!(hello["family"], "peers");
    assert_eq!(hello["code_root"], root_hash(ROOT));
    assert_eq!(hello["pid"], std::process::id());
    assert_eq!(hello["replay"], false);
    assert!(hello.get("resume_ticket").is_none());
    assert!(hello["cwd"]
        .as_str()
        .is_some_and(|c| std::path::Path::new(c).is_absolute()));
}

#[test]
fn request_in_flight_gets_a_may_have_executed_error_when_the_daemon_drops() {
    let (_r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    client.send(call(7, "hold"));
    wait_until("the held call to reach the daemon", || {
        daemon.mcp_received().iter().any(|m| m.contains("\"hold\""))
    });
    daemon.drop_connections();
    let reply = client.wait_reply(json!(7));
    assert_eq!(reply["error"]["code"], -32000);
    assert!(
        reply["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("may or may not have been executed"),
        "got {reply}"
    );
}

#[test]
fn requests_while_the_daemon_is_away_fail_at_once_and_the_relay_stays_up() {
    let (r, daemon, client, spawner) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    daemon.stop();
    wait_until("the relay to notice the loss", || {
        r.logged("lost the daemon connection")
    });
    client.send(call(9, "x"));
    let reply = client.wait_reply(json!(9));
    assert!(
        reply["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("was NOT executed, retry it"),
        "got {reply}"
    );
    client.send(json!({"jsonrpc": "2.0", "method": "notifications/cancelled"}));
    wait_until("the relay to try launching a daemon", || {
        spawner.0.load(Ordering::SeqCst) >= 1
    });
    assert!(
        !client.finished(),
        "the relay must not exit on a daemon loss"
    );
}

#[test]
fn reconnect_replays_initialize_with_the_ticket_and_hides_the_replay_answer() {
    let (_r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    client.send(initialized());
    wait_until("the first ticket", || !daemon.mcp_received().is_empty());
    daemon.drop_connections();
    wait_until("the second hello", || daemon.hellos().len() == 2);
    let second = daemon.hellos()[1].clone();
    assert_eq!(second["replay"], true);
    assert_eq!(second["resume_ticket"], "ticket-1");

    client.send(call(2, "x"));
    let reply = client.wait_reply(json!(2));
    assert!(
        reply.get("result").is_some(),
        "a call after the reconnect must succeed, got {reply}"
    );

    let seen: Vec<_> = daemon.mcp_received();
    assert!(
        seen.iter()
            .any(|m| m.contains("kory-relay-replay-1") && m.contains("\"initialize\"")),
        "initialize was not replayed: {seen:?}"
    );
    assert!(
        client
            .lines()
            .iter()
            .all(|l| l["id"] != "kory-relay-replay-1"),
        "the replay answer reached Claude: {:?}",
        client.lines()
    );
    assert_eq!(client.lines().iter().filter(|l| l["id"] == 1).count(), 1);
}

#[test]
fn requests_sent_during_the_replay_wait_for_initialized() {
    let (_r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    client.send(initialized());
    wait_until("initialized to reach the daemon", || {
        daemon.mcp_received().len() == 2
    });
    daemon.set_initialize_delay_ms(300);
    daemon.drop_connections();
    wait_until("the replayed initialize to reach the daemon", || {
        daemon
            .mcp_received()
            .iter()
            .any(|m| m.contains("kory-relay-replay-1"))
    });
    client.send(call(2, "x"));
    let reply = client.wait_reply(json!(2));
    assert!(reply.get("result").is_some(), "got {reply}");

    let seen = daemon.mcp_received();
    let position = |needle: &str| seen.iter().rposition(|m| m.contains(needle)).expect(needle);
    assert!(position("kory-relay-replay-1") < position("notifications/initialized"));
    assert!(
        position("notifications/initialized") < position("\"tools/call\""),
        "the call overtook initialized: {seen:?}"
    );
}

#[test]
fn tools_list_changed_is_sent_only_when_the_tool_hash_changes() {
    let (_r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    client.send(initialized());
    daemon.drop_connections();
    wait_until("the second hello", || daemon.hellos().len() == 2);
    client.send(call(2, "x"));
    client.wait_reply(json!(2));
    let changed = |c: &Client| {
        c.lines()
            .iter()
            .filter(|l| l["method"] == "notifications/tools/list_changed")
            .count()
    };
    assert_eq!(changed(&client), 0, "same hash must not announce a change");

    daemon.set_tools_hash("h2");
    daemon.drop_connections();
    wait_until("the third hello", || daemon.hellos().len() == 3);
    wait_until("the list_changed notification", || changed(&client) == 1);
}

#[test]
fn unanswered_ping_closes_the_connection_and_answered_pings_keep_it() {
    let mut r = rig(vec![free_port()], &root_hash(ROOT));
    r.cfg.ping_interval = Duration::from_millis(30);
    r.cfg.pong_timeout = Duration::from_millis(80);
    let daemon = fake(&r, &root_hash(ROOT));
    let client = run_session(r.cfg.clone(), Arc::new(NoSpawn(AtomicUsize::new(0))));
    client.send(initialize(1));
    client.wait_reply(json!(1));
    wait_until("three answered pings", || daemon.pings() >= 3);
    assert_eq!(
        daemon.hellos().len(),
        1,
        "answered pings must keep the connection"
    );

    daemon.set_ignore_pings(true);
    wait_until("a reconnect after the missing PONG", || {
        daemon.hellos().len() == 2
    });
    assert!(r.logged("no PONG"));
}

#[test]
fn stdin_eof_sends_bye_and_exits_zero() {
    let (_r, daemon, mut client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    client.eof();
    assert_eq!(client.join(), 0);
    wait_until("the BYE", || !daemon.byes().is_empty());
    assert_eq!(daemon.byes(), vec!["stdin_eof".to_string()]);
}

#[test]
fn a_cancelled_request_is_forgotten_and_cannot_exhaust_the_in_flight_table() {
    let (_r, _daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    for id in 100..400u64 {
        client.send(call(id, "hold"));
        client.send(json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": id}}));
    }
    client.send(call(999, "x"));
    let reply = client.wait_reply(json!(999));
    assert!(
        reply.get("result").is_some(),
        "300 cancelled calls must not fill the in-flight table, got {reply}"
    );
}

#[test]
fn a_cancelled_request_gets_no_error_when_the_daemon_drops() {
    let (_r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    client.send(call(7, "hold"));
    client.send(
        json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 7}}),
    );
    wait_until("the cancellation to reach the daemon", || {
        daemon
            .mcp_received()
            .iter()
            .any(|m| m.contains("notifications/cancelled"))
    });
    daemon.drop_connections();
    wait_until("the second hello", || daemon.hellos().len() == 2);
    client.send(call(8, "x"));
    client.wait_reply(json!(8));
    assert!(
        client.reply_to(json!(7)).is_none(),
        "Claude abandoned request 7, it must not receive an error for it"
    );
}

fn second_fake(r: &Rig) -> claude_peers_relay::fake::FakeDaemon {
    let listener = std::net::TcpListener::bind(("127.0.0.1", r.cfg.candidates[1]))
        .expect("bind the second fake daemon port");
    let opts = claude_peers_relay::fake::FakeOptions {
        key: r.key.clone(),
        code_root: root_hash(ROOT),
        verify_relay: true,
        tools_hash: "h1".into(),
        send_ticket: true,
        hang: false,
    };
    claude_peers_relay::fake::FakeDaemon::start(listener, opts)
}

#[test]
fn a_daemon_that_refuses_the_session_is_named_in_the_error_and_retried_with_back_off() {
    let r = rig(vec![free_port(), free_port()], &root_hash(ROOT));
    let daemon = fake(&r, &root_hash(ROOT));
    let other = second_fake(&r);
    let client = run_session(r.cfg.clone(), Arc::new(NoSpawn(AtomicUsize::new(0))));
    client.send(initialize(1));
    client.wait_reply(json!(1));

    daemon.set_refuse_hello(Some("hello_invalid"));
    other.set_refuse_hello(Some("hello_invalid"));
    let refused_at = std::time::Instant::now();
    daemon.drop_connections();
    let attempts = || {
        r.log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|l| l.contains("hello_invalid"))
            .count()
    };
    wait_until("ten logged refusals", || attempts() >= 10);
    assert!(
        refused_at.elapsed() >= Duration::from_millis(90),
        "passes must be spaced by the back-off, 10 refusals took {:?}",
        refused_at.elapsed()
    );

    client.send(call(9, "x"));
    let reply = client.wait_reply(json!(9));
    assert!(
        reply["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("hello_invalid"),
        "the error must name the cause, got {reply}"
    );
}

#[test]
fn a_request_refused_while_the_daemon_is_absent_never_reaches_it_afterwards() {
    let (r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));

    daemon.set_refuse_hello(Some("hello_invalid"));
    daemon.drop_connections();
    wait_until("a logged refusal", || r.logged("hello_invalid"));
    client.send(call(9, "never-run"));
    let reply = client.wait_reply(json!(9));
    assert!(
        reply["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("was NOT executed"),
        "got {reply}"
    );

    daemon.set_refuse_hello(None);
    let mut next_id = 10;
    wait_until("a call to succeed after the reconnect", || {
        next_id += 1;
        client.send(call(next_id, "after"));
        client
            .wait_reply(json!(next_id))
            .get("result")
            .is_some()
    });
    assert!(
        !daemon.mcp_received().iter().any(|m| m.contains("never-run")),
        "the refused call must not be delivered once the daemon is back"
    );
}

#[test]
fn no_second_daemon_is_started_while_an_existing_one_refuses_the_session() {
    let r = rig(vec![free_port(), free_port()], &root_hash(ROOT));
    let daemon = fake(&r, &root_hash(ROOT));
    let spawner = Arc::new(NoSpawn(AtomicUsize::new(0)));
    let client = run_session(r.cfg.clone(), spawner.clone());
    client.send(initialize(1));
    client.wait_reply(json!(1));

    daemon.set_refuse_hello(Some("hello_invalid"));
    daemon.drop_connections();
    let attempts = || {
        r.log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|l| l.contains("hello_invalid"))
            .count()
    };
    wait_until("five logged refusals", || attempts() >= 5);
    assert_eq!(
        spawner.0.load(Ordering::SeqCst),
        0,
        "a free port exists, but a daemon is there and refuses: starting another cannot help"
    );
}

#[test]
fn a_line_over_the_channel_limit_fails_that_request_only() {
    let (_r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    let pad = "a".repeat(17 * 1024 * 1024);
    client.send(json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "x", "pad": pad}}));
    let reply = client.wait_reply(json!(5));
    assert!(
        reply["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("exceeds"),
        "got {}",
        reply["error"]
    );
    client.send(call(6, "x"));
    assert!(client.wait_reply(json!(6)).get("result").is_some());
    assert_eq!(
        daemon.hellos().len(),
        1,
        "an oversize request must not cost the connection"
    );
}

#[test]
fn daemon_output_is_re_emitted_as_one_json_line_and_non_json_is_dropped() {
    let (r, daemon, client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    daemon.push_mcp("{\n  \"jsonrpc\": \"2.0\",\n  \"method\": \"notifications/message\"\n}");
    wait_until("the notification", || {
        client
            .lines()
            .iter()
            .any(|l| l["method"] == "notifications/message")
    });
    daemon.push_mcp("this is not json");
    wait_until("the drop to be logged", || r.logged("not JSON"));
    assert!(
        client.lines().iter().all(|l| l.get("jsonrpc").is_some()),
        "only JSON-RPC lines may reach Claude"
    );
}

#[test]
fn the_reconnect_loop_stops_touching_the_directory_once_the_session_has_ended() {
    let mut r = rig(vec![free_port()], &root_hash(ROOT));
    r.cfg.connect_timeout = Duration::from_millis(40);
    let daemon = fake(&r, &root_hash(ROOT));
    let spawner = Arc::new(NoSpawn(AtomicUsize::new(0)));
    let mut client = run_session(r.cfg.clone(), spawner.clone());
    client.send(initialize(1));
    client.wait_reply(json!(1));
    daemon.stop();
    wait_until("the reconnect loop to try launching a daemon", || {
        spawner.0.load(Ordering::SeqCst) >= 1
    });
    client.eof();
    assert_eq!(client.join(), 0);
    let lock = launch_lock_file(&r.cfg.peers_dir, &r.cfg.code_root);
    std::fs::remove_file(&lock).expect("the loop left its launch lock");
    // Several back-off periods (40 ms at most each): a live loop would take the lock again.
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !lock.exists(),
        "the reconnect loop kept running after the session ended"
    );
}

#[test]
fn a_proxy_between_the_relay_and_the_daemon_sees_neither_secrets_nor_json_rpc() {
    let canary = format!(
        "canary-{}",
        claude_peers_relay::auth::random_b64(9).expect("random")
    );
    std::env::set_var("ANTHROPIC_API_KEY", &canary);
    let mut r = rig(vec![free_port()], &root_hash(ROOT));
    let daemon = fake(&r, &root_hash(ROOT));
    let proxy = proxy(daemon.port, None);
    r.cfg.candidates = vec![proxy.port];
    let client = run_session(r.cfg.clone(), Arc::new(NoSpawn(AtomicUsize::new(0))));
    client.send(initialize(1));
    client.wait_reply(json!(1));
    client.send(call(2, "x"));
    client.wait_reply(json!(2));
    std::env::remove_var("ANTHROPIC_API_KEY");

    assert_eq!(
        daemon.hellos()[0]["env"]["ANTHROPIC_API_KEY"],
        canary.as_str(),
        "the secret did reach the daemon"
    );
    let seen = proxy.seen.lock().unwrap_or_else(|e| e.into_inner()).clone();
    assert!(
        contains(&seen, b"daemon_nonce"),
        "the proxy must have seen the clear-text handshake, or it saw nothing"
    );
    for secret in [
        canary.as_bytes(),
        b"ANTHROPIC_API_KEY",
        b"jsonrpc",
        b"tools/call",
        b"echo",
        b"serverInfo",
    ] {
        assert!(
            !contains(&seen, secret),
            "the proxy read {:?} on the wire",
            String::from_utf8_lossy(secret)
        );
    }
}

#[test]
fn stdin_eof_while_the_daemon_is_away_exits_zero() {
    let (r, daemon, mut client, _s) = start();
    client.send(initialize(1));
    client.wait_reply(json!(1));
    daemon.stop();
    wait_until("the relay to notice the loss", || {
        r.logged("lost the daemon connection")
    });
    client.eof();
    assert_eq!(client.join(), 0);
}
