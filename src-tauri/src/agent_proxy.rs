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

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;

pub struct AgentProxyHandle(pub Mutex<Option<Child>>);

/// Default listen port — keep in sync with `agent-proxy/src/config.ts`.
const DEFAULT_PORT: u16 = 9099;

pub fn spawn() -> Result<Child, String> {
    if is_port_in_use(DEFAULT_PORT) {
        return Err(format!(
            "port {} is already in use; another agent-proxy may be running",
            DEFAULT_PORT
        ));
    }

    let node = resolve_node().ok_or_else(|| "node executable not found in PATH".to_string())?;
    let entry = resolve_entry()
        .ok_or_else(|| "agent-proxy dist not built; run `npm run build` in agent-proxy/ first".to_string())?;

    eprintln!("[agent-proxy] launching: {} {}", node.display(), entry.display());

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
        .map_err(|e| format!("failed to spawn agent-proxy: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || pipe_to_stderr("agent-proxy/stdout", stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || pipe_to_stderr("agent-proxy/stderr", stderr));
    }

    // Give it a moment to bind, then double-check the port.
    std::thread::sleep(std::time::Duration::from_millis(400));
    if !is_port_in_use(DEFAULT_PORT) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "agent-proxy exited before binding port {} (see logs above)",
            DEFAULT_PORT
        ));
    }
    eprintln!("[agent-proxy] ready on http://127.0.0.1:{}", DEFAULT_PORT);
    Ok(child)
}

/// Kill and reap a child process. Safe to call multiple times.
///
/// **杀的是整个进程组，不只是直接子进程。** agent-proxy 自己会再拉起
/// claude / hermes / opencode 三个 CLI；只对直接子进程发 SIGKILL，
/// 这些孙子会被 init 收养后继续跑、继续烧 token。原先的实现正是这样，
/// 于是「关掉应用」并不等于「LLM 进程都停了」。
///
/// 依赖 `put_in_own_process_group` 已经把子进程放进了自己的组；
/// 因为 pgid == 子进程 pid，所以这里发信号绝不会误伤本进程。
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
/// 活着」的反向断言。
pub fn kill(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        if pid > 0 {
            // 负 pid = 「发给进程组 -pid 的全体成员」。因为 `put_in_own_process_group`
            // 让 pgid == 子进程 pid，这里打到的正是我们拉起的那棵树。
            // SAFETY: 只发信号，不共享内存；pid > 0 保证不会退化成 -1（那个语义是
            // 「全部进程」）。子进程若已退出，这里拿到 ESRCH，无副作用。
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    }
    let _ = child.kill();
    // Wait so the OS reaps the process; otherwise we may leak a zombie
    // briefly. We swallow errors because the child may have exited already.
    let _ = child.wait();
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
    // Windows 上没有进程组这套说法；Taskkill 树形终止由打包/退出逻辑另行处理。
}

fn pipe_to_stderr(prefix: &str, stream: impl Read + Send + 'static) {
    let reader = BufReader::new(stream);
    for line in reader.lines().map_while(Result::ok) {
        eprintln!("[{}] {}", prefix, line);
    }
}

fn is_port_in_use(port: u16) -> bool {
    use std::net::TcpStream;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200)).is_ok()
}

fn resolve_node() -> Option<PathBuf> {
    // 1. `which node` — works if PATH includes the user's node install
    //    (e.g. homebrew in /opt/homebrew/bin which is in default macOS PATH).
    if let Ok(out) = Command::new("which").arg("node").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
    }

    // 2. Scan common install locations. macOS .app processes inherit a
    //    minimal PATH that usually excludes nvm-managed bins, so we
    //    look in the obvious spots directly.
    let home = std::env::var("HOME").unwrap_or_default();
    // 只有 `bin/node` 这种**文件**才算命中，所以这里列的都是可执行文件路径。
    // （原先数组里有一项 `~/.nvm/versions/node` —— 那是目录，`is_file()` 恒为 false，
    //  永远选不中；另有两个空 PathBuf 靠 `is_empty()` 跳过。已清掉，行为不变。）
    let candidates: [PathBuf; 5] = [
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
        PathBuf::from("/bin/node"),
        PathBuf::from(home.clone() + "/.local/bin/node"),
    ];
    for c in candidates.iter() {
        if c.as_os_str().is_empty() {
            continue;
        }
        if c.is_file() {
            return Some(c.clone());
        }
    }

    // 3. nvm version dir — pick the highest version
    pick_highest_nvm_node(&PathBuf::from(home + "/.nvm/versions/node"))

        .or_else(|| Some(PathBuf::from("node")))
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
        let minor = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let patch = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        Some(VersionKey { major, minor, patch })
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
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
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
            p.push(format!("zbb-worker-test-{}-{}-{}", tag, std::process::id(), n));
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
        assert_eq!(pick_highest_nvm_node(&t.path).as_deref(), Some(want.as_path()));
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
        assert_eq!(pick_highest_nvm_node(&t.path).as_deref(), Some(want.as_path()));
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
        assert!(p.is_some(), "末位兜底保证 Some；这不是 bug，但调用方别指望它是 None");
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

    /// 配套：子进程必须真的自成一个组，否则上一条的 `killpg` 打不到该打的东西。
    #[cfg(unix)]
    #[test]
    fn child_becomes_its_own_process_group_leader() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("sleep 0.2").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
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
        assert!(is_port_in_use(DEFAULT_PORT), "port should be bound after spawn");

        kill(&mut child);
        // Give the OS a moment to release the port.
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !is_port_in_use(DEFAULT_PORT),
            "port should be released after kill"
        );
    }
}
