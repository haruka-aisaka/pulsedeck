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
  v >= 1000 ? (v / 1000).toFixed(1) + "k" : v >= 10 ? Math.round(v) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
const fmtTime = (t, withSec = false) => {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withSec ? `${hm}:${String(d.getSeconds()).padStart(2, "0")}` : hm;
};

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

  // グリッドと Y 軸数値（各罫線の右端に値を表示）
  ctx.lineWidth = 1;
  ctx.font = "10px " + getComputedStyle(document.body).getPropertyValue("--mono");
  for (let i = 0; i <= 3; i++) {
    const y = (ph / 4) * i;
    if (i > 0) {
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(125,138,165,0.85)";
    ctx.textAlign = "right";
    ctx.fillText(fmtAxis(hi - ((hi - lo) / 4) * i), w - 4, y + 11);
  }

  // x 軸は表示レンジ分の固定ウィンドウ
  const span = points - 1;

  // X 軸時刻（ウィンドウを 4 等分。データのある範囲のみ）
  if (times.length >= 2) {
    const stepMs = (times[times.length - 1] - times[0]) / (times.length - 1);
    const withSec = stepMs * span < 300_000; // 5 分未満のウィンドウは秒まで表示
    ctx.fillStyle = "rgba(125,138,165,0.7)";
    for (let i = 0; i <= 4; i++) {
      const x = (w / 4) * i;
      const idx = (times.length - 1) - Math.round(((4 - i) / 4) * span);
      // データがまだ無い左側の時間帯もサンプリング間隔から時刻を外挿して表示する
      const t = idx >= 0 ? times[idx] : times[0] + idx * stepMs;
      ctx.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      ctx.fillText(fmtTime(t, withSec), Math.min(Math.max(x, 2), w - 2), h - 2);
    }
  }

  series.forEach((data, si) => {
    if (data.length < 2) return;
    const step = w / span;
    const x0 = w - (data.length - 1) * step; // 右端が最新
    const toY = (v) => ph - ((v - lo) / (hi - lo)) * (ph - 6) - 3;
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
  drawChart($("#c-cpu"), [history.map((p) => p.cpu)], { times, points });
  drawChart($("#c-mem"), [history.map((p) => p.mem)], { colors: ["#6aa5ff"], times, points });
  drawChart($("#c-temp"), [history.map((p) => p.temp ?? 0)], {
    min: 20,
    max: 95,
    colors: ["#ffb454"],
    times,
    points,
  });
  // サーバーは KB/s で送ってくるため MB/s に換算して描画する
  drawChart($("#c-net"), [history.map((p) => p.rx / 1024), history.map((p) => p.tx / 1024)], {
    max: null,
    colors: ["#6aa5ff", "#58f6c4"],
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

function renderProcs(procs) {
  $("#procs tbody").innerHTML = procs.map((p) =>
    `<tr>
    <td>${p.pid}</td><td title="${esc(p.name)}">${esc(p.name)}</td>
    <td class="r">${p.cpu.toFixed(1)}</td><td class="r">${fmtKB(p.rssKB)}</td>
  </tr>`
  ).join("");
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
  renderProcs(s.procs ?? []);
  renderServices(s.services ?? []);
}

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

connect();
addEventListener("resize", renderCharts);
