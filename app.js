// PlateLog: photograph a meal, let Claude estimate it, correct the portions, track the day.
// Photo analysis uses Google Gemini's free tier by default; Claude is an optional paid alternative.
// Everything (meals, weights, settings, keys) stays in this browser's storage.

const SDK_URL = "https://esm.sh/@anthropic-ai/sdk@1.8.0?bundle";
const DEMO = new URLSearchParams(location.search).has("demo");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
// Free Gemini models, best first. If one is busy or over its free limit, the next is tried.
const FREE_MODELS = ["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.5-flash-lite"];
const MODELS = [
  ["gemini-4-hydrogen", "Google Gemini 4 Hydrogen (free)"],
  ["gemini-3.8-flash", "Google Gemini 3.8 Flash (free)"],
  ["gemini-3.5-flash-lite", "Google Gemini 3.5 Flash-Lite (free, fastest)"],
  ["claude-opus-5-5", "Claude Opus 5.5 (paid)"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 (paid)"],
  ["claude-haiku-5-5", "Claude Haiku 5.5 (paid)"],
];
const isGemini = (model) => model.startsWith("gemini");

const NUTRIENTS = ["calories", "protein_g", "carbs_g", "sugar_g", "fat_g", "fiber_g", "calories_low", "calories_high"];

const state = {
  settings: {
    geminiKey: "", // free Google AI Studio key
    apiKey: "",    // optional paid Claude key
    model: "gemini-4-hydrogen",
    kcalGoal: 2000,
    proteinGoal: 75,
    carbGoal: 250,
    fatGoal: 65,
    sugarLimit: 30,
  },
  meals: [],   // {id, ts, date, name, thumb, items[], confidence, notes}
  weights: [], // {date, kg}
};

let tab = "today";
let historyDay = null;
let draft = null; // meal being analysed or reviewed

// ---------- storage (IndexedDB, one record) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("platelog", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadState() {
  try {
    const db = await openDb();
    const saved = await new Promise((resolve, reject) => {
      const r = db.transaction("kv").objectStore("kv").get("state");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (saved) applyState(saved);
  } catch (err) {
    toast("Could not read saved data: " + err.message);
  }
}

function applyState(saved) {
  Object.assign(state.settings, saved.settings || {});
  if (!MODELS.some(([id]) => id === state.settings.model)) state.settings.model = "gemini-4-hydrogen";
  state.meals = Array.isArray(saved.meals) ? saved.meals : [];
  state.weights = Array.isArray(saved.weights) ? saved.weights : [];
}

async function saveState() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(JSON.parse(JSON.stringify(state)), "state");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    toast("Could not save: " + err.message);
  }
}

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round = (n) => Math.round(Number(n) || 0);
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const niceDate = (key) => fromKey(key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
const timeOf = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function totals(items) {
  const t = Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
  for (const it of items) for (const k of NUTRIENTS) t[k] += Number(it[k]) || 0;
  return t;
}
const mealsOn = (key) => state.meals.filter((m) => m.date === key).sort((a, b) => a.ts - b.ts);
const dayTotals = (key) => totals(mealsOn(key).flatMap((m) => m.items));

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- image handling ----------

async function loadImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function scaled(img, maxEdge, quality) {
  const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

// ---------- Claude ----------

const SYSTEM = `You estimate the nutrition of meals for a personal calorie tracker. The person relies on these numbers, so be as accurate as the evidence allows and honest about what it does not show.

Method:
- List each distinct food or drink as its own item. For a mixed dish, keep it as one item unless the parts are clearly separable.
- Estimate each portion's weight in grams from visual scale: plate and bowl size, cutlery, hands, packaging, glass size. A dinner plate is usually 25 to 28 cm across.
- Use standard food composition values for the food as cooked. Include what is absorbed or added in cooking and serving: oil, butter, ghee, cream, sugar, dressings, sauces. Restaurant and fried food carries more fat than home cooking.
- Count only what one person would eat from the photo, unless told otherwise.
- Keep the numbers consistent: calories should be close to 4 per gram of protein, 4 per gram of carbohydrate and 9 per gram of fat. sugar_g is part of carbs_g.
- calories_low and calories_high are an honest range for that item given what you cannot see (portion depth, hidden fat, fillings).
- confidence is "high" only when the food and the portion are both clear.
- notes: one or two short sentences on the assumptions that matter most.
- question: the single question whose answer would narrow the estimate most, or an empty string if nothing important is unknown.
- If there is no food or drink to estimate, set is_food to false, leave items empty and say why in notes.
- The person's own notes and corrections outrank what you infer from the photo.`;

const num = { type: "number" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_food", "meal_name", "items", "confidence", "notes", "question"],
  properties: {
    is_food: { type: "boolean" },
    meal_name: { type: "string", description: "Short name for the whole meal, e.g. 'Chicken curry with rice'" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "portion", "grams", ...NUTRIENTS],
        properties: {
          name: { type: "string" },
          portion: { type: "string", description: "Everyday description, e.g. '2 medium pieces', '1 cup'" },
          grams: num,
          calories: num,
          protein_g: num,
          carbs_g: num,
          sugar_g: num,
          fat_g: num,
          fiber_g: num,
          calories_low: num,
          calories_high: num,
        },
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    notes: { type: "string" },
    question: { type: "string" },
  },
};

async function analyze({ image, note, previous, correction }) {
  if (DEMO) return demoResult();
  const model = state.settings.model;

  const text = [];
  text.push(image ? "Estimate the nutrition of the food in this photo." : "Estimate the nutrition of the meal described below.");
  if (note) text.push(`The person's note: ${note}`);
  if (previous) {
    text.push(`Your earlier estimate was:\n${JSON.stringify(previous)}`);
    text.push(`The person's correction: ${correction}\nReturn the complete revised estimate.`);
  }
  const prompt = text.join("\n\n");
  const data = image ? image.slice(image.indexOf(",") + 1) : "";

  const out = isGemini(model) ? await askGemini(model, prompt, data) : await askClaude(model, prompt, data);
  return parseEstimate(out);
}

function parseEstimate(out) {
  try {
    // Tolerate a code fence or stray words around the JSON object.
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  } catch {
    throw new Error("The answer could not be read. Try again.");
  }
}

// ---------- Google Gemini (free tier) ----------

async function askGemini(model, prompt, imageData) {
  const key = state.settings.geminiKey;
  if (!key) throw new Error("Add the free Google Gemini key in Settings first.");

  const input = [{ type: "text", text: prompt }];
  if (imageData) input.push({ type: "image", data: imageData, mime_type: "image/jpeg" });

  const order = [model, ...FREE_MODELS.filter((m) => m !== model)];
  let lastError;
  for (const m of order) {
    try {
      return await geminiCall(key, m, input, true);
    } catch (err) {
      lastError = err;
      // A schema the server will not accept: ask again with the format described in words.
      if (err.status === 400 && !err.badKey) {
        try {
          return await geminiCall(key, m, input, false);
        } catch (err2) {
          lastError = err2;
        }
      }
      const tryNext = [404, 429, 500, 503].includes(lastError.status);
      if (!tryNext) break;
    }
  }
  if (lastError.status === 429) {
    throw new Error("The free limit is used up for now. Wait a minute and try again; if it keeps happening, the daily limit is reached and resets tomorrow.");
  }
  throw lastError;
}

async function geminiCall(key, model, input, structured) {
  const body = {
    model,
    input,
    system_instruction: structured
      ? SYSTEM
      : `${SYSTEM}\n\nReply with one JSON object only, no other text, matching this JSON schema:\n${JSON.stringify(SCHEMA)}`,
    store: false,
  };
  if (structured) body.response_format = { type: "text", mime_type: "application/json", schema: SCHEMA };

  let res;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("No connection to Google. Check the internet and try again.");
  }
  let json = await res.json().catch(() => null);
  if (Array.isArray(json)) json = json[0];

  if (!res.ok) {
    const info = json?.error || {};
    const badKey =
      res.status === 401 || res.status === 403 || (info.details || []).some((d) => d.reason === "API_KEY_INVALID");
    const err = new Error(
      badKey ? "The Google key was rejected. Check it in Settings." : `Google returned an error (${res.status}): ${info.message || "unknown"}`
    );
    err.status = res.status;
    err.badKey = badKey;
    throw err;
  }
  if (json?.status && json.status !== "completed") {
    throw new Error(`Google did not finish the analysis (${json.status}). Try again or use a different photo.`);
  }
  const blocks = (json?.steps || json?.outputs || []).flatMap((s) => (s.content ? s.content : [s]));
  const out = blocks.filter((b) => b && typeof b.text === "string" && (!b.type || b.type === "text")).map((b) => b.text).join("");
  if (!out) throw new Error("Google returned an empty answer. Try again or use a different photo.");
  return out;
}

// ---------- Claude (optional, paid) ----------

async function askClaude(model, prompt, imageData) {
  if (!state.settings.apiKey) throw new Error("Add a Claude API key in Settings, or switch the model to a free Google one.");

  let Anthropic;
  try {
    ({ default: Anthropic } = await import(SDK_URL));
  } catch {
    throw new Error("Could not load the Claude library. Check the internet connection and try again.");
  }
  // The key is typed in by the person who owns this phone and is stored only on it,
  // which is why calling the API straight from the browser is acceptable here.
  const client = new Anthropic({ apiKey: state.settings.apiKey, dangerouslyAllowBrowser: true });

  const content = [];
  if (imageData) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } });
  content.push({ type: "text", text: prompt });

  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
  };

  let res;
  try {
    // If the model declines a request, Opus and Sonnet can hand it to a fallback
    // model inside the same call. Haiku has no server-side fallback.
    res =
      model === "claude-haiku-5-5"
        ? await client.messages.create(params)
        : await client.beta.messages.create({
            ...params,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new Error("The Claude key was rejected. Check it in Settings.");
    }
    if (err instanceof Anthropic.RateLimitError) throw new Error("Too many requests just now. Wait a minute and try again.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("No connection to Claude. Check the internet and try again.");
    if (err instanceof Anthropic.APIError) throw new Error(`Claude returned an error (${err.status ?? "?"}): ${err.message}`);
    throw err;
  }

  if (res.stop_reason === "refusal") throw new Error("Claude declined to analyse this. Try a different photo.");
  if (res.stop_reason === "max_tokens") throw new Error("The answer was cut off. Try again.");
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function demoResult() {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          is_food: true,
          meal_name: "Grilled chicken, rice and salad",
          items: [
            { name: "Grilled chicken breast", portion: "1 medium piece", grams: 150, calories: 248, protein_g: 46, carbs_g: 0, sugar_g: 0, fat_g: 5.4, fiber_g: 0, calories_low: 210, calories_high: 300 },
            { name: "Steamed white rice", portion: "1 cup", grams: 180, calories: 234, protein_g: 4.8, carbs_g: 51, sugar_g: 0.2, fat_g: 0.5, fiber_g: 0.7, calories_low: 190, calories_high: 290 },
            { name: "Green salad with dressing", portion: "1 small bowl", grams: 90, calories: 85, protein_g: 1.2, carbs_g: 5, sugar_g: 3, fat_g: 7, fiber_g: 1.8, calories_low: 40, calories_high: 140 },
          ],
          confidence: "medium",
          notes: "Demo data, not a real analysis. Assumed the chicken was grilled with little oil.",
          question: "Was the salad dressing oil-based or creamy, and roughly how much?",
        }),
      900
    )
  );
}

// ---------- views ----------

function render() {
  const titles = { today: "Today", history: "History", weight: "Weight", settings: "Settings" };
  $("#title").textContent = titles[tab];
  $("#subtitle").textContent = tab === "today" ? niceDate(dateKey()) : "";
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#view").innerHTML = { today: viewToday, history: viewHistory, weight: viewWeight, settings: viewSettings }[tab]();
}

function bar(label, value, goal, color, isLimit) {
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0;
  const over = isLimit && goal > 0 && value > goal;
  return `<div class="bar">
    <label><span>${label}</span><span class="num ${over ? "over" : ""}">${round(value)} / ${round(goal)} g${over ? " (over)" : ""}</span></label>
    <div class="track"><div class="fill" style="width:${pct}%;--c:${over ? "var(--bad)" : color}"></div></div>
  </div>`;
}

function summaryCard(key) {
  const s = state.settings;
  const t = dayTotals(key);
  const left = s.kcalGoal - t.calories;
  const over = left < 0;
  const pct = s.kcalGoal > 0 ? Math.min(100, (t.calories / s.kcalGoal) * 100) : 0;
  return `<section class="card">
    <div class="summary">
      <div class="ring" style="--p:${pct};--c:${over ? "var(--bad)" : "var(--accent)"}">
        <div><b class="num">${round(t.calories)}</b><span class="small muted">kcal eaten</span></div>
      </div>
      <div class="side">
        <span class="muted">Goal ${round(s.kcalGoal)} kcal</span>
        <b class="num ${over ? "over" : ""}">${round(Math.abs(left))} kcal ${over ? "over" : "left"}</b>
        <span class="small muted">Fiber ${round(t.fiber_g)} g</span>
      </div>
    </div>
    <div class="bars">
      ${bar("Protein", t.protein_g, s.proteinGoal, "var(--protein)")}
      ${bar("Carbs", t.carbs_g, s.carbGoal, "var(--carbs)", true)}
      ${bar("of which sugar", t.sugar_g, s.sugarLimit, "var(--carbs)", true)}
      ${bar("Fat", t.fat_g, s.fatGoal, "var(--fat)", true)}
    </div>
  </section>`;
}

function mealList(key) {
  const meals = mealsOn(key);
  if (!meals.length) return `<p class="muted">No meals logged.</p>`;
  return meals
    .map((m) => {
      const t = totals(m.items);
      const pic = m.thumb ? `<img src="${m.thumb}" alt="">` : `<span class="ph">🍽</span>`;
      return `<button class="meal" data-act="open" data-id="${m.id}">
        ${pic}
        <span class="info"><b>${esc(m.name)}</b>
          <span class="small muted">${timeOf(m.ts)} · carbs ${round(t.carbs_g)} g · sugar ${round(t.sugar_g)} g</span></span>
        <span class="kcal num">${round(t.calories)}</span>
      </button>`;
    })
    .join("");
}

function viewToday() {
  const s = state.settings;
  const needKey = !DEMO && !(isGemini(s.model) ? s.geminiKey : s.apiKey);
  return `
    ${needKey ? `<p class="note">One-time setup: add the free Google key in <button class="link" data-act="goto" data-to="settings">Settings</button> to analyse photos.</p>` : ""}
    ${summaryCard(dateKey())}
    <button class="btn primary big" data-act="camera">📷 Photograph a meal</button>
    <div class="row">
      <button class="btn" data-act="gallery">Choose a photo</button>
      <button class="btn" data-act="describe">Type it instead</button>
    </div>
    <section class="card"><h2>Meals today</h2>${mealList(dateKey())}</section>`;
}

function viewHistory() {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(dateKey(d));
  }
  historyDay ??= dateKey();
  const goal = state.settings.kcalGoal;
  const vals = days.map((k) => dayTotals(k).calories);
  const max = Math.max(goal * 1.25, ...vals, 1);
  const logged = vals.slice(-7).filter((v) => v > 0);
  const avg = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;

  const cols = days
    .map((k, i) => {
      const cls = ["col", vals[i] > goal ? "over" : "", k === historyDay ? "sel" : ""].join(" ");
      return `<button class="${cls}" data-act="day" data-day="${k}" aria-label="${niceDate(k)}: ${round(vals[i])} kcal">
        <i style="height:${(vals[i] / max) * 100}%"></i></button>`;
    })
    .join("");
  const labels = days.map((k) => `<span>${fromKey(k).getDate()}</span>`).join("");

  return `
    <section class="card">
      <h2>Last 14 days</h2>
      <div class="chart">${cols}<div class="goal" style="bottom:${(goal / max) * 100}%"></div></div>
      <div class="xlab">${labels}</div>
      <p class="small muted" style="margin-top:8px">Dashed line is the ${round(goal)} kcal goal. Average over logged days this week: <b class="num">${round(avg)}</b> kcal. Tap a bar to see that day.</p>
    </section>
    <h2 style="font-size:19px">${niceDate(historyDay)}</h2>
    ${summaryCard(historyDay)}
    <section class="card"><h2>Meals</h2>${mealList(historyDay)}</section>`;
}

function weightChart(list) {
  if (list.length < 2) return `<p class="muted">Add two or more entries to see the trend.</p>`;
  const W = 320, H = 170, px = 34, py = 16;
  const t0 = fromKey(list[0].date).getTime();
  const t1 = fromKey(list.at(-1).date).getTime();
  const kgs = list.map((w) => w.kg);
  let lo = Math.min(...kgs), hi = Math.max(...kgs);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const x = (w) => px + ((fromKey(w.date).getTime() - t0) / (t1 - t0 || 1)) * (W - px - 8);
  const y = (kg) => py + (1 - (kg - lo) / (hi - lo)) * (H - 2 * py);
  const pts = list.map((w) => `${x(w).toFixed(1)},${y(w.kg).toFixed(1)}`).join(" ");
  const dots = list.map((w) => `<circle cx="${x(w).toFixed(1)}" cy="${y(w.kg).toFixed(1)}" r="3.5" fill="var(--accent)"/>`).join("");
  return `<svg class="linechart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time">
    <line x1="${px}" x2="${W - 8}" y1="${y(hi)}" y2="${y(hi)}" stroke="var(--line)"/>
    <line x1="${px}" x2="${W - 8}" y1="${y(lo)}" y2="${y(lo)}" stroke="var(--line)"/>
    <text x="0" y="${y(hi) + 4}" font-size="11" fill="var(--muted)">${hi.toFixed(1)}</text>
    <text x="0" y="${y(lo) + 4}" font-size="11" fill="var(--muted)">${lo.toFixed(1)}</text>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

function viewWeight() {
  const list = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
  const latest = list.at(-1);
  const change = list.length > 1 ? latest.kg - list[0].kg : 0;
  const rows = [...list]
    .reverse()
    .map(
      (w) => `<div class="wrow"><span>${niceDate(w.date)}</span>
        <span><b class="num">${w.kg.toFixed(1)} kg</b>
        <button class="link" data-act="delWeight" data-day="${w.date}" aria-label="Delete entry for ${niceDate(w.date)}">✕</button></span></div>`
    )
    .join("");
  return `
    <section class="card">
      <h2>Log weight</h2>
      <div class="grid2">
        <label class="field"><span>Date</span><input id="wDate" type="date" value="${dateKey()}" max="${dateKey()}"></label>
        <label class="field"><span>Weight (kg)</span><input id="wKg" type="number" inputmode="decimal" step="0.1" min="20" max="300" placeholder="${latest ? latest.kg.toFixed(1) : "70.0"}"></label>
      </div>
      <button class="btn primary" data-act="addWeight" style="width:100%">Save weight</button>
    </section>
    <section class="card">
      <h2>Trend</h2>
      ${latest ? `<p style="margin-bottom:8px"><b class="num">${latest.kg.toFixed(1)} kg</b> <span class="muted">${list.length > 1 ? `(${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(1)} kg since ${niceDate(list[0].date)})` : ""}</span></p>` : ""}
      ${weightChart(list)}
    </section>
    ${rows ? `<section class="card"><h2>Entries</h2>${rows}</section>` : ""}`;
}

function viewSettings() {
  const s = state.settings;
  const n = (id, label, val) =>
    `<label class="field"><span>${label}</span><input id="${id}" type="number" inputmode="numeric" min="0" value="${val}"></label>`;
  return `
    <section class="card">
      <h2>Photo analysis</h2>
      <label class="field"><span>Free Google Gemini key</span>
        <input id="sGemini" type="password" autocomplete="off" value="${esc(s.geminiKey)}" placeholder="Paste the key here"></label>
      <p class="small muted" style="margin-bottom:12px">Free, set up once: sign in at aistudio.google.com/apikey with a Google account, create a key and paste it here. Google may use photos sent on the free tier to improve its products.</p>
      <label class="field"><span>Model</span>
        <select id="sModel">${MODELS.map(([id, label]) => `<option value="${id}" ${id === s.model ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="field"><span>Claude API key (optional, only for the paid models)</span>
        <input id="sKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="sk-ant-..."></label>
      <p class="small muted" style="margin-bottom:12px">Keys are stored only on this device and sent only to the service they belong to.</p>
      ${s.geminiKey ? `<button class="btn" data-act="copySetup" style="width:100%">Copy setup link for another phone</button>` : ""}
    </section>
    <section class="card">
      <h2>Daily goals</h2>
      ${n("sKcal", "Calories (kcal)", s.kcalGoal)}
      <div class="grid2">
        ${n("sProtein", "Protein goal (g)", s.proteinGoal)}
        ${n("sCarb", "Carbs limit (g)", s.carbGoal)}
        ${n("sFat", "Fat limit (g)", s.fatGoal)}
        ${n("sSugar", "Sugar limit (g)", s.sugarLimit)}
      </div>
      <button class="btn primary" data-act="saveSettings" style="width:100%">Save settings</button>
    </section>
    <section class="card">
      <h2>Getting accurate numbers</h2>
      <p class="small">Photograph from above with the whole plate in frame, in good light, with a spoon or fork next to it for scale. Add a note for anything the camera cannot see (oil, ghee, sugar, what is inside). Always check the portion weights on the review screen: a photo alone is usually within 20 to 30 percent, and a corrected portion is much closer. A kitchen scale makes it exact.</p>
    </section>
    <section class="card">
      <h2>Backup</h2>
      <p class="small muted" style="margin-bottom:10px">Data lives only in this browser. Export a backup now and then; clearing browser data deletes it.</p>
      <div class="row">
        <button class="btn" data-act="export">Export</button>
        <button class="btn" data-act="import">Import</button>
      </div>
    </section>`;
}

// ---------- meal sheet ----------

function openSheet() {
  $("#sheet").hidden = false;
  renderSheet();
  $("#sheet").scrollTop = 0;
}
function closeSheet() {
  draft = null;
  $("#sheet").hidden = true;
  $("#sheet").innerHTML = "";
}

function itemRow(it, i) {
  return `<div class="item">
    <div class="line1">
      <input type="text" data-field="name" data-i="${i}" value="${esc(it.name)}" aria-label="Food name">
      <button class="x" data-act="delItem" data-i="${i}" aria-label="Remove ${esc(it.name)}">✕</button>
    </div>
    <div class="line2">
      <input class="grams" type="number" inputmode="decimal" min="0" data-field="grams" data-i="${i}" value="${round(it.grams)}" aria-label="Weight in grams">
      <span class="muted">g</span>
      <button class="chip" data-act="scale" data-i="${i}" data-k="0.5">½</button>
      <button class="chip" data-act="scale" data-i="${i}" data-k="1.5">1½</button>
      <button class="chip" data-act="scale" data-i="${i}" data-k="2">×2</button>
      <span class="kc num" data-kc="${i}">${round(it.calories)} kcal</span>
    </div>
    <span class="small muted" data-mac="${i}">${macroLine(it)}</span>
  </div>`;
}
// The portion wording ("1 cup") only holds while the weight is the original estimate.
const macroLine = (it) => {
  const portion = it.portion && (!it.base || round(it.grams) === round(it.base.grams)) ? it.portion : "";
  return `${esc(portion)}${portion ? " · " : ""}P ${round(it.protein_g)} g · C ${round(it.carbs_g)} g (sugar ${round(it.sugar_g)} g) · F ${round(it.fat_g)} g`;
};

function totalBlock() {
  const t = totals(draft.items);
  return `<div class="total"><span>Total</span><b class="num">${round(t.calories)} kcal</b></div>
    <p class="small muted">Likely range ${round(t.calories_low)} to ${round(t.calories_high)} kcal · protein ${round(t.protein_g)} g · carbs ${round(t.carbs_g)} g · sugar ${round(t.sugar_g)} g · fat ${round(t.fat_g)} g</p>`;
}

function renderSheet() {
  const d = draft;
  const head = (title) =>
    `<div class="head"><h2>${title}</h2><button class="btn" data-act="closeSheet">Close</button></div>`;
  const photo = d.image || d.thumb ? `<img class="photo" src="${d.image || d.thumb}" alt="Photo of the meal">` : "";
  let body = "";

  if (d.stage === "note") {
    body = `${head(d.image ? "Add a note" : "Describe the meal")}${photo}
      <label class="field"><span>${d.image ? "Anything the photo cannot show? (optional)" : "What did you eat, and how much?"}</span>
        <textarea id="noteText" placeholder="${d.image ? "e.g. fried in ghee, I will eat half of this" : "e.g. 2 boiled eggs, 2 slices of buttered toast, tea with 1 spoon sugar"}">${esc(d.note)}</textarea></label>
      <button class="btn primary big" data-act="analyze">Analyse</button>`;
  } else if (d.stage === "busy") {
    body = `${head("Analysing")}${photo}
      <div class="spinner" role="status" aria-label="Analysing"></div>
      <p class="center muted">Identifying the food and estimating portions. This takes 10 to 30 seconds.</p>`;
  } else if (d.stage === "error") {
    body = `${head("Something went wrong")}${photo}
      <p class="note err">${esc(d.error)}</p>
      <button class="btn primary" data-act="analyze">Try again</button>
      ${d.items.length ? `<button class="btn" data-act="backToReview">Back to the estimate</button>` : ""}`;
  } else {
    body = `${head(d.id ? "Edit meal" : "Check the estimate")}${photo}
      <section class="card">
        <label class="field"><span>Meal</span><input id="mealName" type="text" value="${esc(d.name)}"></label>
        ${d.confidence ? `<span class="badge ${esc(d.confidence)}">${esc(d.confidence)} confidence</span>` : ""}
        ${d.notes ? `<p class="small muted" style="margin-top:8px">${esc(d.notes)}</p>` : ""}
      </section>
      <section class="card">
        <h2>Items: fix the weights if they look wrong</h2>
        <div id="items">${d.items.map(itemRow).join("") || `<p class="muted">No items.</p>`}</div>
      </section>
      <section class="card" id="totalBlock">${totalBlock()}</section>
      <section class="card">
        <h2>Something wrong or missing?</h2>
        ${d.question ? `<p class="note" style="margin-bottom:10px">${esc(d.question)}</p>` : ""}
        <label class="field"><span>Tell the app and it will redo the estimate</span>
          <textarea id="fixText" placeholder="e.g. that is paneer, not chicken. I also had a glass of milk."></textarea></label>
        <button class="btn" data-act="recheck" style="width:100%">Redo with this information</button>
      </section>
      <button class="btn primary big" data-act="saveMeal" ${d.items.length ? "" : "disabled"}>${d.id ? "Save changes" : "Add to today"}</button>
      ${d.id ? `<button class="btn danger" data-act="delMeal">Delete this meal</button>` : ""}`;
  }
  $("#sheet").innerHTML = `<div class="inner">${body}</div>`;
}

async function startFromFile(file) {
  if (!file) return;
  try {
    const img = await loadImage(file);
    draft = { stage: "note", image: scaled(img, 1568, 0.85), thumb: scaled(img, 160, 0.7), note: "", items: [] };
    openSheet();
  } catch {
    toast("That file could not be opened as a photo.");
  }
}

async function runAnalysis(correction) {
  const d = draft;
  const previous = correction
    ? { meal_name: d.name, items: d.items.map(({ base, ...rest }) => rest) }
    : null;
  d.stage = "busy";
  d.lastCorrection = correction || "";
  renderSheet();
  try {
    const out = await analyze({ image: d.image, note: d.note, previous, correction });
    if (draft !== d) return; // sheet was closed meanwhile
    if (!out.is_food || !out.items?.length) {
      throw new Error(out.notes || "No food was found in this photo.");
    }
    d.name = out.meal_name || "Meal";
    d.items = out.items.map((it) => ({ ...it, base: { ...it } }));
    d.confidence = out.confidence;
    d.notes = out.notes;
    d.question = out.question;
    d.stage = "review";
  } catch (err) {
    if (draft !== d) return;
    d.error = err.message || String(err);
    d.stage = "error";
  }
  renderSheet();
}

// Rescale an item's nutrients from its original estimate when the weight changes.
function setGrams(it, grams) {
  const base = it.base || (it.base = { ...it, base: undefined });
  const k = base.grams > 0 ? grams / base.grams : 0;
  it.grams = grams;
  for (const key of NUTRIENTS) it[key] = (Number(base[key]) || 0) * k;
}

function refreshItem(i) {
  const it = draft.items[i];
  $(`[data-kc="${i}"]`).textContent = `${round(it.calories)} kcal`;
  $(`[data-mac="${i}"]`).innerHTML = macroLine(it);
  $("#totalBlock").innerHTML = totalBlock();
}

function saveMeal() {
  const d = draft;
  const items = d.items.map(({ base, ...rest }) => rest);
  const name = ($("#mealName")?.value || d.name || "Meal").trim();
  if (d.id) {
    const m = state.meals.find((x) => x.id === d.id);
    if (m) Object.assign(m, { name, items, confidence: d.confidence, notes: d.notes });
  } else {
    const now = new Date();
    state.meals.push({
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: now.getTime(),
      date: dateKey(now),
      name,
      thumb: d.thumb || "",
      items,
      confidence: d.confidence,
      notes: d.notes,
    });
  }
  saveState();
  closeSheet();
  render();
  toast("Saved");
}

// ---------- actions ----------

const actions = {
  goto: (el) => { tab = el.dataset.to; render(); },
  camera: () => $("#camera").click(),
  gallery: () => $("#gallery").click(),
  describe: () => { draft = { stage: "note", image: "", thumb: "", note: "", items: [] }; openSheet(); },
  closeSheet,
  backToReview: () => { draft.stage = "review"; draft.lastCorrection = ""; renderSheet(); },
  analyze: () => {
    const box = $("#noteText");
    if (box) draft.note = box.value.trim();
    if (!draft.image && !draft.note && !draft.lastCorrection) return toast("Describe the meal first.");
    runAnalysis(draft.lastCorrection);
  },
  recheck: () => {
    const fix = $("#fixText").value.trim();
    if (!fix) return toast("Type what should change first.");
    draft.name = $("#mealName").value.trim() || draft.name;
    runAnalysis(fix);
  },
  scale: (el) => {
    const i = Number(el.dataset.i);
    const it = draft.items[i];
    setGrams(it, Math.round(it.grams * Number(el.dataset.k)));
    $(`[data-field="grams"][data-i="${i}"]`).value = round(it.grams);
    refreshItem(i);
  },
  delItem: (el) => {
    draft.name = $("#mealName").value;
    draft.items.splice(Number(el.dataset.i), 1);
    renderSheet();
  },
  saveMeal,
  open: (el) => {
    const m = state.meals.find((x) => x.id === el.dataset.id);
    if (!m) return;
    draft = {
      stage: "review", id: m.id, name: m.name, thumb: m.thumb, image: "", note: "",
      items: m.items.map((it) => ({ ...it, base: { ...it } })),
      confidence: m.confidence, notes: m.notes, question: "",
    };
    openSheet();
  },
  delMeal: () => {
    if (!confirm("Delete this meal?")) return;
    state.meals = state.meals.filter((x) => x.id !== draft.id);
    saveState();
    closeSheet();
    render();
  },
  day: (el) => { historyDay = el.dataset.day; render(); },
  addWeight: () => {
    const kg = parseFloat($("#wKg").value);
    const date = $("#wDate").value;
    if (!date || !(kg >= 20 && kg <= 300)) return toast("Enter a weight between 20 and 300 kg.");
    state.weights = state.weights.filter((w) => w.date !== date);
    state.weights.push({ date, kg });
    saveState();
    render();
    toast("Weight saved");
  },
  delWeight: (el) => {
    state.weights = state.weights.filter((w) => w.date !== el.dataset.day);
    saveState();
    render();
  },
  saveSettings: () => {
    const s = state.settings;
    const n = (id, old) => {
      const v = parseFloat($(id).value);
      return v >= 0 ? v : old;
    };
    s.geminiKey = $("#sGemini").value.trim();
    s.apiKey = $("#sKey").value.trim();
    s.model = $("#sModel").value;
    s.kcalGoal = n("#sKcal", s.kcalGoal);
    s.proteinGoal = n("#sProtein", s.proteinGoal);
    s.carbGoal = n("#sCarb", s.carbGoal);
    s.fatGoal = n("#sFat", s.fatGoal);
    s.sugarLimit = n("#sSugar", s.sugarLimit);
    saveState();
    render();
    toast("Settings saved");
  },
  copySetup: async () => {
    const link = `${location.origin}${location.pathname}#setup=${encodeURIComponent(state.settings.geminiKey)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copied. Open it once on the other phone. Share it only with family: it contains the key.");
    } catch {
      prompt("Copy this link and open it once on the other phone:", link);
    }
  },
  export: () => {
    // Keys are left out so a backup file can be shared safely.
    const data = { ...state, settings: { ...state.settings, apiKey: "", geminiKey: "" } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `platelog-backup-${dateKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  import: () => $("#importFile").click(),
};

document.addEventListener("click", (e) => {
  const tabBtn = e.target.closest(".tabs button");
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest("[data-act]");
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (!draft || !el.dataset.field) return;
  const i = Number(el.dataset.i);
  if (el.dataset.field === "name") draft.items[i].name = el.value;
  if (el.dataset.field === "grams") {
    setGrams(draft.items[i], Math.max(0, parseFloat(el.value) || 0));
    refreshItem(i);
  }
});

for (const id of ["#camera", "#gallery"]) {
  $(id).addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    startFromFile(file);
  });
}

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.meals)) throw new Error("not a PlateLog backup");
    if (!confirm(`Replace the data on this device with the backup (${data.meals.length} meals)?`)) return;
    const { apiKey, geminiKey } = state.settings;
    applyState(data);
    state.settings.apiKey ||= apiKey;
    state.settings.geminiKey ||= geminiKey;
    await saveState();
    render();
    toast("Backup restored");
  } catch (err) {
    toast("Import failed: " + err.message);
  }
});

// ---------- start ----------

await loadState();
// One-time setup link: .../#setup=<key> stores the free key on this phone.
if (location.hash.startsWith("#setup=")) {
  const key = decodeURIComponent(location.hash.slice(7)).trim();
  history.replaceState(null, "", location.pathname + location.search);
  if (key) {
    state.settings.geminiKey = key;
    if (!isGemini(state.settings.model)) state.settings.model = "gemini-4-hydrogen";
    await saveState();
    setTimeout(() => toast("Set up. You can photograph a meal now."), 300);
  }
}
render();
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
