// Habit Tracker (GitHub Pages friendly, no build step)
// Storage is localStorage + optional Google Sheet sync via Apps Script Web App.

// Firebase (CDN, modular SDK)
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, getDocs, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

const LS_KEYS = {
  creds: "ht.creds.v1",            // { userHash, passHash }
  session: "ht.session.v1",        // { loggedInUntil }
  config: "ht.config.v1",          // { apiUrl, apiKey }
  habits: "ht.habits.v1",          // [ {id,name,hasText,textLabel} ]
  entries: "ht.entries.v1",        // { [date]: { [habitId]: {done, text} } }
  lastSync: "ht.lastSync.v1"
};

const DEFAULT_HABITS = [
  { id: "exercise", name: "Exercise", hasText: false, textLabel: "" },
  { id: "running", name: "Running", hasText: true, textLabel: "kms" },
  { id: "coding", name: "Coding practice", hasText: false, textLabel: "" },
  { id: "paper", name: "Research paper", hasText: true, textLabel: "paper title" }
];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function loadJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){
    console.warn("Bad JSON in localStorage", key, e);
    return fallback;
  }
}
function saveJSON(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

function normalizeHabits(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(h => h && typeof h === "object")
    .map(h => ({
      id: String(h.id || "").trim(),
      name: String(h.name || "").trim(),
      hasText: !!h.hasText,
      textLabel: String(h.textLabel || "").trim()
    }))
    .filter(h => h.id && h.name);
}

function getHabits(){
  const raw = loadJSON(LS_KEYS.habits, DEFAULT_HABITS);
  const clean = normalizeHabits(raw);
  if(clean.length === 0){
    saveJSON(LS_KEYS.habits, DEFAULT_HABITS);
    return DEFAULT_HABITS;
  }
  if(JSON.stringify(clean) !== JSON.stringify(raw)){
    saveJSON(LS_KEYS.habits, clean); // self-heal
  }
  return clean;
}

function setHabits(habits){
  saveJSON(LS_KEYS.habits, normalizeHabits(habits));
}

function getEntries(){
  const e = loadJSON(LS_KEYS.entries, {});
  return (e && typeof e === "object") ? e : {};
}
function setEntries(entries){
  saveJSON(LS_KEYS.entries, entries || {});
}

function getConfig(){
  return loadJSON(LS_KEYS.config, { apiUrl: "", apiKey: "" });
}

function ensureDefaults(){
  const habits = loadJSON(LS_KEYS.habits, null);
  if(!Array.isArray(habits) || habits.length === 0){
    saveJSON(LS_KEYS.habits, DEFAULT_HABITS);
  } else {
    setHabits(habits); // normalize existing
  }
  const entries = loadJSON(LS_KEYS.entries, null);
  if(!entries || typeof entries !== "object"){
    saveJSON(LS_KEYS.entries, {});
  }
}

function setStatus(el, msg, ok=true){
  if(!el) return;
  el.textContent = msg || "";
  el.classList.toggle("badge-ok", ok);
  el.classList.toggle("badge-bad", !ok);
  if(!msg){
    el.classList.remove("badge-ok","badge-bad");
  }
}

async function sha256Hex(str){
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,"0")).join("");
}

function todayISO(){
  const d = new Date();
  const tzOff = d.getTimezoneOffset() * 60 * 1000;
  const local = new Date(d.getTime() - tzOff);
  return local.toISOString().slice(0,10);
}

function openOverlay(id){ $(id).classList.remove("hidden"); }
function closeOverlay(id){ $(id).classList.add("hidden"); }

function showApp(){
  $("#loginOverlay").classList.add("hidden");
  $("#appRoot").setAttribute("aria-hidden","false");
}
function hideApp(){
  $("#loginOverlay").classList.remove("hidden");
  $("#appRoot").setAttribute("aria-hidden","true");
}

function isSessionValid(){
  const session = loadJSON(LS_KEYS.session, null);
  if(!session?.loggedInUntil) return false;
  return Date.now() < session.loggedInUntil;
}
function setSession(hours=12){
  const loggedInUntil = Date.now() + hours * 3600 * 1000;
  saveJSON(LS_KEYS.session, { loggedInUntil });
}
function clearSession(){
  localStorage.removeItem(LS_KEYS.session);
}

async function doLogin(user, pass){
  const creds = loadJSON(LS_KEYS.creds, null);
  if(!creds?.userHash || !creds?.passHash) return { ok:false, msg:"No credentials set. Click “First-time setup”." };

  const [uHash, pHash] = await Promise.all([sha256Hex(user.trim()), sha256Hex(pass)]);
  if(uHash === creds.userHash && pHash === creds.passHash){
    setSession(12);
    return { ok:true, msg:"Logged in." };
  }
  return { ok:false, msg:"Wrong username/password." };
}

async function setupCreds(user, pass){
  if(!user.trim() || pass.length < 6){
    return { ok:false, msg:"Username required; password must be 6+ chars." };
  }
  const [uHash, pHash] = await Promise.all([sha256Hex(user.trim()), sha256Hex(pass)]);
  saveJSON(LS_KEYS.creds, { userHash: uHash, passHash: pHash });
  setSession(12);
  return { ok:true, msg:"Credentials saved." };
}

function escapeHtml(s){
  return (s ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function slugId(name){
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/(^-|-$)/g,"")
    .slice(0,32) || ("habit-" + Math.random().toString(16).slice(2,10));
}

/* ---------------- UI rendering ---------------- */

function renderHabitsTable(date){
  const habits = getHabits();
  const entries = getEntries();
  const day = entries[date] || {};

  const tbody = $("#habitsTable tbody");
  tbody.innerHTML = "";

  for(const h of habits){
    const st = day[h.id] || { done:false, text:"" };
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = h.name;

    const tdDone = document.createElement("td");
    tdDone.className = "center";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!st.done;
    cb.dataset.habitId = h.id;
    cb.className = "doneBox";
    cb.id = `done-${h.id}`;
    cb.name = `done-${h.id}`;
    tdDone.appendChild(cb);

    const tdText = document.createElement("td");
    if(h.hasText){
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = h.textLabel ? h.textLabel : "details";
      inp.value = st.text || "";
      inp.dataset.habitId = h.id;
      inp.className = "textBox";
      inp.id = `text-${h.id}`;
      inp.name = `text-${h.id}`;
      tdText.appendChild(inp);
    }else{
      tdText.innerHTML = '<span class="muted small">—</span>';
    }

    tr.appendChild(tdName);
    tr.appendChild(tdDone);
    tr.appendChild(tdText);
    tbody.appendChild(tr);
  }
}

function renderHabitsAdmin(){
  const habits = getHabits();
  const tbody = $("#habitsAdminTable tbody");
  tbody.innerHTML = "";

  for(const h of habits){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(h.name)}</td>
      <td>${h.hasText ? escapeHtml(h.textLabel || "Yes") : "No"}</td>
      <td class="center"><button class="btn btnDanger" data-del="${escapeHtml(h.id)}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.del;
      if(!confirm("Delete habit? (This won’t delete historical entries; they’ll just be hidden.)")) return;
      const next = habits.filter(x => x.id !== id);
      setHabits(next);
      try{ initFirebaseIfConfigured().then(()=> cloudIsConfigured() ? cloudSaveHabits() : null).catch(()=>{}); }catch(_e){}
      renderAll();
      setStatus($("#habitStatus"), "Habit deleted (entries kept).", true);
    });
  });

  const sel = $("#habitTrendSelect");
  sel.innerHTML = "";
  for(const h of habits){
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = h.name;
    sel.appendChild(opt);
  }
}

function saveDay(date){
  const habits = getHabits();
  const entries = getEntries();
  const day = entries[date] || {};

  for(const box of $$("#habitsTable .doneBox")){
    const id = box.dataset.habitId;
    day[id] = day[id] || { done:false, text:"" };
    day[id].done = !!box.checked;
  }
  for(const inp of $$("#habitsTable .textBox")){
    const id = inp.dataset.habitId;
    day[id] = day[id] || { done:false, text:"" };
    day[id].text = inp.value.trim();
  }

  for(const h of habits){
    day[h.id] = day[h.id] || { done:false, text:"" };
  }

  entries[date] = day;
  setEntries(entries);
}

/* ---------------- Reports ---------------- */

let completionChart = null;
let trendChart = null;

function toISO(d){
  const tzOff = d.getTimezoneOffset() * 60000;
  const local = new Date(d.getTime() - tzOff);
  return local.toISOString().slice(0,10);
}

function dateRangeFromSelection(sel){
  const now = new Date();
  const tzOff = now.getTimezoneOffset() * 60000;
  const local = new Date(now.getTime() - tzOff);

  if(sel === "month"){
    const start = new Date(local.getFullYear(), local.getMonth(), 1);
    const end = new Date(local.getFullYear(), local.getMonth()+1, 1);
    return { start: toISO(start), end: toISO(new Date(end.getTime()-86400000)) };
  }
  if(sel === "year"){
    const start = new Date(local.getFullYear(), 0, 1);
    const end = new Date(local.getFullYear()+1, 0, 1);
    return { start: toISO(start), end: toISO(new Date(end.getTime()-86400000)) };
  }
  const days = parseInt(sel,10);
  const end = local;
  const start = new Date(local.getTime() - (days-1)*86400000);
  return { start: toISO(start), end: toISO(end) };
}

function eachDate(startISO, endISO){
  const out = [];
  const start = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  for(let d = new Date(start); d <= end; d = new Date(d.getTime()+86400000)){
    out.push(toISO(d));
  }
  return out;
}

function buildReport(range){
  const habits = getHabits();
  const entries = getEntries();
  const dates = eachDate(range.start, range.end);

  const perHabit = new Map(habits.map(h => [h.id, { habit: h, done:0, total:0, texts:[], numSum:0 }]));

  for(const date of dates){
    const day = entries[date];
    for(const h of habits){
      const agg = perHabit.get(h.id);
      agg.total += 1;

      const st = day?.[h.id];
      const done = !!st?.done;
      if(done) agg.done += 1;

      const txt = (st?.text || "").trim();
      if(h.hasText && txt){
        agg.texts.push({date, text: txt});
        const v = parseFloat(txt);
        if(Number.isFinite(v)) agg.numSum += v;
      }
    }
  }

  return { habits, dates, perHabit };
}

function stat(k, v){
  const div = document.createElement("div");
  div.className = "stat";
  div.innerHTML = `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`;
  return div;
}

function renderQuickStats(report, range){
  const habits = report.habits;
  const per = report.perHabit;

  let doneAll = 0, totalAll = 0;
  for(const h of habits){
    const a = per.get(h.id);
    doneAll += a.done;
    totalAll += a.total;
  }
  const overall = totalAll ? (doneAll/totalAll) : 0;

  const running = [...per.values()].find(x => x.habit.id === "running");
  const kms = running ? running.numSum : 0;

  const paper = [...per.values()].find(x => x.habit.id === "paper");
  const papers = paper ? paper.texts.length : 0;

  const box = $("#quickStats");
  box.innerHTML = "";
  box.appendChild(stat("Range", `${range.start} → ${range.end}`));
  box.appendChild(stat("Overall completion", `${Math.round(overall*100)}%`));
  box.appendChild(stat("Running (sum)", `${kms.toFixed(1)} kms`));
  box.appendChild(stat("Papers logged", `${papers}`));
}

function renderCompletionChart(report){
  const habits = report.habits;
  const per = report.perHabit;

  const labels = habits.map(h => h.name);
  const data = habits.map(h => {
    const a = per.get(h.id);
    return a.total ? Math.round((a.done/a.total)*100) : 0;
  });

  const ctx = $("#chartCompletion");
  if(completionChart) completionChart.destroy();
  completionChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ label: "Completion %", data }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, max: 100 } }
    }
  });
}

function renderTrend(range, habitId){
  const habits = getHabits();
  const entries = getEntries();
  const habit = habits.find(h => h.id === habitId) || habits[0];

  const labels = eachDate(range.start, range.end);
  const series = labels.map(date => {
    const st = entries[date]?.[habit.id];
    if(!st) return null;
    if(habit.hasText){
      const v = parseFloat((st.text || "").trim());
      if(Number.isFinite(v)) return v;
    }
    return st.done ? 1 : 0;
  });

  const ctx = $("#chartTrend");
  if(trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: habit.name, data: series, spanGaps: true }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } }
    }
  });

  const hint = $("#trendHint");
  if(habit.id === "running"){
    hint.textContent = "Running: enter kms in details (e.g., 5.2). Chart shows kms/day.";
  }else if(habit.hasText){
    hint.textContent = "Chart shows 1/0 (done/not done). Your details are stored in log entries in the Sheet.";
  }else{
    hint.textContent = "Chart shows 1/0 (done/not done) for the selected range.";
  }
}

function renderLogTable(range){
  const tbody = $("#logTable tbody");
  tbody.innerHTML = "";

  const entries = getEntries();
  const habits = getHabits();
  const habitMap = new Map(habits.map(h => [h.id, h]));
  const dates = eachDate(range.start, range.end);

  const rows = [];
  for(const date of dates){
    const day = entries[date];
    if(!day) continue;
    for(const [hid, st] of Object.entries(day)){
      const h = habitMap.get(hid);
      if(!h) continue;
      const done = !!st?.done;
      const text = (st?.text || "").trim();
      if(!done && !text) continue;
      rows.push({date, habit: h.name, done, text});
    }
  }

  rows.sort((a,b)=> a.date === b.date ? a.habit.localeCompare(b.habit) : b.date.localeCompare(a.date));

  for(const r of rows){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.habit)}</td>
      <td class="center">${r.done ? "✅" : "—"}</td>
      <td>${escapeHtml(r.text || "")}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------- Cloud Sync: Firebase (Auth + Firestore) ----------------
  Storage model in Firestore:
    users/{uid}/app/habits    (doc) { habits: [...], updatedAt }
    users/{uid}/days/{date}  (doc) { date: "YYYY-MM-DD", day: { [habitId]: {done,text} }, updatedAt }
  We keep localStorage as the offline-first cache, then upload deltas.
*/

const FB_KEYS = {
  firebase: "ht.firebase.v1",   // { firebaseConfigText, email, password }
  pending: "ht.pending.v1"      // [dateISO,...] (dates that failed to upload)
};

function getFirebaseLocal(){
  return loadJSON(FB_KEYS.firebase, { firebaseConfigText: "", email: "", password: "" });
}
function setFirebaseLocal(next){
  saveJSON(FB_KEYS.firebase, next || { firebaseConfigText:"", email:"", password:"" });
}
function getPending(){
  const p = loadJSON(FB_KEYS.pending, []);
  return Array.isArray(p) ? p : [];
}
function addPending(date){
  const p = new Set(getPending());
  p.add(date);
  saveJSON(FB_KEYS.pending, Array.from(p));
}
function removePending(date){
  const p = new Set(getPending());
  p.delete(date);
  saveJSON(FB_KEYS.pending, Array.from(p));
}

let fb = {
  app: null,
  auth: null,
  db: null,
  user: null,
  ready: false
};

function parseFirebaseConfig(text){
  const t = (text || "").trim();
  if(!t) return null;
  const obj = JSON.parse(t);
  if(obj && typeof obj === "object" && obj.apiKey && obj.projectId) return obj;
  throw new Error("Config JSON must include at least apiKey + projectId.");
}

function cloudIsConfigured(){
  try{
    const local = getFirebaseLocal();
    return !!parseFirebaseConfig(local.firebaseConfigText);
  }catch(_){
    return false;
  }
}

function cloudUserLabel(){
  if(!fb?.user) return "Not signed in";
  return fb.user.isAnonymous ? `Anonymous (${fb.user.uid.slice(0,8)}…)` : (fb.user.email || fb.user.uid);
}

async function initFirebaseIfConfigured(){
  if(fb.app && fb.db && fb.auth) return true;

  const local = getFirebaseLocal();
  if(!local.firebaseConfigText?.trim()) return false;

  const cfg = parseFirebaseConfig(local.firebaseConfigText);

  fb.app = initializeApp(cfg);
  fb.auth = getAuth(fb.app);
  fb.db = getFirestore(fb.app);

  onAuthStateChanged(fb.auth, (user)=>{
    fb.user = user || null;
    const el = document.querySelector("#fbUserStatus");
    if(el) el.textContent = cloudUserLabel();
  });

  // Auto sign-in (Anonymous) if needed
  if(!fb.auth.currentUser){
    await signInAnonymously(fb.auth);
  }

  // Try flushing pending uploads when we come online
  window.addEventListener("online", ()=>{ flushPending().catch(()=>{}); });

  return true;
}

function requireCloud(){
  if(!cloudIsConfigured()) throw new Error("Firebase not configured. Open Settings → Firebase sync and paste your config JSON.");
  if(!fb.db || !fb.auth) throw new Error("Firebase not initialized yet.");
  if(!fb.user) throw new Error("Not signed in yet.");
}

function habitsDocRef(){
  requireCloud();
  return doc(fb.db, "users", fb.user.uid, "app", "habits");
}

function dayDocRef(date){
  requireCloud();
  return doc(fb.db, "users", fb.user.uid, "days", date);
}

async function cloudSaveHabits(){
  requireCloud();
  await setDoc(habitsDocRef(), { habits: getHabits(), updatedAt: serverTimestamp() }, { merge: true });
}

async function cloudUpsertDay(date){
  requireCloud();
  const entries = getEntries();
  const day = entries?.[date] || {};
  await setDoc(dayDocRef(date), { date, day, updatedAt: serverTimestamp() }, { merge: true });
  removePending(date);
}

async function flushPending(){
  if(!cloudIsConfigured()) return;

  await initFirebaseIfConfigured();
  if(!fb.user) return;

  const p = getPending();
  if(p.length === 0) return;

  for(const date of p){
    try{ await cloudUpsertDay(date); }catch(_e){ /* keep pending */ }
  }
}

async function cloudPullAll(){
  requireCloud();

  // Pull habits
  const hSnap = await getDoc(habitsDocRef());
  if(hSnap.exists()){
    const remoteHabits = hSnap.data()?.habits;
    if(Array.isArray(remoteHabits)) setHabits(remoteHabits);
  }

  // Pull all day docs
  const entries = getEntries();
  const col = collection(fb.db, "users", fb.user.uid, "days");
  const daysSnap = await getDocs(col);

  daysSnap.forEach(d=>{
    const data = d.data() || {};
    const date = data.date || d.id;
    const day = data.day || {};
    if(date) entries[date] = day;
  });

  setEntries(entries);
}

async function cloudSyncNow(){
  await initFirebaseIfConfigured();
  requireCloud();

  // push pending first
  await flushPending();

  // push habits (small)
  await cloudSaveHabits();

  // pull remote
  await cloudPullAll();
}

/* ---------------- Export / Import ---------------- */


function downloadFile(name, content, type){
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJSON(){
  const data = {
    habits: getHabits(),
    entries: getEntries(),
    config: getConfig(),
    exportedAt: new Date().toISOString()
  };
  downloadFile("habit-tracker-backup.json", JSON.stringify(data, null, 2), "application/json");
}

async function importJSONFile(file){
  const txt = await file.text();
  const data = JSON.parse(txt);
  if(data.habits) setHabits(data.habits);
  if(data.entries) setEntries(data.entries);
  if(data.config) saveJSON(LS_KEYS.config, data.config);
}

/* ---------------- Boot ---------------- */

function renderAll(){
  const date = $("#datePicker").value || todayISO();
  renderHabitsAdmin();
  renderHabitsTable(date);

  const rangeVal = $("#rangeSelect").value;
  const range = dateRangeFromSelection(rangeVal);

  const report = buildReport(range);
  renderQuickStats(report, range);
  renderCompletionChart(report);
  renderTrend(range, $("#habitTrendSelect").value || getHabits()[0]?.id);
  renderLogTable(range);
}

function wire(){
  $("#datePicker").value = todayISO();
  $("#datePicker").addEventListener("change", ()=> renderHabitsTable($("#datePicker").value));

  $("#btnSaveDay").addEventListener("click", async ()=>{
    const date = $("#datePicker").value;
    saveDay(date);

    // queue for upload (in case you're offline)
    addPending(date);

    setStatus($("#saveStatus"), "Saved locally. Syncing…", true);
    try{
      await initFirebaseIfConfigured();
      if(cloudIsConfigured()){
        await cloudUpsertDay(date);
        await cloudSaveHabits();
        setStatus($("#saveStatus"), "Saved + synced ✅", true);
      }else{
        setStatus($("#saveStatus"), "Saved locally ✅ (Cloud not configured)", true);
      }
    }catch(e){
      setStatus($("#saveStatus"), "Saved locally ✅ (will sync later)", true);
      console.warn("cloud sync failed", e);
    }

    setTimeout(()=> setStatus($("#saveStatus"), ""), 2500);
    renderAll();
  });

$("#btnRefresh").addEventListener("click", renderAll);
  $("#rangeSelect").addEventListener("change", renderAll);
  $("#habitTrendSelect").addEventListener("change", renderAll);

  $("#btnSettings").addEventListener("click", async ()=>{
    const local = getFirebaseLocal();
    $("#fbConfig").value = local.firebaseConfigText || "";
    $("#fbEmail").value = local.email || "";
    $("#fbPass").value = local.password || "";
    try{ await initFirebaseIfConfigured(); }catch(_e){}
    const el = $("#fbUserStatus");
    if(el) el.textContent = cloudUserLabel();
    openOverlay("#settingsOverlay");
  });
  $("#btnCloseSettings").addEventListener("click", ()=> closeOverlay("#settingsOverlay"));

  $("#btnLogin").addEventListener("click", async ()=>{
    const user = $("#loginUser").value;
    const pass = $("#loginPass").value;
    const res = await doLogin(user, pass);
    if(res.ok){
      showApp();
      renderAll();
    }else{
      alert(res.msg);
    }
  });

  $("#btnFirstSetup").addEventListener("click", ()=>{
    alert("Open Settings → set a new username and password → Save credentials.");
    $("#btnSettings").click();
  });

  $("#btnSaveCreds").addEventListener("click", async ()=>{
    const user = $("#setUser").value;
    const pass = $("#setPass").value;
    const res = await setupCreds(user, pass);
    setStatus($("#credsStatus"), res.msg, res.ok);
    if(res.ok){
      closeOverlay("#settingsOverlay");
      showApp();
      renderAll();
    }
  });

  $("#btnLogout").addEventListener("click", ()=>{
    clearSession();
    hideApp();
    closeOverlay("#settingsOverlay");
  });

  $("#btnAddHabit").addEventListener("click", ()=>{
    const name = $("#newHabitName").value.trim();
    const hasText = $("#newHabitHasText").value === "true";
    const textLabel = $("#newHabitTextLabel").value.trim();

    if(!name){
      setStatus($("#habitStatus"), "Habit name required.", false);
      return;
    }

    const habits = getHabits();
    const id = slugId(name);
    if(habits.some(h => h.id === id)){
      setStatus($("#habitStatus"), "Habit id conflict. Try a slightly different name.", false);
      return;
    }

    habits.push({ id, name, hasText, textLabel });
    setHabits(habits);

    $("#newHabitName").value = "";
    $("#newHabitTextLabel").value = "";
    $("#newHabitHasText").value = "false";

    setStatus($("#habitStatus"), "Habit added.", true);
    renderAll();
  });

  $("#btnSaveApi").addEventListener("click", async ()=>{
    const firebaseConfigText = $("#fbConfig").value.trim();
    const email = ($("#fbEmail")?.value || "").trim();
    const password = ($("#fbPass")?.value || "").trim();

    setFirebaseLocal({ firebaseConfigText, email, password });
    setStatus($("#apiStatus"), "Saved on this device.", true);

    try{
      await initFirebaseIfConfigured();
      $("#fbUserStatus").textContent = cloudUserLabel();
    }catch(e){
      setStatus($("#apiStatus"), e.message, false);
    }
  });

  $("#btnTestApi").addEventListener("click", async ()=>{
    setStatus($("#apiStatus"), "Testing…", true);
    try{
      const local = getFirebaseLocal();
      parseFirebaseConfig(local.firebaseConfigText);
      await initFirebaseIfConfigured();
      requireCloud();
      await cloudSaveHabits();
      setStatus($("#apiStatus"), "OK ✅", true);
    }catch(e){
      setStatus($("#apiStatus"), e.message, false);
    }
  });

  $("#btnFbSignIn").addEventListener("click", async ()=>{
    try{
      setStatus($("#apiStatus"), "Signing in…", true);
      await initFirebaseIfConfigured();
      const email = ($("#fbEmail")?.value || "").trim();
      const pass = ($("#fbPass")?.value || "").trim();
      if(!email || !pass) throw new Error("Enter email + password (or just use Anonymous).");
      await signInWithEmailAndPassword(fb.auth, email, pass);
      setStatus($("#apiStatus"), "Signed in ✅", true);
      $("#fbUserStatus").textContent = cloudUserLabel();
    }catch(e){
      setStatus($("#apiStatus"), e.message, false);
    }
  });

  $("#btnFbCreateAccount").addEventListener("click", async ()=>{
    try{
      setStatus($("#apiStatus"), "Creating account…", true);
      await initFirebaseIfConfigured();
      const email = ($("#fbEmail")?.value || "").trim();
      const pass = ($("#fbPass")?.value || "").trim();
      if(!email || !pass) throw new Error("Enter email + password.");
      await createUserWithEmailAndPassword(fb.auth, email, pass);
      setStatus($("#apiStatus"), "Account created ✅", true);
      $("#fbUserStatus").textContent = cloudUserLabel();
    }catch(e){
      setStatus($("#apiStatus"), e.message, false);
    }
  });

  $("#btnFbSignOut").addEventListener("click", async ()=>{
    try{
      setStatus($("#apiStatus"), "Signing out…", true);
      await initFirebaseIfConfigured();
      await signOut(fb.auth);
      setStatus($("#apiStatus"), "Signed out.", true);
      $("#fbUserStatus").textContent = cloudUserLabel();
    }catch(e){
      setStatus($("#apiStatus"), e.message, false);
    }
  });

$("#btnSync").addEventListener("click", async ()=>{
    try{
      setStatus($("#saveStatus"), "Syncing…", true);
      await cloudSyncNow();
      setStatus($("#saveStatus"), "Synced ✅", true);
      renderAll();
      setTimeout(()=> setStatus($("#saveStatus"), ""), 2500);
    }catch(e){
      setStatus($("#saveStatus"), `Sync failed: ${e.message}`, false);
    }
  });

$("#btnExport").addEventListener("click", exportJSON);
  $("#btnExport2").addEventListener("click", exportJSON);

  $("#btnImport").addEventListener("click", ()=> $("#fileImportMain").click());
  $("#btnImport2").addEventListener("click", ()=> $("#fileImport").click());

  $("#fileImportMain").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if(!file) return;
    await importJSONFile(file);
    renderAll();
    alert("Imported.");
    e.target.value = "";
  });

  $("#fileImport").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if(!file) return;
    await importJSONFile(file);
    renderAll();
    alert("Imported.");
    e.target.value = "";
  });
}

(function init(){
  ensureDefaults();
  wire();

  if(isSessionValid()){
    showApp();
    renderAll();

    // Optional: auto-sync from Firebase if configured
    if(cloudIsConfigured()){
      initFirebaseIfConfigured()
        .then(()=> cloudSyncNow())
        .then(()=> renderAll())
        .catch((e)=> console.warn("auto cloud sync failed", e));
    }
  }else{
    hideApp();
  }
})();
