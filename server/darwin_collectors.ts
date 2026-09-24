// macOS ネイティブ実行時のホストメトリクス収集。
// Docker Desktop VM を経由せず、macOS 自身の公開コマンドだけを使用する。

import type { ProcInfo, ProcSet, Snapshot } from "./collectors.ts";

const DISK_CACHE_MS = 30_000;

function diskPath(): string {
  return Deno.env.get("MACOS_DISK_PATH") ?? "/System/Volumes/Data";
}

interface StaticInfo {
  hostname: string;
  os: string;
  totalKB: number;
  cores: number;
  bootSec: number;
}

async function run(command: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(command, { args }).output();
  if (!out.success) {
    throw new Error(`${command} exited ${out.code}: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

export function parsePercent(text: string): number {
  const m = text.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
  if (!m) throw new Error("memory_pressure free percentage was not found");
  return Math.max(0, Math.min(100, Number(m[1])));
}

export function parseCpuUsage(text: string): number {
  const m = text.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys/i);
  if (!m) throw new Error("top CPU usage was not found");
  return Math.max(0, Math.min(100, Number(m[1]) + Number(m[2])));
}

function parseLoad(text: string): [number, number, number] {
  const values = text.match(/[\d.]+/g)?.map(Number) ?? [];
  if (values.length < 3) throw new Error("vm.loadavg was not found");
  return [values[0], values[1], values[2]];
}

function parseBootSec(text: string): number {
  const m = text.match(/sec\s*=\s*(\d+)/);
  if (!m) throw new Error("kern.boottime was not found");
  return Number(m[1]);
}

function parseDf(text: string, mount: string): Snapshot["disk"] {
  const row = text.split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const totalKB = Number(row[1]);
  const usedKB = Number(row[2]);
  if (!Number.isFinite(totalKB) || !Number.isFinite(usedKB) || totalKB <= 0) {
    throw new Error(`unexpected df output: ${text}`);
  }
  return { totalKB, usedKB, usage: (usedKB / totalKB) * 100, mount };
}

function parseSizeKB(value: string): number {
  const m = value.match(/([\d.]+)\s*([KMGT])(?:B)?/i);
  if (!m) return 0;
  const unit = m[2].toUpperCase();
  const scale: Record<string, number> = { K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 };
  return Number(m[1]) * scale[unit];
}

function parseSwap(text: string): { totalKB: number; usedKB: number } {
  const total = text.match(/total\s*=\s*([^\s]+)/i)?.[1] ?? "0K";
  const used = text.match(/used\s*=\s*([^\s]+)/i)?.[1] ?? "0K";
  return { totalKB: parseSizeKB(total), usedKB: parseSizeKB(used) };
}

function parseNetwork(text: string): { rx: number; tx: number } {
  // netstat -ib はアドレス種別ごとに同じインターフェースを複数行出す。
  // 各インターフェースの最大カウンターだけを採用して二重計上を防ぐ。
  const byInterface = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const name = fields[0].replace(/\*$/, "");
    if (!name || name.startsWith("lo")) continue;
    const rx = Number(fields[6]);
    const tx = Number(fields[9]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    const prev = byInterface.get(name);
    byInterface.set(name, { rx: Math.max(prev?.rx ?? 0, rx), tx: Math.max(prev?.tx ?? 0, tx) });
  }
  let rx = 0, tx = 0;
  for (const value of byInterface.values()) {
    rx += value.rx;
    tx += value.tx;
  }
  return { rx, tx };
}

function parseProcs(text: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s*$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), name: m[2], cpu: Number(m[3]), rssKB: Number(m[4]) });
  }
  return procs;
}

export class DarwinCollector {
  #static: Promise<StaticInfo> | null = null;
  #prevNet: { rx: number; tx: number; t: number } | null = null;
  #diskCache: { disk: Snapshot["disk"]; t: number } | null = null;

  async #getStatic(): Promise<StaticInfo> {
    if (!this.#static) {
      this.#static = Promise.all([
        run("/bin/hostname", []),
        run("/usr/bin/sw_vers", ["-productVersion"]),
        run("/usr/sbin/sysctl", ["-n", "hw.memsize"]),
        run("/usr/sbin/sysctl", ["-n", "hw.ncpu"]),
        run("/usr/sbin/sysctl", ["-n", "kern.boottime"]),
      ]).then(([hostname, version, memBytes, cores, boot]) => ({
        hostname,
        os: `macOS ${version}`,
        totalKB: Number(memBytes) / 1024,
        cores: Number(cores),
        bootSec: parseBootSec(boot),
      }));
    }
    return await this.#static;
  }

  async snapshot(includeProcs = true): Promise<Snapshot> {
    const now = Date.now();
    const staticInfo = await this.#getStatic();
    const [top, memoryPressure, loadText, swapText, netText] = await Promise.all([
      run("/usr/bin/top", ["-l", "1", "-n", "0"]),
      run("/usr/bin/memory_pressure", ["-Q"]),
      run("/usr/sbin/sysctl", ["-n", "vm.loadavg"]),
      run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
      run("/usr/sbin/netstat", ["-ib"]),
    ]);

    const mount = diskPath();
    let disk = this.#diskCache?.disk ?? { totalKB: 0, usedKB: 0, usage: 0, mount };
    if (!this.#diskCache || now - this.#diskCache.t > DISK_CACHE_MS) {
      disk = parseDf(await run("/bin/df", ["-kP", mount]), mount);
      this.#diskCache = { disk, t: now };
    }

    const freePct = parsePercent(memoryPressure);
    const net = parseNetwork(netText);
    let rxKBs = 0, txKBs = 0;
    if (this.#prevNet) {
      const dt = (now - this.#prevNet.t) / 1000;
      if (dt > 0) {
        rxKBs = Math.max(0, (net.rx - this.#prevNet.rx) / 1024 / dt);
        txKBs = Math.max(0, (net.tx - this.#prevNet.tx) / 1024 / dt);
      }
    }
    this.#prevNet = { ...net, t: now };

    const procs = includeProcs ? await this.topProcs() : { byCpu: [], byMem: [] };
    const availKB = (staticInfo.totalKB * freePct) / 100;
    return {
      t: now,
      hostname: staticInfo.hostname,
      os: staticInfo.os,
      uptimeSec: Math.max(0, Math.floor(now / 1000) - staticInfo.bootSec),
      load: parseLoad(loadText),
      cpu: { usage: parseCpuUsage(top), perCore: [], tempC: null, cores: staticInfo.cores },
      mem: {
        totalKB: staticInfo.totalKB,
        availKB,
        usedKB: staticInfo.totalKB - availKB,
        usage: 100 - freePct,
      },
      swap: parseSwap(swapText),
      disk,
      net: { rxKBs, txKBs, rxTotal: net.rx, txTotal: net.tx },
      procs,
    };
  }

  async topProcs(): Promise<ProcSet> {
    const procs = parseProcs(await run("/bin/ps", ["-axo", "pid=,comm=,%cpu=,rss="]));
    const byCpu = [...procs].sort((a, b) => b.cpu - a.cpu || b.rssKB - a.rssKB).slice(0, 10);
    const byMem = [...procs].sort((a, b) => b.rssKB - a.rssKB || b.cpu - a.cpu).slice(0, 10);
    return { byCpu, byMem };
  }
}
