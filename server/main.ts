// PulseDeck: サーバー状況ダッシュボード
// 2 秒ごとにメトリクスを収集し、SSE でブラウザへ配信する。

import { Collector, Snapshot } from "./collectors.ts";
import { ContainerInfo, listContainers } from "./docker.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8480);
const TICK_MS = 2000;
const DOCKER_INTERVAL_MS = 10_000;
const HISTORY_MAX = 5400; // 2 秒間隔 × 5400 = 3 時間

interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  temp: number | null;
  rx: number;
  tx: number;
}

const collector = new Collector();
const history: HistoryPoint[] = [];
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
let latest: Snapshot | null = null;
let containers: ContainerInfo[] = [];
let dockerAvailable = true;

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

async function tick() {
  try {
    latest = await collector.snapshot();
    history.push({
      t: latest.t,
      cpu: latest.cpu.usage,
      mem: latest.mem.usage,
      temp: latest.cpu.tempC,
      rx: latest.net.rxKBs,
      tx: latest.net.txKBs,
    });
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    broadcast("snapshot", { ...latest, containers, dockerAvailable });
  } catch (e) {
    console.error("collect error:", e);
  }
}

async function dockerTick() {
  try {
    containers = await listContainers();
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
    containers = [];
  }
}

await dockerTick();
await tick(); // 1 回目は差分の基準づくり
setInterval(tick, TICK_MS);
setInterval(dockerTick, DOCKER_INTERVAL_MS);

const webRoot = new URL("../web/", import.meta.url);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/stream") {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        clients.add(c);
        const enc = new TextEncoder();
        c.enqueue(enc.encode(`event: history\ndata: ${JSON.stringify(history)}\n\n`));
        if (latest) {
          c.enqueue(enc.encode(
            `event: snapshot\ndata: ${JSON.stringify({ ...latest, containers, dockerAvailable })}\n\n`,
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
    return Response.json({ ...latest, containers, dockerAvailable, history });
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
