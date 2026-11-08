fn main() {
    let code = claude_peers_relay::run_main(std::env::args().skip(1).collect());
    std::process::exit(code);
}
