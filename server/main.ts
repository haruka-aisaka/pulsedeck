// PulseDeck: サーバー状況ダッシュボード
// 2 秒ごとにメトリクスを収集し、SSE でブラウザへ配信する。

import { Collector, Snapshot } from "./collectors.ts";
import { ContainerInfo, listContainers } from "./docker.ts";
import { listServices, ServiceInfo } from "./services.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8480);
const TICK_MS = 2000;
const PROC_EVERY_TICKS = 3; // プロセス走査は 6 秒ごと（全 /proc 走査は高コスト）
const DOCKER_INTERVAL_MS = 10_000;
const SERVICES_INTERVAL_MS = 60_000;
const HISTORY_MAX = 300; // 各レンジ 300 点固定（メモリ一定）

interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  temp: number | null;
  rx: number;
  tx: number;
}

// 表示レンジ。every は 2 秒 tick 何回分を 1 点に集約するか
const RANGES = [
  { key: "m10", every: 1 }, // 2 秒 × 300 = 10 分
  { key: "h3", every: 18 }, // 36 秒平均 × 300 = 3 時間
  { key: "h24", every: 144 }, // 4.8 分平均 × 300 = 24 時間
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const collector = new Collector();
const histories: Record<RangeKey, HistoryPoint[]> = { m10: [], h3: [], h24: [] };

interface Acc {
  n: number;
  cpu: number;
  mem: number;
  temp: number;
  tempN: number;
  rx: number;
  tx: number;
}
const emptyAcc = (): Acc => ({ n: 0, cpu: 0, mem: 0, temp: 0, tempN: 0, rx: 0, tx: 0 });
const accs: Record<RangeKey, Acc> = { m10: emptyAcc(), h3: emptyAcc(), h24: emptyAcc() };

// 各レンジへ 1 tick 分を反映し、集約点が確定したレンジには longpoint を配信する
function pushHistory(p: HistoryPoint) {
  for (const { key, every } of RANGES) {
    let point = p;
    if (every > 1) {
      const a = accs[key];
      a.n++;
      a.cpu += p.cpu;
      a.mem += p.mem;
      a.rx += p.rx;
      a.tx += p.tx;
      if (p.temp != null) {
        a.temp += p.temp;
        a.tempN++;
      }
      if (a.n < every) continue;
      point = {
        t: p.t,
        cpu: a.cpu / a.n,
        mem: a.mem / a.n,
        temp: a.tempN > 0 ? a.temp / a.tempN : null,
        rx: a.rx / a.n,
        tx: a.tx / a.n,
      };
      accs[key] = emptyAcc();
      broadcast("longpoint", { range: key, point });
    }
    const h = histories[key];
    h.push(point);
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
  }
}
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
let latest: Snapshot | null = null;
let containers: ContainerInfo[] = [];
let dockerAvailable = true;
let services: ServiceInfo[] = [];

function broadcast(event: string, data: unknown) {
  const payload = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(payload);
    } catch {
      clients.delete(c);
    }
  }
}

let tickCount = 0;
let lastProcs: Snapshot["procs"] = [];

async function tick() {
  try {
    // 閲覧者がいない間はプロセス走査を止め、基本メトリクスのみ履歴用に収集する
    const wantProcs = clients.size > 0 && tickCount++ % PROC_EVERY_TICKS === 0;
    latest = await collector.snapshot(wantProcs);
    if (wantProcs) lastProcs = latest.procs;
    else latest.procs = lastProcs;
    pushHistory({
      t: latest.t,
      cpu: latest.cpu.usage,
      mem: latest.mem.usage,
      temp: latest.cpu.tempC,
      rx: latest.net.rxKBs,
      tx: latest.net.txKBs,
    });
    if (clients.size > 0) broadcast("snapshot", { ...latest, containers, dockerAvailable, services });
  } catch (e) {
    console.error("collect error:", e);
  }
}

async function dockerTick() {
  if (clients.size === 0) return; // 閲覧者がいない間は dockerd に負荷をかけない
  try {
    containers = await listContainers();
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
    containers = [];
  }
}

async function servicesTick() {
  if (clients.size === 0) return;
  try {
    services = await listServices(containers);
  } catch (e) {
    console.error("services error:", e);
  }
}

await tick(); // 1 回目は差分の基準づくり
setInterval(tick, TICK_MS);
setInterval(dockerTick, DOCKER_INTERVAL_MS);
setInterval(servicesTick, SERVICES_INTERVAL_MS);

const webRoot = new URL("../web/", import.meta.url);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/manifest+json",
};

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/stream") {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        clients.add(c);
        // 接続直後にコンテナ・サービス情報を最新化（アイドル中は停止しているため）
        dockerTick().then(servicesTick);
        const enc = new TextEncoder();
        c.enqueue(enc.encode(`event: history\ndata: ${JSON.stringify(histories)}\n\n`));
        if (latest) {
          c.enqueue(enc.encode(
            `event: snapshot\ndata: ${
              JSON.stringify({ ...latest, containers, dockerAvailable, services })
            }\n\n`,
          ));
        }
      },
      cancel() {
        clients.delete(ctrl);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  if (url.pathname === "/api/snapshot") {
    return Response.json({ ...latest, containers, dockerAvailable, services, histories });
  }

  // 静的ファイル配信
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const file = await Deno.readFile(new URL("." + path, webRoot));
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});

console.log(`PulseDeck listening on http://0.0.0.0:${PORT}`);
