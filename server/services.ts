// ホストで LISTEN 中の TCP ポートを検出し、Web サービス一覧を組み立てる
// (/proc/net/tcp{,6} を解析。pid: host + network_mode: host 前提でホストの値が見える)

import { ContainerInfo } from "./docker.ts";

export interface ServiceInfo {
  port: number;
  name: string;
  source: "docker" | "host";
}

const EXCLUDED_PORTS = new Set([22, 53]); // SSH と DNS は Web サービスではないため除外
const LISTEN = "0A";
const LOCALHOST_V4 = "0100007F";
const LOCALHOST_V6 = "0000000000000000FFFF00000100007F";

function parseProcNetTcp(text: string, v6: boolean): Map<number, number> {
  // port → socket inode
  const out = new Map<number, number>();
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== LISTEN) continue;
    const [addr, portHex] = f[1].split(":");
    // 127.0.0.1 / ::1 のみで LISTEN しているものは外部から到達できないので除外
    if (addr === LOCALHOST_V4 || addr === LOCALHOST_V6) continue;
    if (v6 && addr === "00000000000000000000000001000000") continue;
    const port = parseInt(portHex, 16);
    if (!out.has(port)) out.set(port, Number(f[9]));
  }
  return out;
}

// socket inode → プロセス名。全 /proc/[pid]/fd を走査するため、必要な inode だけ解決する
async function resolveNames(inodes: Set<number>): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  outer: for await (const e of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      for await (const fd of Deno.readDir(`/proc/${e.name}/fd`)) {
        const link = await Deno.readLink(`/proc/${e.name}/fd/${fd.name}`).catch(() => "");
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (!m) continue;
        const inode = Number(m[1]);
        if (!inodes.has(inode) || names.has(inode)) continue;
        names.set(inode, (await Deno.readTextFile(`/proc/${e.name}/comm`)).trim());
        if (names.size === inodes.size) break outer;
      }
    } catch {
      // 権限がない・消えたプロセスは無視
    }
  }
  return names;
}

const SELF_PORT = Number(Deno.env.get("PORT") ?? 8480);

export async function listServices(containers: ContainerInfo[]): Promise<ServiceInfo[]> {
  const ports = new Map<number, number>(); // port → inode
  for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
    try {
      for (const [port, inode] of parseProcNetTcp(await Deno.readTextFile(file), v6)) {
        if (!ports.has(port)) ports.set(port, inode);
      }
    } catch {
      // tcp6 が無い環境などは無視
    }
  }
  for (const p of EXCLUDED_PORTS) ports.delete(p);

  // Docker の公開ポート → コンテナ名
  const byDockerPort = new Map<number, string>();
  for (const c of containers) {
    if (c.state !== "running") continue;
    for (const p of c.ports) byDockerPort.set(p, c.name);
  }

  const unresolved = new Set(
    [...ports].filter(([port]) => !byDockerPort.has(port)).map(([, inode]) => inode),
  );
  const procNames = unresolved.size > 0 ? await resolveNames(unresolved) : new Map<number, string>();

  return [...ports]
    .map(([port, inode]): ServiceInfo => {
      if (port === SELF_PORT) return { port, name: "pulsedeck", source: "host" };
      const docker = byDockerPort.get(port);
      return docker
        ? { port, name: docker, source: "docker" }
        : { port, name: procNames.get(inode) ?? "unknown", source: "host" };
    })
    .sort((a, b) => a.port - b.port);
}
