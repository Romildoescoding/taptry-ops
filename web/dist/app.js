/* TapTry Ops dashboard. Plain JS, no build step. */
(() => {
  "use strict";

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n) => (n == null || isNaN(n) ? "–" : Number(n).toLocaleString("en-US"));
  const compact = (n) => (n == null ? "–" : Math.abs(n) >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k" : num(Math.round(n)));
  const usd = (n, d = 2) => (n == null ? "–" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (n) => (n == null ? "–" : `${n}%`);
  const toDate = (iso) => (iso ? new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z") : null);
  const ist = (iso, opts = { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) => (iso ? toDate(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", ...opts }) : "–");
  const ago = (iso) => {
    if (!iso) return "never";
    const m = Math.round((Date.now() - toDate(iso)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
  };
  const dayLabel = (d) => {
    if (!d) return "";
    const s = String(d);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return s.replace(/^\w+,\s*/, "").slice(0, 12);
  };
  const toast = (msg, ms = 2600) => {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => (t.hidden = true), ms);
  };

  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: "same-origin", headers: opts.body ? { "Content-Type": "application/json" } : {}, ...opts });
    if (r.status === 401) {
      location.href = "/login";
      throw new Error("login");
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  // ---------- saved filters ----------
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("tt." + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("tt." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let range = store.get("range", { preset: "30d" });
  let phRange = store.get("phRange", { preset: "default" });
  let phOpts = store.get("ph", { interval: "", compare: true });
  const rangeQS = (r = range) => (r.from ? `from=${r.from}&to=${r.to || ""}` : `preset=${r.preset}`);

  // ---------- charts (SVG drawn at the container's real pixel width, so text stays readable) ----------
  const charts = new Map();
  let chartSeq = 0;
  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => f <= s) || 10) * p;
  };

  function smoothPath(pts) {
    if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1] || pts[i];
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      const [x3, y3] = pts[i + 2] || pts[i + 1];
      const t = 0.16;
      // Clamp control points to the plot so curves never dip below zero.
      const c1y = Math.min(Math.max(y1 + (y2 - y0) * t, Math.min(y1, y2)), Math.max(y1, y2));
      const c2y = Math.min(Math.max(y2 - (y3 - y1) * t, Math.min(y1, y2)), Math.max(y1, y2));
      d += ` C${x1 + (x2 - x0) * t},${c1y} ${x2 - (x3 - x1) * t},${c2y} ${x2},${y2}`;
    }
    return d;
  }
  const holder = (spec) => {
    const id = "c" + ++chartSeq;
    charts.set(id, spec);
    return `<div class="chart" data-chart="${id}" style="height:${spec.height}px"></div>`;
  };
  /** series: [{name, data:[...], color, dashed}] ; labels: x labels */
  const lineChart = ({ labels, series, height = innerWidth >= 900 ? 240 : 200, fmt = num }) => holder({ kind: "line", labels, series, height, fmt });
  /** stacks: [{name, data, color, hatch}] stacked pill bars, like the reference board. */
  const pillBars = ({ labels, stacks, height = innerWidth >= 900 ? 280 : 220, fmt = num, ghost = true }) => holder({ kind: "bars", labels, stacks, height, fmt, ghost });

  const xLabels = (labels, xAt, W, H) => {
    const n = labels.length;
    const fit = Math.max(2, Math.floor(W / 64));
    const step = Math.max(1, Math.ceil(n / fit));
    let s = "";
    for (let i = 0; i < n; i += step) {
      if (n - 1 - i < step / 2 && i !== n - 1 && i !== 0) continue;
      s += `<text x="${xAt(i)}" y="${H - 6}" text-anchor="middle">${esc(dayLabel(labels[i]))}</text>`;
    }
    return s;
  };

  function drawChart(el) {
    const c = charts.get(el.dataset.chart);
    if (!c) return;
    const W = Math.max(240, Math.round(el.clientWidth));
    const H = c.height;
    const l = 34, r = 8, t = 12, b = 24;
    const n = c.labels.length;
    let svg;
    if (c.kind === "line") {
      const max = niceMax(Math.max(1, ...c.series.flatMap((s) => s.data.map((v) => v || 0))));
      c.xs = c.labels.map((_, i) => (n === 1 ? (l + W - r) / 2 : l + (i * (W - l - r)) / (n - 1)));
      c.y = (v) => t + (H - t - b) * (1 - (v || 0) / max);
      const grid = [0, 0.5, 1].map((f) => {
        const yy = t + (H - t - b) * (1 - f);
        return `<line x1="${l}" x2="${W - r}" y1="${yy}" y2="${yy}" stroke="#262626" stroke-dasharray="${f ? "3 5" : ""}"/><text x="${l - 8}" y="${yy + 3.5}" text-anchor="end">${compact(max * f)}</text>`;
      }).join("");
      const g = "g" + el.dataset.chart;
      const paths = c.series.map((s, si) => {
        const pts = s.data.map((v, i) => [c.xs[i], c.y(v)]);
        const d = smoothPath(pts);
        const area = si === 0 && n > 1 ? `<path d="${d} L${c.xs[n - 1]},${H - b} L${c.xs[0]},${H - b} Z" fill="url(#${g})"/>` : "";
        return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.dashed ? 2 : 2.6}" stroke-dasharray="${s.dashed ? "6 6" : ""}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }).join("");
      svg = `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.series[0]?.color}" stop-opacity=".35"/><stop offset="1" stop-color="${c.series[0]?.color}" stop-opacity="0"/></linearGradient></defs>
        ${grid}${xLabels(c.labels, (i) => c.xs[i], W, H)}${paths}<line class="guide" visibility="hidden" x1="0" x2="0" y1="${t}" y2="${H - b}" stroke="#555"/>
        ${c.series.map((s, si) => `<circle class="pt pt${si}" visibility="hidden" r="5" cx="0" cy="0" fill="${s.color}" stroke="#0a0a0a" stroke-width="2"/>`).join("")}`;
    } else {
      c.totals = c.labels.map((_, i) => c.stacks.reduce((s, k) => s + (k.data[i] || 0), 0));
      const max = niceMax(Math.max(1, ...c.totals));
      c.l = l;
      c.colW = (W - l - r) / Math.max(1, n);
      const bw = Math.max(2, Math.min(c.colW * 0.68, 40));
      const gap = bw < 8 ? 1 : 3;
      const y0 = H - b, ph = H - t - b;
      const grid = [0, 0.5, 1].map((f) => `<text x="${l - 8}" y="${t + ph * (1 - f) + 3.5}" text-anchor="end">${compact(max * f)}</text>`).join("");
      const hid = "h" + el.dataset.chart;
      let bars = "";
      c.labels.forEach((_, i) => {
        const x = l + c.colW * i + (c.colW - bw) / 2;
        const rad = Math.min(bw / 2, 14);
        if (c.ghost) bars += `<rect x="${x}" y="${t}" width="${bw}" height="${ph}" rx="${rad}" fill="#1c1c1c"/>`;
        let yy = y0;
        c.stacks.forEach((s) => {
          const v = s.data[i] || 0;
          if (!v) return;
          const h = Math.max(Math.min(bw, 4), (v / max) * ph - gap);
          yy -= h;
          bars += `<rect x="${x}" y="${yy}" width="${bw}" height="${h}" rx="${Math.min(rad, h / 2)}" fill="${s.hatch ? `url(#${hid})` : s.color}"/>`;
          yy -= gap;
        });
      });
      svg = `<defs><pattern id="${hid}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#8f6bff"/><rect width="2.4" height="7" fill="#c3b1ff"/></pattern></defs>
        ${grid}${bars}${xLabels(c.labels, (i) => l + c.colW * i + c.colW / 2, W, H)}`;
    }
    c.W = W;
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg><div class="tip" hidden></div>`;
  }

  function bindCharts(root = document) {
    $$(".chart[data-chart]", root).forEach((el) => {
      drawChart(el);
      if (el.dataset.bound) return;
      el.dataset.bound = "1";
      const show = (ev) => {
        const c = charts.get(el.dataset.chart);
        const svg = $("svg", el), tip = $(".tip", el);
        if (!c || !svg) return;
        const sx = ev.clientX - svg.getBoundingClientRect().left;
        let i, x, y;
        if (c.kind === "line") {
          i = c.xs.reduce((best, xx, k) => (Math.abs(xx - sx) < Math.abs(c.xs[best] - sx) ? k : best), 0);
          const g = $(".guide", svg);
          g.setAttribute("x1", c.xs[i]); g.setAttribute("x2", c.xs[i]); g.setAttribute("visibility", "visible");
          c.series.forEach((s, si) => { const p = $(`.pt${si}`, svg); p.setAttribute("cx", c.xs[i]); p.setAttribute("cy", c.y(s.data[i])); p.setAttribute("visibility", "visible"); });
          tip.innerHTML = `<b>${esc(dayLabel(c.labels[i]))}</b><br>` + c.series.map((s) => `${esc(s.name)}: <b>${c.fmt(s.data[i] ?? 0)}</b>`).join("<br>");
          x = c.xs[i]; y = Math.min(...c.series.map((s) => c.y(s.data[i]))) - 8;
        } else {
          i = Math.max(0, Math.min(c.labels.length - 1, Math.floor((sx - c.l) / c.colW)));
          tip.innerHTML = `<b>${esc(dayLabel(c.labels[i]))}</b> · ${c.fmt(c.totals[i])}` + c.stacks.filter((s) => s.data[i]).map((s) => `<br>${esc(s.name)}: <b>${c.fmt(s.data[i])}</b>`).join("");
          x = c.l + c.colW * i + c.colW / 2; y = 30;
        }
        tip.hidden = false;
        const half = tip.offsetWidth / 2;
        tip.style.left = `${Math.min(Math.max(x, half), c.W - half)}px`;
        tip.style.top = `${Math.max(y, tip.offsetHeight + 4)}px`;
      };
      el.addEventListener("pointermove", show);
      el.addEventListener("pointerdown", show);
      el.addEventListener("pointerleave", () => { const tip = $(".tip", el); if (tip) tip.hidden = true; });
    });
  }
  let resizeT;
  let lastW = innerWidth;
  window.addEventListener("resize", () => {
    if (innerWidth === lastW) return; // phones fire resize when the URL bar hides
    lastW = innerWidth;
    clearTimeout(resizeT);
    resizeT = setTimeout(() => $$(".chart[data-chart]").forEach(drawChart), 150);
  });

  const keyLegend = (items) => `<div class="keys">${items.map(([n, col]) => `<span><i style="background:${col}"></i>${esc(n)}</span>`).join("")}</div>`;
  const rowBars = (rows, { color = "var(--orange)", max, fmt = (r) => num(r.value) } = {}) => {
    const m = max ?? Math.max(1, ...rows.map((r) => r.value || 0));
    return rows.map((r) => `<div class="rowbar ${r.cls || ""}"><span>${esc(r.name)}</span><div class="bar"><i style="width:${Math.max(r.value ? 2 : 0, ((r.value || 0) / m) * 100)}%;background:${r.color || color}"></i></div><span class="n">${fmt(r)}</span></div>`).join("");
  };

  function bubbles(items) {
    // Up to 4 circles, area proportional to the value, packed like the reference board.
    const sorted = [...items].filter((x) => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 4);
    if (!sorted.length) return `<div class="empty">No leads yet</div>`;
    const max = sorted[0].value;
    const rad = (v) => Math.max(10, 29 * Math.sqrt(v / max)); // % of box width
    const pos = [[60, 42], [27, 72], [74, 80], [17, 36]];
    const tags = ["top:4%;left:6%", "bottom:-26px;left:50%;transform:translateX(-50%)", "bottom:-26px;left:50%;transform:translateX(-50%)", "top:-26px;left:50%;transform:translateX(-50%)"];
    return `<div class="bubbles">${sorted.map((b, i) => {
      const r = rad(b.value);
      const [x, y] = pos[i];
      return `<div class="bubble ${b.cls}" style="width:${r * 2}%;height:${r * 2}%;left:${x - r}%;top:${y - r}%;z-index:${4 - i};font-size:${Math.max(15, Math.round((r / 29) * 38))}px"><span>${compact(b.value)}</span><em style="${tags[i]};color:${b.dot}">${esc(b.name)}</em></div>`;
    }).join("")}</div>`;
  }

  // ---------- filters ----------
  const PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7D"], ["30d", "30D"], ["90d", "90D"], ["mtd", "MTD"]];
  const PH_PRESETS = [["default", "As in PostHog"], ["today", "Today"], ["7d", "7D"], ["14d", "14D"], ["30d", "30D"], ["90d", "90D"], ["180d", "6M"], ["mtd", "MTD"]];
  // Two independent ranges: outreach pages share one, the Product page has its own.
  const cur = (scope) => (scope === "ph" ? phRange : range);
  const setCur = (scope, v) => { if (scope === "ph") { phRange = v; store.set("phRange", v); } else { range = v; store.set("range", v); } };
  const rangeBar = (extra = "", scope = "range") => {
    const r = cur(scope);
    return `<div class="filters" id="rangeBar">
      ${(scope === "ph" ? PH_PRESETS : PRESETS).map(([k, l]) => `<button class="chip ${!r.from && r.preset === k ? "on" : ""}" data-preset="${k}">${l}</button>`).join("")}
      <button class="chip ${r.from ? "on" : ""}" id="rCustom">${r.from ? esc(rangeLabel(scope)) : "Custom"}</button>
      ${extra}
    </div>
    <div class="filters dates" id="rDates" ${r.from ? "" : "hidden"}>
      <span class="label">From</span><input type="date" id="rFrom" value="${esc(r.from || "")}" aria-label="From">
      <span class="label">To</span><input type="date" id="rTo" value="${esc(r.to || "")}" aria-label="To">
    </div>`;
  };
  function bindRange(rerender, scope = "range") {
    $$("#rangeBar [data-preset]").forEach((b) => (b.onclick = () => { setCur(scope, { preset: b.dataset.preset }); rerender(); }));
    const apply = () => {
      const f = $("#rFrom").value, t = $("#rTo").value;
      if (f) { const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); setCur(scope, { from: f, to: t ? (t >= f ? t : f) : today }); rerender(); }
    };
    $("#rCustom").onclick = () => { const d = $("#rDates"); d.hidden = !d.hidden; if (!d.hidden) $("#rFrom").focus(); };
    $("#rFrom").onchange = apply;
    $("#rTo").onchange = apply;
  }
  const rangeLabel = (scope = "range") => {
    const r = cur(scope);
    return r.from ? (r.to && r.to !== r.from ? `${dayLabel(r.from)} – ${dayLabel(r.to)}` : dayLabel(r.from)) : ([...PRESETS, ...PH_PRESETS].find((p) => p[0] === r.preset) || [0, "30D"])[1];
  };

  // ---------- PostHog rendering ----------
  const PH_DASH = { "2090168": "Starter", "2090237": "Analytics Wizard" };
  const seriesOf = (res) => (Array.isArray(res) ? res.filter((s) => s && typeof s === "object" && Array.isArray(s.data)) : []);
  function boldValue(ins) {
    const s = seriesOf(ins.result);
    const cur = s.find((x) => x.compare_label !== "previous") || s[0];
    const prev = s.find((x) => x.compare_label === "previous");
    const v = (x) => (x ? Number(x.aggregated_value ?? x.count ?? x.data.reduce((a, b) => a + (b || 0), 0)) : null);
    const value = v(cur), before = v(prev);
    const delta = before ? Math.round(((value - before) / before) * 1000) / 10 : null;
    return { value, delta };
  }
  const deltaHtml = (d, inverse = false) => (d == null ? "" : `<span class="delta ${(d >= 0) !== inverse ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}%</span>`);
  const PALETTE = ["#8f6bff", "#ff4d24", "#ffd23f", "#3ecf5a", "#5ab4ff", "#ff8ad8"];

  function insightCard(ins, host) {
    const kind = ins.kind || "";
    const res = ins.result;
    let body;
    const s = seriesOf(res).filter((x) => x.compare_label !== "previous");
    if (ins.error && (res == null || (Array.isArray(res) && !res.length))) body = `<div class="note err">${esc(ins.error)}</div>`;
    else if (kind.includes("Funnel")) {
      const steps = Array.isArray(res?.[0]) ? res[0] : res || [];
      const first = steps[0]?.count || 0;
      let worst = -1, wd = 0;
      steps.forEach((st, i) => { if (i && steps[i - 1].count) { const d = 1 - st.count / steps[i - 1].count; if (d > wd) { wd = d; worst = i; } } });
      body = `<div class="funnel">${rowBars(steps.map((st, i) => ({ name: st.custom_name || st.name, value: st.count, cls: i === worst ? "worst" : "", color: i === worst ? "var(--orange)" : "var(--violet)", keep: i ? (steps[i - 1].count ? Math.round((st.count / steps[i - 1].count) * 100) : 0) : null })), { max: first || 1, fmt: (r) => `${num(r.value)}${r.keep != null ? ` · ${r.keep}%` : ""}` })}</div>
        ${worst > 0 ? `<div class="callout"><div class="ic">↓</div><div>Biggest leak: into <b>${esc(steps[worst].custom_name || steps[worst].name)}</b>, ${Math.round(wd * 100)}% drop off.</div></div>` : ""}`;
    } else if (kind.includes("Retention")) {
      const rows = Array.isArray(res) ? res : [];
      const cols = Math.max(0, ...rows.map((r) => r.values?.length || 0));
      body = `<div style="overflow-x:auto"><table class="ret"><tr><th></th>${Array.from({ length: cols }, (_, i) => `<th>${i}</th>`).join("")}</tr>${rows.map((r) => {
        const base = r.values?.[0]?.count || 0;
        return `<tr><td class="l">${esc(dayLabel(r.date) || r.label)}</td>${(r.values || []).map((v) => { const p = base ? Math.round((v.count / base) * 100) : 0; return `<td class="${p > 35 ? "c" : ""}" style="background:rgba(143,107,255,${0.08 + (p / 100) * 0.85})">${base ? p + "%" : ""}</td>`; }).join("")}</tr>`;
      }).join("")}</table></div>`;
    } else if (ins.display === "BoldNumber" && s.length) {
      const b = boldValue(ins);
      body = `<div class="mid">${compact(b.value)}${deltaHtml(b.delta)}</div>`;
    } else if (["ActionsBarValue", "ActionsPie", "ActionsTable"].includes(ins.display) && s.length) {
      const rows = s.map((x, i) => ({ name: Array.isArray(x.breakdown_value) ? x.breakdown_value.join(" · ") : x.breakdown_value ?? x.label, value: Number(x.aggregated_value ?? x.count ?? 0), color: PALETTE[i % PALETTE.length] })).sort((a, b) => b.value - a.value);
      body = rowBars(rows.slice(0, 10));
    } else if (s.length && s[0].data.length > 1 && ["ActionsBar", "ActionsStackedBar", "ActionsUnstackedBar"].includes(ins.display)) {
      const labels = s[0].days?.length ? s[0].days : s[0].labels;
      body = `<div class="pair"><div><div class="label">Total</div><div class="mid">${compact(s.reduce((a, x) => a + (x.count || x.data.reduce((p, q) => p + (q || 0), 0)), 0))}</div></div></div>` +
        pillBars({ labels, stacks: s.slice(0, 5).map((x, i) => ({ name: String(x.breakdown_value ?? x.label), data: x.data, color: PALETTE[(i + 1) % PALETTE.length] })) });
    } else if (s.length && s[0].data.length > 1) {
      const labels = s[0].days?.length ? s[0].days : s[0].labels;
      body = lineChart({ labels, series: s.slice(0, 5).map((x, i) => ({ name: x.breakdown_value ?? x.label, data: x.data, color: PALETTE[i] })) });
      if (s.length === 1) {
        // Active-user series can't be summed, so show the latest value and the peak instead.
        const isActive = /active|dau|wau|mau|unique/i.test(ins.name) || ["dau", "weekly_active", "monthly_active", "unique_session"].includes(s[0].action?.math);
        const data = s[0].data;
        const head = isActive
          ? `<div class="pair"><div><div class="label">Latest</div><div class="mid">${compact(data[data.length - 1])}</div></div><div><div class="label">Peak</div><div class="mid">${compact(Math.max(...data))}</div></div><div><div class="label">Average</div><div class="mid">${compact(data.reduce((a, b) => a + (b || 0), 0) / data.length)}</div></div></div>`
          : `<div class="pair"><div><div class="label">Total</div><div class="mid">${compact(s[0].count || data.reduce((a, b) => a + (b || 0), 0))}</div></div><div><div class="label">Latest</div><div class="mid">${compact(data[data.length - 1])}</div></div></div>`;
        body = head + body;
      }
    } else if (s.length) {
      body = `<div class="mid">${compact(s[0].aggregated_value ?? s[0].count)}</div>`;
    } else body = `<div class="empty">No data in this range</div>`;
    return `<div class="card"><h2>${esc(ins.name)}<a class="sp label" href="${esc(host)}/insights/${esc(ins.short_id)}" target="_blank" rel="noopener">PostHog ↗</a></h2>${body}
      <div class="sub" style="margin-top:10px">${ins.fetched_at ? "Fresh " + ago(ins.fetched_at) : ""}${ins.error && res ? ` · <span class="late">${esc(ins.error)}</span>` : ""}</div></div>`;
  }
  const boldHeroes = (list, note) => `<div class="card"><div class="heroes ${list.length >= 3 ? "h3" : ""}">${list.map((ins) => {
    const b = boldValue(ins);
    return `<div class="hero"><i class="slider"></i><div class="label">${esc(ins.name)}</div><div class="big">${compact(b.value)}${deltaHtml(b.delta)}</div></div>`;
  }).join("")}</div><div class="sub" style="margin-top:6px">${esc(note)}</div></div>`;

  // ---------- pages ----------
  const main = () => $("#main");
  const head = (title, right = "") => `<div class="page-head"><h1>${esc(title)}</h1>${right}</div>`;
  let lastQueue = [];

  async function pageDashboard() {
    const d = await api(`/api/overview?${rangeQS()}&compare=1`);
    const o = d.outreach, t = o.totals, c = d.costs;
    lastQueue = d.queue.top;
    setCount(d.queue.count);
    const pipe = Object.fromEntries(o.pipeline.map((p) => [p.k, p.n]));
    const awaiting = (pipe.sent || 0) + (pipe.followed_up || 0);
    const bestDay = o.daily.reduce((b, x) => (x.first + x.followups > (b ? b.first + b.followups : -1) ? x : b), null);
    const bold = d.product.filter((i) => i.display === "BoldNumber").slice(0, 3);
    const lines = d.product.filter((i) => i.kind === "TrendsQuery" && i.display !== "BoldNumber" && !["ActionsBarValue", "ActionsPie", "ActionsTable"].includes(i.display));
    const active = lines.filter((i) => /daily active|weekly active|\bDAU|\bWAU/i.test(i.name));
    const trends = (active.length ? active : lines).slice(0, 2);
    main().innerHTML = `
      ${head("Overview", `<span class="badge">${esc(ist(new Date().toISOString(), { weekday: "short", day: "numeric", month: "short" }))}</span>`)}
      ${rangeBar()}
      <div class="card" style="margin-top:12px"><div class="heroes h3">
        <div class="hero"><i class="slider"></i><div class="label">Emails sent</div><div class="big">${compact(t.emailsSent)}</div><div class="sub">${num(t.firstEmails)} first · ${num(t.followups)} follow-ups</div></div>
        <div class="hero"><div class="label">Positive replies</div><div class="big">${num(t.replied)}</div><div class="sub">${pct(t.replyRate)} reply rate · ${num(t.optedOut)} opt-outs</div></div>
        <div class="hero"><div class="label">Needs you</div><div class="big" style="color:${d.queue.urgent ? "var(--orange)" : "inherit"}">${num(d.queue.count)}</div><div class="sub">${num(d.queue.urgent)} urgent · <a href="#inbox">open inbox →</a></div></div>
      </div></div>
      <div class="grid two" style="margin-top:14px">
        <div class="card"><h2>Outreach<span class="sp badge">${esc(rangeLabel())}</span></h2>
          <div class="grid" style="grid-template-columns:minmax(0,1fr)">${pillBars({ labels: o.daily.map((x) => x.day), stacks: [{ name: "First emails", data: o.daily.map((x) => x.first), color: "#ff4d24" }, { name: "Follow-ups", data: o.daily.map((x) => x.followups), color: "#ffd23f" }] })}</div>
          <div class="legend" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:12px">
            <div class="leg"><i class="sw orange"></i><div><div class="label">First emails</div><div class="v">${num(t.firstEmails)}</div></div></div>
            <div class="leg"><i class="sw yellow"></i><div><div class="label">Follow-ups</div><div class="v">${num(t.followups)}</div></div></div>
            <div class="leg"><i class="sw violet"></i><div><div class="label">Active threads</div><div class="v">${num(t.activeThreads)}</div><div class="sub">${num(t.dueToday)} follow-ups due</div></div></div>
          </div>
          ${bestDay && bestDay.first + bestDay.followups ? `<div class="callout"><div class="ic">✉</div><div>${esc(dayLabel(bestDay.day))} was the busiest day: <b>${num(bestDay.first + bestDay.followups)} emails</b>.</div></div>` : ""}
        </div>
        <div class="card"><h2>Leads<span class="sp badge">all time</span></h2>
          ${bubbles([{ name: "Awaiting", value: awaiting, cls: "yellow", dot: "#c9a200" }, { name: "Replied", value: pipe.replied || 0, cls: "orange", dot: "#ff4d24" }, { name: "Opted out", value: pipe.opted_out || 0, cls: "violet", dot: "#8f6bff" }, { name: "Bounced", value: pipe.bounced || 0, cls: "grey", dot: "#666" }])}
          <div class="legend" style="margin-top:16px">
            ${[["Replied", pipe.replied, "var(--orange)"], ["Awaiting reply", awaiting, "var(--yellow)"], ["Opted out", pipe.opted_out, "var(--violet)"], ["Bounced", pipe.bounced, "#666"]].map(([n, v, col]) => {
              const all = awaiting + (pipe.replied || 0) + (pipe.opted_out || 0) + (pipe.bounced || 0);
              return `<div class="leg" style="display:block"><div class="label">${n}</div><div class="v">${num(v || 0)} <span class="sub">(${all ? Math.round(((v || 0) / all) * 100) : 0}%)</span></div><div class="prog"><i style="width:${all ? ((v || 0) / all) * 100 : 0}%;background:${col}"></i></div></div>`;
            }).join("")}
          </div>
        </div>
      </div>
      <div class="section-title">Needs you<a href="#inbox">All ${num(d.queue.count)} →</a></div>
      ${queueList(d.queue.top, true)}
      ${bold.length ? `<div class="section-title">Product<a href="#product">More →</a></div>${boldHeroes(bold, "Ranges as set in PostHog · change vs the period before")}` : ""}
      ${trends.length ? `<div class="grid halves" style="margin-top:14px">${trends.map((i) => insightCard(i, d.host)).join("")}</div>` : ""}
      <div class="section-title">AWS<a href="#costs">More →</a></div>
      ${costsCard(c)}`;
    bindRange(render);
    bindQueue();
    bindCharts();
  }

  function costsCard(c) {
    const cur = c.month;
    return `<div class="card"><div class="heroes h3">
        <div class="hero"><i class="slider"></i><div class="label">AWS this month · to ${esc(dayLabel(c.through))}</div><div class="big"><small>$</small>${usd(c.mtd)}${deltaHtml(c.changePct, true)}</div><div class="sub">vs ${usd(c.lastMonthSameDay)} last month, same day</div></div>
        <div class="hero"><div class="label">Forecast to month end</div><div class="big"><small>$</small>${usd(c.forecast)}</div><div class="sub">avg $${usd(c.avg7)}/day over the last 7 days</div></div>
        <div class="hero"><div class="label">Fleet run-rate now</div><div class="big"><small>$</small>${usd(c.runRatePerDay)}<span class="unit">/day</span></div><div class="sub">${num(c.instancesRunning)} running${c.unpricedTypes.length ? ` · price not set for ${esc(c.unpricedTypes.join(", "))} (System → EC2 prices)` : ""}</div></div>
      </div>
      <div style="margin-top:16px">${c.daily.length ? pillBars({ labels: c.daily.map((d) => d.day), stacks: [{ name: "This month", data: c.daily.map((d) => (d.day.startsWith(cur) ? d.usd : 0)), color: "#ff4d24" }, { name: "Last month", data: c.daily.map((d) => (d.day.startsWith(cur) ? 0 : d.usd)), color: "#3a3a3a" }], fmt: (v) => "$" + usd(v) }) : `<div class="empty">No cost data yet. It arrives daily at 8:30 AM IST.</div>`}</div>
    </div>`;
  }

  async function pageCosts() {
    const c = await api("/api/costs");
    main().innerHTML = head("AWS costs") + costsCard(c);
    bindCharts();
  }

  async function pageOutreach() {
    const o = await api(`/api/outreach?${rangeQS()}`);
    const t = o.totals;
    const srcName = { play: "Play Store", reddit: "Reddit", github: "GitHub", ownapp: "Own-app demos", x: "X", producthunt: "Product Hunt", devto: "dev.to", indiehackers: "Indie Hackers", other: "Other", unknown: "Unknown" };
    const rateRow = (r, name) => ({ name, value: r.replyRate || 0, sent: r.sent ?? r.leads, replied: r.replied, opted: r.opted_out });
    const rateFmt = (r) => (r.sent < 30 ? `${(r.replied || 0) + (r.opted || 0)} of ${r.sent}` : `${r.value}% · ${num(r.sent)}`);
    main().innerHTML = `${head("Outreach")}${rangeBar()}
      <div class="card" style="margin-top:12px"><div class="heroes h3">
        <div class="hero"><i class="slider"></i><div class="label">Emails sent</div><div class="big">${compact(t.emailsSent)}</div></div>
        <div class="hero"><div class="label">Reply rate</div><div class="big">${t.replyRate ?? "–"}<span class="unit">%</span></div><div class="sub">${pct(t.positiveRate)} positive</div></div>
        <div class="hero"><div class="label">Positive replies</div><div class="big">${num(t.replied)}</div></div>
      </div></div>
      <div class="tiles" style="margin-top:12px">
        ${[["First emails", t.firstEmails], ["Follow-ups", t.followups], ["Opt-outs", t.optedOut], ["Bounce rate", pct(t.bounceRate)], ["Active threads", t.activeThreads], ["Follow-ups due", t.dueToday], ["Bounced", t.bounced], ["Positive rate", pct(t.positiveRate)]]
          .map(([l, v]) => `<div class="tile"><div class="label">${l}</div><div class="v">${typeof v === "number" ? num(v) : v}</div></div>`).join("")}
      </div>
      <div class="grid two" style="margin-top:14px">
        <div class="card"><h2>Sent per day</h2>${pillBars({ labels: o.daily.map((x) => x.day), stacks: [{ name: "First", data: o.daily.map((x) => x.first), color: "#ff4d24" }, { name: "Follow-ups", data: o.daily.map((x) => x.followups), color: "#ffd23f" }] })}${keyLegend([["First emails", "#ff4d24"], ["Follow-ups", "#ffd23f"]])}</div>
        <div class="card"><h2>Replies per day</h2>${pillBars({ labels: o.daily.map((x) => x.day), stacks: [{ name: "Positive", data: o.daily.map((x) => x.positive), color: "#3ecf5a" }, { name: "Opt-outs", data: o.daily.map((x) => x.optOuts), hatch: true }] })}${keyLegend([["Positive", "#3ecf5a"], ["Opt-outs", "var(--hatch)"]])}</div>
      </div>
      <div class="grid three" style="margin-top:14px">
        <div class="card"><h2>Reply rate by source</h2>${o.bySource.length ? rowBars(o.bySource.map((r) => rateRow(r, srcName[r.k] || r.k)), { fmt: rateFmt }) : `<div class="empty">No emails in range</div>`}</div>
        <div class="card"><h2>By pitch variant</h2>${o.byVariant.length ? rowBars(o.byVariant.map((r) => rateRow(r, "Variant " + r.k)), { color: "var(--yellow)", fmt: rateFmt }) : `<div class="empty">–</div>`}</div>
        <div class="card"><h2>After how many follow-ups</h2>${o.byStep.length ? rowBars(o.byStep.map((r) => ({ ...rateRow(r, r.k == 0 ? "No follow-up yet" : `After FU${r.k}`) })), { color: "var(--violet)", fmt: rateFmt }) : `<div class="empty">–</div>`}</div>
      </div>
      <div class="grid halves" style="margin-top:14px">
        <div class="card"><h2>Inboxes today</h2>${o.inboxes.map((i) => `<div class="leg" style="display:block;margin-bottom:8px"><div style="display:flex;justify-content:space-between"><span>${i.inbox}@</span><span class="label">bounce 3d <b class="${(i.bounce3d || 0) > 4 ? "late" : ""}">${pct(i.bounce3d ?? 0)}</b></span></div><div class="v">${num(i.newToday)} <span class="sub">/ ${i.newCap} new</span></div><div class="prog"><i style="width:${Math.min(100, (i.newToday / i.newCap) * 100)}%;background:var(--orange)"></i></div></div>`).join("")}</div>
        <div class="card"><h2>When leads reply (IST)</h2>${o.repliesByHour.some(Boolean) ? `<div class="hours">${o.repliesByHour.map((v, h) => `<i title="${h}:00 · ${v}" style="height:${(v / Math.max(...o.repliesByHour)) * 100}%"></i>`).join("")}</div><div style="display:flex;justify-content:space-between" class="label"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>` : `<div class="empty">Appears once the inbox scripts are installed</div>`}
          <h2 style="margin-top:20px">Lead status, all time</h2>${rowBars(o.pipeline.map((p) => ({ name: (p.k || "(blank)").replace(/_/g, " "), value: p.n })), { color: "#555" })}
        </div>
      </div>`;
    bindRange(render);
    bindCharts();
  }

  async function pageProduct() {
    const qs = `${rangeQS(phRange)}&interval=${phOpts.interval}&compare=${phOpts.compare ? 1 : 0}`;
    const bar = rangeBar(`<select id="phInterval" aria-label="Interval"><option value="">Auto interval</option>${["hour", "day", "week", "month"].map((v) => `<option value="${v}" ${phOpts.interval === v ? "selected" : ""}>By ${v}</option>`).join("")}</select><label class="toggle"><input type="checkbox" id="phCompare" ${phOpts.compare ? "checked" : ""}> compare</label>`, "ph");
    main().innerHTML = `${head("Product")}${bar}<div class="skeleton" style="margin-top:14px"></div>`;
    bindRange(render, "ph");
    bindPh();
    const d = await api(`/api/product?${qs}`);
    if (!d.insights.length) {
      main().innerHTML = `${head("Product")}${bar}<div class="card" style="margin-top:12px"><div class="empty">No PostHog data yet. Check the PostHog row on the System tab.</div></div>`;
      bindRange(render, "ph");
      bindPh();
      return;
    }
    const groups = {};
    d.insights.forEach((i) => (groups[i.dashboard_id] ??= []).push(i));
    let html = "";
    for (const [dash, list] of Object.entries(groups)) {
      const bold = list.filter((i) => i.display === "BoldNumber");
      const rest = list.filter((i) => i.display !== "BoldNumber");
      html += `<div class="section-title">${esc(PH_DASH[dash] || "Dashboard " + dash)}<a href="${esc(d.host)}/dashboard/${esc(dash)}" target="_blank" rel="noopener">PostHog ↗</a></div>
        ${bold.length ? boldHeroes(bold, phRange.preset === "default" && !phRange.from ? "Ranges as set in PostHog" + (phOpts.compare ? " · change vs the period before" : "") : rangeLabel("ph") + (phOpts.compare ? " · change vs the period before" : "")) : ""}
        <div class="grid halves" style="margin-top:14px">${rest.map((i) => insightCard(i, d.host)).join("")}</div>`;
    }
    $(".skeleton")?.remove();
    main().insertAdjacentHTML("beforeend", html);
    bindCharts();
  }
  function bindPh() {
    const i = $("#phInterval"), c = $("#phCompare");
    if (i) i.onchange = () => { phOpts.interval = i.value; store.set("ph", phOpts); render(); };
    if (c) c.onchange = () => { phOpts.compare = c.checked; store.set("ph", phOpts); render(); };
  }

  // ---------- inbox ----------
  const KIND = { reply: "Reply", escalation: "Escalated", flagged: "Security review", enterprise: "Enterprise", report: "Report", subscription: "Billing", abandoned: "Checkout", system: "System", bounce: "Deliverability" };
  function ageInfo(it) {
    const hrs = (Date.now() - toDate(it.at)) / 3600000;
    return { text: hrs < 1 ? `${Math.max(1, Math.round(hrs * 60))}m` : hrs < 48 ? `${Math.round(hrs)}h` : `${Math.round(hrs / 24)}d`, late: hrs > it.slaHours };
  }
  const itemHref = (it) => (it.threadId && it.inbox ? `#thread/${encodeURIComponent(it.inbox)}/${encodeURIComponent(it.threadId)}?k=${encodeURIComponent(it.key)}` : `#item/${encodeURIComponent(it.key)}`);
  function queueList(items, compactMode = false) {
    if (!items.length) return `<div class="card"><div class="empty">Nothing waiting on you.</div></div>`;
    return `<div class="list">${items.map((it) => {
      const a = ageInfo(it);
      return `<a class="item" href="${itemHref(it)}"><div class="t"><span class="badge p${it.priority}">P${it.priority}</span>${esc(it.title)}</div>
        <div class="d">${esc(it.detail)}</div>
        <div class="m"><span>${esc(KIND[it.kind] || it.kind)}</span>${it.inbox ? `<span>${esc(it.inbox)}@</span>` : ""}<span class="${a.late ? "late" : ""}">waiting ${a.text}${a.late ? " · over SLA" : ""}</span>${it.suggested ? "<span>reply drafted</span>" : ""}</div></a>`;
    }).join("")}</div>`;
  }
  function bindQueue() { /* links handle navigation */ }

  let inboxFilter = "all";
  async function pageInbox() {
    const { items } = await api("/api/inbox");
    lastQueue = items;
    setCount(items.length);
    const filters = [["all", "All"], ["p0", "Urgent"], ["reply", "Replies"], ["apps", "App & billing"], ["system", "System"]];
    const shown = items.filter((i) => inboxFilter === "all" || (inboxFilter === "p0" && i.priority === 0) || (inboxFilter === "reply" && (i.kind === "reply" || i.kind === "escalation")) || (inboxFilter === "apps" && ["flagged", "enterprise", "report", "subscription", "abandoned"].includes(i.kind)) || (inboxFilter === "system" && ["system", "bounce"].includes(i.kind)));
    main().innerHTML = `${head("Inbox", `<span class="badge">${items.length} open</span>`)}
      <div class="filters">${filters.map(([k, l]) => `<button class="chip ${inboxFilter === k ? "on" : ""}" data-f="${k}">${l} ${k === "all" ? "" : `<span class="sub">${items.filter((i) => (k === "p0" && i.priority === 0) || (k === "reply" && (i.kind === "reply" || i.kind === "escalation")) || (k === "apps" && ["flagged", "enterprise", "report", "subscription", "abandoned"].includes(i.kind)) || (k === "system" && ["system", "bounce"].includes(i.kind))).length}</span>`}</button>`).join("")}</div>
      <div style="margin-top:12px">${queueList(shown)}</div>
      <div class="sub" style="margin-top:14px">Replies show up here when the newest message in a thread is from a lead. Answer here, or anywhere else: once a reply goes out in that thread, the item clears on its own.</div>`;
    $$("[data-f]").forEach((b) => (b.onclick = () => { inboxFilter = b.dataset.f; pageInbox(); }));
  }

  async function setState(key, state, hours) {
    await api("/api/inbox/state", { method: "POST", body: JSON.stringify({ key, state, hours }) });
  }
  const stateButtons = (key) => `<button class="btn" data-st="handled" data-key="${esc(key)}">✓ Handled</button><button class="btn" data-st="snoozed" data-key="${esc(key)}">Snooze 1 day</button><button class="btn" data-st="dead" data-key="${esc(key)}">Dead</button>`;
  function bindStateButtons(after = () => (location.hash = "#inbox")) {
    $$("[data-st]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await setState(b.dataset.key, b.dataset.st, 24); toast(b.dataset.st === "snoozed" ? "Snoozed for a day" : "Done"); after(); } catch (e) { toast(e.message); b.disabled = false; }
    }));
  }

  async function pageItem(key) {
    if (!lastQueue.length) lastQueue = (await api("/api/inbox")).items;
    const it = lastQueue.find((x) => x.key === key);
    if (!it) { main().innerHTML = `${head("Item")}<div class="card"><div class="empty">This item is already handled.</div></div>`; return; }
    const links = { flagged: "https://taptry.in", enterprise: it.leadEmail ? `mailto:${it.leadEmail}` : "", report: "https://taptry.in" };
    main().innerHTML = `${head(KIND[it.kind] || "Item", `<span class="badge p${it.priority}">P${it.priority}</span>`)}
      <div class="card"><h2>${esc(it.title)}</h2><div style="font-size:16px;line-height:1.5;white-space:pre-wrap">${esc(it.detail)}</div>
      <div class="sub" style="margin-top:10px">Waiting since ${esc(ist(it.at))}</div>
      <div class="btns" style="margin-top:16px">${links[it.kind] ? `<a class="btn primary" href="${esc(links[it.kind])}" target="_blank" rel="noopener">Open ↗</a>` : ""}${stateButtons(it.key)}</div></div>`;
    bindStateButtons();
  }

  async function pageThread(inbox, threadId, key) {
    main().innerHTML = `${head("Conversation")}<div class="skeleton"></div>`;
    if (!lastQueue.length) lastQueue = (await api("/api/inbox").catch(() => ({ items: [] }))).items;
    const it = lastQueue.find((x) => x.key === key || (x.threadId === threadId && x.inbox === inbox));
    const t = await api(`/api/thread/${encodeURIComponent(inbox)}/${encodeURIComponent(threadId)}`);
    const draftKey = `draft.${inbox}.${threadId}`;
    const saved = store.get(draftKey, "");
    const lead = [...t.messages].reverse().find((m) => !m.mine);
    main().innerHTML = `${head(it ? it.title : "Conversation", `<span class="badge">${esc(inbox)}@</span>${it ? `<span class="badge p${it.priority}">P${it.priority}</span>` : ""}`)}
      ${t.live ? "" : `<div class="note err">Showing the stored copy: ${esc(t.error || "")}. Sending needs the ${esc(inbox)}@ web app.</div>`}
      ${it?.kind === "escalation" ? `<div class="note">Escalated #${esc(it.escalationId)}: ${esc(it.detail)}</div>` : ""}
      <div class="thread">${t.messages.map((m) => `<div class="msg ${m.mine ? "mine" : ""}"><div class="h">${esc(m.mine ? "You · " + inbox + "@" : m.from)} · ${esc(ist(new Date(m.date).toISOString()))}</div>${esc(m.body)}</div>`).join("") || `<div class="empty">No messages</div>`}</div>
      <div class="composer">
        <div class="label">Reply to ${esc(lead ? lead.from : "the lead")} from ${esc(inbox)}@taptry.in</div>
        <textarea id="replyBody" placeholder="Write your reply…">${esc(saved || it?.suggested || "")}</textarea>
        <input id="aiNote" class="search" style="margin:0" placeholder="Optional note for the AI draft (e.g. offer a call, mention the free plan)">
        <div class="btns">
          <button class="btn hot" id="sendBtn">Send reply</button>
          <button class="btn" id="aiBtn">✦ AI draft</button>
          ${it ? stateButtons(it.key) : ""}
        </div>
        <div class="sub">${it?.suggested ? "Pre-filled with the suggested reply from the escalation. " : ""}Sends as a reply in this Gmail thread, signed as you write it.</div>
      </div>`;
    const ta = $("#replyBody");
    ta.oninput = () => store.set(draftKey, ta.value);
    $("#aiBtn").onclick = async () => {
      const b = $("#aiBtn");
      b.disabled = true; b.textContent = "Drafting…";
      try {
        const r = await api(`/api/thread/${encodeURIComponent(inbox)}/${encodeURIComponent(threadId)}/draft`, { method: "POST", body: JSON.stringify({ note: $("#aiNote").value }) });
        ta.value = r.draft; store.set(draftKey, ta.value);
      } catch (e) { toast(e.message, 5000); }
      b.disabled = false; b.textContent = "✦ AI draft";
    };
    $("#sendBtn").onclick = async () => {
      const body = ta.value.trim();
      if (body.length < 2) return toast("Write a reply first");
      if (!confirm(`Send this reply from ${inbox}@taptry.in?`)) return;
      const b = $("#sendBtn");
      b.disabled = true; b.textContent = "Sending…";
      try {
        await api(`/api/thread/${encodeURIComponent(inbox)}/${encodeURIComponent(threadId)}/reply`, { method: "POST", body: JSON.stringify({ body, escalationId: it?.escalationId }) });
        store.set(draftKey, "");
        lastQueue = lastQueue.filter((x) => x !== it);
        toast("Sent ✓");
        location.hash = "#inbox";
      } catch (e) { toast(e.message, 6000); b.disabled = false; b.textContent = "Send reply"; }
    };
    bindStateButtons();
  }

  // ---------- leads ----------
  let leadQ = store.get("leadQ", { status: "", source: "", inbox: "", sort: "last_touch", dir: "desc", page: 1, q: "" });
  const STATUS = [["", "Active"], ["replied", "Replied"], ["sent", "Sent"], ["followed_up", "Followed up"], ["opted_out", "Opted out"], ["bounced", "Bounced"], ["do_not_contact", "Do not contact"], ["queued", "Queued"], ["skip", "Skipped"]];
  async function pageLeads() {
    const qs = new URLSearchParams(Object.entries(leadQ).filter(([, v]) => v !== "" && v != null)).toString();
    const d = await api(`/api/leads?${qs}`);
    const srcs = [...new Set(d.facets.filter((f) => f.f === "source").map((f) => f.v))].filter(Boolean);
    const sortSel = [["last_touch", "Last touch"], ["first_sent", "First sent"], ["last_reply", "Last reply"], ["installs", "Installs"], ["developer", "Name"], ["followups", "Follow-ups"]];
    const statusBadge = (s) => `<span class="badge ${s === "replied" ? "ok" : ["bounced", "opted_out", "do_not_contact"].includes(s) ? "err" : ""}">${esc((s || "–").replace("_", " "))}</span>`;
    main().innerHTML = `${head("Leads", `<span class="badge">${num(d.total)}</span>`)}
      <input class="search" id="leadSearch" placeholder="Search name, app or email" value="${esc(leadQ.q)}">
      <div class="filters">${STATUS.map(([k, l]) => `<button class="chip ${leadQ.status === k ? "on" : ""}" data-status="${k}">${l}</button>`).join("")}</div>
      <div class="filters" style="margin-top:6px">
        <select id="lSource"><option value="">All sources</option>${srcs.map((s) => `<option ${leadQ.source === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
        <select id="lInbox"><option value="">All inboxes</option>${["connect", "reachout", "hello"].map((s) => `<option ${leadQ.inbox === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <select id="lSort">${sortSel.map(([k, l]) => `<option value="${k}" ${leadQ.sort === k ? "selected" : ""}>Sort: ${l}</option>`).join("")}</select>
        <button class="chip" id="lDir">${leadQ.dir === "asc" ? "↑ Oldest" : "↓ Newest"}</button>
      </div>
      <div class="card only-wide" style="margin-top:12px"><table class="t"><tr><th>Developer · App</th><th>Status</th><th>Source</th><th>Inbox</th><th>First sent</th><th class="r">FU</th><th>Last reply</th></tr>
        ${d.rows.map((r) => `<tr class="click" data-lead="${esc(r.email)}"><td><b style="font-weight:500">${esc(r.developer || r.email)}</b><div class="sub">${esc(r.app)}</div></td><td>${statusBadge(r.status)}</td><td>${esc(r.source_kind)}</td><td>${esc(r.inbox)}</td><td>${esc(ist(r.first_sent_at, { day: "numeric", month: "short" }))}</td><td class="r">${r.fu_count}</td><td>${r.last_reply_at ? esc(ago(r.last_reply_at)) : "–"}</td></tr>`).join("")}
      </table></div>
      <div class="list only-narrow" style="margin-top:12px">${d.rows.map((r) => `<a class="item" href="#lead/${encodeURIComponent(r.email)}"><div class="t">${esc(r.developer || r.email)} ${statusBadge(r.status)}</div><div class="d">${esc(r.app)}</div><div class="m"><span>${esc(r.source_kind)}</span><span>${esc(r.inbox)}@</span><span>sent ${esc(ist(r.first_sent_at, { day: "numeric", month: "short" }))}</span><span>FU${r.fu_count}</span>${r.last_reply_at ? `<span>replied ${esc(ago(r.last_reply_at))}</span>` : ""}</div></a>`).join("")}</div>
      ${d.rows.length ? "" : `<div class="card"><div class="empty">No leads match</div></div>`}
      <div class="pager"><button class="btn" id="prev" ${d.page <= 1 ? "disabled" : ""}>← Prev</button><span class="sub">Page ${d.page} of ${d.pages}</span><button class="btn" id="next" ${d.page >= d.pages ? "disabled" : ""}>Next →</button></div>`;
    const go = (patch) => { leadQ = { ...leadQ, ...patch }; store.set("leadQ", leadQ); pageLeads(); };
    let deb;
    $("#leadSearch").oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => go({ q: e.target.value, page: 1 }), 350); };
    $$("[data-status]").forEach((b) => (b.onclick = () => go({ status: b.dataset.status, page: 1 })));
    $("#lSource").onchange = (e) => go({ source: e.target.value, page: 1 });
    $("#lInbox").onchange = (e) => go({ inbox: e.target.value, page: 1 });
    $("#lSort").onchange = (e) => go({ sort: e.target.value, page: 1 });
    $("#lDir").onclick = () => go({ dir: leadQ.dir === "asc" ? "desc" : "asc", page: 1 });
    $("#prev").onclick = () => go({ page: d.page - 1 });
    $("#next").onclick = () => go({ page: d.page + 1 });
    $$("[data-lead]").forEach((tr) => (tr.onclick = () => (location.hash = "#lead/" + encodeURIComponent(tr.dataset.lead))));
    const s = $("#leadSearch"); if (leadQ.q && document.activeElement !== s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }

  async function pageLead(email) {
    const d = await api(`/api/leads/${encodeURIComponent(email)}`);
    const l = d.lead;
    const demo = d.demo[0];
    const srcUrl = (String(l.source || "").match(/https?:\/\/\S+/) || [""])[0];
    main().innerHTML = `${head(l.developer || l.email, `<span class="badge">${esc(l.status)}</span>`)}
      <div class="grid two">
        <div class="card"><h2>${esc(l.app || "Lead")}</h2>
          <dl class="kv">
            <dt>Email</dt><dd><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></dd>
            <dt>Greeting</dt><dd>${esc(l.greeting)}</dd>
            <dt>Source</dt><dd>${esc(l.source_kind)}${srcUrl ? ` · <a href="${esc(srcUrl)}" target="_blank" rel="noopener">open ↗</a>` : ""}</dd>
            <dt>Installs</dt><dd>${esc(l.installs || "–")}</dd>
            <dt>Inbox</dt><dd>${esc(l.inbox)}@ · variant ${esc(l.variant || "–")}</dd>
            <dt>First sent</dt><dd>${esc(ist(l.first_sent_at))}</dd>
            <dt>Follow-ups</dt><dd>${l.fu_count}${l.fu_sent_at ? ` · last ${esc(ist(l.fu_sent_at))}` : ""}</dd>
            <dt>Last reply</dt><dd>${esc(l.last_reply_at ? ist(l.last_reply_at) : "–")}</dd>
            ${d.signup ? `<dt>TapTry account</dt><dd>Signed up ${esc(ist(d.signup.createdAt, { day: "numeric", month: "short" }))} · ${esc(d.signup.app_count)} apps${d.signup.plan ? ` · ${esc(d.signup.plan)}` : ""}</dd>` : ""}
            ${demo ? `<dt>Own-app demo</dt><dd><a href="https://taptry.in/app/${esc(demo.slug)}" target="_blank" rel="noopener">/app/${esc(demo.slug)}</a> · ${demo.held_by_taptry ? "not claimed yet" : "claimed"} · ${num(demo.runs_by_others)} runs</dd>` : ""}
            <dt>Notes</dt><dd style="white-space:pre-wrap;font-size:13px;color:#bdbdbd">${esc(l.notes)}</dd>
          </dl>
          <div class="btns" style="margin-top:16px">
            ${l.thread_id && l.inbox ? `<a class="btn primary" href="#thread/${encodeURIComponent(l.inbox)}/${encodeURIComponent(l.thread_id)}">Open conversation</a>` : ""}
            <button class="btn" data-ls="do_not_contact">Do not contact</button><button class="btn" data-ls="skip">Skip</button>
          </div>
          <div class="sub" style="margin-top:8px">Status changes are written back to the Outreach Tracker within 5 minutes, and the outreach tasks respect them.</div>
        </div>
        <div class="card"><h2>Timeline</h2>
          ${d.messages.length ? `<div class="thread">${d.messages.map((m) => `<div class="msg ${m.direction === "out" ? "mine" : ""}"><div class="h">${esc(m.direction === "out" ? m.inbox + "@" : m.from_addr)} · ${esc(m.kind)} · ${esc(ist(m.sent_at))}</div>${esc(m.text || m.subject || "")}</div>`).join("")}</div>` : `<div class="empty">No mail stored for this lead yet.</div>`}
          ${d.escalations.map((e) => `<div class="note" style="margin-top:10px">#${esc(e.id)} · ${esc(e.status)} · ${esc(e.summary)}</div>`).join("")}
        </div>
      </div>`;
    $$("[data-ls]").forEach((b) => (b.onclick = async () => {
      if (!confirm(`Mark ${l.email} as "${b.dataset.ls.replace(/_/g, " ")}"?`)) return;
      try { await api(`/api/leads/${encodeURIComponent(l.email)}/status`, { method: "POST", body: JSON.stringify({ status: b.dataset.ls }) }); toast("Saved"); pageLead(email); } catch (e) { toast(e.message); }
    }));
  }

  // ---------- system ----------
  const COLLECTORS = { aws_cost: "AWS costs · daily 8:30 AM", aws_fleet: "AWS fleet · hourly", posthog: "PostHog dashboards · hourly", appdb: "App database · hourly", mail_sync: "Inbox sync on demand" };
  async function pageSystem() {
    const [s, cfg] = await Promise.all([api("/api/system"), api("/api/config")]);
    const byName = Object.fromEntries(s.collectors.map((c) => [c.collector, c]));
    const fresh = (last, maxMin) => (!last ? "off" : Date.now() - toDate(last) > maxMin * 60000 ? "bad" : "");
    main().innerHTML = `${head("System")}
      <div class="card"><h2>Data collectors</h2><div class="list">${Object.entries(COLLECTORS).map(([k, label]) => {
        const c = byName[k];
        const st = !c ? `<span class="badge warn">not run yet</span>` : !c.finished_at ? `<span class="badge warn">running</span>` : c.ok ? `<span class="badge ok">ok · ${num(c.rows)}</span>` : `<span class="badge err">failed</span>`;
        return `<div class="item" style="cursor:default"><div class="t">${label} ${st}</div>${c && !c.ok && c.error ? `<div class="d late">${esc(c.error)}</div>` : ""}<div class="m"><span>last run ${c ? esc(ago(c.started_at)) : "never"}</span><span>last success ${c?.last_ok ? esc(ago(c.last_ok)) : "never"}</span></div><div><button class="btn sm" data-run="${k}">Run now</button></div></div>`;
      }).join("")}</div></div>
      <div class="grid halves" style="margin-top:14px">
        <div class="card"><h2>Google scripts</h2>${s.scripts.map((x) => `<div class="rowbar" style="grid-template-columns:1fr auto"><span><i class="dot ${fresh(x.last, x.maxMinutes)}"></i>${esc(x.name)}${x.webapp === false ? ` <span class="badge warn">web app not deployed</span>` : ""}</span><span class="n">${esc(ago(x.last))}</span></div>`).join("")}</div>
        <div class="card"><h2>Scheduled tasks (from the Log tab)</h2>${s.tasks.map((x) => `<div class="rowbar" style="grid-template-columns:1fr auto"><span><i class="dot ${!x.last ? "off" : Date.now() - toDate(x.last) > x.maxHours * 3600000 ? "bad" : ""}"></i>${esc(x.label)}</span><span class="n">${esc(ago(x.last))}</span></div>`).join("")}<div class="sub" style="margin-top:8px">Reply check and nudges only log when they had something to do, so a quiet day there is normal.</div></div>
      </div>
      <div class="grid halves" style="margin-top:14px">
        <div class="card"><h2>Keys</h2>${Object.entries({ aws: "AWS keys", posthog: "PostHog key", appdb: "App DB (APPDB_URL)", ingest: "Script secret (INGEST_SECRET)", ai: "AI drafts (ANTHROPIC_API_KEY)" }).map(([k, l]) => `<div class="rowbar" style="grid-template-columns:1fr auto"><span><i class="dot ${s.secrets[k] ? "" : "off"}"></i>${l}</span><span class="n">${s.secrets[k] ? "set" : "missing"}</span></div>`).join("")}</div>
        <div class="card"><h2>EC2 prices for the run-rate</h2><div class="sub">On-demand $/hour by "region:type", from the EC2 pricing page.</div>
          <textarea id="prices" class="search" style="border-radius:16px;min-height:90px;margin-top:10px;font-family:var(--mono);font-size:13px">${esc(JSON.stringify(cfg.ec2_prices || {}, null, 1))}</textarea>
          <button class="btn primary" id="savePrices">Save</button></div>
      </div>`;
    $$("[data-run]").forEach((b) => (b.onclick = async () => {
      b.disabled = true; b.textContent = "Running…";
      try { const r = await api("/api/run/" + b.dataset.run, { method: "POST" }); toast(r.ok ? `Done · ${r.rows} rows` : `Failed: ${r.error}`, 4000); } catch (e) { toast(e.message); }
      pageSystem();
    }));
    $("#savePrices").onclick = async () => {
      try { await api("/api/config/ec2_prices", { method: "PUT", body: JSON.stringify(JSON.parse($("#prices").value || "{}")) }); toast("Saved"); } catch (e) { toast("Not valid JSON: " + e.message); }
    };
  }

  // ---------- freshness ----------
  let refreshing = false;
  async function refreshStale(force = false) {
    if (refreshing) return;
    refreshing = true;
    const btn = $("#refreshBtn");
    btn.classList.add("spin");
    try {
      let { stale } = await api("/api/stale");
      if (force) stale = [...new Set([...stale, "mail_sync", "posthog", "aws_fleet", "appdb"])];
      if (stale.length) {
        const f = $("#fresh");
        f.hidden = false;
        f.innerHTML = `Refreshing <b>${stale.map((s) => s.replace("_", " ")).join(", ")}</b>…`;
        await Promise.allSettled(stale.map((s) => api("/api/run/" + s, { method: "POST" })));
        f.hidden = true;
        render();
      } else if (force) render();
    } catch { /* offline: keep what's shown */ }
    btn.classList.remove("spin");
    refreshing = false;
  }
  $("#refreshBtn").onclick = () => refreshStale(true);

  function setCount(n) { $("#navCount").textContent = n ? String(n) : ""; }

  // ---------- router ----------
  async function render() {
    charts.clear();
    const h = location.hash.slice(1) || "dashboard";
    const [path, query] = h.split("?");
    const parts = path.split("/").map(decodeURIComponent);
    const qp = new URLSearchParams(query || "");
    const tab = { thread: "inbox", item: "inbox", lead: "leads" }[parts[0]] || parts[0];
    $$("#nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + tab));
    const routes = {
      dashboard: pageDashboard, outreach: pageOutreach, product: pageProduct, costs: pageCosts, system: pageSystem, leads: pageLeads, inbox: pageInbox,
      lead: () => pageLead(parts[1]), item: () => pageItem(parts[1]), thread: () => pageThread(parts[1], parts[2], qp.get("k")),
    };
    const fn = routes[parts[0]] || pageDashboard;
    if (!main().innerHTML.includes("skeleton")) main().innerHTML = `<div class="skeleton" style="height:180px"></div>`;
    try {
      await fn();
    } catch (e) {
      if (e.message !== "login") main().innerHTML = `<div class="note err">Couldn't load this page: ${esc(e.message)}</div>`;
    }
    window.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", render);
  render().then(() => refreshStale(false));
  api("/api/inbox").then((r) => setCount(r.items.length)).catch(() => {});
})();
