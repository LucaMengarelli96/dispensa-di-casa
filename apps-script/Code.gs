/**
 * Dispensa di Casa — server Apps Script.
 * Riceve richieste dall'app (solo da utenti che hanno fatto l'accesso), chiama Gemini e risponde in JSON.
 *
 * Proprietà dello script (Impostazioni progetto → Proprietà dello script):
 *   GEMINI_API_KEY  chiave creata su https://aistudio.google.com/apikey  (obbligatoria)
 *   GEMINI_MODEL    facoltativa: modello preferito al posto di MODELLO_PREFERITO
 */

// Chiave pubblica del progetto Firebase: serve solo a verificare chi fa la richiesta.
const FIREBASE_API_KEY = 'AIzaSyCgspbazrVlNVL2kpujFb0nNB4Kn3c9x2I';
const MAX_RECEIPTS_PER_DAY = 40;
const MAX_IDEAS_PER_DAY = 40;
const MAX_IMPORTS_PER_DAY = 40;
// Modello scelto: veloce (pochi secondi) e con quota gratuita ampia. Se non risponde si passa ai successivi.
const MODELLO_PREFERITO = 'gemini-3.5-flash-lite';
const REPARTI = ['Frutta e verdura', 'Pane e forno', 'Latticini e frigo', 'Carne e pesce', 'Pasta e dispensa', 'Bevande', 'Surgelati', 'Casa e igiene', 'Altro'];

function doGet() {
  return json_({ ok: true, service: 'Dispensa di Casa', version: 1 });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const uid = verifyUser_(req.idToken);
    if (req.action === 'receipt') {
      limit_(uid, 'receipt', MAX_RECEIPTS_PER_DAY);
      return json_(Object.assign({ ok: true }, readReceipt_(req)));
    }
    if (req.action === 'ideas') {
      limit_(uid, 'ideas', MAX_IDEAS_PER_DAY);
      return json_(Object.assign({ ok: true }, suggestIdeas_(req)));
    }
    if (req.action === 'import') {
      limit_(uid, 'import', MAX_IMPORTS_PER_DAY);
      return json_(Object.assign({ ok: true }, importRecipe_(req)));
    }
    return json_({ ok: false, error: 'Azione sconosciuta' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------- Sicurezza ---------- */

// Verifica il token di accesso Firebase dell'utente: chi non ha fatto l'accesso all'app viene rifiutato.
function verifyUser_(idToken) {
  if (!idToken) throw new Error('Accesso richiesto');
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Accesso scaduto: chiudi e riapri l\'app');
  const users = JSON.parse(res.getContentText()).users;
  if (!users || !users.length) throw new Error('Utente non riconosciuto');
  return users[0].localId;
}

// Limite giornaliero per utente, per non esaurire la quota gratuita di Gemini.
function limit_(uid, action, max) {
  const cache = CacheService.getScriptCache();
  const key = action + ':' + uid + ':' + Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyyMMdd');
  const n = Number(cache.get(key) || 0);
  if (n >= max) throw new Error('Limite giornaliero raggiunto, riprova domani');
  cache.put(key, String(n + 1), 21600);
}

/* ---------- Scontrino ---------- */

function readReceipt_(req) {
  if (!req.image) throw new Error('Foto mancante');
  const today = Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd');
  const aliases = (req.aliases || []).slice(0, 150).map(function (a) { return '- "' + a.raw + '" → "' + a.name + '"'; }).join('\n');
  const prompt = [
    'Leggi la foto di uno scontrino di un supermercato italiano. Oggi è ' + today + '.',
    'Restituisci SOLO un oggetto JSON, senza testo prima o dopo, con questa forma:',
    '{"store": string|null, "date": "YYYY-MM-DD"|null, "total": number|null, "lines": [riga, ...]}',
    'Ogni riga dello scontrino diventa un elemento di "lines", nello stesso ordine, con questi campi:',
    '- "raw": il testo della riga come stampato, senza il prezzo (es. "MOZZ.BUF.CAMP.DOP 250G")',
    '- "name": nome chiaro in italiano, senza marca e senza abbreviazioni, con iniziale maiuscola (es. "Mozzarella di bufala")',
    '- "qty": quantità totale acquistata (numero), "unit": "g" | "ml" | "pz" | "conf"',
    '    · prodotti con peso o volume: converti in g o ml e moltiplica per il numero di confezioni (es. "SPAGHETTI 500G" x2 → 1000 g; "LATTE 1L" x2 → 2000 ml)',
    '    · prodotti a peso ("KG 0,612") → grammi (612 g)',
    '    · uova, yogurt in vasetti, scatolette senza peso indicato → "pz"',
    '- "price": prezzo totale pagato per la riga in euro (numero), già moltiplicato per la quantità',
    '- "loc": dove si conserva, "frigo" | "dispensa" | "freezer" | "none" ("none" per prodotti non alimentari). Latte UHT, passate, pasta, scatolame → "dispensa"; surgelati → "freezer"',
    '- "rep": reparto, uno di ' + JSON.stringify(REPARTI),
    '- "expDays": giorni tipici di conservazione da oggi per il prodotto chiuso (numero intero), null per non alimentari',
    '- "skip": null per i prodotti; altrimenti il motivo breve se la riga NON è un prodotto da registrare: "sconto", "shopper", "totale", "pagamento", "punti", "iva", "resto"',
    'Se uno sconto si riferisce chiaramente al prodotto della riga precedente, sottrailo dal "price" di quella riga e segna la riga dello sconto con skip "sconto".',
    'Se una parte è illeggibile, includi comunque la riga con la tua migliore stima.',
    aliases ? 'Nomi che questa famiglia preferisce per righe già viste (usali quando la riga corrisponde):\n' + aliases : '',
  ].join('\n');
  const out = gemini_([
    { inlineData: { mimeType: req.mime || 'image/jpeg', data: req.image } },
    { text: prompt },
  ], RECEIPT_SCHEMA);
  const lines = linesOf_(out).map(function (l) {
    return {
      raw: String(l.raw || '').slice(0, 120),
      name: String(l.name || l.raw || '').slice(0, 80),
      qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
      unit: ['g', 'ml', 'pz', 'conf'].indexOf(l.unit) >= 0 ? l.unit : 'pz',
      price: Number(l.price) || 0,
      loc: ['frigo', 'dispensa', 'freezer', 'none'].indexOf(l.loc) >= 0 ? l.loc : 'dispensa',
      rep: REPARTI.indexOf(l.rep) >= 0 ? l.rep : 'Altro',
      expDays: l.expDays == null ? null : Math.max(0, Math.round(Number(l.expDays) || 0)),
      skip: l.skip ? String(l.skip).slice(0, 30) : null,
    };
  });
  return { store: out.store || null, date: out.date || null, total: Number(out.total) || null, lines: lines, model: model_() };
}

// Struttura della risposta imposta al modello (evita JSON con forme diverse da un modello all'altro)
const RECEIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    store: { type: 'STRING', nullable: true },
    date: { type: 'STRING', nullable: true },
    total: { type: 'NUMBER', nullable: true },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          raw: { type: 'STRING' }, name: { type: 'STRING' }, qty: { type: 'NUMBER' },
          unit: { type: 'STRING', enum: ['g', 'ml', 'pz', 'conf'] }, price: { type: 'NUMBER' },
          loc: { type: 'STRING', enum: ['frigo', 'dispensa', 'freezer', 'none'] },
          rep: { type: 'STRING', enum: REPARTI },
          expDays: { type: 'INTEGER', nullable: true }, skip: { type: 'STRING', nullable: true },
        },
        required: ['raw', 'name', 'qty', 'unit', 'price', 'loc', 'rep'],
      },
    },
  },
  required: ['lines'],
};

// Trova l'elenco delle righe anche se il modello ha usato una forma diversa
function linesOf_(out) {
  if (Array.isArray(out)) return out;
  if (out && Array.isArray(out.lines)) return out.lines;
  for (const k in out) if (Array.isArray(out[k])) return out[k];
  return [];
}

/* ---------- Idee: piatti con ciò che scade prima ---------- */

const ING_SCHEMA = {
  type: 'OBJECT',
  properties: {
    n: { type: 'STRING' }, q: { type: 'NUMBER' }, u: { type: 'STRING', enum: ['g', 'ml', 'pz', 'conf'] },
    opt: { type: 'BOOLEAN' }, raw: { type: 'STRING', nullable: true },
  },
  required: ['n', 'q', 'u', 'opt'],
};

const IDEAS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ideas: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' }, serv: { type: 'INTEGER' }, time: { type: 'INTEGER' },
          why: { type: 'STRING' }, search: { type: 'STRING' },
          uses: { type: 'ARRAY', items: { type: 'STRING' } },
          missing: { type: 'ARRAY', items: { type: 'STRING' } },
          ings: { type: 'ARRAY', items: ING_SCHEMA },
        },
        required: ['name', 'serv', 'time', 'why', 'search', 'uses', 'missing', 'ings'],
      },
    },
  },
  required: ['ideas'],
};

const ING_RULES = [
  'Regole per gli ingredienti ("ings"):',
  '- "n": se l\'ingrediente è nell\'elenco della dispensa usa ESATTAMENTE quel nome; altrimenti un nome breve e chiaro in italiano',
  '- "q" e "u": quantità per le porzioni indicate, in "g", "ml", "pz" (pezzi, es. uova, zucchine) o "conf"',
  '- "opt": true per sale, pepe, spezie, olio, acqua e tutto ciò che è "q.b." (in quel caso "q": 0)',
].join('\n');

function stockLines_(stock) {
  return (stock || []).slice(0, 250).map(function (s) {
    return '- ' + s.name + (s.qty ? ' (' + s.qty + ' ' + (s.unit || '') + ')' : '') + (s.days != null ? ', scade tra ' + s.days + ' giorni' : '');
  }).join('\n');
}

function suggestIdeas_(req) {
  const expiring = req.expiring || [];
  const prompt = [
    'Sei un cuoco di casa italiano. Proponi ' + (req.count || 3) + ' piatti semplici e diversi tra loro, da preparare a casa in famiglia.',
    expiring.length
      ? 'Usa SOPRATTUTTO questi ingredienti, che scadono presto (prima quelli che scadono prima):\n' + stockLines_(expiring)
      : 'Non ci sono ingredienti in scadenza: usa quello che c\'è in dispensa.',
    'Ingredienti disponibili in casa:\n' + stockLines_(req.stock),
    'Ogni piatto può richiedere al massimo 2 ingredienti da comprare (non contano sale, pepe, olio, spezie, acqua).',
    req.exclude && req.exclude.length ? 'Non riproporre questi piatti: ' + req.exclude.join(', ') + '.' : '',
    'Per ogni piatto: "name" nome del piatto; "serv" porzioni (' + (req.serv || 4) + '); "time" minuti totali;',
    '"why" una frase breve su cosa usa che scade; "search" 2-4 parole per cercare la ricetta su un sito di cucina;',
    '"uses" i nomi ESATTI degli ingredienti in scadenza che usa; "missing" i nomi degli ingredienti da comprare; "ings" tutti gli ingredienti.',
    ING_RULES,
  ].join('\n');
  const out = gemini_([{ text: prompt }], IDEAS_SCHEMA);
  const ideas = (out.ideas || linesOf_(out)).slice(0, 5).map(function (i) {
    return {
      name: String(i.name || '').slice(0, 80), serv: Math.max(1, Number(i.serv) || 4), time: Math.max(0, Number(i.time) || 0),
      why: String(i.why || '').slice(0, 200), search: String(i.search || i.name || '').slice(0, 60),
      uses: (i.uses || []).map(String).slice(0, 10), missing: (i.missing || []).map(String).slice(0, 5),
      ings: cleanIngs_(i.ings),
    };
  });
  return { ideas: ideas };
}

function cleanIngs_(ings) {
  return (ings || []).slice(0, 40).map(function (x) {
    const opt = !!x.opt || !(Number(x.q) > 0);
    return {
      n: String(x.n || '').slice(0, 60), q: opt ? 0 : Number(x.q), u: ['g', 'ml', 'pz', 'conf'].indexOf(x.u) >= 0 ? x.u : 'pz',
      opt: opt, raw: x.raw ? String(x.raw).slice(0, 120) : null,
    };
  }).filter(function (x) { return x.n; });
}

/* ---------- Import di una ricetta da link ---------- */

const IMPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' }, serv: { type: 'INTEGER' }, time: { type: 'INTEGER', nullable: true },
    ings: { type: 'ARRAY', items: ING_SCHEMA },
  },
  required: ['name', 'serv', 'ings'],
};

function importRecipe_(req) {
  const url = String(req.url || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Indirizzo non valido');
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code === 403 || code === 401) throw new Error('Il sito non permette la lettura automatica: inserisci la ricetta a mano');
  if (code !== 200) throw new Error('Pagina non raggiungibile (errore ' + code + ')');
  const html = res.getContentText();
  const ld = findRecipeLd_(html);
  let source;
  if (ld && ld.recipeIngredient && ld.recipeIngredient.length) {
    source = [
      'Ricetta: ' + text_(ld.name),
      'Porzioni: ' + text_(ld.recipeYield),
      'Tempo: ' + (minutes_(ld.totalTime) || (minutes_(ld.prepTime) + minutes_(ld.cookTime)) || 'non indicato') + ' minuti',
      'Ingredienti:', [].concat(ld.recipeIngredient).map(function (s) { return '- ' + text_(s); }).join('\n'),
    ].join('\n');
  } else {
    // Nessun dato strutturato: si passa il testo della pagina e l'AI estrae solo nome, porzioni e ingredienti
    source = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 15000);
  }
  const prompt = [
    'Da questa ricetta estrai solo: "name" nome del piatto, "serv" porzioni (numero; se non indicato 4), "time" minuti totali (null se non indicato), "ings" ingredienti.',
    'Per ogni ingrediente metti in "raw" il testo originale della riga.',
    ING_RULES,
    'Elenco della dispensa (usa questi nomi quando l\'ingrediente è lo stesso):\n' + (req.stockNames || []).slice(0, 300).join(', '),
    'Se il testo non contiene una ricetta, restituisci "ings" vuoto.',
    '---', source,
  ].join('\n');
  const out = gemini_([{ text: prompt }], IMPORT_SCHEMA);
  const ings = cleanIngs_(out.ings);
  if (!ings.length) throw new Error('In questa pagina non ho trovato una ricetta');
  return {
    name: String(out.name || text_(ld && ld.name) || 'Ricetta').slice(0, 80),
    serv: Math.max(1, Number(out.serv) || 4), time: Number(out.time) || null,
    ings: ings, url: url, host: url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0], structured: !!ld,
  };
}

// Cerca nella pagina i dati strutturati schema.org di tipo Recipe (usati dalla maggior parte dei siti di ricette)
function findRecipeLd_(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const found = walkLd_(data);
    if (found) return found;
  }
  return null;
}
function walkLd_(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { const f = walkLd_(node[i]); if (f) return f; } return null; }
  const t = [].concat(node['@type'] || []);
  if (t.indexOf('Recipe') >= 0) return node;
  return walkLd_(node['@graph']) || walkLd_(node.mainEntity);
}
function text_(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text_).join(', ');
  if (typeof v === 'object') return text_(v.name || v['@value'] || '');
  return String(v).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
}
function minutes_(iso) {
  const m = String(iso || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? (Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

/* ---------- Gemini ---------- */

function gemini_(parts, schema) {
  const key = apiKey_();
  const cache = CacheService.getScriptCache();
  const models = models_().slice(0, 4);
  let lastErr = '';
  for (let i = 0; i < models.length; i++) {
    let useSchema = !!schema;
    for (let attempt = 0; attempt < 2; attempt++) {
      const config = { responseMimeType: 'application/json', temperature: 0.1 };
      if (useSchema) config.responseSchema = schema;
      const t0 = Date.now();
      const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent', {
        method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
        payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: config }),
      });
      const code = res.getResponseCode();
      console.log('Gemini ' + models[i] + (useSchema ? ' (schema)' : '') + ': ' + code + ' in ' + (Date.now() - t0) + ' ms');
      if (code === 200) {
        const body = JSON.parse(res.getContentText());
        const cand = body.candidates && body.candidates[0];
        const text = cand && cand.content && cand.content.parts ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
        if (!text) throw new Error('L\'AI non ha risposto: prova con una foto più nitida');
        const clean = text.replace(/^\s*```(json)?/i, '').replace(/```\s*$/, '');
        try { return JSON.parse(clean); } catch (e) { throw new Error('Risposta dell\'AI non leggibile: riprova'); }
      }
      lastErr = code + ' ' + res.getContentText().slice(0, 160);
      // Modello che non accetta lo schema: riprova senza
      if (code === 400 && useSchema) { useSchema = false; continue; }
      // Modello ritirato o senza quota gratuita: lo salto per qualche ora
      if (code === 404 || code === 429) cache.put('skip:' + models[i], '1', code === 404 ? 21600 : 600);
      break;
    }
    if (!/^(429|500|503|404)/.test(lastErr)) throw new Error('Errore AI ' + lastErr);
  }
  if (/^429/.test(lastErr)) throw new Error('Limite gratuito dell\'AI raggiunto: riprova tra qualche minuto');
  throw new Error('L\'AI è sovraccarica in questo momento: riprova tra un minuto');
}

function apiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Manca GEMINI_API_KEY nelle proprietà dello script');
  return key;
}

// Modelli in ordine di preferenza: quello scelto, poi gli altri Flash-Lite e infine i Flash, dal più recente.
// L'elenco dei modelli disponibili per la chiave viene ricordato per 6 ore.
function models_() {
  const cache = CacheService.getScriptCache();
  const first = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || MODELLO_PREFERITO;
  let list = JSON.parse(cache.get('models') || 'null');
  if (!list) {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': apiKey_() }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('Chiave Gemini non valida o non attiva');
    const all = (JSON.parse(res.getContentText()).models || [])
      .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
      .map(function (m) { return m.name.replace('models/', ''); })
      .filter(function (n) { return /^gemini-[\d.]+-flash/.test(n) && !/image|tts|live|audio|embed/.test(n); });
    const rank = function (n) { return (/lite/.test(n) ? 0 : 2) + (/preview|exp/.test(n) ? 1 : 0); };
    list = all.sort(function (a, b) { return rank(a) - rank(b) || version_(b) - version_(a) || a.length - b.length; });
    if (!list.length) throw new Error('Nessun modello Gemini Flash disponibile per questa chiave');
    cache.put('models', JSON.stringify(list), 21600);
  }
  return [first].concat(list.filter(function (n) { return n !== first; }))
    .filter(function (n) { return !cache.get('skip:' + n); });
}
function model_() { return models_()[0]; }
function version_(name) { const m = name.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Prova manuale dall'editor ---------- */

// Esegui questa funzione dall'editor per controllare chiave e modello: il risultato compare nel log.
function prova() {
  CacheService.getScriptCache().remove('models');
  console.log('Modelli in ordine di preferenza: ' + models_().slice(0, 4).join(', '));
  const t0 = Date.now();
  const out = gemini_([{ text: 'Testo di uno scontrino italiano, oggi è ' + Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd') + ':\n' +
    'LATTE PS UHT 1L 1,29\nLATTE PS UHT 1L 1,29\nMOZZ.BUF.CAMP.DOP 250G 3,49\nZUCCH.SCURE KG0,612 1,52\nSCONTO FIDATY -0,50\nSHOPPER 0,10\nTOTALE 7,19\n' +
    'Per ogni riga: raw senza prezzo, name nome chiaro in italiano senza abbreviazioni, qty e unit (g, ml, pz, conf), price, loc, rep, expDays, skip (motivo se non è un prodotto).' }], RECEIPT_SCHEMA);
  console.log('Tempo totale: ' + (Date.now() - t0) + ' ms');
  console.log(JSON.stringify(linesOf_(out).map(function (l) { return [l.raw, l.name, l.qty + ' ' + l.unit, l.price, l.loc, l.skip].join(' | '); }), null, 1));
}

// Prova dell'import da link e delle idee dall'editor
function provaRicette() {
  const t0 = Date.now();
  const imp = importRecipe_({ url: 'https://ricette.giallozafferano.it/Spaghetti-alla-Carbonara.html', stockNames: ['Spaghetti', 'Uova', 'Parmigiano', 'Pecorino', 'Guanciale', 'Pepe nero'] });
  console.log('Import in ' + (Date.now() - t0) + ' ms, dati strutturati: ' + imp.structured);
  console.log(imp.name + ' · ' + imp.serv + ' porzioni · ' + imp.time + ' min');
  console.log(imp.ings.map(function (i) { return i.n + ' ' + (i.opt ? 'q.b.' : i.q + ' ' + i.u) + '  ← ' + i.raw; }).join('\n'));
  const t1 = Date.now();
  const id = suggestIdeas_({ expiring: [{ name: 'Zucchine', qty: 3, unit: 'pz', days: 2 }, { name: 'Mozzarella', qty: 1, unit: 'pz', days: 1 }],
    stock: [{ name: 'Uova', qty: 6, unit: 'pz' }, { name: 'Parmigiano', qty: 200, unit: 'g' }, { name: 'Spaghetti', qty: 1000, unit: 'g' }] });
  console.log('Idee in ' + (Date.now() - t1) + ' ms');
  console.log(id.ideas.map(function (i) { return i.name + ' (' + i.time + ' min) usa ' + i.uses.join(', ') + ' · manca ' + i.missing.join(', '); }).join('\n'));
}
