// PulseDeck フロントエンド — SSE 受信と描画（依存ライブラリなし）
"use strict";

const $ = (s) => document.querySelector(s);
const MAX_POINTS = 300; // サーバー保持の点数
// レンジ別履歴（サーバー側でダウンサンプリング済み）
let histories = { m10: [], h3: [], h24: [] };
let range = "m10"; // 既定は短期
// 表示レンジ → 参照する履歴と点数。m1 は m10 の末尾 30 点を切り出すだけ（追加転送なし）
const RANGE_VIEWS = {
  m1: { src: "m10", points: 30 },
  m10: { src: "m10", points: 300 },
  h3: { src: "h3", points: 300 },
  h24: { src: "h24", points: 300 },
};

// ---------- ユーティリティ ----------
const fmtKB = (kb) => {
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + " GB";
  if (kb >= 1024) return (kb / 1024).toFixed(1) + " MB";
  return Math.round(kb) + " KB";
};
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const levelColor = (pct) => pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warn)" : "var(--accent)";

// ---------- ゲージ ----------
function setGauge(id, pct, text, sub, colorPct = pct) {
  const el = $(id);
  const ring = el.querySelector(".ring");
  ring.style.setProperty("--p", Math.max(0, Math.min(100, pct)).toFixed(1));
  ring.style.setProperty("--c", levelColor(colorPct));
  el.querySelector(".val").textContent = text;
  el.querySelector(".gsub").textContent = sub;
}

// ---------- チャート（Canvas 自作） ----------
const fmtAxis = (v) =>
  v === 0
    ? "0"
    : v >= 1000
    ? (v / 1000).toFixed(1) + "k"
    : v >= 10
    ? Math.round(v)
    : v >= 1
    ? v.toFixed(1)
    : v.toFixed(2);
const fmtTime = (t, withSec = false) => {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withSec ? `${hm}:${String(d.getSeconds()).padStart(2, "0")}` : hm;
};

// 1 / 2 / 2.5 / 5 × 10^n 系列から、約 4 分割になるキリのいい刻みを選ぶ
function niceStep(range) {
  const raw = range / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const b of [1, 2, 2.5, 5]) {
    if (b * pow >= raw) return b * pow;
  }
  return 10 * pow;
}

// X 軸の時刻刻み候補（秒）。ウィンドウ幅 / 4 以上の最小のものを選ぶ
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];

function drawChart(
  canvas,
  series,
  { min = 0, max = 100, colors = ["#58f6c4"], fill = true, times = [], points = MAX_POINTS } = {},
) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const ph = h - 14; // 下 14px は時刻ラベル領域

  // 動的レンジ（max が指定なしのとき）
  const lo = min;
  let hi = max;
  if (max === null) {
    hi = Math.max(1, ...series.flat().filter((v) => v != null)) * 1.15;
  }

  const style = getComputedStyle(document.documentElement);
  const cssVar = (n) => style.getPropertyValue(n).trim();
  const toY = (v) => ph - ((v - lo) / (hi - lo)) * (ph - 6) - 3;

  // Y 軸: キリのいい値の位置に罫線とラベルを引く
  ctx.lineWidth = 1;
  ctx.font = "10px " + cssVar("--mono");
  const yStep = niceStep(hi - lo);
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi + 1e-9; v += yStep) {
    const y = toY(v);
    if (v > lo && y > 6) {
      ctx.strokeStyle = cssVar("--grid-line");
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    if (y >= 12 && y <= ph) {
      ctx.fillStyle = cssVar("--axis-label");
      ctx.textAlign = "right";
      ctx.fillText(fmtAxis(v), w - 4, y - 3);
    }
  }

  // x 軸は表示レンジ分の固定ウィンドウ
  const span = points - 1;

  // X 軸: 切りのいい時刻境界（ローカルタイム整列）にラベルを置く
  if (times.length >= 2) {
    const stepMs = (times[times.length - 1] - times[0]) / (times.length - 1);
    const windowMs = stepMs * span;
    const tickMs = (TIME_STEPS.find((s) => s * 1000 >= windowMs / 4) ?? 21600) * 1000;
    const withSec = tickMs < 60_000;
    const tEnd = times[times.length - 1];
    const tStart = tEnd - windowMs;
    const tzOff = new Date(tEnd).getTimezoneOffset() * 60_000;
    ctx.fillStyle = cssVar("--axis-time");
    for (
      let t = Math.ceil((tStart - tzOff) / tickMs) * tickMs + tzOff;
      t <= tEnd;
      t += tickMs
    ) {
      const x = ((t - tStart) / windowMs) * w;
      ctx.textAlign = x < 20 ? "left" : x > w - 20 ? "right" : "center";
      ctx.fillText(fmtTime(t, withSec), Math.min(Math.max(x, 2), w - 2), h - 2);
    }
  }

  series.forEach((data, si) => {
    if (data.length < 2) return;
    const step = w / span;
    const x0 = w - (data.length - 1) * step; // 右端が最新
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = x0 + i * step, y = toY(v ?? lo);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    if (fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, ph);
      grad.addColorStop(0, colors[si] + "55");
      grad.addColorStop(1, colors[si] + "00");
      ctx.save();
      ctx.lineTo(w, ph);
      ctx.lineTo(x0, ph);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = x0 + i * step, y = toY(v ?? lo);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
    }
    ctx.strokeStyle = colors[si];
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();
  });
}

function renderCharts() {
  const view = RANGE_VIEWS[range];
  const history = (histories[view.src] ?? []).slice(-view.points);
  const times = history.map((p) => p.t);
  const points = view.points;
  // 線の色はテーマ変数から取得（fill のグラデーション合成のため hex 形式で定義してある）
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim();
  const accent2 = style.getPropertyValue("--accent2").trim();
  const warn = style.getPropertyValue("--warn").trim();
  drawChart($("#c-cpu"), [history.map((p) => p.cpu)], { colors: [accent], times, points });
  drawChart($("#c-mem"), [history.map((p) => p.mem)], { colors: [accent2], times, points });
  drawChart($("#c-temp"), [history.map((p) => p.temp ?? 0)], {
    min: 20,
    max: 95,
    colors: [warn],
    times,
    points,
  });
  // サーバーは KB/s で送ってくるため MB/s に換算して描画する
  drawChart($("#c-net"), [history.map((p) => p.rx / 1024), history.map((p) => p.tx / 1024)], {
    max: null,
    colors: [accent2, accent],
    times,
    points,
  });
}

// ---------- テーブル・コア ----------
const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderCores(perCore) {
  $("#cores").innerHTML = perCore.map((u, i) =>
    `<div class="core"><span>core${i}</span><div class="bar"><i style="width:${
      u.toFixed(1)
    }%"></i></div><span class="pct">${u.toFixed(0)}%</span></div>`
  ).join("");
}

function renderContainers(list, available) {
  $("#ct-count").textContent = available
    ? `${list.filter((c) => c.state === "running").length}/${list.length}`
    : "";
  const tbody = $("#containers tbody");
  if (!available) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Docker socket not available</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((c) =>
    `<tr>
    <td title="${esc(c.name)}">${esc(c.name)}</td>
    <td class="col-img" title="${esc(c.image)}">${esc(c.image)}</td>
    <td><span class="state ${esc(c.state)}">${esc(c.state)}</span></td>
    <td class="r">${c.cpu == null ? "—" : c.cpu.toFixed(1)}</td>
    <td class="r">${c.memUsedMB == null ? "—" : c.memUsedMB.toFixed(0) + " MB"}</td>
  </tr>`
  ).join("") || `<tr><td colspan="5" class="empty">No containers</td></tr>`;
}

function renderServices(services) {
  $("#svc-count").textContent = services.length || "";
  // アクセス中のホスト名でリンクを組み立てる（LAN でも tailnet でもそのまま開ける）
  $("#services").innerHTML = services.map((s) => {
    const url = s.port === 443 ? `https://${location.hostname}` : `http://${location.hostname}:${s.port}`;
    return `<a class="svc" href="${url}" target="_blank" rel="noopener">
      ${esc(s.name)}<span class="port">:${s.port}</span><span class="src">${s.source}</span></a>`;
  }).join("") || `<div class="empty">No listening services detected</div>`;
}

// Top Processes のソート状態（CPU or MEM）と直近のデータ・総メモリ量を保持し、トグル操作で即座に再描画できるようにする
let procSort = "cpu";
try {
  const s = localStorage.getItem("procSort");
  if (s === "cpu" || s === "mem") procSort = s;
} catch { /* localStorage 不可なら既定の CPU */ }
let lastProcs = { byCpu: [], byMem: [] };
let lastMemTotalKB = 0;

function renderProcs() {
  const list = (procSort === "mem" ? lastProcs.byMem : lastProcs.byCpu) ?? [];
  $("#procs tbody").innerHTML = list.map((p) => {
    const memPct = lastMemTotalKB > 0 ? (p.rssKB / lastMemTotalKB) * 100 : null;
    return `<tr>
    <td>${p.pid}</td><td title="${esc(p.name)}">${esc(p.name)}</td>
    <td class="r">${p.cpu.toFixed(1)}</td><td class="r">${fmtKB(p.rssKB)}</td>
    <td class="r">${memPct == null ? "—" : memPct.toFixed(1)}</td>
  </tr>`;
  }).join("");
}

// ---------- スナップショット適用 ----------
function apply(s) {
  $("#hostname").textContent = s.hostname;
  $("#os").textContent = s.os.replace("Linux version ", "Linux ");
  $("#uptime").textContent = fmtUptime(s.uptimeSec);
  $("#load").textContent = s.load.map((v) => v.toFixed(2)).join(" ");

  setGauge(
    "#g-cpu",
    s.cpu.usage,
    s.cpu.usage.toFixed(0) + "%",
    `${s.cpu.cores} cores · load ${s.load[0].toFixed(2)}`,
  );
  setGauge(
    "#g-mem",
    s.mem.usage,
    s.mem.usage.toFixed(0) + "%",
    `${fmtKB(s.mem.usedKB)} / ${fmtKB(s.mem.totalKB)}`,
  );
  if (s.cpu.tempC != null) {
    setGauge(
      "#g-temp",
      (s.cpu.tempC / 90) * 100,
      s.cpu.tempC.toFixed(1) + "°",
      "throttle @ 85°C",
      (s.cpu.tempC / 90) * 100,
    );
  } else {
    setGauge("#g-temp", 0, "—", "no sensor");
  }
  setGauge(
    "#g-disk",
    s.disk.usage,
    s.disk.usage.toFixed(0) + "%",
    `${fmtKB(s.disk.usedKB)} / ${fmtKB(s.disk.totalKB)}`,
  );

  // 短期レンジはスナップショットから追記（初回は history イベント済み分と t で重複排除）
  const m10 = histories.m10;
  if (!m10.length || m10[m10.length - 1].t < s.t) {
    m10.push({
      t: s.t,
      cpu: s.cpu.usage,
      mem: s.mem.usage,
      temp: s.cpu.tempC,
      rx: s.net.rxKBs,
      tx: s.net.txKBs,
    });
  }
  if (m10.length > MAX_POINTS) m10.splice(0, m10.length - MAX_POINTS);
  // 長期表示中は該当データが変わったときだけ再描画する（longpoint イベント側で描画）
  if (RANGE_VIEWS[range].src === "m10") renderCharts();
  renderCores(s.cpu.perCore);
  renderContainers(s.containers ?? [], s.dockerAvailable);
  lastProcs = s.procs ?? { byCpu: [], byMem: [] };
  lastMemTotalKB = s.mem?.totalKB ?? 0;
  renderProcs();
  renderServices(s.services ?? []);
}

// ---------- スプラッシュ ----------
const splashStart = performance.now();
let splashHidden = false;

function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  // 一瞬で消えるとチラつくため最低 900ms は表示する
  const wait = Math.max(0, 900 - (performance.now() - splashStart));
  setTimeout(() => {
    const el = $("#splash");
    el.classList.add("hide");
    setTimeout(() => el.remove(), 500);
  }, wait);
}

// サーバーに繋がらない場合でもスプラッシュで塞ぎ続けない
setTimeout(hideSplash, 4000);

// ---------- SSE 接続（自動再接続つき） ----------
function setConn(cls, label) {
  const el = $("#conn");
  el.className = "conn " + cls;
  $("#conn-label").textContent = label;
}

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("history", (e) => {
    histories = JSON.parse(e.data);
    renderCharts();
  });
  es.addEventListener("longpoint", (e) => {
    const { range: r, point } = JSON.parse(e.data);
    const h = histories[r];
    if (!h) return;
    h.push(point);
    if (h.length > MAX_POINTS) h.splice(0, h.length - MAX_POINTS);
    if (RANGE_VIEWS[range].src === r) renderCharts();
  });
  es.addEventListener("snapshot", (e) => {
    setConn("live", "live");
    apply(JSON.parse(e.data));
    hideSplash();
  });
  es.onerror = () => setConn("dead", "disconnected — retrying");
}

// ---------- レンジ切り替え ----------
document.querySelectorAll(".range-toggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    range = btn.dataset.range;
    document.querySelectorAll(".range-toggle button").forEach((b) => b.classList.toggle("on", b === btn));
    renderCharts();
  });
});

// ---------- プロセス一覧のソート切り替え ----------
function applyProcSort() {
  document.querySelectorAll(".proc-sort button").forEach((b) => {
    b.classList.toggle("on", b.dataset.sort === procSort);
  });
  renderProcs();
}
document.querySelectorAll(".proc-sort button").forEach((btn) => {
  btn.addEventListener("click", () => {
    procSort = btn.dataset.sort;
    try {
      localStorage.setItem("procSort", procSort);
    } catch { /* 保存できなくても動作は継続 */ }
    applyProcSort();
  });
});
applyProcSort();

// ---------- テーマ (auto → light → dark) ----------
const THEME_MODES = ["auto", "light", "dark"];
// ボタン用アイコン（stroke は currentColor でテーマに追従）
const THEME_ICONS = {
  // 半分塗りの円 = OS 追従
  auto:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3 a9 9 0 0 1 0 18 z" fill="currentColor" stroke="none"/></svg>',
  // 太陽
  light:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
  // 月
  dark:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z"/></svg>',
};
const prefersLight = matchMedia("(prefers-color-scheme: light)");
let themeMode = "auto";
try {
  themeMode = localStorage.getItem("theme") ?? "auto";
} catch { /* localStorage 不可の環境では auto 固定 */ }

function applyTheme() {
  const resolved = themeMode === "auto" ? (prefersLight.matches ? "light" : "dark") : themeMode;
  document.documentElement.dataset.theme = resolved;
  $("#theme-btn").innerHTML = `${THEME_ICONS[themeMode]}<span>${themeMode}</span>`;
  // モバイルのステータスバー色もテーマに追従させる
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(
    document.documentElement,
  ).getPropertyValue("--bg1").trim();
  renderCharts();
}

$("#theme-btn").addEventListener("click", () => {
  themeMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  try {
    localStorage.setItem("theme", themeMode);
  } catch { /* 保存できなくても動作は継続 */ }
  applyTheme();
});
prefersLight.addEventListener("change", () => {
  if (themeMode === "auto") applyTheme();
});
applyTheme();

connect();
addEventListener("resize", renderCharts);

// ---------- Service Worker（secure context のみ。平文 HTTP では何もしない） ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* 登録失敗時は従来どおり動作 */
  });
}
