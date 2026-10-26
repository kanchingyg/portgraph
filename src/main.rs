use std::env;
use std::io::Write;

use portgraph::mcp::{run_mcp_server, set_guards};
use portgraph::{
    build_topology, kill_port_owner, parse_port_input, render_topology, who_owns_port, VERSION,
};

struct ParsedArgs {
    flags: Vec<String>,
    rest: Vec<String>,
}

fn parse_argv(argv: &[String]) -> ParsedArgs {
    let mut flags = Vec::new();
    let mut rest = Vec::new();
    for a in argv {
        if a.starts_with("--") {
            flags.push(a.clone());
        } else {
            rest.push(a.clone());
        }
    }
    ParsedArgs { flags, rest }
}

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let parsed = parse_argv(&argv);
    let allow_write = parsed.flags.iter().any(|f| f == "--allow-write");
    let dry_run = parsed.flags.iter().any(|f| f == "--dry-run");
    set_guards(allow_write, dry_run);

    if parsed.flags.iter().any(|f| f == "--mcp") {
        if let Err(e) = run_mcp_server() {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }

    let code = run_cli(&parsed, allow_write);
    std::process::exit(code);
}

fn run_cli(parsed: &ParsedArgs, allow_write: bool) -> i32 {
    let cmd = parsed
        .rest
        .first()
        .filter(|c| !c.starts_with('-'))
        .map(|s| s.as_str());

    if cmd == Some("who") {
        let port_arg = parsed.rest.get(1).map(|s| s.as_str()).unwrap_or("");
        let port = match parse_port_input(port_arg) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        };
        match who_owns_port(port) {
            Ok(Some(owner)) => {
                let text = serde_json::to_string_pretty(&owner).unwrap_or_default();
                let _ = std::io::stderr().write_all(text.as_bytes());
                let _ = std::io::stderr().write_all(b"\n");
                0
            }
            Ok(None) => 1,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        }
    } else if cmd == Some("kill") {
        if !allow_write {
            eprintln!("Read-only: pass --allow-write to kill a port owner.");
            return 1;
        }
        let port_arg = parsed.rest.get(1).map(|s| s.as_str()).unwrap_or("");
        let port = match parse_port_input(port_arg) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        };
        let res = kill_port_owner(port, true);
        eprintln!("{}", res.message);
        if res.ok {
            0
        } else {
            1
        }
    } else if parsed.flags.iter().any(|f| f == "--help" || f == "-h") {
        eprintln!(
            "portgraph {VERSION} — portgraph | who :PORT | kill :PORT --allow-write | --mcp"
        );
        2
    } else {
        match build_topology() {
            Ok(graph) => {
                eprintln!("{}", render_topology(&graph));
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        }
    }
}
