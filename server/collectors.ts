// ホストメトリクス収集（/proc, /sys 直読み。pid: host 前提でコンテナ内からもホスト値が取れる）

const HOST_ROOT = Deno.env.get("HOST_ROOT") ?? "/";

export interface CpuSample {
  total: number;
  idle: number;
}

export interface Snapshot {
  t: number;
  hostname: string;
  os: string;
  uptimeSec: number;
  load: [number, number, number];
  cpu: { usage: number; perCore: number[]; tempC: number | null; cores: number };
  mem: { totalKB: number; availKB: number; usedKB: number; usage: number };
  swap: { totalKB: number; usedKB: number };
  disk: { totalKB: number; usedKB: number; usage: number; mount: string };
  net: { rxKBs: number; txKBs: number; rxTotal: number; txTotal: number };
  procs: ProcInfo[];
}

export interface ProcInfo {
  pid: number;
  name: string;
  cpu: number;
  rssKB: number;
}

async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

function parseCpuLine(fields: string[]): CpuSample {
  const nums = fields.slice(1).map(Number);
  const idle = nums[3] + (nums[4] ?? 0); // idle + iowait
  const total = nums.reduce((a, b) => a + b, 0);
  return { total, idle };
}

const DISK_CACHE_MS = 30_000; // df は fork を伴うため 30 秒キャッシュ

export class Collector {
  #prevCpu: CpuSample[] = [];
  #prevNet: { rx: number; tx: number; t: number } | null = null;
  #prevProcCpu = new Map<number, number>();
  #prevProcT = 0;
  #diskCache: { disk: Snapshot["disk"]; t: number } | null = null;

  async snapshot(includeProcs = true): Promise<Snapshot> {
    const now = Date.now();
    const [stat, meminfo, loadavg, uptime, netdev] = await Promise.all([
      readText("/proc/stat"),
      readText("/proc/meminfo"),
      readText("/proc/loadavg"),
      readText("/proc/uptime"),
      readText("/proc/net/dev"),
    ]);

    // --- CPU ---
    const cpuLines = stat.split("\n").filter((l) => /^cpu\d* /.test(l));
    const samples = cpuLines.map((l) => parseCpuLine(l.trim().split(/\s+/)));
    const usages = samples.map((s, i) => {
      const prev = this.#prevCpu[i];
      if (!prev) return 0;
      const dt = s.total - prev.total;
      const di = s.idle - prev.idle;
      return dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
    });
    this.#prevCpu = samples;

    // --- メモリ ---
    const mem = new Map<string, number>();
    for (const line of meminfo.split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) mem.set(m[1], Number(m[2]));
    }
    const memTotal = mem.get("MemTotal") ?? 0;
    const memAvail = mem.get("MemAvailable") ?? 0;
    const swapTotal = mem.get("SwapTotal") ?? 0;
    const swapFree = mem.get("SwapFree") ?? 0;

    // --- 温度 ---
    let tempC: number | null = null;
    try {
      tempC = Number(await readText("/sys/class/thermal/thermal_zone0/temp")) / 1000;
    } catch {
      // 温度センサーがない環境では非表示にする
    }

    // --- ディスク（ホストルートを df で取得。fork コスト削減のためキャッシュ） ---
    let disk = this.#diskCache?.disk ?? { totalKB: 0, usedKB: 0, usage: 0, mount: HOST_ROOT };
    if (!this.#diskCache || now - this.#diskCache.t > DISK_CACHE_MS) {
      try {
        const out = await new Deno.Command("df", { args: ["-kP", HOST_ROOT] }).output();
        const row = new TextDecoder().decode(out.stdout).trim().split("\n").at(-1)!.split(/\s+/);
        const totalKB = Number(row[1]);
        const usedKB = Number(row[2]);
        disk = { totalKB, usedKB, usage: totalKB > 0 ? (usedKB / totalKB) * 100 : 0, mount: HOST_ROOT };
      } catch {
        // df がない環境では 0 のまま
      }
      this.#diskCache = { disk, t: now };
    }

    // --- ネットワーク（lo 以外の合算） ---
    let rx = 0, tx = 0;
    for (const line of netdev.split("\n").slice(2)) {
      const m = line.trim().match(/^([^:]+):\s*(.+)$/);
      if (!m || m[1] === "lo") continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    let rxKBs = 0, txKBs = 0;
    if (this.#prevNet) {
      const dt = (now - this.#prevNet.t) / 1000;
      if (dt > 0) {
        rxKBs = Math.max(0, (rx - this.#prevNet.rx) / 1024 / dt);
        txKBs = Math.max(0, (tx - this.#prevNet.tx) / 1024 / dt);
      }
    }
    this.#prevNet = { rx, tx, t: now };

    const procs = includeProcs ? await this.topProcs(now) : [];

    return {
      t: now,
      hostname: (await readText("/proc/sys/kernel/hostname")).trim(),
      os: (await readText("/proc/version")).split(" ").slice(0, 3).join(" "),
      uptimeSec: Number(uptime.split(" ")[0]),
      load: loadavg.split(" ").slice(0, 3).map(Number) as [number, number, number],
      cpu: { usage: usages[0] ?? 0, perCore: usages.slice(1), tempC, cores: usages.length - 1 },
      mem: {
        totalKB: memTotal,
        availKB: memAvail,
        usedKB: memTotal - memAvail,
        usage: memTotal > 0 ? ((memTotal - memAvail) / memTotal) * 100 : 0,
      },
      swap: { totalKB: swapTotal, usedKB: swapTotal - swapFree },
      disk,
      net: { rxKBs, txKBs, rxTotal: rx, txTotal: tx },
      procs,
    };
  }

  // CPU 使用率 Top 10 プロセス（前回サンプルとの差分から算出）
  async topProcs(now: number): Promise<ProcInfo[]> {
    const pageKB = 4; // Linux の標準ページサイズ 4KiB
    const results: { pid: number; name: string; ticks: number; rssKB: number }[] = [];
    for await (const e of Deno.readDir("/proc")) {
      if (!/^\d+$/.test(e.name)) continue;
      const pid = Number(e.name);
      try {
        const stat = await readText(`/proc/${pid}/stat`);
        const m = stat.match(/^\d+ \((.*)\) \S (.*)$/s);
        if (!m) continue;
        const f = m[2].split(" ");
        const ticks = Number(f[10]) + Number(f[11]); // utime + stime
        const rssKB = Number(f[20]) * pageKB;
        results.push({ pid, name: m[1], ticks, rssKB });
      } catch {
        // 走査中に消えたプロセスは無視
      }
    }
    const dt = (now - this.#prevProcT) / 1000;
    const hz = 100; // USER_HZ
    const procs: ProcInfo[] = results.map((r) => {
      const prev = this.#prevProcCpu.get(r.pid);
      const cpu = prev !== undefined && dt > 0 ? Math.max(0, ((r.ticks - prev) / hz / dt) * 100) : 0;
      return { pid: r.pid, name: r.name, cpu, rssKB: r.rssKB };
    });
    this.#prevProcCpu = new Map(results.map((r) => [r.pid, r.ticks]));
    this.#prevProcT = now;
    return procs.sort((a, b) => b.cpu - a.cpu || b.rssKB - a.rssKB).slice(0, 10);
  }
}
