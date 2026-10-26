use std::io::{self, BufRead, Write};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    build_topology, find_node, kill_port_owner, parse_port_input, resolve_process_meta, VERSION,
};

const DEFAULT_N_CTX: usize = 4096;
const TRUNC_MARKER: &str = "[...TRUNCATED BY PORTGRAPH CONTEXT GUARD...]";

static ALLOW_WRITE: Mutex<bool> = Mutex::new(false);
static DRY_RUN: Mutex<bool> = Mutex::new(false);
static N_CTX: Mutex<usize> = Mutex::new(DEFAULT_N_CTX);

static LOOP_LAST_HASH: Mutex<String> = Mutex::new(String::new());
static LOOP_REPEAT: Mutex<u32> = Mutex::new(0);

pub fn set_guards(allow_write: bool, dry_run: bool) {
    *ALLOW_WRITE.lock().unwrap() = allow_write;
    *DRY_RUN.lock().unwrap() = dry_run;
}

fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(arr) => {
            let parts = arr.iter().map(canonicalize_json).collect::<Vec<_>>();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            let parts = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonicalize_json(&map[*k])
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", parts.join(","))
        }
    }
}

pub fn reset_loop_breaker() {
    *LOOP_LAST_HASH.lock().unwrap() = String::new();
    *LOOP_REPEAT.lock().unwrap() = 0;
}

pub fn check_loop_breaker(tool_name: &str, args: &Value) -> Option<String> {
    let payload = format!("{}:{}", tool_name, canonicalize_json(args));
    let hash = hex::encode(Sha256::digest(payload.as_bytes()));
    let mut last = LOOP_LAST_HASH.lock().unwrap();
    let mut count = LOOP_REPEAT.lock().unwrap();
    if *last == hash {
        *count += 1;
    } else {
        *last = hash;
        *count = 1;
    }
    if *count >= 3 {
        return Some(
            "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis."
                .into(),
        );
    }
    None
}

pub fn guard_mutating(tool_name: &str, mutates: bool) -> Option<String> {
    if !mutates {
        return None;
    }
    if *DRY_RUN.lock().unwrap() {
        return Some(format!(
            "[dry-run] Would call mutating tool {tool_name}; pass --allow-write and omit --dry-run to execute."
        ));
    }
    if !*ALLOW_WRITE.lock().unwrap() {
        return Some("Read-only mode: pass --allow-write to enable mutating tools.".into());
    }
    None
}

fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    if let Some(idx) = out.find("sk-") {
        let tail = &out[idx..];
        let len = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .count();
        if len >= 23 {
            out.replace_range(idx..idx + len, "[REDACTED]");
        }
    }
    if out.contains("Bearer ") {
        out = out.replace("Bearer ", "Bearer [REDACTED]");
    }
    out
}

fn head_tail_truncate(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let head_len = (max_chars as f64 * 0.6).floor() as usize;
    let tail_len = (max_chars as f64 * 0.4).floor() as usize;
    if tail_len <= TRUNC_MARKER.len() {
        return text.chars().take(max_chars).collect();
    }
    let tail_len = tail_len - TRUNC_MARKER.len();
    let tail_start = text.len() - tail_len;
    format!(
        "{}{}{}",
        &text[..head_len],
        TRUNC_MARKER,
        &text[tail_start..]
    )
}

fn finalize_tool_text(text: &str) -> String {
    let n_ctx = *N_CTX.lock().unwrap();
    let budget = ((n_ctx * 4) as f64 * 0.3).floor() as usize;
    redact_secrets(&head_tail_truncate(text, budget))
}

fn err_frame(id: &Value, stdout: &mut io::StdoutLock, message: String) {
    write_json_rpc_frame(
        stdout,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": finalize_tool_text(&message) }],
                "isError": true
            }
        }),
    );
}

fn write_json_rpc_frame(stdout: &mut io::StdoutLock, obj: &Value) {
    let line = format!("{}\n", obj);
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}

fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "get_local_topology",
            "description": "Map active local ports, PIDs, Docker, and LLM servers.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "who_owns_port",
            "description": "Resolve process, command, and cwd for a TCP port.",
            "inputSchema": {
                "type": "object",
                "properties": { "port": { "type": "number" } },
                "required": ["port"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "kill_port_owner",
            "description": "Terminate the process bound to a port (destructive).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "port": { "type": "number" },
                    "confirm": { "type": "boolean" }
                },
                "required": ["port", "confirm"],
                "additionalProperties": false
            },
            "annotations": { "destructiveHint": true }
        }),
    ]
}

fn port_from_args(args: &Value) -> Result<u16, String> {
    if let Some(n) = args.get("port").and_then(|v| v.as_u64()) {
        if n >= 1 && n <= 65535 {
            return Ok(n as u16);
        }
    }
    if let Some(s) = args.get("port").and_then(|v| v.as_str()) {
        return parse_port_input(s);
    }
    Err("missing or invalid port".into())
}

fn handle_tools_call(id: &Value, params: &Value, stdout: &mut io::StdoutLock) {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    if let Some(err) = check_loop_breaker(name, &args) {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{ "type": "text", "text": err }],
                    "isError": true
                }
            }),
        );
        return;
    }

    let mutates = name == "kill_port_owner";
    if let Some(reason) = guard_mutating(name, mutates) {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{ "type": "text", "text": reason }],
                    "isError": true
                }
            }),
        );
        return;
    }

    let result: Result<Value, String> = match name {
        "get_local_topology" => match build_topology() {
            Ok(graph) => Ok(serde_json::to_value(graph).unwrap_or(json!({}))),
            Err(e) => Err(e),
        },
        "who_owns_port" => {
            let port = match port_from_args(&args) {
                Ok(p) => p,
                Err(e) => return err_frame(id, stdout, e),
            };
            let graph = match build_topology() {
                Ok(g) => g,
                Err(e) => return err_frame(id, stdout, e),
            };
            let node = find_node(&graph, port).cloned();
            if let Some(ref n) = node {
                if n.pid > 0 {
                    let (command, cwd) = resolve_process_meta(n.pid);
                    Ok(json!({
                        "owner": {
                            "port": port,
                            "pid": n.pid,
                            "address": n.address,
                            "command": command,
                            "cwd": cwd
                        },
                        "node": n
                    }))
                } else {
                    Ok(json!({ "owner": null, "node": n }))
                }
            } else {
                Ok(json!({ "owner": null, "node": null }))
            }
        }
        "kill_port_owner" => {
            let port = match port_from_args(&args) {
                Ok(p) => p,
                Err(e) => return err_frame(id, stdout, e),
            };
            let confirm = args
                .get("confirm")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let res = kill_port_owner(port, confirm);
            Ok(json!({ "ok": res.ok, "message": res.message }))
        }
        _ => Err(format!("Unknown tool: {name}")),
    };

    match result {
        Ok(value) => {
            let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
            write_json_rpc_frame(
                stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": finalize_tool_text(&text) }]
                    }
                }),
            );
        }
        Err(e) => {
            write_json_rpc_frame(
                stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": finalize_tool_text(&e) }],
                        "isError": true
                    }
                }),
            );
        }
    }
}

pub fn dispatch_mcp_message(msg: &Value, stdout: &mut io::StdoutLock) {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    if method == "initialize" {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "portgraph", "version": VERSION }
                }
            }),
        );
        return;
    }
    if method == "notifications/initialized" {
        return;
    }
    if method == "tools/list" {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": tool_list() }
            }),
        );
        return;
    }
    if method == "tools/call" {
        handle_tools_call(&id, &params, stdout);
        return;
    }
    if !id.is_null() {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            }),
        );
    }
}

pub fn run_mcp_server() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut reader = stdin.lock();
    let mut buffer = String::new();
    loop {
        buffer.clear();
        let read = reader.read_line(&mut buffer)?;
        if read == 0 {
            break;
        }
        let line = buffer.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(msg) => dispatch_mcp_message(&msg, &mut stdout),
            Err(_) => continue,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_breaker_trips_on_third_identical_call() {
        reset_loop_breaker();
        let args = json!({});
        assert!(check_loop_breaker("get_local_topology", &args).is_none());
        assert!(check_loop_breaker("get_local_topology", &args).is_none());
        assert!(check_loop_breaker("get_local_topology", &args).is_some());
    }

    #[test]
    fn guard_blocks_mutating_without_allow_write() {
        set_guards(false, false);
        assert!(guard_mutating("kill_port_owner", true).is_some());
        set_guards(true, false);
        assert!(guard_mutating("kill_port_owner", true).is_none());
    }

    #[test]
    fn dry_run_blocks_mutating_kill() {
        set_guards(false, true);
        let reason = guard_mutating("kill_port_owner", true).unwrap_or_default();
        assert!(reason.contains("dry-run"));
    }

    #[test]
    fn tools_list_has_three_entries() {
        assert_eq!(tool_list().len(), 3);
    }
}
