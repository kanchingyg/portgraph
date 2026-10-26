pub mod mcp;

use std::collections::HashMap;
use std::process::Command;

use serde::{Deserialize, Serialize};

pub const VERSION: &str = "0.1.1";

pub fn llm_signature_ports() -> HashMap<u16, &'static str> {
    HashMap::from([
        (11434, "ollama"),
        (1234, "lmstudio"),
        (8000, "vllm"),
        (8080, "llamacpp"),
        (6333, "qdrant"),
    ])
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PortListener {
    pub port: u16,
    pub pid: u32,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PortOwner {
    pub port: u16,
    pub pid: u32,
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerContainerRow {
    pub name: String,
    pub ports: String,
    pub image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyNode {
    pub port: u16,
    pub pid: u32,
    pub address: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker: Option<DockerRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerRef {
    pub name: String,
    pub image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyGraph {
    pub scanned_at: String,
    pub nodes: Vec<TopologyNode>,
}

pub fn parse_port_input(raw: &str) -> Result<u16, String> {
    let s = raw.trim().trim_start_matches(':');
    let n: u32 = s.parse().map_err(|_| format!("Invalid port: {raw}"))?;
    if n < 1 || n > 65535 {
        return Err(format!("Invalid port: {raw}"));
    }
    Ok(n as u16)
}

fn exec_text(program: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() && out.stdout.is_empty() {
        return Err(format!("{program} failed"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn list_listening_ports() -> Result<Vec<PortListener>, String> {
    if std::env::consts::OS == "windows" {
        let out = exec_text("netstat", &["-ano"])?;
        let mut rows = Vec::new();
        for line in out.lines() {
            if !line.to_ascii_uppercase().contains("LISTENING") {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 {
                continue;
            }
            let local = parts[1];
            let pid: u32 = parts[4].parse().unwrap_or(0);
            let (address, port) = split_host_port(local)?;
            if pid > 0 {
                rows.push(PortListener {
                    port,
                    pid,
                    address,
                });
            }
        }
        return Ok(rows);
    }

    match exec_text("ss", &["-tlnp"]) {
        Ok(out) => Ok(parse_ss_output(&out)),
        Err(_) => {
            let out = exec_text("netstat", &["-tlnp"])?;
            Ok(parse_netstat_unix(&out))
        }
    }
}

fn split_host_port(local: &str) -> Result<(String, u16), String> {
    if let Some(idx) = local.rfind(':') {
        let port = local[idx + 1..].parse().map_err(|_| "bad port")?;
        let address = local[..idx].to_string();
        return Ok((address, port));
    }
    Err("bad address".into())
}

fn parse_ss_output(out: &str) -> Vec<PortListener> {
    let mut rows = Vec::new();
    for line in out.lines() {
        let port = line
            .split(':')
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse::<u16>().ok());
        let port = port.unwrap_or(0);
        if port == 0 {
            continue;
        }
        let pid = line
            .split("pid=")
            .nth(1)
            .and_then(|s| s.split(',').next())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let addr = line.split_whitespace().nth(3).unwrap_or("*").to_string();
        rows.push(PortListener {
            port,
            pid,
            address: addr,
        });
    }
    rows
}

fn parse_netstat_unix(out: &str) -> Vec<PortListener> {
    let mut rows = Vec::new();
    for line in out.lines() {
        if !line.to_ascii_uppercase().contains("LISTEN") {
            continue;
        }
        let port = line
            .split(':')
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        if port == 0 {
            continue;
        }
        let pid = line
            .split('/')
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        rows.push(PortListener {
            port,
            pid,
            address: "*".into(),
        });
    }
    rows
}

pub fn resolve_process_meta(pid: u32) -> (Option<String>, Option<String>) {
    if pid == 0 {
        return (None, None);
    }
    if std::env::consts::OS == "windows" {
        let out = exec_text("tasklist", &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
        match out {
            Ok(text) => {
                let line = text.lines().next().unwrap_or("").trim();
                let command = line
                    .split(',')
                    .next()
                    .map(|s| s.trim_matches('"').to_string())
                    .filter(|s| !s.is_empty());
                (command, None)
            }
            Err(_) => (None, None),
        }
    } else {
        match exec_text("ps", &["-p", &pid.to_string(), "-o", "command="]) {
            Ok(cmd) => {
                let c = cmd.trim();
                if c.is_empty() {
                    (None, None)
                } else {
                    (Some(c.to_string()), None)
                }
            }
            Err(_) => (None, None),
        }
    }
}

pub fn who_owns_port(port: u16) -> Result<Option<PortOwner>, String> {
    let listeners = list_listening_ports()?;
    let hit = listeners.into_iter().find(|r| r.port == port);
    match hit {
        None => Ok(None),
        Some(row) if row.pid == 0 => Ok(None),
        Some(row) => {
            let (command, cwd) = resolve_process_meta(row.pid);
            Ok(Some(PortOwner {
                port,
                pid: row.pid,
                address: row.address,
                command,
                cwd,
            }))
        }
    }
}

pub struct KillResult {
    pub ok: bool,
    pub message: String,
}

pub fn kill_port_owner(port: u16, confirm: bool) -> KillResult {
    if !confirm {
        return KillResult {
            ok: false,
            message: "kill_port_owner requires confirm: true".into(),
        };
    }
    let owner = match who_owns_port(port) {
        Ok(Some(o)) => o,
        Ok(None) => {
            return KillResult {
                ok: false,
                message: format!("No listener on port {port}"),
            };
        }
        Err(e) => {
            return KillResult {
                ok: false,
                message: e,
            };
        }
    };

    let self_pid = std::process::id();
    if owner.pid == self_pid {
        return KillResult {
            ok: false,
            message: "Refusing to kill the current process (agent/IDE guard)".into(),
        };
    }

    if std::env::consts::OS == "windows" {
        if let Err(e) = exec_text("taskkill", &["/PID", &owner.pid.to_string(), "/F"]) {
            return KillResult {
                ok: false,
                message: e,
            };
        }
    } else {
        let status = Command::new("kill")
            .args(["-TERM", &owner.pid.to_string()])
            .status();
        match status {
            Ok(s) if s.success() => {}
            _ => {
                return KillResult {
                    ok: false,
                    message: format!("Failed to signal PID {}", owner.pid),
                };
            }
        }
    }
    KillResult {
        ok: true,
        message: format!("Terminated PID {} on port {}", owner.pid, port),
    }
}

pub fn list_docker_containers() -> Vec<DockerContainerRow> {
    let out = exec_text("docker", &["ps", "--format", "{{json .}}"]);
    match out {
        Ok(text) => {
            let mut rows = Vec::new();
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(line) {
                    rows.push(DockerContainerRow {
                        name: j
                            .get("Names")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        ports: j
                            .get("Ports")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        image: j
                            .get("Image")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
            }
            rows
        }
        Err(_) => Vec::new(),
    }
}

fn docker_port_map(rows: &[DockerContainerRow]) -> HashMap<u16, DockerRef> {
    let mut map = HashMap::new();
    for row in rows {
        for part in row.ports.split(',') {
            if let Some(m) = part.trim().split(':').nth(1) {
                if let Some(host) = m.split("->").next() {
                    if let Ok(p) = host.parse::<u16>() {
                        map.insert(
                            p,
                            DockerRef {
                                name: row.name.clone(),
                                image: row.image.clone(),
                            },
                        );
                    }
                }
            }
            if let Some(idx) = part.find("0.0.0.0:") {
                let rest = &part[idx + 8..];
                if let Ok(p) = rest.split("->").next().unwrap_or(rest).parse::<u16>() {
                    map.insert(
                        p,
                        DockerRef {
                            name: row.name.clone(),
                            image: row.image.clone(),
                        },
                    );
                }
            }
        }
    }
    map
}

pub fn build_topology() -> Result<TopologyGraph, String> {
    let listeners = list_listening_ports()?;
    let dmap = docker_port_map(&list_docker_containers());
    let sig = llm_signature_ports();
    let mut nodes = Vec::new();
    let mut seen = HashMap::new();
    for row in listeners {
        if seen.contains_key(&row.port) {
            continue;
        }
        seen.insert(row.port, true);
        let mut tags = Vec::new();
        if sig.contains_key(&row.port) {
            tags.push("llm".into());
        }
        if dmap.contains_key(&row.port) {
            tags.push("docker".into());
        }
        let (command, cwd) = if row.pid > 0 {
            resolve_process_meta(row.pid)
        } else {
            (None, None)
        };
        nodes.push(TopologyNode {
            port: row.port,
            pid: row.pid,
            address: row.address,
            tags,
            command,
            cwd,
            docker: dmap.get(&row.port).cloned(),
        });
    }
    nodes.sort_by_key(|n| n.port);
    Ok(TopologyGraph {
        scanned_at: iso_timestamp(),
        nodes,
    })
}

fn iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let nanos = dur.subsec_nanos();
    format!("{secs}.{nanos:09}Z")
}

pub fn find_node(graph: &TopologyGraph, port: u16) -> Option<&TopologyNode> {
    graph.nodes.iter().find(|n| n.port == port)
}

pub fn render_topology(graph: &TopologyGraph) -> String {
    const DIM: &str = "\x1b[2m";
    const RESET: &str = "\x1b[0m";
    const CYAN: &str = "\x1b[36m";
    const GREEN: &str = "\x1b[32m";
    let mut lines = Vec::new();
    lines.push(format!(
        "{CYAN}portgraph{RESET} {DIM}local topology{RESET}  {}",
        graph.scanned_at
    ));
    lines.push(String::new());
    if graph.nodes.is_empty() {
        lines.push("  (no listening ports detected)".into());
        return lines.join("\n");
    }
    lines.push("  PORT     PID      TAGS           SERVICE / MODEL".into());
    lines.push(format!("  {}", "─".repeat(52)));
    for n in &graph.nodes {
        let tags = if n.tags.is_empty() {
            "-".to_string()
        } else {
            n.tags.join(",")
        };
        let svc = n
            .docker
            .as_ref()
            .map(|d| d.name.as_str())
            .or(n.command.as_deref())
            .unwrap_or(n.address.as_str());
        let svc = if svc.len() > 28 {
            svc.chars().take(28).collect::<String>()
        } else {
            svc.to_string()
        };
        lines.push(format!(
            "  {:<8} {:<8} {:<14} {}",
            n.port,
            n.pid,
            tags,
            svc
        ));
    }
    lines.push(String::new());
    lines.push(format!(
        "{GREEN}tip{RESET}  npx portgraph who :3000  ·  npx portgraph --mcp"
    ));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parse_port_accepts_colon_form() {
        assert_eq!(parse_port_input(":3000").unwrap(), 3000);
        assert_eq!(parse_port_input("8080").unwrap(), 8080);
    }

    #[test]
    fn parse_port_rejects_invalid() {
        assert!(parse_port_input("0").is_err());
        assert!(parse_port_input("99999").is_err());
    }

    #[test]
    fn docker_port_map_parses_publish() {
        let rows = vec![DockerContainerRow {
            name: "web".into(),
            ports: "0.0.0.0:3000->80/tcp".into(),
            image: "nginx".into(),
        }];
        let m = docker_port_map(&rows);
        assert_eq!(m.get(&3000).map(|d| d.name.as_str()), Some("web"));
    }

    #[test]
    fn who_owns_port_finds_ephemeral_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let conn = listener.accept().ok();
            if let Some((mut s, _)) = conn {
                let _ = s.read(&mut [0u8; 8]);
            }
        });
        let owner = who_owns_port(port).expect("scan");
        assert!(owner.is_some());
        assert_eq!(owner.unwrap().port, port);
        drop(handle);
    }

    #[test]
    fn kill_requires_confirm() {
        let res = kill_port_owner(9, false);
        assert!(!res.ok);
    }
}
