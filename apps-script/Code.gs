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
