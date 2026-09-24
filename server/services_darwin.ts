// macOS ネイティブ実行時の LISTEN TCP サービス一覧。

import type { ContainerInfo } from "./docker.ts";
import type { ServiceInfo } from "./services.ts";

const EXCLUDED_PORTS = new Set([22, 53]);
const SELF_PORT = Number(Deno.env.get("PORT") ?? 8480);

async function lsof(): Promise<string> {
  const out = await new Deno.Command("/usr/sbin/lsof", {
    args: ["-nP", "-iTCP", "-sTCP:LISTEN"],
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim() || "lsof failed");
  return new TextDecoder().decode(out.stdout);
}

export async function listDarwinServices(containers: ContainerInfo[]): Promise<ServiceInfo[]> {
  const byDockerPort = new Map<number, string>();
  for (const c of containers) {
    if (c.state !== "running") continue;
    for (const port of c.ports) byDockerPort.set(port, c.name);
  }

  const services = new Map<number, ServiceInfo>();
  for (const line of (await lsof()).split("\n").slice(1)) {
    const endpoint = line.match(/\bTCP\s+(.+):(\d+)\s+\(LISTEN\)$/);
    if (!endpoint) continue;
    const address = endpoint[1];
    const port = Number(endpoint[2]);
    if (!Number.isFinite(port) || EXCLUDED_PORTS.has(port)) continue;
    // PulseDeck 自身は loopback 限定でも、Tailscale Serve の転送先として表示する。
    if (port === SELF_PORT) {
      services.set(port, { port, name: "pulsedeck", source: "host" });
      continue;
    }
    const dockerName = byDockerPort.get(port);
    // 通常の localhost 専用プロセスは外部リンクにできないため除外する。
    // ただし Docker の公開ポートは Tailscale Serve 等の転送先になり得るため表示する。
    if (/^(?:127\.0\.0\.1|\[?::1\]?)$/i.test(address) && !dockerName) continue;
    const command = line.trim().split(/\s+/)[0] || "unknown";
    if (!services.has(port)) {
      services.set(
        port,
        dockerName ? { port, name: dockerName, source: "docker" } : { port, name: command, source: "host" },
      );
    }
  }
  return [...services.values()].sort((a, b) => a.port - b.port);
}
