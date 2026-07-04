// Docker Engine API クライアント（unix socket 上の最小 HTTP/1.1 実装）
// Deno の fetch は unix socket を扱えないため自前でリクエストを組み立てる。

const SOCKET = Deno.env.get("DOCKER_SOCK") ?? "/var/run/docker.sock";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  cpu: number | null;
  memUsedMB: number | null;
  memLimitMB: number | null;
  ports: number[];
}

async function request(path: string): Promise<unknown> {
  const conn = await Deno.connect({ path: SOCKET, transport: "unix" });
  try {
    await conn.write(new TextEncoder().encode(
      `GET ${path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`,
    ));
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    const raw = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      raw.set(c, off);
      off += c.length;
    }
    const text = new TextDecoder().decode(raw);
    const sep = text.indexOf("\r\n\r\n");
    const head = text.slice(0, sep);
    let body = text.slice(sep + 4);
    if (/transfer-encoding:\s*chunked/i.test(head)) {
      // chunked ボディを結合する
      let out = "";
      let rest = body;
      while (rest.length > 0) {
        const nl = rest.indexOf("\r\n");
        if (nl < 0) break;
        const size = parseInt(rest.slice(0, nl), 16);
        if (!size) break;
        out += rest.slice(nl + 2, nl + 2 + size);
        rest = rest.slice(nl + 2 + size + 2);
      }
      body = out;
    }
    if (!/^HTTP\/1\.[01] 200/.test(head)) throw new Error(`docker api: ${head.split("\r\n")[0]}`);
    return JSON.parse(body);
  } finally {
    conn.close();
  }
}

// one-shot 統計の CPU% 算出用に前回サンプルを保持する（daemon 側の 1 秒サンプリングを避ける）
const prevCpuSample = new Map<string, { total: number; system: number }>();

export async function listContainers(): Promise<ContainerInfo[]> {
  // deno-lint-ignore no-explicit-any
  const list = await request("/v1.43/containers/json?all=1") as any[];
  const running = list.filter((c) => c.State === "running");
  const stats = new Map<string, { cpu: number | null; memUsedMB: number; memLimitMB: number }>();
  await Promise.all(running.map(async (c) => {
    try {
      // deno-lint-ignore no-explicit-any
      const s = await request(`/v1.43/containers/${c.Id}/stats?stream=false&one-shot=true`) as any;
      const total = s.cpu_stats.cpu_usage.total_usage;
      const system = s.cpu_stats.system_cpu_usage ?? 0;
      const cores = s.cpu_stats.online_cpus || 1;
      const prev = prevCpuSample.get(c.Id);
      prevCpuSample.set(c.Id, { total, system });
      const cpu = prev && system > prev.system
        ? ((total - prev.total) / (system - prev.system)) * cores * 100
        : null; // 初回は差分が取れないため非表示
      const memUsed = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.inactive_file ?? 0);
      stats.set(c.Id, {
        cpu,
        memUsedMB: memUsed / 1048576,
        memLimitMB: (s.memory_stats.limit ?? 0) / 1048576,
      });
    } catch {
      // 統計が取れないコンテナは null のまま表示する
    }
  }));
  // 消えたコンテナのサンプルを掃除
  const alive = new Set(running.map((c) => c.Id));
  for (const id of prevCpuSample.keys()) {
    if (!alive.has(id)) prevCpuSample.delete(id);
  }
  return list.map((c) => ({
    id: c.Id.slice(0, 12),
    name: (c.Names?.[0] ?? "").replace(/^\//, ""),
    image: c.Image,
    state: c.State,
    status: c.Status,
    cpu: stats.get(c.Id)?.cpu ?? null,
    memUsedMB: stats.get(c.Id)?.memUsedMB ?? null,
    memLimitMB: stats.get(c.Id)?.memLimitMB ?? null,
    // deno-lint-ignore no-explicit-any
    ports: [...new Set((c.Ports ?? []).filter((p: any) => p.PublicPort && p.Type === "tcp").map((p: any) => p.PublicPort as number))],
  }));
}
