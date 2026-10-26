// Manages the local `agent-proxy` Node.js service as a Tauri-managed child
// process. The service binds to 127.0.0.1:9099 and bridges the desktop UI to
// local Claude Code / Hermes / OpenCode CLIs.
//
// Lifecycle:
//   - spawned during `setup` (right after the Tauri app is built)
//   - killed on `RunEvent::Exit` (covers window close + OS-driven quit)
//
// We deliberately do NOT use `tauri-plugin-shell` here — we want the child
// fully owned by us (kill on drop, port collision detection) rather than
// spawned on demand by the frontend.

use std::ffi::OsStr;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

pub struct AgentProxyHandle(pub Mutex<Option<Child>>);

/// Default listen port — keep in sync with `agent-proxy/src/config.ts`.
const DEFAULT_PORT: u16 = 9099;

/// SIGTERM 整组之后、SIGKILL 整组之前的宽限期（秒）。
/// agent-proxy 的 node 侧收到 SIGTERM 会先杀它拉起的 CLI 再退出，
/// 给它一点时间把孙子的管道收干净，避免「优雅退出」变成二次 SIGKILL。
const KILL_GRACE: Duration = Duration::from_secs(3);

pub fn spawn() -> Result<Child, String> {
    if is_port_in_use(DEFAULT_PORT) {
        return Err(format!(
            "port {} is already in use; another agent-proxy may be running",
            DEFAULT_PORT
        ));
    }

    let node = resolve_node().ok_or_else(|| "node executable not found in PATH".to_string())?;
    let entry = resolve_entry().ok_or_else(|| {
        "agent-proxy dist not built; run `npm run build` in agent-proxy/ first".to_string()
    })?;

    eprintln!(
        "[agent-proxy] launching: {} {}",
        node.display(),
        entry.display()
    );

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .env("AGENT_PROXY_AUTOSTART", "1")
        .current_dir(entry.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    put_in_own_process_group(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| spawn_error_message(&node, &e))?;

    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || pipe_to_stderr("agent-proxy/stdout", stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || pipe_to_stderr("agent-proxy/stderr", stderr));
    }

    // Give it a moment to bind, then double-check the port.
    std::thread::sleep(std::time::Duration::from_millis(400));
    if !is_port_in_use(DEFAULT_PORT) {
        // 也要走整组 kill：node 可能在绑端口之前就已经拉起了 CLI，
        // 裸 child.kill() 只杀 node 自己，孙子会变孤儿继续烧 token。
        kill(&mut child);
        return Err(format!(
            "agent-proxy exited before binding port {} (see logs above)",
            DEFAULT_PORT
        ));
    }
    eprintln!("[agent-proxy] ready on http://127.0.0.1:{}", DEFAULT_PORT);
    Ok(child)
}

/// Kill and reap the agent-proxy process tree. Safe to call multiple times.
///
/// **杀的是整个进程组，不只是直接子进程。** agent-proxy 自己会再拉起
/// claude / hermes / opencode 三个 CLI；只对直接子进程发 SIGKILL，
/// 这些孙子会被 init 收养后继续跑、继续烧 token。原先的实现正是这样，
/// 于是「关掉应用」并不等于「LLM 进程都停了」。
///
/// 依赖 `put_in_own_process_group` 已经把子进程放进了自己的组；
/// 因为 pgid == 子进程 pid，所以这里发信号绝不会误伤本进程。
///
/// 收尾顺序是「先礼后兵」：SIGTERM 整组 → 宽限 `KILL_GRACE` 秒 →
/// SIGKILL 整组。node 侧（agent-proxy/src/index.ts）收到 SIGTERM 会
/// 先杀它登记的 CLI 子进程再退出，留宽限期才不会把优雅退出掐断在半路。
/// 宽限期过后无论 node 死没死都再补一次 SIGKILL 整组，保证没有漏网的孙子。
///
/// Windows 没有进程组信号这套，用 `taskkill /T` 杀进程树：
/// 先不带 `/F`（礼貌），超宽限再 `/T /F`（强杀）。
///
/// ⚠️ 2026-10-05 修正一个**比它要解决的问题严重得多**的 bug：
/// 这里原先写的是 `libc::kill(-1, SIGKILL)`。`pid` 算出来了却没用上。
/// POSIX 里 `kill(-1, sig)` 不是「killpg 1」，而是
/// **「发给调用者有权限的全部进程」** —— 也就是说，用户每退出一次这个应用，
/// 就会 SIGKILL 掉他名下**所有**进程：编辑器、终端、浏览器、别的应用，
/// 以及任何正在跑的脚本。这条路径接在 `RunEvent::Exit` 上（见 `lib.rs`），
/// 也就是「关掉应用」这个最普通的动作。
///
/// 正确写法是 `kill(-pgid, sig)`，即 `killpg` 的语义。之所以一直没被发现，
/// 是因为同文件里那条测试只断言「孙进程死了」—— 全场清场当然也能让孙进程死，
/// **它测的是「有东西死了」，不是「该死的东西死了」**。现在补了「无关进程必须
/// 活着」的反向断言，并且把 pid→-pgid 的换算收进纯函数 `group_signal_target`
/// 用单测钉住（pid 为 0 时绝不允许发信号）。
pub fn kill(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Some(target) = group_signal_target(child.id()) {
            // 负 pid = 「发给进程组 -pid 的全体成员」。因为 `put_in_own_process_group`
            // 让 pgid == 子进程 pid，这里打到的正是我们拉起的那棵树。
            // SAFETY: 只发信号，不共享内存；group_signal_target 保证 target < 0
            // 且绝不等于 -1（那个语义是「全部进程」）。子进程若已退出，
            // 这里拿到 ESRCH，无副作用。
            unsafe { libc::kill(target, libc::SIGTERM) };
            wait_group_leader(child, KILL_GRACE);
            // 宽限期过后补刀：node 可能还在跑，某个 CLI 也可能单杀不死。
            // 对空组再发一次 SIGKILL 只是 ESRCH，没有副作用。
            unsafe { libc::kill(target, libc::SIGKILL) };
        }
    }
    #[cfg(windows)]
    {
        let pid = child.id();
        // 先礼貌：taskkill 不带 /F，给进程树发 WM_CLOSE。
        let _ = Command::new("taskkill")
            .args(taskkill_tree_args(pid, false))
            .stdin(Stdio::null())
            .status();
        wait_group_leader(child, KILL_GRACE);
        // 再强杀：/T 整棵树，/F 强制执行。
        let _ = Command::new("taskkill")
            .args(taskkill_tree_args(pid, true))
            .stdin(Stdio::null())
            .status();
    }
    let _ = child.kill();
    // Wait so the OS reaps the process; otherwise we may leak a zombie
    // briefly. We swallow errors because the child may have exited already.
    let _ = child.wait();
}

/// 等进程组组长（直接子进程）退出，最多 `grace`。
/// 已退出返回 true；超时还活着返回 false（调用方随后补 SIGKILL）。
fn wait_group_leader(child: &mut Child, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return true, // 已经 wait 过/收不到了，当它死了
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// pid → `kill(2)` 的进程组目标参数：`-(pid as i32)`。
///
/// 之所以抽成纯函数：`kill(-1, sig)` 是「杀调用者全部进程」，
/// 而 `kill(-pgid, sig)` 才是「杀这一组」—— 两者只差一个负号，
/// 肉眼极难分辨，必须靠单测钉住。pid 为 0 时返回 `None`：
/// 组号 0 的语义同样是「调用者所在组」，绝不能拿去发信号。
pub fn group_signal_target(pid: u32) -> Option<i32> {
    if pid == 0 {
        return None;
    }
    // pid 来自 std::process::Child::id()，实际值远小于 i32::MAX。
    let raw = pid as i32;
    if raw <= 0 {
        return None;
    }
    Some(-raw)
}

/// `taskkill` 杀进程树的参数。`force=false` 是先礼后兵的「礼」。
/// 纯函数，任何平台都能测（编译和跑测试不依赖 Windows）。
///
/// ⚠ **只有 Windows 分支会调用它** ⇒ 非 Windows 的**非测试**构建里它是死代码
///   ⇒ `cargo clippy -- -D warnings` 会直接判红（CI 的 Rust 腿就是这个命令）。
///   ⇒ 这里**精确豁免这一条**（不是整仓关掉这个 lint）：
///   真要治它，就得把这段参数构造在两个平台各写一遍 ⇒ 反而更容易漂移。
///   测试（`taskkill_tree_args_shape`）在所有平台都跑 ⇒ 逻辑本身一直有覆盖。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn taskkill_tree_args(pid: u32, force: bool) -> Vec<String> {
    let mut args = vec!["/T".to_string(), "/PID".to_string(), pid.to_string()];
    if force {
        args.push("/F".to_string());
    }
    args
}

// ──────────── helpers ────────────

/// 让子进程成为**自己进程组的组长**（pgid == 自己的 pid）。
///
/// 为什么必须做：agent-proxy 不是终点进程，它自己还会再拉起
/// claude / hermes / opencode 三个 CLI。只对直接子进程发信号，
/// 这些孙子会活下来继续跑、继续烧 token。不开新进程组的话，
/// 后面 `kill()` 里的 `killpg` 也没有一个属于自己的组可以打。
#[cfg(unix)]
fn put_in_own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn put_in_own_process_group(_cmd: &mut Command) {
    // Windows 上没有进程组这套说法；Taskkill 树形终止见 kill()。
}

// 父进程猝死（外部 SIGKILL / setup 后 panic）时 Rust 侧够不着的路径，
// 由 agent-proxy 的 ppid 看门狗兜底（agent-proxy/src/index.ts）：
// node 记下启动时的 ppid，发现父变了就杀光 CLI 再退出。
// macOS 没有 PDEATHSIG，Windows 上又不宜为它引入 windows-sys 依赖，
// 所以这个监护放在 Node 侧，一次实现覆盖 Unix 全家。

/// 每条流（stdout / stderr）最多转发这么多字节到 Tauri 的 stderr。
///
/// W-03：原先 `pipe_to_stderr` 用 `lines()` 无限转发，agent-proxy 或它拉起的
/// CLI 一旦刷屏（死循环日志、超长报错）就会把整个输出塞进进程内存。
/// 现在**有上限**，且超限后**继续把管道读空**（背压）：只丢弃不转发，
/// 否则子进程会写满管道后阻塞，表现为「Agent 卡死」。
pub const MAX_FORWARDED_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ForwardStats {
    /// 真正交给 sink 的字节数（<= limit）
    forwarded: u64,
    /// 从流里读出的总字节数（含被丢弃的）
    total: u64,
    /// 是否发生了截断
    truncated: bool,
}

/// 把 `stream` 读空，最多把 `limit` 字节交给 `sink`。
///
/// 按固定 8KB 块读，**不按行**：单行 100MB 的日志用 `read_until` 同样会撑爆内存。
/// 超限后仍然继续读（背压），只是不再交给 sink。
fn forward_stream(
    stream: impl Read,
    limit: usize,
    mut sink: impl FnMut(&[u8]),
) -> ForwardStats {
    let mut reader = BufReader::new(stream);
    let mut buf = [0u8; 8192];
    let mut stats = ForwardStats {
        forwarded: 0,
        total: 0,
        truncated: false,
    };
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                stats.total += n as u64;
                if !stats.truncated {
                    let remaining = limit.saturating_sub(stats.forwarded as usize);
                    let take = n.min(remaining);
                    if take > 0 {
                        sink(&buf[..take]);
                        stats.forwarded += take as u64;
                    }
                    if take < n {
                        stats.truncated = true;
                    }
                }
            }
            Err(_) => break, // 子进程退出/管道断了：没有更多可读的
        }
    }
    stats
}

fn pipe_to_stderr(prefix: impl Into<String>, stream: impl Read + Send + 'static) {
    let prefix = prefix.into();
    thread::spawn(move || {
        let stderr = std::io::stderr();
        let mut out = stderr.lock();
        let _ = write!(out, "[{}] ", prefix);
        let stats = forward_stream(stream, MAX_FORWARDED_BYTES, |chunk| {
            let _ = out.write_all(chunk);
        });
        if stats.truncated {
            let _ = writeln!(
                out,
                "\n[{}] output truncated: forwarded {} of {} bytes (limit {} per stream)",
                prefix, stats.forwarded, stats.total, MAX_FORWARDED_BYTES
            );
        } else {
            let _ = out.flush();
        }
    });
}

fn is_port_in_use(port: u16) -> bool {
    use std::net::TcpStream;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200)).is_ok()
}

/// 解析 `node` 可执行文件。行为是**显式**的（W-02）：
///
/// 1. 只在 `PATH` 的每个目录里找 `node`（Windows 额外认 `node.exe`）；
///    `PATH` 缺失或为空 ⇒ 这一步**跳过**，不会去猜当前目录；
/// 2. 扫常见安装位置（Homebrew / /usr/local / /usr/bin / ~/.local/bin）；
/// 3. nvm 版本目录里挑版本号最大的；
/// 4. 全都没命中 ⇒ 返回裸 `"node"`，让 `Command::spawn` 给出 ENOENT，
///    错误信息里明确写「PATH 与常见安装位置都没找到」。
///
/// ⚠ 第 4 步保证本函数**永远 `Some`** —— 调用方别指望用它判断 node 在不在。
///   这是「启动失败时错误可行动」与「不要静默假装成功」的取舍：
///   真正的失败点在 `spawn`，那里会把原因翻译成人话。
pub fn resolve_node() -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH");
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    resolve_node_in(path_env.as_deref(), &home, &common_node_candidates(&home))
}

fn common_node_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
        PathBuf::from("/bin/node"),
        home.join(".local/bin/node"),
    ]
}

fn node_binary_names() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &["node.exe", "node"]
    }
    #[cfg(not(windows))]
    {
        &["node"]
    }
}

/// 在 `PATH` 里按顺序找第一个 `node` 文件。
/// 空字符串 / 空路径段一律跳过（POSIX 里空段等于当前目录，行为不确定）。
fn find_node_on_path(path_env: Option<&OsStr>) -> Option<PathBuf> {
    let raw = path_env?;
    if raw.is_empty() {
        return None;
    }
    for dir in std::env::split_paths(raw) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in node_binary_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// `resolve_node` 的可测版本：PATH、HOME、常见候选目录都从参数进来。
fn resolve_node_in(
    path_env: Option<&OsStr>,
    home: &Path,
    common: &[PathBuf],
) -> Option<PathBuf> {
    if let Some(p) = find_node_on_path(path_env) {
        return Some(p);
    }

    for c in common {
        if !c.as_os_str().is_empty() && c.is_file() {
            return Some(c.clone());
        }
    }

    pick_highest_nvm_node(&home.join(".nvm").join("versions").join("node"))
        .or_else(|| Some(PathBuf::from("node")))
}

/// spawn 失败时给用户/日志看的错误：如果是裸 `"node"` 兜底失败，
/// 直接把「怎么修」写出来（装 Node 18+ / 修 PATH），不要只甩 os error。
fn spawn_error_message(node: &Path, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound && node == Path::new("node") {
        return format!(
            "failed to spawn agent-proxy: node executable not found in PATH or common install \
             locations ({e}); install Node.js 18+ or add its bin directory to PATH"
        );
    }
    format!("failed to spawn agent-proxy: {e}")
}

/// nvm 版本目录名（`v20.11.0`）的数值化排序键。
///
/// 存在的理由：原先直接对**文件名字符串**排序，而字典序与版本大小无关
/// （`"v9.5.0" > "v21.0.0"`），装了 v9/v20/v21 的机器会拿到 v9。
/// 字段按 major → minor → patch 逐级比，derive 出来的 `Ord` 正好是这个顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct VersionKey {
    major: u32,
    minor: u32,
    patch: u32,
}

impl VersionKey {
    /// 解析目录名。首段不是数字就返回 `None`（`aliases` / `.cache` / `latest`）。
    fn parse(name: &str) -> Option<VersionKey> {
        let body = name.strip_prefix('v').unwrap_or(name);
        let mut parts = body.split('.');
        // major 必须真的是数字，否则整个名字就不是版本目录。
        // minor / patch 缺省按 0：nvm 会有 `v20`、`v20.11` 这类名字，不该被丢掉。
        let major = parts.next().and_then(|s| s.parse::<u32>().ok())?;
        let minor = parts
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let patch = parts
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        Some(VersionKey {
            major,
            minor,
            patch,
        })
    }
}

/// 从 nvm 的版本目录里挑一个 `bin/node` 出来。抽成纯函数是为了能被测：
/// 原来这段直接读 `HOME` 和真实文件系统，测不了也构造不出多版本并存的目录。
fn pick_highest_nvm_node(nvm_root: &std::path::Path) -> Option<PathBuf> {
    if !nvm_root.is_dir() {
        return None;
    }
    let rd = std::fs::read_dir(nvm_root).ok()?;
    // (版本, 路径)。认不出的目录名直接跳过，不参与排序也不参与命中。
    let mut candidates: Vec<(VersionKey, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            Some((VersionKey::parse(&name)?, e.path()))
        })
        .collect();
    // 降序取最高版本 ⇒ 用 Reverse 包一层，比 sort_by(|a,b| b.0.cmp(&a.0)) 更直白
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
    for (_, dir) in candidates {
        let p = dir.join("bin").join("node");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn resolve_entry() -> Option<PathBuf> {
    // 1. Production: alongside the executable. On macOS .app bundles the
    //    Tauri `resources` map lands under Contents/Resources/, while on
    //    Windows / Linux the bundle is laid out next to the .exe / binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // 1a. macOS .app: <Contents>/Resources/agent-proxy/dist/index.js
            if let Some(contents_dir) = dir.parent() {
                let p = contents_dir
                    .join("Resources")
                    .join("agent-proxy")
                    .join("dist")
                    .join("index.js");
                if p.exists() {
                    return Some(p);
                }
            }
            // 1b. Windows / Linux: alongside the binary
            let p = dir.join("agent-proxy").join("dist").join("index.js");
            if p.exists() {
                return Some(p);
            }
        }
    }

    // 2. Dev: <workspace>/agent-proxy/dist/index.js — search upwards from
    //    CARGO_MANIFEST_DIR (src-tauri/) until we find a sibling agent-proxy.
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let mut cur = PathBuf::from(&manifest);
        for _ in 0..5 {
            let candidate = cur.join("agent-proxy").join("dist").join("index.js");
            if candidate.exists() {
                return Some(candidate);
            }
            if !cur.pop() {
                break;
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// 临时目录 + `Drop` 清理。Rust 的测试默认并行跑在同一进程里，
    /// 所以名字里必须带序号，不能只用 pid（pid 对所有用例都一样）。
    struct TempTree {
        path: PathBuf,
    }
    static SEQ: AtomicUsize = AtomicUsize::new(0);

    impl TempTree {
        fn new(tag: &str) -> TempTree {
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let mut p = std::env::temp_dir();
            p.push(format!(
                "zbb-worker-test-{}-{}-{}",
                tag,
                std::process::id(),
                n
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).expect("建临时目录");
            TempTree { path: p }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// 在 nvm_root 下造一个 `vX.Y.Z/bin/node`。
    fn make_nvm_version(nvm_root: &std::path::Path, v: &str) -> PathBuf {
        let dir = nvm_root.join(v).join("bin");
        std::fs::create_dir_all(&dir).expect("建版本目录");
        let node = dir.join("node");
        std::fs::write(&node, b"#!/bin/sh\nexit 0\n").expect("写假 node");
        node
    }

    /// P0-2：nvm 多版本并存时必须挑**版本号最大**的那个。
    ///
    /// 原实现按文件名字典序取最大，而字典序与版本大小无关：
    /// `"v9.5.0" > "v21.0.0" > "v20.11.0"`。于是 nvm 装了 v9/v20/v21 的机器
    /// 实际会拿到 **v9**。用户表现是「明明装了新 node，应用用的还是老版本」。
    #[test]
    fn nvm_picks_highest_version_numerically() {
        let t = TempTree::new("nvm-highest");
        // 故意把 v9 放在字典序最大、v100 放在最小，逼出两种排序的差异
        for v in ["v9.5.0", "v10.0.0", "v20.11.0", "v21.0.0", "v100.0.0"] {
            make_nvm_version(&t.path, v);
        }
        let want = t.path.join("v100.0.0").join("bin").join("node");
        let got = pick_highest_nvm_node(&t.path);
        assert_eq!(
            got.as_deref(),
            Some(want.as_path()),
            "应挑版本号最大的 v100.0.0，而不是字典序最大的 v9.5.0"
        );
    }

    #[test]
    fn nvm_compares_minor_and_patch_not_just_major() {
        let t = TempTree::new("nvm-minor");
        for v in ["v20.9.0", "v20.11.0", "v20.10.0"] {
            make_nvm_version(&t.path, v);
        }
        let want = t.path.join("v20.11.0").join("bin").join("node");
        assert_eq!(
            pick_highest_nvm_node(&t.path).as_deref(),
            Some(want.as_path())
        );
    }

    /// 没有 `v` 前缀 / 不是版本号的名字（nvm 自己会放 `aliases`、`.cache`）
    /// 不该被当成候选。
    #[test]
    fn nvm_skips_non_version_directory_names() {
        let t = TempTree::new("nvm-noise");
        make_nvm_version(&t.path, "v21.0.0");
        for noise in ["aliases", ".cache", "latest", "current"] {
            std::fs::create_dir_all(t.path.join(noise).join("bin")).unwrap();
            std::fs::write(t.path.join(noise).join("bin").join("node"), b"x").unwrap();
        }
        let want = t.path.join("v21.0.0").join("bin").join("node");
        assert_eq!(
            pick_highest_nvm_node(&t.path).as_deref(),
            Some(want.as_path())
        );
    }

    #[test]
    fn nvm_returns_none_when_root_missing_or_has_no_node() {
        let t = TempTree::new("nvm-empty");
        assert_eq!(pick_highest_nvm_node(&t.path), None, "空目录应返回 None");
        assert_eq!(pick_highest_nvm_node(&t.path.join("does-not-exist")), None);
        // 有版本目录但里面没有 bin/node
        std::fs::create_dir_all(t.path.join("v21.0.0")).unwrap();
        assert_eq!(pick_highest_nvm_node(&t.path), None);
    }

    /// `resolve_node()` 的最后一步恒返回裸 `"node"`，所以它**永远**是 `Some`。
    /// 记在这里是为了别再往 `spawn()` 上加「node 找不到」的分支期待 ——
    /// 那条 `ok_or_else` 不可达，失败会以 `Command::spawn` 的 ENOENT 形式出现。
    #[test]
    fn resolve_node_always_succeeds_via_bare_name_fallback() {
        let p = resolve_node();
        assert!(
            p.is_some(),
            "末位兜底保证 Some；这不是 bug，但调用方别指望它是 None"
        );
    }

    fn make_fake_node_in(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).expect("建假 bin 目录");
        let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&node, b"#!/bin/sh\nexit 0\n").expect("写假 node");
        node
    }

    /// W-02：`PATH` 里有 node ⇒ 用 PATH 里的那个（且按目录顺序取第一个）。
    #[test]
    fn node_is_found_on_path_in_directory_order() {
        let t = TempTree::new("path-order");
        let first = t.path.join("first");
        let second = t.path.join("second");
        let want = make_fake_node_in(&first);
        make_fake_node_in(&second);

        let joined = std::env::join_paths([&first, &second]).expect("拼 PATH");
        let got = find_node_on_path(Some(joined.as_os_str()));
        assert_eq!(got.as_deref(), Some(want.as_path()));
    }

    /// W-02：PATH 为空 / 缺失 ⇒ **不猜**当前目录，直接返回 None，
    /// 交给后面的常见目录与 nvm 兜底。
    #[test]
    fn empty_or_missing_path_yields_no_path_hit() {
        assert_eq!(
            find_node_on_path(Some(OsStr::new(""))),
            None,
            "PATH 为空时不应命中任何东西（尤其不能拿当前目录当 PATH）"
        );
        assert_eq!(find_node_on_path(None), None, "PATH 缺失时同样不命中");
        assert_eq!(
            find_node_on_path(Some(OsStr::new("/definitely/not/here"))),
            None
        );
    }

    /// W-02：PATH 为空且常见目录里没有 node ⇒ 落到裸 `"node"`（由 spawn 报可行动的错）。
    #[test]
    fn resolve_with_empty_path_falls_back_to_bare_node() {
        let t = TempTree::new("resolve-empty");
        let got = resolve_node_in(Some(OsStr::new("")), &t.path, &[]);
        assert_eq!(got, Some(PathBuf::from("node")));
        let got = resolve_node_in(None, &t.path, &[]);
        assert_eq!(got, Some(PathBuf::from("node")));
    }

    /// W-02：PATH 没命中时，常见安装位置仍然能救回来。
    #[test]
    fn resolve_falls_back_to_common_install_locations() {
        let t = TempTree::new("resolve-common");
        let bin = t.path.join("homebrew-bin");
        let want = make_fake_node_in(&bin);
        let got = resolve_node_in(
            Some(OsStr::new("/definitely/not/here")),
            &t.path,
            std::slice::from_ref(&want),
        );
        assert_eq!(got.as_deref(), Some(want.as_path()));
    }

    /// W-02：裸兜底失败时，错误必须说明「装 Node 18+ / 修 PATH」。
    #[test]
    fn spawn_error_for_bare_node_is_actionable() {
        let e = std::io::Error::new(std::io::ErrorKind::NotFound, "No such file or directory");
        let msg = spawn_error_message(Path::new("node"), &e);
        assert!(msg.contains("PATH"), "错误应提到 PATH：{msg}");
        assert!(msg.contains("Node.js 18+"), "错误应给出安装建议：{msg}");
        // 明确的绝对路径失败时不要把「装 node」的话术硬套上去
        let msg2 = spawn_error_message(Path::new("/opt/homebrew/bin/node"), &e);
        assert!(!msg2.contains("Node.js 18+"));
    }

    /// W-03：输出超过上限 ⇒ 只转发上限以内，但**整条流仍被读空**（不阻塞子进程）。
    #[test]
    fn forward_stream_caps_output_and_still_drains() {
        let total = 2 * 1024 * 1024; // > 1MB
        let data = vec![b'x'; total];
        let mut forwarded = Vec::new();
        let stats = forward_stream(Cursor::new(data), MAX_FORWARDED_BYTES, |chunk| {
            forwarded.extend_from_slice(chunk)
        });
        assert_eq!(stats.total, total as u64, "必须把整条流读完（背压）");
        assert_eq!(stats.forwarded, MAX_FORWARDED_BYTES as u64);
        assert_eq!(forwarded.len(), MAX_FORWARDED_BYTES);
        assert!(stats.truncated);
    }

    /// W-03：单行超长（没有换行）也不能撑爆内存 —— 按块读，不按行读。
    #[test]
    fn forward_stream_handles_single_huge_line() {
        let mut data = vec![b'y'; 1024 * 1024];
        data.push(b'\n');
        let stats = forward_stream(Cursor::new(data), 1024, |_| {});
        assert_eq!(stats.total, 1024 * 1024 + 1);
        assert_eq!(stats.forwarded, 1024);
        assert!(stats.truncated);
    }

    #[test]
    fn forward_stream_passes_small_output_through_untouched() {
        let mut forwarded = Vec::new();
        let stats = forward_stream(Cursor::new(b"hello\nworld\n"), 1024, |c| {
            forwarded.extend_from_slice(c)
        });
        assert_eq!(stats.forwarded, 12);
        assert_eq!(stats.total, 12);
        assert!(!stats.truncated);
        assert_eq!(forwarded, b"hello\nworld\n");
    }

    /// W-03 真进程版：子进程输出 1.5MB，转发有上限且函数返回（没有卡在管道上）。
    #[cfg(unix)]
    #[test]
    fn forward_stream_from_real_child_caps_at_limit() {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("head -c 1572864 /dev/zero")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .expect("起刷屏子进程");
        let stream = child.stdout.take().expect("stdout");
        let stats = forward_stream(stream, MAX_FORWARDED_BYTES, |_| {});
        let status = child.wait().expect("等子进程");
        assert!(status.success());
        assert_eq!(stats.total, 1_572_864);
        assert_eq!(stats.forwarded, MAX_FORWARDED_BYTES as u64);
        assert!(stats.truncated);
    }

    /// W-01：应用被 SIGKILL（`RunEvent::Exit` 不会触发）时，
    /// agent-proxy 必须靠 ppid 看门狗自己退出，不能变成孤儿继续烧 token。
    ///
    /// 造法：测试进程起一个 `/bin/sh` 当「Tauri」，它 `nohup` 起真的
    /// `agent-proxy/dist/index.js`；然后测试**只 SIGKILL 那个 sh**（不杀进程组），
    /// 模拟「宿主编排层把应用强杀」。看门狗间隔用环境变量压到 300ms。
    #[cfg(unix)]
    #[test]
    fn parent_sigkill_takes_down_proxy_via_ppid_watchdog() {
        use std::net::TcpListener;

        let node = resolve_node().expect("node");
        let entry = match resolve_entry() {
            Some(p) => p,
            None => {
                eprintln!("skipping: agent-proxy/dist/index.js not built");
                return;
            }
        };
        let port = TcpListener::bind(("127.0.0.1", 0))
            .and_then(|l| l.local_addr())
            .expect("拿空闲端口")
            .port();
        let t = TempTree::new("parent-death");

        let script = format!(
            "AGENT_PROXY_PARENT_WATCH_MS=300 nohup \"{}\" \"{}\" --port {} --persist-dir \"{}\" \
             >/dev/null 2>&1 & echo $!; wait",
            node.display(),
            entry.display(),
            port,
            t.path.display()
        );
        let mut shell = Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("起模拟 Tauri 的 shell");

        let mut line = String::new();
        BufReader::new(shell.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("读 agent-proxy pid");
        let proxy_pid: libc::pid_t = line.trim().parse().expect("pid 是数字");

        let mut bound = false;
        for _ in 0..200 {
            if is_port_in_use(port) {
                bound = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !bound {
            unsafe { libc::kill(proxy_pid, libc::SIGKILL) };
            let _ = shell.wait();
            panic!("agent-proxy 没有在 10s 内绑定端口 {port}");
        }

        // 「应用」异常退出：只杀 sh，不碰它拉起的 node（模拟宿主编排层 kill -9）
        unsafe { libc::kill(shell.id() as libc::pid_t, libc::SIGKILL) };
        let _ = shell.wait();

        // 看门狗窗口内它应该还活着 —— 否则这条测的是「sh 退出顺手带走了 node」，
        // 而不是 ppid 看门狗。
        thread::sleep(Duration::from_millis(100));
        assert!(
            process_alive(proxy_pid),
            "前置条件：父进程死后、看门狗触发前，agent-proxy 应当还活着"
        );

        let mut still_alive = true;
        for _ in 0..120 {
            thread::sleep(Duration::from_millis(50));
            if !process_alive(proxy_pid) {
                still_alive = false;
                break;
            }
        }
        if still_alive {
            unsafe { libc::kill(proxy_pid, libc::SIGKILL) };
        }
        assert!(
            !still_alive,
            "父进程被 SIGKILL 后 agent-proxy 仍然活着 —— ppid 看门狗没有生效"
        );
    }

    /// P0-1：`agent-proxy` 不是终点，它自己会再拉起 claude / hermes / opencode。
    /// 只杀直接子进程，这些孙子会活下来继续跑、继续烧 token。
    ///
    /// 这条用真实的「父 → 孙」两层进程树来验：父是 `/bin/sh`，孙是 `sleep 300`。
    /// 退出前无论成败都会把 `sleep` 收掉，不给系统留垃圾。
    #[cfg(unix)]
    #[test]
    fn kill_takes_down_the_whole_process_group() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 300 & echo $!; wait")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped());
        put_in_own_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("起父进程");

        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("读孙进程 pid");
        let grandchild: libc::pid_t = line.trim().parse().expect("孙进程 pid 是个数字");
        assert!(
            process_alive(grandchild),
            "前置条件：孙进程应当是活着的，否则这条测不到东西"
        );

        kill(&mut child);

        // 轮询等 SIGKILL 落地。
        // ⚠️ 第一版这里写成 `.find(|a| !*a)` + `if alive.is_none() { return }`，
        // 结果**孙进程一直活着时正好走 early-return 成功路径** —— 一条结构上
        // 没法失败的断言，在 `kill()` 还没改的代码上也是绿的。
        // 判据自己先得能红。
        let mut still_alive = true;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(20));
            if !process_alive(grandchild) {
                still_alive = false;
                break;
            }
        }
        // 收尾：断言失败也别把 sleep 留在系统里
        unsafe { libc::kill(grandchild, libc::SIGKILL) };
        assert!(
            !still_alive,
            "孙进程 {grandchild} 在 kill() 之后仍然活着 —— kill 只作用到了直接子进程"
        );
    }

    /// 2026-10-05：这条钉住上面那个 `kill(-1, SIGKILL)` 的 bug。
    ///
    /// 前一条测试只断言「孙进程死了」，而**全场清场也能让孙进程死** ——
    /// 它区分不出「杀对了组」和「杀过了头」。而 `kill(-1, sig)` 的 POSIX 语义
    /// 恰恰是「调用者有权限的全部进程」，接在 `RunEvent::Exit` 上意味着
    /// 用户每次退出应用都会杀掉自己的编辑器、终端和浏览器。
    ///
    /// 所以这里放一个**组外的无关进程**（`sleep` 不开新进程组，留在测试进程
    /// 自己的组里），断言 `kill()` 之后它还活着。
    #[cfg(unix)]
    #[test]
    fn kill_leaves_processes_outside_the_group_alone() {
        // 组外旁观者：留在本进程组里，固定版的 kill(-pgid) 不该碰到它
        let mut bystander = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 300")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("起组外旁观进程");
        let bystander_pid = bystander.id() as libc::pid_t;

        // 组内：父 → 孙两层，模拟 agent-proxy 再拉起 CLI 的形状
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 300 & wait")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::null());
        put_in_own_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("起组内父进程");

        // 前置条件：动手之前旁观者必须是活的，否则「它后来还活着」说明不了任何事
        assert!(
            process_alive(bystander_pid),
            "前置条件：旁观进程 {bystander_pid} 应当在 kill() 之前就是活的"
        );

        kill(&mut child);

        // 给信号一点落地时间（SIGKILL 同步，但留出观察窗口更稳）
        std::thread::sleep(Duration::from_millis(100));

        // 收尾：无论断言成败都不给系统留垃圾
        let still_alive = process_alive(bystander_pid);
        unsafe { libc::kill(bystander_pid, libc::SIGKILL) };
        let _ = bystander.wait();

        // 只断言旁观者、不断言孙进程：孙进程属于被杀的组，**本来就该死**，
        // 那是上一条测试的职责，混进来只会让这条判据含义不清。
        assert!(
            still_alive,
            "组外进程 {bystander_pid} 被 kill() 连带杀掉了 —— \
             这正是 kill(-1, SIGKILL) 的语义（发给调用者的全部进程），\
             而正确行为只应作用于 -pgid 那一组"
        );
    }

    /// pid → 进程组信号目标的换算。`kill(-1)` 事故（杀调用者全部进程）
    /// 与 `kill(-pgid)`（杀这一组）只差一个负号，用纯函数 + 单测钉住。
    #[test]
    fn group_signal_target_maps_pid_to_negative_pgid() {
        assert_eq!(group_signal_target(4242), Some(-4242));
        assert_eq!(
            group_signal_target(0),
            None,
            "pid 0 的语义同样是「调用者所在组」，绝不能拿去发信号"
        );
        // 生产路径上 target 绝不允许是 -1：那正是历史事故的语义
        // （kill(-1) = 杀调用者名下的全部进程）。pid 1 除外 —— 它
        // 换算出 -1 是数学必然，但 spawn 出来的子进程永远不可能是
        // pid 1（1 号位永远是 init/launchd），所以到不了这条分支。
        for pid in [2u32, 999, 65_535, 2_147_483_647] {
            let target = group_signal_target(pid).expect("合法 pid 应有目标");
            assert_eq!(target, -(pid as i32));
            assert_ne!(target, -1, "target -1 会杀掉调用者名下的全部进程");
        }
        assert_eq!(group_signal_target(1), Some(-1));
    }

    /// `taskkill` 参数形状：/T 是树杀的关键，/F 只在强杀轮出现。
    #[test]
    fn taskkill_tree_args_shape() {
        assert_eq!(taskkill_tree_args(1234, false), vec!["/T", "/PID", "1234"]);
        assert_eq!(
            taskkill_tree_args(1234, true),
            vec!["/T", "/PID", "1234", "/F"]
        );
    }

    /// kill() 必须先 SIGTERM、后 SIGKILL。用 trap 写 marker 来证：
    /// 直接 SIGKILL 的话 trap 根本没机会跑，marker 永远不会出现。
    ///
    /// 子进程形状是 `sleep 300 & wait`：bash 3.2（macOS 的 /bin/sh）
    /// 在**前台** sleep 期间会推迟执行 trap，必须用 `& wait` 让 wait
    /// 可被信号打断，trap 才会跑。
    #[cfg(unix)]
    #[test]
    fn kill_sends_sigterm_before_sigkill() {
        let t = TempTree::new("sigterm-first");
        let marker = t.path.join("term-marker");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(format!(
                "trap 'echo term > \"{}\"' TERM; echo ready; sleep 300 & wait",
                marker.display()
            ))
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped());
        put_in_own_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("起带 trap 的进程");

        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("读 ready 行");
        assert_eq!(line.trim(), "ready", "前置条件：子进程应先打印 ready");

        kill(&mut child);

        let mut saw_marker = false;
        for _ in 0..250 {
            if marker.exists() {
                saw_marker = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            saw_marker,
            "kill() 应当先发 SIGTERM（trap 有机会写 marker），再发 SIGKILL"
        );
    }

    /// 配套：子进程必须真的自成一个组，否则上一条的 `killpg` 打不到该打的东西。
    #[cfg(unix)]
    #[test]
    fn child_becomes_its_own_process_group_leader() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 0.2")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        put_in_own_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn");
        let pid = child.id() as libc::pid_t;
        let pgid = unsafe { libc::getpgid(pid) };
        assert_eq!(pgid, pid, "pgid 应等于子进程自己的 pid");
        let _ = child.wait();
    }

    /// 进程是否**仍在运行**（而不是「进程表里还有这一条」）。
    ///
    /// ⚠️ 2026-10-05 修正：原实现只有 `kill(pid, 0)`，而它对 **zombie 也返回 0**。
    /// 判据在 `kill_leaves_processes_outside_the_group_alone` 上就是这么哑掉的：
    /// 那个 bystander 是测试进程的**直接子进程**，被 SIGKILL 后不会立刻消失，
    /// 而是变成僵尸等 `wait()` —— 于是「旁观者被杀」被读成「旁观者还活着」，
    /// 断言在真出 bug 的代码上照样是绿的。
    ///
    /// 所以先用 `WNOHANG` 试着收一遍：收到说明它已退出只是没被收走，判死。
    /// `ECHILD`（不是本进程的子进程，例如孙进程）则以 `kill` 的结果为准。
    #[cfg(unix)]
    fn process_alive(pid: libc::pid_t) -> bool {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false; // ESRCH：进程表里真的没有了
        }
        let mut status: libc::c_int = 0;
        let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if reaped > 0 {
            return false; // 收到了：先前是僵尸
        }
        // reaped == 0 → 还在跑；reaped < 0（ECHILD）→ 不是本进程子进程，
        // 上面 kill(pid,0) 已经说过它在
        true
    }

    /// End-to-end check: spawn → port bound → kill → port released.
    /// Skipped if the dist isn't built or `node` isn't on PATH.
    #[test]
    fn spawn_and_kill_lifecycle() {
        if resolve_node().is_none() {
            eprintln!("skipping: node not in PATH");
            return;
        }
        if resolve_entry().is_none() {
            eprintln!("skipping: agent-proxy/dist/index.js not built");
            return;
        }
        if is_port_in_use(DEFAULT_PORT) {
            eprintln!("skipping: port {} already in use", DEFAULT_PORT);
            return;
        }

        let mut child = spawn().expect("spawn");
        assert!(
            is_port_in_use(DEFAULT_PORT),
            "port should be bound after spawn"
        );

        kill(&mut child);
        // Give the OS a moment to release the port.
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !is_port_in_use(DEFAULT_PORT),
            "port should be released after kill"
        );
    }
}
