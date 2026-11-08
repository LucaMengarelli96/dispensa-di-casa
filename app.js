// Dispensa di Casa — app di famiglia per spesa, scorte, ricette e promemoria.
// Tutti i dati vivono in Firestore sotto households/{id}/…; la cache locale rende l'app usabile offline.
import {
  auth, db, signInWithGoogle, onAuthStateChanged, signOut,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot,
  query, where, writeBatch, arrayUnion, serverTimestamp,
} from './firebase.js';

/* ================= Costanti e utilità ================= */
const DAY = 86400000;
const REPARTI = ['Frutta e verdura', 'Pane e forno', 'Latticini e frigo', 'Carne e pesce', 'Pasta e dispensa', 'Bevande', 'Surgelati', 'Casa e igiene', 'Altro'];
const LOCS = { dispensa: 'Dispensa', frigo: 'Frigo', freezer: 'Freezer' };
const UNITS = ['pz', 'g', 'ml', 'conf'];
const STEP = { g: 100, ml: 250, pz: 1, conf: 1 };
// Indirizzo del server Apps Script (lettura scontrini con l'AI)
const SERVER_URL = 'https://script.google.com/macros/s/AKfycbyr5gDrqyHpSuvT-lUkdMqSCk7sLhnE8a2L03D7mfIGdmEwL70VnQgRqCF-VswLH2ceiQ/exec';
const COLORS = ['#1d6b47', '#b8392a', '#9a6212', '#2f5d9e', '#7a3fa0', '#2a7f86'];

const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const iso = d => { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const isoIn = n => iso(new Date(today().getTime() + n * DAY));
const parseIso = s => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysTo = s => s ? Math.round((parseIso(s) - today()) / DAY) : null;
const fmtD = s => s ? parseIso(s).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';
const norm = s => String(s || '').trim().toLowerCase();
const slug = s => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x';
const cap = s => { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const eur = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
function fmtQty(q, u) {
  q = Math.round(q * 100) / 100;
  if (u === 'g' && q >= 1000) return (q / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' kg';
  if (u === 'ml' && q >= 1000) return (q / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' l';
  return q.toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' ' + u;
}
const colorFor = id => COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initials = name => String(name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ================= Stato ================= */
const state = {
  user: null, hid: null, household: null,
  stock: [], list: [], recipes: [], reminders: [], purchases: [], aliases: [],
  loaded: {}, meta: {},
  tab: 'home', loc: 'frigo', recipeFilter: 'tutte',
};
let unsubs = [];
const col = name => collection(db, 'households', state.hid, name);
const dref = (name, id) => doc(db, 'households', state.hid, name, id);
const newId = name => doc(col(name)).id;
const myName = () => (state.user?.displayName || state.user?.email || 'Io').split(' ')[0];
const stamp = () => ({ updatedAt: serverTimestamp(), by: state.user.uid });
const fail = e => { console.error(e); toast('Non salvato: ' + (e.code === 'permission-denied' ? 'permesso negato' : 'riprova')); };
// Le scritture non si aspettano: offline vengono messe in coda e la UI si aggiorna subito dalla cache.
const commit = b => b.commit().catch(fail);

const totalOf = name => state.stock.filter(s => norm(s.name) === norm(name)).reduce((a, s) => a + (s.qty || 0), 0);
const stockOf = name => state.stock.find(s => norm(s.name) === norm(name));
const inList = name => state.list.some(i => norm(i.name) === norm(name) && !i.done);
const lastPrice = name => { const p = state.purchases.filter(x => norm(x.name) === norm(name)).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0]; return p ? p.price : null; };
const lowStock = () => { const seen = new Set(), out = []; state.stock.forEach(s => { const k = norm(s.name); if (!seen.has(k) && s.min > 0 && totalOf(s.name) < s.min) { seen.add(k); out.push(s); } }); return out; };
const expiring = () => state.stock.filter(s => s.exp && daysTo(s.exp) <= 3).sort((a, b) => a.exp.localeCompare(b.exp));
const REP_WORDS = [
  ['Frutta e verdura', 'mel pere pera banan aranc limon mandarin kiwi uva fragol frutt verdur insalat lattug rucol spinac pomodor pomodorin zucchin melanzan peperon carot patat cipoll aglio sedano finocch broccol cavol cavolfior zucca funghi basilic prezzemol avocado ananas pesc albicocc ciliegi cetriol porr asparag carciof legum fagiolin'],
  ['Pane e forno', 'pane panin piadin focacc grissin crackers fette biscottate cornett brioche pancarr tramezzin'],
  ['Latticini e frigo', 'latte yogurt burro formagg mozzarell parmigian grana ricott stracchin mascarpon panna uova uovo prosciutt salame mortadell speck wurstel affettat pesto tofu'],
  ['Carne e pesce', 'carne pollo tacchin manzo maiale vitell salsicc hamburger bistecc fettin pesce salmon merluzz orata branzin gamber cozz vongol'],
  ['Bevande', 'acqua vino birra succo bibit aranciata tisan'],
  ['Surgelati', 'surgelat gelato bastoncin'],
  ['Casa e igiene', 'detersiv sapon shampoo bagnoschiuma dentifric igienic scottex tovagliol spugn ammorbident candeggin sgrassator lavastoviglie sacchett pannolin assorbent deodorant rasoi cotton crocchett croccantin lettiera'],
  ['Pasta e dispensa', 'pasta spaghett penne fusill rigaton riso farina zucchero sale olio aceto passata pelati legumi ceci lenticch fagiol tonno scatola caffè caffe cacao marmellat miele biscott cereal fette lievito brodo dado spezie pepe'],
];
const guessRep = name => { const n = norm(name); for (const [rep, words] of REP_WORDS) if (words.split(' ').some(w => n.includes(w))) return rep; return 'Altro'; };
const repOf = name => stockOf(name)?.rep || state.list.find(i => norm(i.name) === norm(name))?.rep || guessRep(name);
const ingChip = i => { if (i.opt) return `<span class="chip">${esc(i.n)} q.b.</span>`; const have = totalOf(i.n) >= i.q; return `<span class="chip ${have ? '' : 'crit'}">${have ? '' : '✕ '}${esc(i.n)} ${fmtQty(i.q, i.u)}</span>`; };
function recipeStatus(r, serv) {
  const f = (serv || r.serv) / r.serv;
  const miss = (r.ings || []).filter(i => !i.opt && totalOf(i.n) < i.q * f);
  return { miss, ok: miss.length === 0 };
}

/* ================= Interfaccia di base ================= */
const $ = id => document.getElementById(id);
function toast(msg) {
  const h = $('toastHost'); h.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => { h.innerHTML = ''; }, 2800);
}
const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  cart: '<path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  pot: '<path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M2 10h20M9 6c0-1 1-2 3-2s3 1 3 2"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  barcode: '<path d="M4 6v12M7 6v12M11 6v12M14 6v12M17 6v12M20 6v12"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  tick: '<path d="M5 12l5 5 9-10"/>',
};
const ic = (k, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;
const TABS = [['home', 'Oggi', 'home'], ['spesa', 'Spesa', 'cart'], ['dispensa', 'Scorte', 'box'], ['ricette', 'Ricette', 'pot'], ['promemoria', 'Promemoria', 'bell']];
const TITLES = { home: 'Oggi', spesa: 'Lista della spesa', dispensa: 'Scorte di casa', ricette: 'Ricette', promemoria: 'Promemoria' };
const opts = (list, sel) => list.map(v => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
const locOpts = sel => Object.entries(LOCS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
function expChip(s) {
  const n = daysTo(s);
  if (n == null) return '';
  if (n < 0) return `<span class="chip crit">Scaduto</span>`;
  if (n === 0) return `<span class="chip crit">Scade oggi</span>`;
  if (n <= 3) return `<span class="chip warn">Tra ${n} gg</span>`;
  return `<span class="chip">${fmtD(s)}</span>`;
}

/* ================= Accesso e famiglia ================= */
function showChrome(on) { ['topbar', 'fab', 'tabs'].forEach(id => { $(id).hidden = !on; }); }

function renderLogin(errMsg) {
  showChrome(false); closeSheet();
  $('view').innerHTML = `
  <div class="login">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1>Dispensa di Casa</h1>
    <p>Lista della spesa, scorte di frigo, dispensa e freezer, ricette e promemoria. Condivisi con la tua famiglia, anche senza campo.</p>
    <button class="gbtn" id="googleBtn">
      <svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      Accedi con Google
    </button>
    ${errMsg ? `<p class="err">${esc(errMsg)}</p>` : ''}
    ${new URLSearchParams(location.search).get('join') ? '<p class="note">Hai ricevuto un invito: dopo l\'accesso entrerai nella dispensa della tua famiglia.</p>' : ''}
  </div>`;
  $('googleBtn').onclick = () => signInWithGoogle().catch(e => {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    renderLogin(e.code === 'auth/popup-blocked' ? 'Il browser ha bloccato la finestra di accesso: consenti i popup e riprova.'
      : e.code === 'auth/network-request-failed' ? 'Serve la connessione per il primo accesso.'
      : e.code === 'auth/unauthorized-domain' ? 'Questo indirizzo non è ancora autorizzato in Firebase.'
      : 'Accesso non riuscito (' + e.code + ').');
  });
}

function renderOnboarding(joinId) {
  showChrome(false);
  $('view').innerHTML = `
  <div class="login">
    <h1>Ciao ${esc(myName())}</h1>
    ${joinId ? `
      <p>Hai un invito per entrare nella dispensa di famiglia.</p>
      <button class="btn primary block" id="joinBtn">Entra nella dispensa di famiglia</button>
      <p class="hint">Oppure crea una dispensa nuova, separata:</p>` : `
      <p>Crea la dispensa della tua famiglia. Poi invita gli altri con un link.</p>`}
    <form id="createForm" style="display:flex;flex-direction:column;gap:10px">
      <label class="field">Nome della dispensa<input id="hhName" value="Casa ${esc((state.user.displayName || '').split(' ').slice(-1)[0] || '')}" required></label>
      <button class="btn ${joinId ? '' : 'primary'} block" type="submit">Crea una dispensa nuova</button>
    </form>
    <p class="hint">Hai ricevuto un link di invito? Aprilo da questo telefono e ti porta qui.</p>
    <button class="btn ghost" id="logoutBtn">Esci (${esc(state.user.email)})</button>
  </div>`;
  if (joinId) $('joinBtn').onclick = () => joinHousehold(joinId);
  $('createForm').onsubmit = e => { e.preventDefault(); createHousehold($('hhName').value.trim() || 'Casa'); };
  $('logoutBtn').onclick = () => signOut(auth);
}

const SEED_RECIPES = [
  { name: 'Spaghetti al pomodoro', serv: 4, time: 20, ings: [['Spaghetti', 320, 'g'], ['Passata di pomodoro', 700, 'g'], ['Olio extravergine', 30, 'ml'], ['Parmigiano', 40, 'g']] },
  { name: 'Risotto alla parmigiana', serv: 4, time: 30, ings: [['Riso carnaroli', 320, 'g'], ['Burro', 40, 'g'], ['Parmigiano', 80, 'g']] },
  { name: 'Frittata di zucchine', serv: 4, time: 25, ings: [['Uova', 6, 'pz'], ['Zucchine', 3, 'pz'], ['Parmigiano', 50, 'g']] },
  { name: 'Pasta tonno e pomodoro', serv: 4, time: 20, ings: [['Penne', 320, 'g'], ['Tonno in scatola', 2, 'pz'], ['Passata di pomodoro', 400, 'g']] },
  { name: 'Pancake', serv: 4, time: 20, ings: [['Farina 00', 200, 'g'], ['Latte', 300, 'ml'], ['Uova', 2, 'pz'], ['Zucchero', 30, 'g']] },
];

async function createHousehold(name) {
  $('view').innerHTML = '<div class="spinner" role="progressbar" aria-label="Creazione"></div>';
  const uid = state.user.uid;
  const hid = doc(collection(db, 'households')).id;
  try {
    const b = writeBatch(db);
    b.set(doc(db, 'households', hid), { name, members: [uid], memberNames: { [uid]: myName() }, createdAt: serverTimestamp(), createdBy: uid });
    b.set(doc(db, 'users', uid), { householdId: hid });
    await b.commit();
    state.hid = hid;
    const b2 = writeBatch(db);
    SEED_RECIPES.forEach(r => b2.set(doc(col('recipes')), { name: r.name, serv: r.serv, time: r.time, src: 'base', ings: r.ings.map(([n, q, u]) => ({ n, q, u })), ...stamp() }));
    await b2.commit();
    startHousehold(hid);
    toast('Dispensa creata. Invita la famiglia dal pallino in alto a destra.');
  } catch (e) { console.error(e); renderOnboarding(); toast('Creazione non riuscita: serve la connessione.'); }
}

async function joinHousehold(hid) {
  $('view').innerHTML = '<div class="spinner" role="progressbar" aria-label="Accesso"></div>';
  const uid = state.user.uid;
  try {
    await updateDoc(doc(db, 'households', hid), { members: arrayUnion(uid), [`memberNames.${uid}`]: myName() });
    await setDoc(doc(db, 'users', uid), { householdId: hid });
    history.replaceState(null, '', location.pathname);
    startHousehold(hid);
    toast('Sei entrato nella dispensa di famiglia');
  } catch (e) {
    console.error(e); history.replaceState(null, '', location.pathname);
    renderOnboarding(); toast(e.code === 'not-found' ? 'Invito non valido' : 'Non riesco a entrare: controlla la connessione');
  }
}

onAuthStateChanged(auth, async user => {
  stopHousehold();
  state.user = user;
  if (!user) { renderLogin(); return; }
  const joinId = new URLSearchParams(location.search).get('join');
  let hid = null;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    hid = snap.exists() ? snap.data().householdId : null;
  } catch (e) {
    try { hid = localStorage.getItem('hid:' + user.uid); } catch (_) {}
    if (!hid) { renderLogin('Serve la connessione per il primo accesso.'); return; }
  }
  if (joinId && joinId !== hid) { renderOnboarding(joinId); return; }
  if (joinId) history.replaceState(null, '', location.pathname);
  if (!hid) { renderOnboarding(); return; }
  startHousehold(hid);
});

/* ================= Sincronizzazione ================= */
function stopHousehold() { unsubs.forEach(u => u()); unsubs = []; state.loaded = {}; state.meta = {}; }

function startHousehold(hid) {
  stopHousehold();
  state.hid = hid;
  try { localStorage.setItem('hid:' + state.user.uid, hid); } catch (_) {}
  showChrome(true);
  const listen = (key, ref, map) => unsubs.push(onSnapshot(ref, { includeMetadataChanges: true }, snap => {
    state.meta[key] = { cache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites };
    map(snap); state.loaded[key] = true; schedule();
  }, err => { console.error(key, err); if (err.code === 'permission-denied' && key === 'household') { renderOnboarding(); } }));
  listen('household', doc(db, 'households', hid), s => { state.household = s.exists() ? s.data() : null; });
  const rows = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
  listen('stock', col('stock'), s => { state.stock = rows(s); });
  listen('list', col('list'), s => { state.list = rows(s); });
  listen('recipes', col('recipes'), s => { state.recipes = rows(s); });
  listen('reminders', col('reminders'), s => { state.reminders = rows(s); });
  listen('purchases', query(col('purchases'), where('date', '>=', isoIn(-120))), s => { state.purchases = rows(s); });
  listen('aliases', col('aliases'), s => { state.aliases = rows(s); });
}

let raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); autoReminders(); }); }

function syncStatus() {
  const m = Object.values(state.meta);
  const el = $('sync'), t = $('syncText');
  el.classList.remove('off', 'pending');
  if (!navigator.onLine) { el.classList.add('off'); t.textContent = 'Offline'; el.title = 'Le modifiche restano sul telefono e si inviano appena torna la rete'; }
  else if (m.some(x => x.pending)) { el.classList.add('pending'); t.textContent = 'Invio…'; el.title = 'Sto inviando le modifiche'; }
  else if (m.some(x => x.cache)) { el.classList.add('pending'); t.textContent = 'Collegamento…'; el.title = ''; }
  else { t.textContent = 'Sincronizzato'; el.title = 'Tutta la famiglia vede gli stessi dati'; }
}
addEventListener('online', syncStatus); addEventListener('offline', syncStatus);

/* Promemoria: alla data prevista il prodotto entra da solo in lista (una volta per scadenza) */
function autoReminders() {
  if (!state.loaded.reminders || !state.loaded.list) return;
  const due = state.reminders.filter(r => daysTo(r.next) <= 0 && r.listedFor !== r.next);
  if (!due.length) return;
  const b = writeBatch(db);
  due.forEach(r => {
    if (!inList(r.name)) b.set(dref('list', `rem-${r.id}-${r.next}`), { name: r.name, rep: r.rep || 'Casa e igiene', qty: r.qty || '', src: 'promemoria', done: false, ...stamp() });
    b.update(dref('reminders', r.id), { listedFor: r.next });
    r.listedFor = r.next;
  });
  commit(b);
}

/* ================= Operazioni sui dati ================= */
function addStockOps(b, { name, qty, unit, loc, exp, rep, min }) {
  name = cap(name); qty = num(qty);
  if (!name || qty <= 0) return;
  const same = state.stock.find(s => norm(s.name) === norm(name) && s.loc === loc && s.unit === unit && (s.exp || null) === (exp || null));
  if (same) { b.update(dref('stock', same.id), { qty: same.qty + qty, ...stamp() }); same.qty += qty; return; }
  const base = stockOf(name);
  const id = newId('stock');
  const item = { name, qty, unit, loc, exp: exp || null, rep: (rep && rep !== 'Altro' ? rep : null) || base?.rep || guessRep(name), min: min ?? base?.min ?? 0 };
  b.set(dref('stock', id), { ...item, ...stamp() });
  state.stock.push({ id, ...item });
}
function addPurchaseOps(b, name, rep, price) {
  price = num(price);
  if (price > 0) b.set(dref('purchases', newId('purchases')), { name: cap(name), rep: rep || 'Altro', price, date: iso(today()), ...stamp() });
}
function listLowOps(b) {
  let n = 0;
  lowStock().forEach(s => {
    if (!inList(s.name)) {
      b.set(dref('list', 'low-' + slug(s.name)), { name: s.name, rep: s.rep || 'Altro', qty: fmtQty(s.min, s.unit), src: 'scorta', done: false, ...stamp() });
      state.list.push({ id: 'low-' + slug(s.name), name: s.name, done: false }); n++;
    }
  });
  return n;
}
function addListItem(name, extra = {}) {
  name = cap(name); if (!name) return;
  if (inList(name)) { toast(name + ' è già in lista'); return; }
  setDoc(dref('list', newId('list')), { name, rep: extra.rep || repOf(name), qty: extra.qty || '', src: extra.src || 'manuale', note: extra.note || '', byName: myName(), done: false, ...stamp() }).catch(fail);
}

/* ================= Schermate ================= */
function render() {
  if (!state.hid || !state.loaded.household) return;
  syncStatus();
  const members = Object.entries(state.household?.memberNames || {});
  $('family').innerHTML = members.slice(0, 4).map(([uid, n]) => `<span style="background:${colorFor(uid)}">${esc(initials(n))}</span>`).join('');
  $('title').textContent = TITLES[state.tab];
  const todo = state.list.filter(i => !i.done).length;
  $('tabs').innerHTML = TABS.map(([k, l, icn]) => `
    <button class="tabbtn" data-tab="${k}" ${state.tab === k ? 'aria-current="page"' : ''}>${ic(icn)}${k === 'spesa' && todo ? `<span class="badge num">${todo}</span>` : ''}${l}</button>`).join('');
  const views = { home: vHome, spesa: vSpesa, dispensa: vDispensa, ricette: vRicette, promemoria: vPromemoria };
  const main = $('view'), y = main.scrollTop;
  const focusId = document.activeElement?.id, val = focusId === 'newItem' ? $('newItem').value : null;
  main.innerHTML = views[state.tab]();
  main.scrollTop = y;
  if (focusId === 'newItem' && $('newItem')) { $('newItem').value = val; $('newItem').focus(); }
}

function vInstallCard() {
  if (isStandalone()) return '';
  return `<section class="card"><div class="card-h"><h2>Installa l'app sul telefono</h2></div>
    <p class="hint" style="padding:0 14px 14px;margin:0">${isIOS()
      ? 'Su iPhone: tocca il pulsante Condividi di Safari, poi «Aggiungi alla schermata Home». Apri l\'app dall\'icona: così funziona offline e potrà mandarti le notifiche.'
      : 'Apri il menu del browser (⋮) e scegli «Installa app» o «Aggiungi a schermata Home».'}
    ${deferredInstall ? '<br><button class="btn small primary" data-act="install" style="margin-top:8px">Installa ora</button>' : ''}</p></section>`;
}

function vSpending() {
  const recent = state.purchases.filter(p => daysTo(p.date) > -30);
  if (!recent.length) return `<section class="card"><div class="card-h"><h2>Spesa ultimi 30 giorni</h2></div><p class="empty">Quando registri una spesa con i prezzi, qui vedi quanto spendi per reparto.</p></section>`;
  const total = recent.reduce((a, p) => a + p.price, 0);
  const byRep = REPARTI.map(r => [r, recent.filter(p => (p.rep || 'Altro') === r).reduce((a, p) => a + p.price, 0)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...byRep.map(x => x[1]), 1);
  const week = recent.filter(p => daysTo(p.date) > -7).reduce((a, p) => a + p.price, 0);
  return `<section class="card">
    <div class="card-h"><h2>Spesa ultimi 30 giorni</h2><span class="spend-total num">${eur(total)}</span></div>
    <p class="hint" style="padding:0 14px;margin:0 0 8px">di cui ${eur(week)} negli ultimi 7 giorni</p>
    <ul class="bars">${byRep.map(([r, v]) => `<li><span class="bl">${r}</span><span class="bt"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span><span class="bv num">${eur(v)}</span></li>`).join('')}</ul>
  </section>`;
}

function vHome() {
  const exp = expiring(), low = lowStock();
  const due = state.reminders.filter(r => daysTo(r.next) <= 0);
  const ready = state.recipes.filter(r => recipeStatus(r).ok);
  const todo = state.list.filter(i => !i.done).length;
  if (!state.stock.length && !state.list.length) {
    return `${vInstallCard()}
    <section class="card"><div class="card-h"><h2>Benvenuto in ${esc(state.household?.name || 'Dispensa')}</h2></div>
      <p class="empty">Inizia così:<br>1. Tocca <b>+</b> e scansiona i codici a barre di quello che hai in casa, o inseriscilo a mano.<br>2. Scrivi la lista della spesa nella scheda Spesa.<br>3. Invita la famiglia dal pallino in alto a destra.</p></section>`;
  }
  return `
  <div class="tiles">
    <button class="tile crit" data-go="dispensa"><b class="num">${exp.length}</b><span>in scadenza entro 3 giorni</span></button>
    <button class="tile warn" data-go="spesa"><b class="num">${low.length}</b><span>sotto la scorta minima</span></button>
    <button class="tile ok" data-go="ricette"><b class="num">${ready.length}</b><span>ricette pronte con ciò che hai</span></button>
  </div>
  ${vInstallCard()}
  ${exp.length ? `<section class="card">
    <div class="card-h"><h2>Da consumare presto</h2><button class="link" data-go="dispensa">Vedi scorte</button></div>
    <ul class="rows">${exp.map(s => `
      <li class="row"><span class="stripe ${daysTo(s.exp) <= 0 ? 'crit' : 'warn'}"></span>
        <div class="grow tap" data-editstock="${s.id}"><div class="t">${esc(s.name)}</div><div class="s num">${LOCS[s.loc] || ''} · ${fmtQty(s.qty, s.unit)}</div></div>
        ${expChip(s.exp)}</li>`).join('')}</ul></section>` : ''}
  ${due.length ? `<section class="card">
    <div class="card-h"><h2>Promemoria di oggi</h2><button class="link" data-go="promemoria">Tutti</button></div>
    <ul class="rows">${due.map(r => `
      <li class="row"><div class="grow"><div class="t">${esc(r.name)}</div><div class="s">ogni ${r.every} giorni · ${esc(r.qty || '')}</div></div>
      ${inList(r.name) ? '<span class="chip ok">In lista</span>' : `<button class="btn small" data-addrem="${r.id}">In lista</button>`}</li>`).join('')}</ul></section>` : ''}
  <section class="card">
    <div class="card-h"><h2>Cosa cucino?</h2><button class="link" data-go="ricette">Ricette</button></div>
    <ul class="rows">${ready.slice(0, 3).map(r => `
      <li class="row"><div class="grow"><div class="t">${esc(r.name)}</div><div class="s">${r.serv} porzioni${r.time ? ' · ' + r.time + ' min' : ''} · tutto in casa</div></div>
      <button class="btn small primary" data-cook="${r.id}">Cucina</button></li>`).join('')}</ul>
    <div style="padding:${ready.length ? '4px' : '0'} 14px 14px"><button class="btn block" data-act="suggest">Suggeriscimi qualcosa con ciò che scade</button></div></section>
  ${vSpending()}
  <p class="note">Lista della spesa: <b class="num">${todo}</b> prodott${todo === 1 ? 'o' : 'i'} da prendere.</p>`;
}

function vSpesa() {
  const checked = state.list.filter(i => i.done).length;
  const srcLabel = { scorta: 'Sotto scorta', promemoria: 'Promemoria', ricetta: 'Per ricetta', manuale: '' };
  const groups = REPARTI.map(rep => [rep, state.list.filter(i => (REPARTI.includes(i.rep) ? i.rep : 'Altro') === rep).sort((a, b) => a.name.localeCompare(b.name))]).filter(g => g[1].length);
  const names = [...new Set([...state.stock.map(s => s.name), ...state.purchases.map(p => p.name)])];
  return `
  <form class="addbar" id="addItem">
    <input class="inp" id="newItem" list="knownNames" placeholder="Aggiungi alla lista (es. pomodori)" autocomplete="off" aria-label="Nuovo prodotto">
    <datalist id="knownNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <button class="btn primary" type="submit">Aggiungi</button>
  </form>
  ${groups.length ? `<section class="card">
    ${groups.map(([rep, items]) => `
      <div class="section-label">${rep}</div>
      <ul class="rows">${items.map(i => {
        const lp = lastPrice(i.name);
        return `<li class="row ${i.done ? 'done' : ''}">
          <button class="check" role="checkbox" aria-checked="${!!i.done}" aria-label="Preso: ${esc(i.name)}" data-toggle="${i.id}">${i.done ? ic('tick', 3) : ''}</button>
          <div class="grow tap" data-edititem="${i.id}"><div class="t">${esc(i.name)}</div>
            <div class="s">${[i.qty, lp != null ? 'ultimo ' + eur(lp) : '', i.note, i.byName && i.src === 'manuale' ? 'da ' + i.byName : ''].filter(Boolean).map(esc).join(' · ')}</div></div>
          ${srcLabel[i.src] ? `<span class="chip ${i.src === 'scorta' ? 'warn' : i.src === 'promemoria' ? 'ok' : ''}">${srcLabel[i.src]}</span>` : ''}
        </li>`;}).join('')}</ul>`).join('')}
  </section>
  <button class="btn primary block" data-act="finish" ${checked ? '' : 'disabled'}>Fine spesa: registra ${checked} prodott${checked === 1 ? 'o' : 'i'} in casa</button>`
  : '<p class="empty">La lista è vuota. Aggiungi qui sopra quello che serve: tutta la famiglia la vede subito.</p>'}
  <p class="hint">Ordinata per reparto. Spunta mentre compri, anche senza campo.</p>`;
}

function vDispensa() {
  const items = state.stock.filter(s => s.loc === state.loc).sort((a, b) => (a.exp || '9999').localeCompare(b.exp || '9999') || a.name.localeCompare(b.name));
  const count = l => state.stock.filter(s => s.loc === l).length;
  return `
  <div class="seg" role="group" aria-label="Dove">
    ${Object.entries(LOCS).map(([k, v]) => `<button aria-pressed="${state.loc === k}" data-loc="${k}">${v} <span class="num">(${count(k)})</span></button>`).join('')}
  </div>
  <section class="card"><ul class="rows">
    ${items.map(s => {
      const low = s.min > 0 && totalOf(s.name) < s.min; const n = daysTo(s.exp);
      return `<li class="row"><span class="stripe ${n != null && n <= 0 ? 'crit' : (n != null && n <= 3) || low ? 'warn' : ''}"></span>
        <div class="grow tap" data-editstock="${s.id}"><div class="t">${esc(s.name)}</div>
          <div class="s">${expChip(s.exp)} ${low ? '<span class="chip warn">Sotto scorta</span>' : ''}</div></div>
        <div class="stepper"><button aria-label="Meno ${esc(s.name)}" data-dec="${s.id}">−</button><output class="num">${fmtQty(s.qty, s.unit)}</output><button aria-label="Più ${esc(s.name)}" data-inc="${s.id}">+</button></div>
      </li>`;}).join('') || `<li class="empty">${LOCS[state.loc]} vuoto. Tocca + per aggiungere.</li>`}
  </ul></section>
  <p class="hint">In alto ciò che scade prima. Tocca un prodotto per modificarlo o impostare la scorta minima: sotto quella soglia finisce da solo in lista.</p>`;
}

function vRicette() {
  const f = state.recipeFilter;
  let rs = state.recipes.map(r => ({ r, st: recipeStatus(r) }));
  if (f === 'pronte') rs = rs.filter(x => x.st.ok);
  if (f === 'quasi') rs = rs.filter(x => !x.st.ok);
  rs.sort((a, b) => a.st.miss.length - b.st.miss.length || a.r.name.localeCompare(b.r.name));
  return `
  <button class="btn primary block" data-act="suggest">Suggeriscimi qualcosa</button>
  <div class="recipe-tools">
    <button class="btn" data-act="import">Importa da link</button>
    <button class="btn" data-act="newrecipe">Nuova ricetta</button>
  </div>
  <div class="seg" role="group" aria-label="Filtro ricette">
    ${[['tutte', 'Tutte'], ['pronte', 'Pronte ora'], ['quasi', 'Manca qualcosa']].map(([k, v]) => `<button aria-pressed="${f === k}" data-rf="${k}">${v}</button>`).join('')}
  </div>
  ${rs.map(({ r, st }) => `
  <section class="card">
    <div class="card-h"><h2>${esc(r.name)}</h2>${st.ok ? '<span class="chip ok">Pronta</span>' : `<span class="chip warn">Manca${st.miss.length > 1 ? 'no' : ''} ${st.miss.length}</span>`}</div>
    <p class="hint" style="padding:0 14px 8px;margin:0">${r.serv} porzioni${r.time ? ' · ' + r.time + ' min' : ''}${r.url ? ` · <a class="src-link" href="${esc(r.url)}" target="_blank" rel="noopener">${r.src === 'ai' ? 'Cerca su GialloZafferano' : 'Ricetta originale'}</a>` : ''}${r.src === 'ai' ? ' · idea AI' : ''}</p>
    <div class="recipe-ings">${(r.ings || []).map(ingChip).join('')}</div>
    <div class="recipe-actions">
      ${st.ok ? `<button class="btn primary small" data-cook="${r.id}">Cucina e scala dalle scorte</button>` : `<button class="btn small" data-missing="${r.id}">Metti in lista ciò che manca</button>`}
      <button class="btn small ghost" data-editrecipe="${r.id}">Modifica</button>
    </div>
  </section>`).join('') || '<p class="empty">Nessuna ricetta in questo filtro.</p>'}`;
}

function vPromemoria() {
  const rs = [...state.reminders].sort((a, b) => (a.next || '').localeCompare(b.next || ''));
  return `
  <section class="card"><ul class="rows">
    ${rs.map(r => { const n = daysTo(r.next); return `
    <li class="row"><span class="stripe ${n <= 0 ? 'warn' : ''}"></span>
      <div class="grow tap" data-editrem="${r.id}"><div class="t">${esc(r.name)}</div>
        <div class="s">Ogni ${r.every} giorni${r.qty ? ' · ' + esc(r.qty) : ''} · ${r.notify ? 'con notifica' : 'solo in lista'}</div></div>
      ${n <= 0 ? (inList(r.name) ? '<span class="chip ok">In lista</span>' : `<button class="btn small" data-addrem="${r.id}">In lista</button>`) : `<span class="chip num">${n === 1 ? 'domani' : 'tra ' + n + ' gg'}</span>`}
    </li>`; }).join('') || '<li class="empty">Nessun promemoria. Aggiungi gli acquisti che fai a intervalli regolari: detersivi, acqua, cibo per animali…</li>'}
  </ul></section>
  <button class="btn block" data-act="newrem">Nuovo promemoria ricorrente</button>
  <p class="hint">Alla data prevista il prodotto entra da solo nella lista. Quando lo registri come comprato, il conteggio riparte. Le notifiche sul telefono arrivano nella prossima versione.</p>`;
}

/* ================= Fogli modali ================= */
const ov = () => $('overlay');
let sheetCleanup = null;
function sheet(title, body) {
  if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; }
  ov().innerHTML = `<div class="scrim" data-close="1"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="grab"></div><div class="sheet-h"><h2>${esc(title)}</h2><button class="x" data-close="1" aria-label="Chiudi">×</button></div>${body}</div></div>`;
}
function closeSheet() { if (sheetCleanup) { sheetCleanup(); sheetCleanup = null; } ov().innerHTML = ''; }

function sheetAdd() {
  sheet('Aggiungi prodotti', `
    <button class="opt" data-act="barcode">${ic('barcode')}<div><b>Scansiona il codice a barre</b><span>Riconosce il prodotto e ricorda il nome che scegli tu</span></div></button>
    <button class="opt" data-act="manual">${ic('pencil')}<div><b>Inserisci a mano</b><span>Per frutta, verdura e prodotti sfusi</span></div></button>
    <button class="opt" data-act="receipt">${ic('receipt')}<div><b>Foto dello scontrino</b><span>Legge tutte le righe: controlli, correggi e salvi</span></div></button>`);
}

function stockForm(p, prefix) {
  return `
    <label class="field">Prodotto<input id="${prefix}name" value="${esc(p.name || '')}" required></label>
    <div class="grid3">
      <label class="field">Quantità<input id="${prefix}qty" type="number" step="any" inputmode="decimal" value="${p.qty ?? 1}" required></label>
      <label class="field">Unità<select id="${prefix}unit">${opts(UNITS, p.unit || 'pz')}</select></label>
      <label class="field">Dove<select id="${prefix}loc">${locOpts(p.loc || 'dispensa')}</select></label>
    </div>
    <div class="grid2">
      <label class="field">Scadenza<input id="${prefix}exp" type="date" value="${p.exp || ''}"></label>
      <label class="field">Scorta minima<input id="${prefix}min" type="number" step="any" inputmode="decimal" value="${p.min ?? 0}"></label>
    </div>
    <label class="field">Reparto<select id="${prefix}rep">${opts(REPARTI, p.rep || 'Altro')}</select></label>`;
}
const readStock = prefix => ({ name: $(prefix + 'name').value, qty: num($(prefix + 'qty').value), unit: $(prefix + 'unit').value, loc: $(prefix + 'loc').value, exp: $(prefix + 'exp').value || null, min: num($(prefix + 'min').value), rep: $(prefix + 'rep').value });

function sheetManual(prefill = {}) {
  sheet('Inserisci a mano', `
    <form id="manForm" style="display:flex;flex-direction:column;gap:10px">
      ${stockForm({ unit: 'pz', loc: 'frigo', exp: isoIn(7), ...prefill }, 'm')}
      <label class="field">Prezzo pagato (€, facoltativo)<input id="mprice" type="number" step="0.01" inputmode="decimal" placeholder="es. 2,30"></label>
      <button class="btn primary block" type="submit">Salva</button>
    </form>`);
  setTimeout(() => $('mname')?.focus(), 50);
}

function sheetEditStock(id) {
  const s = state.stock.find(x => x.id === id); if (!s) return;
  sheet('Modifica prodotto', `
    <form id="editStockForm" data-id="${id}" style="display:flex;flex-direction:column;gap:10px">
      ${stockForm(s, 'e')}
      <button class="btn primary block" type="submit">Salva modifiche</button>
    </form>
    <div class="grid2"><button class="btn" data-act="usedup" data-id="${id}">Finito: metti in lista</button><button class="btn" data-act="delstock" data-id="${id}">Elimina</button></div>`);
}

/* --- Codice a barre --- */
let scanner = null;
function sheetBarcode() {
  sheet('Scansiona il codice', `
    <div id="reader"></div>
    <p class="hint" id="scanHint">Inquadra il codice a barre. Se la fotocamera non parte, scrivi il numero qui sotto.</p>
    <form id="eanForm" class="addbar"><input class="inp" id="eanIn" inputmode="numeric" pattern="[0-9]{8,14}" placeholder="Numero sotto il codice (8-13 cifre)" aria-label="Codice a barre"><button class="btn" type="submit">Cerca</button></form>`);
  sheetCleanup = stopScanner;
  if (!window.Html5Qrcode) { $('scanHint').textContent = 'Lettore non disponibile offline: scrivi il numero del codice.'; return; }
  const F = window.Html5QrcodeSupportedFormats;
  scanner = new window.Html5Qrcode('reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], useBarCodeDetectorIfSupported: true, verbose: false });
  scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => ({ width: Math.min(300, w * 0.85), height: Math.min(140, h * 0.5) }) },
    code => { stopScanner(); lookupBarcode(code); }, () => {})
    .catch(() => { $('scanHint').textContent = 'Non riesco ad aprire la fotocamera: consenti l\'accesso nelle impostazioni del browser, oppure scrivi il numero del codice.'; });
}
function stopScanner() { if (scanner) { const s = scanner; scanner = null; s.stop().then(() => s.clear()).catch(() => {}); } }

function guessFromCategories(tags = []) {
  const t = tags.join(' ');
  if (/frozen/.test(t)) return { loc: 'freezer', rep: 'Surgelati' };
  if (/dair|chees|yogurt|milk|butter|egg/.test(t)) return { loc: 'frigo', rep: 'Latticini e frigo' };
  if (/meat|fish|seafood|poultr/.test(t)) return { loc: 'frigo', rep: 'Carne e pesce' };
  if (/fruit|vegetabl/.test(t) && !/canned|dried|juice/.test(t)) return { loc: 'frigo', rep: 'Frutta e verdura' };
  if (/beverage|water|drink|juice/.test(t)) return { loc: 'dispensa', rep: 'Bevande' };
  if (/bread|bakery|biscuit/.test(t)) return { loc: 'dispensa', rep: 'Pane e forno' };
  if (/household|cleaning|deterg|hygien/.test(t)) return { loc: 'dispensa', rep: 'Casa e igiene' };
  return { loc: 'dispensa', rep: 'Pasta e dispensa' };
}
function parseQuantity(q) {
  const m = String(q || '').toLowerCase().replace(',', '.').match(/([\d.]+)\s*(kg|g|gr|l|lt|cl|ml)\b/);
  if (!m) return { qty: 1, unit: 'pz' };
  let v = parseFloat(m[1]); const u = m[2];
  if (u === 'kg') return { qty: v * 1000, unit: 'g' };
  if (u === 'g' || u === 'gr') return { qty: v, unit: 'g' };
  if (u === 'l' || u === 'lt') return { qty: v * 1000, unit: 'ml' };
  if (u === 'cl') return { qty: v * 10, unit: 'ml' };
  return { qty: v, unit: 'ml' };
}
async function lookupBarcode(code) {
  sheet('Cerco il prodotto', `<div class="spinner" role="progressbar" aria-label="Ricerca"></div><p class="hint" style="text-align:center">Codice ${esc(code)}</p>`);
  let p = null, source = '';
  try { const k = await getDoc(dref('barcodes', code)); if (k.exists()) { p = k.data(); source = 'Riconosciuto: l\'hai già registrato'; } } catch (_) {}
  if (!p) {
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name_it,product_name,brands,quantity,categories_tags`);
      const j = await r.json();
      if (j.status === 1 && j.product) {
        const pr = j.product, g = guessFromCategories(pr.categories_tags), q = parseQuantity(pr.quantity);
        p = { name: cap(pr.product_name_it || pr.product_name || ''), ...q, ...g };
        source = 'Da Open Food Facts' + (pr.brands ? ' · ' + pr.brands.split(',')[0] : '') + ': correggi il nome se vuoi, lo ricorderò';
      }
    } catch (_) { source = 'Offline: compila tu, ricorderò il codice'; }
  }
  if (!p) { p = { name: '', qty: 1, unit: 'pz', loc: 'dispensa', rep: 'Pasta e dispensa' }; source = source || 'Prodotto non trovato: compila tu, la prossima volta lo riconosco'; }
  const days = p.loc === 'frigo' ? 7 : p.loc === 'freezer' ? 90 : 180;
  sheet('Prodotto', `
    <form id="barForm" data-code="${esc(code)}" style="display:flex;flex-direction:column;gap:10px">
      <p class="hint" style="margin:0">${esc(source)} · <span class="mono">${esc(code)}</span></p>
      ${stockForm({ ...p, exp: isoIn(days), min: stockOf(p.name || '-')?.min ?? 0 }, 'b')}
      <label class="field">Prezzo pagato (€, facoltativo)<input id="bprice" type="number" step="0.01" inputmode="decimal" value="${lastPrice(p.name || '-') ?? ''}"></label>
      <button class="btn primary block" type="submit">Aggiungi</button>
      <button class="btn block" type="button" data-act="barcode">Scansiona un altro</button>
    </form>`);
}

/* --- Scontrino --- */
// Chiave stabile di una riga di scontrino: solo le lettere (pesi e prezzi cambiano da una spesa all'altra)
const rawKey = raw => String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 60);
let rc = null; // scontrino in revisione

async function callServer(action, payload) {
  if (!SERVER_URL) throw new Error('Il server non è ancora collegato');
  if (!navigator.onLine) throw new Error('Serve la connessione per leggere lo scontrino');
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(SERVER_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, idToken, ...payload }) });
  let j; try { j = await res.json(); } catch (_) { throw new Error('Risposta del server non valida'); }
  if (!j.ok) throw new Error(j.error || 'Errore del server');
  return j;
}

// Rimpicciolisce la foto sul telefono (lato lungo 1600 px, JPEG): invio veloce anche con poco campo
async function shrinkImage(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.82);
    return { preview: data, base64: data.split(',')[1] };
  } finally { URL.revokeObjectURL(url); }
}

function sheetReceipt() {
  sheet('Foto dello scontrino', `
    <label class="btn primary block" for="rcam">Scatta una foto</label>
    <input type="file" id="rcam" accept="image/*" capture="environment" hidden>
    <label class="btn block" for="rlib">Scegli dalla galleria</label>
    <input type="file" id="rlib" accept="image/*" hidden>
    <p class="hint">Inquadra tutto lo scontrino, dritto e ben illuminato. Se è lungo, piegalo o fai due foto separate.</p>`);
}

async function readReceipt(file) {
  sheet('Leggo lo scontrino', `<div class="spinner" role="progressbar" aria-label="Lettura"></div><p class="hint" style="text-align:center" id="rstatus">Preparo la foto…</p>`);
  try {
    const img = await shrinkImage(file);
    if ($('rstatus')) $('rstatus').textContent = 'L\'AI sta leggendo le righe (10-20 secondi)…';
    const aliases = [...state.aliases].sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)).slice(0, 150).map(a => ({ raw: a.raw, name: a.name }));
    const out = await callServer('receipt', { image: img.base64, mime: 'image/jpeg', aliases });
    const amap = new Map(state.aliases.map(a => [a.id, a]));
    rc = {
      store: out.store, total: out.total, preview: img.preview, remember: true,
      lines: out.lines.map(l => {
        const a = l.skip ? null : amap.get(rawKey(l.raw));
        const x = { ...l, ...(a ? { name: a.name, loc: a.loc || l.loc, rep: a.rep || l.rep, unit: a.unit || l.unit } : {}) };
        return { ...x, on: !l.skip, aiName: x.name, aiLoc: x.loc, exp: x.expDays == null ? '' : isoIn(x.expDays), known: !!a };
      }),
    };
    drawReceipt();
  } catch (e) {
    console.error(e);
    sheet('Scontrino non letto', `<p class="err">${esc(e.message || 'Errore')}</p>
      <button class="btn primary block" data-act="receipt">Riprova</button><button class="btn block" data-act="manual">Inserisci a mano</button>`);
  }
}

function drawReceipt() {
  const on = rc.lines.filter(l => l.on);
  const sum = on.reduce((a, l) => a + (num(l.price) || 0), 0);
  const lineHtml = (l, i) => l.skip && !l.on ? `
    <div class="rline off"><div class="top"><span class="mono">${esc(l.raw)}</span>
      <button type="button" class="btn small ghost" data-rinc="${i}">Includi</button></div><span class="hint">Ignorata: ${esc(l.skip)}</span></div>` : `
    <div class="rline ${l.on ? '' : 'off'}">
      <div class="top"><span class="mono">${esc(l.raw)}</span>
        <button type="button" class="check" role="checkbox" aria-checked="${l.on}" aria-label="Includi ${esc(l.name)}" data-ron="${i}">${l.on ? ic('tick', 3) : ''}</button></div>
      <label class="field">Nome${l.known ? ' <span class="chip ok" style="margin-left:6px">come l\'altra volta</span>' : ''}<input data-rfield="name" data-ri="${i}" value="${esc(l.name)}"></label>
      <div class="grid3">
        <label class="field">Quantità<input type="number" step="any" inputmode="decimal" data-rfield="qty" data-ri="${i}" value="${l.qty}"></label>
        <label class="field">Unità<select data-rfield="unit" data-ri="${i}">${opts(UNITS, l.unit)}</select></label>
        <label class="field">Dove<select data-rfield="loc" data-ri="${i}">${locOpts(l.loc)}<option value="none" ${l.loc === 'none' ? 'selected' : ''}>Non tracciare</option></select></label>
      </div>
      <div class="grid2">
        <label class="field">Scadenza<input type="date" data-rfield="exp" data-ri="${i}" value="${l.exp || ''}"></label>
        <label class="field">Prezzo (€)<input type="number" step="0.01" inputmode="decimal" data-rfield="price" data-ri="${i}" value="${l.price || ''}"></label>
      </div>
    </div>`;
  const diff = rc.total ? Math.abs(rc.total - sum) : 0;
  sheet('Controlla e salva', `
    <img class="thumb" src="${rc.preview}" alt="Foto dello scontrino">
    <p class="hint" style="margin:0">${rc.store ? esc(rc.store) + ' · ' : ''}In grigio il testo stampato, sotto il nome che vedrai in app. Le scadenze sono stimate: correggile se serve.</p>
    ${rc.lines.map(lineHtml).join('')}
    <p class="note num">Somma righe incluse: <b>${eur(sum)}</b>${rc.total ? ` · totale scontrino ${eur(rc.total)}${diff > 0.05 ? ' <span class="chip warn">non coincide: controlla prezzi e sconti</span>' : ' <span class="chip ok">coincide</span>'}` : ''}</p>
    <label class="row" style="padding:0;border:0;gap:10px"><button type="button" class="check" role="checkbox" aria-checked="${rc.remember}" data-act="rremember" aria-label="Ricorda correzioni">${rc.remember ? ic('tick', 3) : ''}</button>
      <span class="s">Ricorda le mie correzioni per i prossimi scontrini</span></label>
    <button class="btn primary block" data-act="rsave" ${on.length ? '' : 'disabled'}>Salva ${on.length} prodott${on.length === 1 ? 'o' : 'i'}</button>`);
}

function saveReceipt() {
  const lines = rc.lines.filter(l => l.on && cap(l.name));
  const b = writeBatch(db); let n = 0, fixes = 0;
  const bought = new Set();
  lines.forEach(l => {
    const name = cap(l.name);
    addPurchaseOps(b, name, l.rep, l.price);
    if (l.loc !== 'none') { addStockOps(b, { name, qty: l.qty, unit: l.unit, loc: l.loc, exp: l.exp || null, rep: l.rep }); n++; }
    bought.add(norm(name));
    const key = rawKey(l.raw);
    if (rc.remember && key.length >= 3 && (name !== l.aiName || l.loc !== l.aiLoc || l.known)) {
      b.set(dref('aliases', key), { raw: l.raw, name, loc: l.loc, rep: l.rep, unit: l.unit, ...stamp() }); if (!l.known) fixes++;
    }
  });
  // Ciò che hai comprato esce dalla lista e fa ripartire i promemoria
  state.list.filter(i => !i.done && bought.has(norm(i.name))).forEach(i => b.delete(dref('list', i.id)));
  state.reminders.filter(r => bought.has(norm(r.name))).forEach(r => b.update(dref('reminders', r.id), { next: isoIn(r.every), ...stamp() }));
  commit(b); closeSheet(); rc = null;
  toast(`${n} prodott${n === 1 ? 'o' : 'i'} in casa${fixes ? ` · ${fixes} correzion${fixes === 1 ? 'e ricordata' : 'i ricordate'}` : ''}`);
}

/* --- Ricette --- */
function sheetCook(id) {
  const r = state.recipes.find(x => x.id === id); if (!r) return; let serv = r.serv;
  const draw = () => {
    const f = serv / r.serv;
    sheet(r.name, `
      <div class="row" style="padding:0;border:0"><span class="grow s">Porzioni</span>
        <div class="stepper"><button data-serv="-1" aria-label="Meno porzioni">−</button><output class="num">${serv}</output><button data-serv="1" aria-label="Più porzioni">+</button></div></div>
      <div class="card"><ul class="rows">${r.ings.filter(i => !i.opt).map(i => { const need = i.q * f, have = totalOf(i.n), left = have - need, min = stockOf(i.n)?.min || 0; return `
        <li class="row"><div class="grow"><div class="t">${esc(i.n)}</div><div class="s num">usi ${fmtQty(need, i.u)} · resta ${left >= 0 ? fmtQty(left, i.u) : '—'}</div></div>
        ${left < 0 ? '<span class="chip crit">Non basta</span>' : min > left ? '<span class="chip warn">Andrà in lista</span>' : '<span class="chip ok">Ok</span>'}</li>`; }).join('')}
      </ul></div>
      <p class="hint">Si scala prima dalla confezione che scade prima.</p>
      <button class="btn primary block" data-act="cookok" ${recipeStatus(r, serv).ok ? '' : 'disabled'}>Ho cucinato: aggiorna le scorte</button>`);
  };
  sheetCook.adj = d => { serv = Math.max(1, serv + d); draw(); };
  sheetCook.ok = () => {
    const f = serv / r.serv, b = writeBatch(db);
    r.ings.filter(i => !i.opt).forEach(i => {
      let need = i.q * f;
      state.stock.filter(s => norm(s.name) === norm(i.n)).sort((a, c) => (a.exp || '9999').localeCompare(c.exp || '9999')).forEach(s => {
        if (need <= 0) return;
        const take = Math.min(s.qty, need); need -= take; s.qty -= take;
        if (s.qty <= 0 && !s.min) b.delete(dref('stock', s.id)); else b.update(dref('stock', s.id), { qty: Math.max(0, s.qty), ...stamp() });
      });
    });
    const n = listLowOps(b); commit(b); closeSheet();
    toast(`Scorte aggiornate${n ? ` · ${n} prodott${n === 1 ? 'o' : 'i'} in lista` : ''}`);
  };
  draw();
}

function sheetRecipe(id, prefill, note) {
  const r = id ? state.recipes.find(x => x.id === id) : (prefill || { name: '', serv: 4, time: '', ings: [{ n: '', q: '', u: 'g' }] });
  if (!r) return;
  const names = [...new Set(state.stock.map(s => s.name))];
  const row = (i, k) => `<div class="ing-row" data-ing="${k}">
    <label class="field">Ingrediente<input list="stockNames" data-in="${k}" value="${esc(i.n)}"></label>
    <label class="field">Qtà<input type="number" step="any" inputmode="decimal" data-iq="${k}" value="${i.opt ? '' : i.q}" placeholder="q.b."></label>
    <label class="field">Unità<select data-iu="${k}">${opts(UNITS, i.u)}</select></label>
    <button type="button" class="del" data-delIng="${k}" aria-label="Togli ingrediente">×</button></div>`;
  sheet(id ? 'Modifica ricetta' : prefill ? 'Controlla e salva' : 'Nuova ricetta', `
    <form id="recipeForm" data-id="${id || ''}" data-src="${esc(prefill?.src || '')}" style="display:flex;flex-direction:column;gap:10px">
      ${note ? `<p class="note" style="margin:0">${note}</p>` : ''}
      <label class="field">Nome<input id="rname" value="${esc(r.name)}" required></label>
      <div class="grid2">
        <label class="field">Porzioni<input id="rserv" type="number" min="1" value="${r.serv}"></label>
        <label class="field">Minuti<input id="rtime" type="number" min="0" value="${r.time || ''}"></label>
      </div>
      <label class="field">Link alla ricetta (facoltativo)<input id="rurl" type="url" inputmode="url" value="${esc(r.url || '')}" placeholder="https://…"></label>
      <datalist id="stockNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div id="ings" style="display:flex;flex-direction:column;gap:8px">${r.ings.map(row).join('')}</div>
      <button type="button" class="btn" data-act="addIng">Aggiungi ingrediente</button>
      <p class="hint">Usa per gli ingredienti gli stessi nomi delle scorte (te li suggerisco mentre scrivi): così l'app sa cosa hai in casa. Lascia vuota la quantità per gli ingredienti «q.b.».</p>
      <button class="btn primary block" type="submit">Salva ricetta</button>
      ${id ? `<button type="button" class="btn block" data-act="delrecipe" data-id="${id}">Elimina ricetta</button>` : ''}
    </form>`);
  sheetRecipe.row = row;
}

/* --- Idee AI: piatti con ciò che scade prima --- */
let ideas = [];
const gzSearch = terms => 'https://www.giallozafferano.it/ricerca-ricette/' + String(terms).trim().toLowerCase().split(/\s+/).map(encodeURIComponent).join('+') + '/';
function stockSummary() {
  const by = new Map();
  state.stock.forEach(s => {
    const k = norm(s.name), d = daysTo(s.exp);
    const x = by.get(k) || { name: s.name, qty: 0, unit: s.unit, days: null };
    if (x.unit === s.unit) x.qty += s.qty;
    if (d != null && (x.days == null || d < x.days)) x.days = d;
    by.set(k, x);
  });
  return [...by.values()];
}

async function sheetSuggest(more) {
  sheet('Cerco idee', `<div class="spinner" role="progressbar" aria-label="Ricerca"></div><p class="hint" style="text-align:center">Guardo cosa scade prima e cosa hai in casa…</p>`);
  const all = stockSummary();
  const expiring = all.filter(s => s.days != null && s.days >= 0 && s.days <= 5).sort((a, b) => a.days - b.days).slice(0, 15);
  try {
    const out = await callServer('ideas', {
      expiring, stock: all.map(s => ({ name: s.name, qty: Math.round(s.qty * 10) / 10, unit: s.unit })),
      exclude: more ? ideas.map(i => i.name) : [], count: 3, serv: 4,
    });
    ideas = out.ideas;
    drawIdeas(expiring);
  } catch (e) {
    sheet('Idee non disponibili', `<p class="err">${esc(e.message)}</p><button class="btn primary block" data-act="suggest">Riprova</button>`);
  }
}

function drawIdeas(expiring) {
  const soon = new Map((expiring || []).map(s => [norm(s.name), s.days]));
  const when = d => d === 0 ? 'oggi' : d === 1 ? 'domani' : 'tra ' + d + ' gg';
  sheet('Idee per stasera', ideas.map((r, i) => {
    const saved = state.recipes.some(x => norm(x.name) === norm(r.name));
    const st = recipeStatus(r);
    const missing = [...new Set([...st.miss.map(x => x.n), ...r.missing.filter(n => !totalOf(n))])];
    return `<div class="rline">
      <div class="top"><b>${esc(r.name)}</b><span class="hint">${r.serv} porz.${r.time ? ' · ' + r.time + ' min' : ''}</span></div>
      ${r.why ? `<span class="hint">${esc(r.why)}</span>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${r.uses.map(n => `<span class="chip warn">${esc(n)}${soon.has(norm(n)) ? ' · ' + when(soon.get(norm(n))) : ''}</span>`).join('')}
        ${missing.map(n => `<span class="chip crit">✕ ${esc(n)}</span>`).join('')}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${saved ? '<span class="chip ok">Salvata</span>' : `<button class="btn small primary" data-saveidea="${i}">Salva in Ricette</button>`}
        ${missing.length ? `<button class="btn small" data-ideamiss="${i}">Metti in lista ciò che manca</button>` : ''}
        <a class="src-link" href="${gzSearch(r.search)}" target="_blank" rel="noopener">Cerca su GialloZafferano</a>
      </div></div>`;
  }).join('') + `
    <button class="btn block" data-act="moreideas">Altre idee</button>
    <p class="hint">Proposte dell'AI: dosi indicative per ${ideas[0]?.serv || 4} persone. Per il procedimento cerca la ricetta su GialloZafferano.</p>`);
  drawIdeas.expiring = expiring;
}

/* --- Import di una ricetta da link --- */
function sheetImport(prefillUrl = '') {
  sheet('Importa da link', `
    <form id="impForm" style="display:flex;flex-direction:column;gap:10px">
      <label class="field">Link della ricetta<input id="impUrl" type="text" inputmode="url" autocapitalize="off" autocomplete="off" value="${esc(prefillUrl)}" placeholder="https://ricette.giallozafferano.it/…" required></label>
      <button class="btn primary block" type="submit">Leggi la ricetta</button>
    </form>
    <p class="hint">Copia il link dal browser (Condividi → Copia) e incollalo qui. Salvo nome, porzioni e ingredienti collegati alle tue scorte; il procedimento lo leggi sul sito.</p>`);
  setTimeout(() => $('impUrl')?.focus(), 50);
}

async function importRecipe(text) {
  const m = String(text).match(/https?:\/\/[^\s"'<>]+/i);
  const url = m ? m[0] : (/^[\w-]+(\.[\w-]+)+\//.test(text.trim()) ? 'https://' + text.trim() : '');
  if (!url) { toast('Incolla un link che inizi con https://'); return; }
  const dup = state.recipes.find(r => r.url && r.url === url);
  if (dup) { closeSheet(); state.tab = 'ricette'; render(); toast(`«${dup.name}» è già nelle ricette`); return; }
  sheet('Leggo la ricetta', `<div class="spinner" role="progressbar" aria-label="Lettura"></div><p class="hint" style="text-align:center">${esc(url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])}</p>`);
  try {
    const stockNames = [...new Set(state.stock.map(s => s.name))];
    const r = await callServer('import', { url, stockNames });
    const known = r.ings.filter(i => !i.opt && stockOf(i.n)).length;
    sheetRecipe(null, { name: r.name, serv: r.serv, time: r.time || '', url: r.url, src: 'link', ings: r.ings },
      `Da <b>${esc(r.host)}</b>: ${r.ings.length} ingredienti, ${known} già collegati alle tue scorte. Controlla nomi e quantità, poi salva.`);
  } catch (e) {
    sheet('Ricetta non letta', `<p class="err">${esc(e.message)}</p>
      <button class="btn primary block" data-act="import">Prova un altro link</button><button class="btn block" data-act="newrecipe">Inserisci a mano</button>`);
  }
}

/* --- Lista: modifica voce e fine spesa --- */
function sheetEditItem(id) {
  const i = state.list.find(x => x.id === id); if (!i) return;
  sheet('Voce della lista', `
    <form id="itemForm" data-id="${id}" style="display:flex;flex-direction:column;gap:10px">
      <label class="field">Prodotto<input id="iname" value="${esc(i.name)}" required></label>
      <div class="grid2">
        <label class="field">Quantità<input id="iqty" value="${esc(i.qty || '')}" placeholder="es. 2 conf"></label>
        <label class="field">Reparto<select id="irep">${opts(REPARTI, REPARTI.includes(i.rep) ? i.rep : 'Altro')}</select></label>
      </div>
      <label class="field">Nota<input id="inote" value="${esc(i.note || '')}"></label>
      <button class="btn primary block" type="submit">Salva</button>
      <button type="button" class="btn block" data-act="delitem" data-id="${id}">Togli dalla lista</button>
    </form>`);
}

function sheetFinish() {
  const items = state.list.filter(i => i.done);
  const defLoc = rep => ['Latticini e frigo', 'Frutta e verdura', 'Carne e pesce'].includes(rep) ? 'frigo' : rep === 'Surgelati' ? 'freezer' : rep === 'Casa e igiene' ? 'none' : 'dispensa';
  sheet('Registra la spesa', `
    <p class="hint">Scegli dove metti ogni prodotto. «Non tracciare» per ciò che non vuoi nelle scorte (aggiorna solo promemoria e spesa).</p>
    ${items.map(i => { const s = stockOf(i.name), u = s?.unit || 'pz', loc = s?.loc || defLoc(i.rep); return `
    <div class="rline"><b>${esc(i.name)}</b>
      <div class="grid3">
        <label class="field">Quantità<input type="number" step="any" inputmode="decimal" data-fqty="${i.id}" value="${u === 'g' ? 500 : u === 'ml' ? 1000 : 1}"></label>
        <label class="field">Unità<select data-funit="${i.id}">${opts(UNITS, u)}</select></label>
        <label class="field">Dove<select data-floc="${i.id}">${locOpts(loc)}<option value="none" ${loc === 'none' ? 'selected' : ''}>Non tracciare</option></select></label>
      </div>
      <div class="grid2">
        <label class="field">Scadenza<input type="date" data-fexp="${i.id}" value="${isoIn(loc === 'frigo' ? 7 : loc === 'freezer' ? 90 : 180)}"></label>
        <label class="field">Prezzo (€)<input type="number" step="0.01" inputmode="decimal" data-fprice="${i.id}" value="${lastPrice(i.name) ?? ''}"></label>
      </div></div>`; }).join('')}
    <button class="btn primary block" data-act="finishok">Conferma</button>`);
}

/* --- Promemoria --- */
function sheetReminder(id) {
  const r = id ? state.reminders.find(x => x.id === id) : { name: '', every: 30, qty: '1 conf', rep: 'Casa e igiene', notify: true, next: null };
  if (!r) return;
  sheet(id ? 'Modifica promemoria' : 'Nuovo promemoria', `
    <form id="remForm" data-id="${id || ''}" style="display:flex;flex-direction:column;gap:10px">
      <label class="field">Cosa comprare<input id="rmname" value="${esc(r.name)}" required placeholder="es. Pastiglie lavastoviglie"></label>
      <div class="grid2">
        <label class="field">Ogni quanti giorni<input id="rmevery" type="number" min="1" value="${r.every}"></label>
        <label class="field">Quantità<input id="rmqty" value="${esc(r.qty || '')}"></label>
      </div>
      <div class="grid2">
        <label class="field">Prossima volta<input id="rmnext" type="date" value="${r.next || isoIn(r.every)}"></label>
        <label class="field">Reparto<select id="rmrep">${opts(REPARTI, r.rep)}</select></label>
      </div>
      <label class="row" style="padding:0;border:0;gap:10px"><input type="checkbox" id="rmnot" ${r.notify ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--accent)"><span class="s">Notifica a tutta la famiglia (dalla prossima versione)</span></label>
      <button class="btn primary block" type="submit">${id ? 'Salva' : 'Crea promemoria'}</button>
      ${id ? `<button type="button" class="btn block" data-act="delrem" data-id="${id}">Elimina promemoria</button>` : ''}
    </form>`);
}

/* --- Famiglia e impostazioni --- */
function sheetFamily() {
  const link = `${location.origin}${location.pathname}?join=${state.hid}`;
  const members = Object.entries(state.household?.memberNames || {});
  sheet(state.household?.name || 'Famiglia', `
    <div class="card"><ul class="rows">${members.map(([uid, n]) => `<li class="row"><span class="family"><span style="background:${colorFor(uid)};margin:0">${esc(initials(n))}</span></span><div class="grow t">${esc(n)}${uid === state.user.uid ? ' (tu)' : ''}</div></li>`).join('')}</ul></div>
    <b>Invita la famiglia</b>
    <p class="hint" style="margin:0">Manda questo link: chi lo apre e accede con Google entra in questa dispensa. Condividilo solo con chi vive con te.</p>
    <p class="note mono invite">${esc(link)}</p>
    <div class="grid2"><button class="btn primary" data-act="share" data-link="${esc(link)}">Condividi link</button><button class="btn" data-act="copy" data-link="${esc(link)}">Copia link</button></div>
    <button class="btn ghost block" data-act="logout">Esci (${esc(state.user.email)})</button>`);
}

/* ================= Eventi ================= */
const confirmTap = (btn, label) => { if (btn.dataset.armed) return true; btn.dataset.armed = '1'; btn.textContent = label; btn.classList.add('primary'); setTimeout(() => { delete btn.dataset.armed; }, 4000); return false; };

document.addEventListener('click', e => {
  const t = e.target.closest('button,[data-close],[data-editstock],[data-edititem],[data-editrem]');
  if (!t) return;
  const d = t.dataset;
  if (d.close) { if (e.target === t) closeSheet(); return; }
  if (d.tab) { state.tab = d.tab; render(); $('view').scrollTop = 0; return; }
  if (d.go) { state.tab = d.go; render(); return; }
  if (d.loc) { state.loc = d.loc; render(); return; }
  if (d.rf) { state.recipeFilter = d.rf; render(); return; }
  if (d.toggle) { const i = state.list.find(x => x.id === d.toggle); if (i) updateDoc(dref('list', i.id), { done: !i.done, ...stamp() }).catch(fail); return; }
  if (d.inc || d.dec) {
    const s = state.stock.find(x => x.id === (d.inc || d.dec)); if (!s) return;
    const step = STEP[s.unit] || 1, q = Math.max(0, Math.round((s.qty + (d.inc ? step : -step)) * 100) / 100);
    const b = writeBatch(db);
    if (q <= 0 && !s.min) b.delete(dref('stock', s.id)); else b.update(dref('stock', s.id), { qty: q, ...stamp() });
    s.qty = q; const n = listLowOps(b); commit(b);
    if (n) toast(`${s.name} sotto scorta: aggiunto alla lista`);
    return;
  }
  if (d.editstock) { sheetEditStock(d.editstock); return; }
  if (d.edititem) { sheetEditItem(d.edititem); return; }
  if (d.editrem) { sheetReminder(d.editrem); return; }
  if (d.cook) { sheetCook(d.cook); return; }
  if (d.serv) { sheetCook.adj(+d.serv); return; }
  if (d.editrecipe) { sheetRecipe(d.editrecipe); return; }
  if (d.missing) {
    const r = state.recipes.find(x => x.id === d.missing); let n = 0;
    recipeStatus(r).miss.forEach(i => { if (!inList(i.n)) { addListItem(i.n, { qty: fmtQty(i.q, i.u), src: 'ricetta', note: r.name }); state.list.push({ name: i.n }); n++; } });
    toast(n ? `${n} ingredient${n === 1 ? 'e' : 'i'} in lista` : 'Già tutto in lista'); return;
  }
  if (d.addrem) { const r = state.reminders.find(x => x.id === d.addrem); if (r) { addListItem(r.name, { qty: r.qty, rep: r.rep, src: 'promemoria' }); toast(`${r.name} in lista`); } return; }
  if (d.saveidea !== undefined) {
    const r = ideas[+d.saveidea]; if (!r) return;
    setDoc(dref('recipes', newId('recipes')), { name: cap(r.name), serv: r.serv, time: r.time || null, url: gzSearch(r.search), src: 'ai', ings: r.ings.map(i => ({ n: cap(i.n), q: i.q, u: i.u, opt: !!i.opt })), ...stamp() }).catch(fail);
    state.recipes.push({ name: r.name }); drawIdeas(drawIdeas.expiring); toast('Ricetta salvata'); return;
  }
  if (d.ideamiss !== undefined) {
    const r = ideas[+d.ideamiss]; if (!r) return; let n = 0;
    const st = recipeStatus(r);
    const need = new Map(st.miss.map(i => [norm(i.n), { n: i.n, qty: fmtQty(i.q, i.u) }]));
    r.missing.filter(x => !totalOf(x)).forEach(x => { if (!need.has(norm(x))) need.set(norm(x), { n: x, qty: '' }); });
    need.forEach(x => { if (!inList(x.n)) { addListItem(x.n, { qty: x.qty, src: 'ricetta', note: r.name }); state.list.push({ name: x.n }); n++; } });
    toast(n ? `${n} ingredient${n === 1 ? 'e' : 'i'} in lista` : 'Già tutto in lista'); return;
  }
  if (d.ron !== undefined) { rc.lines[+d.ron].on = !rc.lines[+d.ron].on; drawReceipt(); return; }
  if (d.rinc !== undefined) { rc.lines[+d.rinc].on = true; drawReceipt(); return; }
  if (d.delIng !== undefined || d.deling !== undefined) { const k = d.delIng ?? d.deling; document.querySelector(`[data-ing="${k}"]`)?.remove(); return; }
  switch (d.act) {
    case 'barcode': sheetBarcode(); break;
    case 'receipt': sheetReceipt(); break;
    case 'rremember': rc.remember = !rc.remember; drawReceipt(); break;
    case 'rsave': saveReceipt(); break;
    case 'manual': sheetManual(); break;
    case 'phase2': toast(`${d.what || 'Questa funzione'} arriva nella prossima versione`); break;
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } break;
    case 'finish': sheetFinish(); break;
    case 'finishok': {
      const done = state.list.filter(i => i.done), b = writeBatch(db); let n = 0;
      done.forEach(i => {
        const q = s => document.querySelector(`[data-${s}="${i.id}"]`)?.value;
        const loc = q('floc');
        const rem = state.reminders.find(r => norm(r.name) === norm(i.name));
        if (rem) b.update(dref('reminders', rem.id), { next: isoIn(rem.every), ...stamp() });
        addPurchaseOps(b, i.name, i.rep, q('fprice'));
        if (loc && loc !== 'none') { addStockOps(b, { name: i.name, qty: q('fqty'), unit: q('funit'), loc, exp: q('fexp') || null, rep: i.rep }); n++; }
        b.delete(dref('list', i.id));
      });
      commit(b); closeSheet(); toast(`Spesa registrata: ${n} prodott${n === 1 ? 'o' : 'i'} in casa`); break;
    }
    case 'cookok': sheetCook.ok(); break;
    case 'newrecipe': sheetRecipe(); break;
    case 'suggest': sheetSuggest(false); break;
    case 'moreideas': sheetSuggest(true); break;
    case 'import': sheetImport(); break;
    case 'addIng': { const box = $('ings'), k = 'n' + Date.now(); box.insertAdjacentHTML('beforeend', sheetRecipe.row({ n: '', q: '', u: 'g' }, k)); box.querySelector(`[data-in="${k}"]`).focus(); break; }
    case 'delrecipe': if (confirmTap(t, 'Tocca di nuovo per eliminare')) { deleteDoc(dref('recipes', d.id)).catch(fail); closeSheet(); toast('Ricetta eliminata'); } break;
    case 'newrem': sheetReminder(); break;
    case 'delrem': if (confirmTap(t, 'Tocca di nuovo per eliminare')) { deleteDoc(dref('reminders', d.id)).catch(fail); closeSheet(); toast('Promemoria eliminato'); } break;
    case 'delitem': deleteDoc(dref('list', d.id)).catch(fail); closeSheet(); break;
    case 'delstock': if (confirmTap(t, 'Tocca di nuovo per eliminare')) { deleteDoc(dref('stock', d.id)).catch(fail); closeSheet(); toast('Prodotto eliminato'); } break;
    case 'usedup': {
      const s = state.stock.find(x => x.id === d.id); if (!s) break;
      const b = writeBatch(db); b.delete(dref('stock', s.id));
      if (!inList(s.name)) b.set(dref('list', 'low-' + slug(s.name)), { name: s.name, rep: s.rep || 'Altro', qty: s.min ? fmtQty(s.min, s.unit) : '', src: 'scorta', done: false, ...stamp() });
      commit(b); closeSheet(); toast(`${s.name} finito: aggiunto alla lista`); break;
    }
    case 'share': {
      const link = d.link;
      if (navigator.share) navigator.share({ title: 'Dispensa di Casa', text: 'Entra nella nostra dispensa di famiglia:', url: link }).catch(() => {});
      else navigator.clipboard?.writeText(link).then(() => toast('Link copiato')).catch(() => toast('Copia il link qui sopra'));
      break;
    }
    case 'copy': navigator.clipboard?.writeText(d.link).then(() => toast('Link copiato')).catch(() => toast('Seleziona e copia il link qui sopra')); break;
    case 'logout': closeSheet(); signOut(auth); break;
  }
});

document.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, v = id => $(id)?.value.trim() ?? '';
  if (f.id === 'addItem') { const n = v('newItem'); if (n) { addListItem(n); $('newItem').value = ''; } return; }
  if (f.id === 'manForm' || f.id === 'barForm') {
    const p = readStock(f.id === 'manForm' ? 'm' : 'b');
    if (!p.name.trim() || p.qty <= 0) { toast('Indica nome e quantità'); return; }
    const b = writeBatch(db);
    addStockOps(b, p);
    addPurchaseOps(b, p.name, p.rep, v(f.id === 'manForm' ? 'mprice' : 'bprice'));
    if (f.id === 'barForm') b.set(dref('barcodes', f.dataset.code), { name: cap(p.name), qty: p.qty, unit: p.unit, loc: p.loc, rep: p.rep, ...stamp() });
    const li = state.list.find(i => norm(i.name) === norm(p.name) && !i.done);
    if (li) b.delete(dref('list', li.id));
    commit(b); closeSheet(); toast(`${cap(p.name)} aggiunto${li ? ' e tolto dalla lista' : ''}`); return;
  }
  if (f.id === 'editStockForm') {
    const p = readStock('e'); if (!p.name.trim()) return;
    const b = writeBatch(db);
    b.update(dref('stock', f.dataset.id), { ...p, name: cap(p.name), ...stamp() });
    const s = state.stock.find(x => x.id === f.dataset.id); Object.assign(s, p);
    listLowOps(b); commit(b); closeSheet(); toast('Salvato'); return;
  }
  if (f.id === 'itemForm') {
    updateDoc(dref('list', f.dataset.id), { name: cap(v('iname')), qty: v('iqty'), rep: v('irep'), note: v('inote'), ...stamp() }).catch(fail);
    closeSheet(); return;
  }
  if (f.id === 'recipeForm') {
    const ings = [...document.querySelectorAll('[data-ing]')].map(r => {
      const k = r.dataset.ing;
      const q = num(r.querySelector(`[data-iq="${k}"]`).value);
      return { n: cap(r.querySelector(`[data-in="${k}"]`).value), q: q > 0 ? q : 0, u: r.querySelector(`[data-iu="${k}"]`).value, opt: !(q > 0) };
    }).filter(i => i.n);
    if (!ings.some(i => !i.opt)) { toast('Aggiungi almeno un ingrediente con quantità'); return; }
    const id = f.dataset.id || newId('recipes');
    const data = { name: cap(v('rname')), serv: Math.max(1, num(v('rserv')) || 1), time: num(v('rtime')) || null, url: v('rurl') || null, ings, src: f.dataset.id ? (state.recipes.find(r => r.id === id)?.src || 'mia') : (f.dataset.src || 'mia'), ...stamp() };
    setDoc(dref('recipes', id), data).catch(fail); closeSheet(); toast('Ricetta salvata'); return;
  }
  if (f.id === 'remForm') {
    const every = Math.max(1, num(v('rmevery')) || 30);
    const id = f.dataset.id || newId('reminders');
    const data = { name: cap(v('rmname')), every, qty: v('rmqty'), next: v('rmnext') || isoIn(every), rep: v('rmrep'), notify: $('rmnot').checked, ...stamp() };
    (f.dataset.id ? updateDoc(dref('reminders', id), data) : setDoc(dref('reminders', id), { ...data, listedFor: null })).catch(fail);
    closeSheet(); toast(f.dataset.id ? 'Promemoria aggiornato' : 'Promemoria creato'); return;
  }
  if (f.id === 'impForm') { importRecipe(v('impUrl')); return; }
  if (f.id === 'eanForm') { const c = v('eanIn').replace(/\D/g, ''); if (c.length >= 8) { stopScanner(); lookupBarcode(c); } else toast('Il codice ha da 8 a 13 cifre'); }
});

// Campi dello scontrino: aggiornano la riga senza ridisegnare (il cursore resta dov'è)
document.addEventListener('input', e => {
  const d = e.target.dataset;
  if (d.rfield && d.ri !== undefined && rc) {
    const l = rc.lines[+d.ri];
    l[d.rfield] = ['qty', 'price'].includes(d.rfield) ? num(e.target.value) : e.target.value;
    if (d.rfield === 'price' || d.rfield === 'qty') {
      const sum = rc.lines.filter(x => x.on).reduce((a, x) => a + (num(x.price) || 0), 0);
      const b = document.querySelector('.sheet .note b'); if (b) b.textContent = eur(sum);
    }
  }
});
document.addEventListener('change', e => {
  if ((e.target.id === 'rcam' || e.target.id === 'rlib') && e.target.files?.[0]) readReceipt(e.target.files[0]);
});

$('fab').addEventListener('click', sheetAdd);
$('family').addEventListener('click', sheetFamily);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

let deferredInstall = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; schedule(); });
