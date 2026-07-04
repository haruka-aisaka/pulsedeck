// PulseDeck フロントエンド — SSE 受信と描画（依存ライブラリなし）
"use strict";

const $ = (s) => document.querySelector(s);
let history = [];
const MAX_POINTS = 5400;

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
const levelColor = (pct) =>
  pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warn)" : "var(--accent)";

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
function drawChart(canvas, series, { min = 0, max = 100, colors = ["#58f6c4"], fill = true } = {}) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // 動的レンジ（max が指定なしのとき）
  let lo = min, hi = max;
  if (max === null) {
    hi = Math.max(1, ...series.flat().filter((v) => v != null)) * 1.15;
  }

  // グリッド
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // x 軸ウィンドウはデータ量に応じて 10 分〜3 時間で伸びる
  const len = Math.max(...series.map((d) => d.length));
  const span = Math.max(300, Math.min(len, MAX_POINTS)) - 1;
  series.forEach((data, si) => {
    if (data.length < 2) return;
    const step = w / span;
    const x0 = w - (data.length - 1) * step; // 右端が最新
    const toY = (v) => h - ((v - lo) / (hi - lo)) * (h - 6) - 3;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = x0 + i * step, y = toY(v ?? lo);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    if (fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, colors[si] + "55");
      grad.addColorStop(1, colors[si] + "00");
      ctx.save();
      ctx.lineTo(w, h + 2); ctx.lineTo(x0, h + 2); ctx.closePath();
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
  drawChart($("#c-cpu"), [history.map((p) => p.cpu)]);
  drawChart($("#c-mem"), [history.map((p) => p.mem)], { colors: ["#6aa5ff"] });
  drawChart($("#c-temp"), [history.map((p) => p.temp ?? 0)], { min: 20, max: 95, colors: ["#ffb454"] });
  drawChart($("#c-net"), [history.map((p) => p.rx), history.map((p) => p.tx)], {
    max: null, colors: ["#6aa5ff", "#58f6c4"],
  });
}

// ---------- テーブル・コア ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderCores(perCore) {
  $("#cores").innerHTML = perCore.map((u, i) =>
    `<div class="core"><span>core${i}</span><div class="bar"><i style="width:${u.toFixed(1)}%"></i></div><span class="pct">${u.toFixed(0)}%</span></div>`
  ).join("");
}

function renderContainers(list, available) {
  $("#ct-count").textContent = available ? `${list.filter((c) => c.state === "running").length}/${list.length}` : "";
  const tbody = $("#containers tbody");
  if (!available) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Docker socket not available</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((c) => `<tr>
    <td title="${esc(c.name)}">${esc(c.name)}</td>
    <td title="${esc(c.image)}">${esc(c.image)}</td>
    <td><span class="state ${esc(c.state)}">${esc(c.state)}</span></td>
    <td class="r">${c.cpu == null ? "—" : c.cpu.toFixed(1)}</td>
    <td class="r">${c.memUsedMB == null ? "—" : c.memUsedMB.toFixed(0) + " MB"}</td>
  </tr>`).join("") || `<tr><td colspan="5" class="empty">No containers</td></tr>`;
}

function renderProcs(procs) {
  $("#procs tbody").innerHTML = procs.map((p) => `<tr>
    <td>${p.pid}</td><td title="${esc(p.name)}">${esc(p.name)}</td>
    <td class="r">${p.cpu.toFixed(1)}</td><td class="r">${fmtKB(p.rssKB)}</td>
  </tr>`).join("");
}

// ---------- スナップショット適用 ----------
function apply(s) {
  $("#hostname").textContent = s.hostname;
  $("#os").textContent = s.os.replace("Linux version ", "Linux ");
  $("#uptime").textContent = fmtUptime(s.uptimeSec);
  $("#load").textContent = s.load.map((v) => v.toFixed(2)).join(" ");

  setGauge("#g-cpu", s.cpu.usage, s.cpu.usage.toFixed(0) + "%", `${s.cpu.cores} cores · load ${s.load[0].toFixed(2)}`);
  setGauge("#g-mem", s.mem.usage, s.mem.usage.toFixed(0) + "%", `${fmtKB(s.mem.usedKB)} / ${fmtKB(s.mem.totalKB)}`);
  if (s.cpu.tempC != null) {
    setGauge("#g-temp", (s.cpu.tempC / 90) * 100, s.cpu.tempC.toFixed(1) + "°", "throttle @ 85°C", (s.cpu.tempC / 90) * 100);
  } else {
    setGauge("#g-temp", 0, "—", "no sensor");
  }
  setGauge("#g-disk", s.disk.usage, s.disk.usage.toFixed(0) + "%", `${fmtKB(s.disk.usedKB)} / ${fmtKB(s.disk.totalKB)}`);

  // 初回受信は history イベント済み分と重複するため t で弾く
  if (!history.length || history[history.length - 1].t < s.t) {
    history.push({ t: s.t, cpu: s.cpu.usage, mem: s.mem.usage, temp: s.cpu.tempC, rx: s.net.rxKBs, tx: s.net.txKBs });
  }
  if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);
  renderCharts();
  renderCores(s.cpu.perCore);
  renderContainers(s.containers ?? [], s.dockerAvailable);
  renderProcs(s.procs ?? []);
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
    history = JSON.parse(e.data);
    renderCharts();
  });
  es.addEventListener("snapshot", (e) => {
    setConn("live", "live");
    apply(JSON.parse(e.data));
  });
  es.onerror = () => setConn("dead", "disconnected — retrying");
}

connect();
addEventListener("resize", renderCharts);
