// Store unico dell'app allenamento: Upstash Redis via REST, database DEDICATO (`workout-db`,
// Vercel Marketplace sul progetto `workout-app`). Qui vive il MERGE, che prima stava sul
// telefono: il contratto e' quello di wiki/Personale/allenamento/sync-contract.md, cambia solo
// chi lo applica (il server) e quando (all'istante del push, non all'avvio).
//
// Un record per giorno/serie, non un documento unico. Chiavi:
//   wk:nut:<data>        survey nutrizione         LAST-WINS su savedAt
//   wk:weight:<data>     pesata                    LAST-WINS su loggedAt
//   wk:meal:<data>       pasti del giorno (array)  UNION per mealKey + lapidi
//   wk:tomb:<data>       lapidi pasti (array)      UNION di chiavi, append-only
//   wk:sess:<dateISO>    seduta                    UNION per data (append-only: non si riscrive)
//   wk:chat:<id>         voce di chat/feedback     UNION (append-only)
//   wk:load:<id>         carico dichiarato         LAST-WINS su updatedAt
//   wk:plan              piano del coach           BLIND-DOWN (solo token server)
//   wk:metrics           referto/metriche          BLIND-DOWN (solo token server)
//   wk:profilo           profilo (8 campi)         LAST-WINS su profileUpdatedAt
//   wk:splitidx          indice rotazione split    LAST-WINS su splitIdxUpdatedAt
//   wk:recovery          modalita' recupero        LAST-WINS su updatedAt
//   wk:adaptation        adaptation IA             LAST-WINS su lastUpdated
//   wk:forcerun          segnale force-run         LAST-WINS su ts
// Indice:  wk:idx  ZSET  membro = chiave completa, punteggio = numero di sequenza del server
// Meta:    wk:meta HASH  ultimo_delta · ultimo_delta_app · ultimo_delta_server ·
//                        server_updated_at · ultimo_cursore · ultimo_rifiuto · ultimo_rifiuto_che
// ⚠️ `ultimo_delta_app` e `ultimo_delta_server` sono separati di proposito: «da quanto non
// consegna il TELEFONO» non si legge da `ultimo_delta`, che lo muove anche il Mac ogni notte.
// E' lo stesso tell di R104 — il `modifiedTime` del file Drive restava fresco grazie al coach
// mentre la sorgente taceva da tre giorni. Un contatore per autore, o non misura niente.
//
// ⚠️ Il punteggio dell'indice e' una SEQUENZA DEL SERVER (`INCR wk:seq`), non l'orologio di chi
// scrive e nemmeno il timbro del record. Due motivi: (1) un client con l'ora sbagliata non puo'
// far sparire la propria scrittura da `?since=`; (2) una sequenza non ha collisioni, quindi il
// cursore e' esclusivo senza rischio di perdere i record scritti nello stesso millisecondo.
// Il `timbro` del record resta quello del contratto e serve al merge, non alla paginazione.

import crypto from 'node:crypto';

const URL_BASE = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.KV_REST_API_TOKEN || '';

export const IDX = 'wk:idx';
export const SEQ = 'wk:seq';
export const META = 'wk:meta';

export class Rifiuto extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export async function kv(...cmds) {
  if (!URL_BASE || !TOKEN) throw new Rifiuto(503, 'store non configurato');
  const r = await fetch(URL_BASE + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Rifiuto(502, 'store HTTP ' + r.status);
  const out = await r.json();
  const err = Array.isArray(out) && out.find((x) => x && x.error);
  if (err) throw new Rifiuto(502, 'store: ' + err.error);
  return out.map((x) => x.result);
}

// ─── timbri ──────────────────────────────────────────────────────────────────
// Confronto per ISTANTE (Date.parse), MAI lessicografico: i produttori scrivono ISO in formati
// diversi (app '…Z', server '…+00:00'/'+02:00') e la stringa li ordinerebbe male — stessa
// deviazione gia' corretta in `newer()` dell'app e in `_parse_iso` lato Mac.
// Assente/invalido = piu' vecchio di tutto: il presente vince sull'assente.
export const ts = (x) => {
  const t = x ? Date.parse(x) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};
export const piuFresco = (a, b) => ts(a) > ts(b);

// ─── identita' di un pasto ───────────────────────────────────────────────────
// Replica fedele di `mealKey()` dell'app: `mealId` quando c'e', altrimenti loggedAt+descrizione,
// perche' `loggedAt` da solo NON identifica un pasto (dentro un batch e' identico per tutti e la
// dedup ne cancellerebbe due su tre).
export function mealKey(m) {
  if (!m) return null;
  if (m.mealId) return m.mealId;
  return (m.loggedAt || '') + '|' + (m.foodDescription || '');
}

// ─── tabella maestra, in codice ──────────────────────────────────────────────
// forma: 'last-wins' | 'union-array' | 'union-chiavi' | 'append' | 'blind-down'
// chiave: 'data' = serve una chiave per record · 'fissa' = una sola istanza
// `campoTimbro` puo' essere una lista: si prende il primo presente. Serve dove il timbro fine
// e' arrivato dopo (⚠ della tabella maestra): `loads` e `progression` portano ancora voci vecchie
// con la sola `date` a granularita'-giorno. Un record senza timbro e' piu' vecchio di tutto, quindi
// la lista evita che una voce storica diventi incomparabile.
export const TIPI = {
  nut:        { forma: 'last-wins',    campoTimbro: 'savedAt',                  chiave: 'data' },
  weight:     { forma: 'last-wins',    campoTimbro: 'loggedAt',                 chiave: 'data' },
  meal:       { forma: 'union-array',  campoTimbro: null,                       chiave: 'data' },
  tomb:       { forma: 'union-chiavi', campoTimbro: null,                       chiave: 'data' },
  sess:       { forma: 'append',       campoTimbro: 'date',                     chiave: 'data' },
  chat:       { forma: 'append',       campoTimbro: 'date',                     chiave: 'data' },
  load:       { forma: 'last-wins',    campoTimbro: ['updatedAt', 'date'],      chiave: 'data' },
  prog:       { forma: 'last-wins',    campoTimbro: ['updatedAt', 'date'],      chiave: 'data' },
  varlast:    { forma: 'last-wins',    campoTimbro: ['updatedAt', 'date'],      chiave: 'data' },
  weekly:     { forma: 'append',       campoTimbro: 'weekEnd',                  chiave: 'data' },
  monthly:    { forma: 'append',       campoTimbro: null,                       chiave: 'data' },
  plan:       { forma: 'blind-down',   campoTimbro: 'generatedAt',              chiave: 'fissa' },
  // ⚠️ il referto NON ha `generatedAt`: i suoi timbri sono `publishedAt` (lo mette publish_metrics)
  // e `generated`. Col campo sbagliato il timbro sarebbe sempre nullo e ogni scrittura vincerebbe.
  metrics:    { forma: 'blind-down',   campoTimbro: ['publishedAt', 'generated'], chiave: 'fissa' },
  profilo:    { forma: 'last-wins',    campoTimbro: 'profileUpdatedAt',         chiave: 'fissa' },
  splitidx:   { forma: 'last-wins',    campoTimbro: 'splitIdxUpdatedAt',        chiave: 'fissa' },
  recovery:   { forma: 'last-wins',    campoTimbro: 'updatedAt',                chiave: 'fissa' },
  adaptation: { forma: 'last-wins',    campoTimbro: 'lastUpdated',              chiave: 'fissa' },
  forcerun:   { forma: 'last-wins',    campoTimbro: 'ts',                       chiave: 'fissa' },
  // Guardie delle migrazioni una-tantum dell'app (`_fix`, `_nutRecovered`). Non sono dato-verita':
  // sono il «questo l'ho gia' fatto». Viaggiano perche' un telefono reinstallato, senza di esse,
  // ri-lancerebbe `fixProgressioneFossile`/`migraS1AllaMacchina` su dati gia' corretti. Unione di
  // chiavi: una guardia si accende e non si spegne piu'.
  flags:      { forma: 'union-dict',   campoTimbro: null,                       chiave: 'fissa' },
};

export const chiaveRedis = (tipo, chiave) =>
  TIPI[tipo].chiave === 'fissa' ? 'wk:' + tipo : 'wk:' + tipo + ':' + chiave;

// Il nome con cui un record si annuncia nelle risposte (e nel banner dell'app). Deve reggere
// anche un tipo che non esiste: e' proprio il record malformato quello che va saputo nominare.
export const nome = (tipo, chiave) => {
  const t = TIPI[tipo];
  if (!t) return String(tipo === undefined ? 'senza-tipo' : tipo).slice(0, 40) + (chiave ? ':' + String(chiave).slice(0, 60) : '');
  return t.chiave === 'fissa' ? tipo : tipo + ':' + String(chiave === undefined ? '?' : chiave).slice(0, 120);
};

// ─── validazione ─────────────────────────────────────────────────────────────
// Le chiavi viaggiano in `wk:<tipo>:<chiave>`. I due punti sono ammessi perche' la chiave di una
// seduta E' un ISO pieno (`1999-01-03T08:00:00.000Z`), e restano innocui: il prefisso `wk:<tipo>:`
// e' messo dal server, quindi nessuna chiave puo' scavalcare il proprio tipo. Fuori dall'alfabeto
// qui sotto non passa niente — in particolare spazi, `*`, `?`, `{`, `}` e `/`, che in Redis
// aprirebbero pattern e hash-tag.
const CHIAVE_OK = /^[A-Za-z0-9_.:@#+-]{1,120}$/;

export function valida(rec) {
  if (!rec || typeof rec !== 'object') return 'record non e\' un oggetto';
  const t = TIPI[rec.tipo];
  if (!t) return 'tipo sconosciuto: ' + String(rec.tipo).slice(0, 40);
  if (t.chiave === 'data') {
    if (typeof rec.chiave !== 'string' || !CHIAVE_OK.test(rec.chiave)) return 'chiave non valida';
  }
  if (rec.dati === undefined || rec.dati === null) return 'dati mancanti';
  if (t.forma === 'union-array' && !Array.isArray(rec.dati)) return 'dati devono essere un array';
  if (t.forma === 'union-chiavi' && !Array.isArray(rec.dati)) return 'dati devono essere un array';
  if (t.forma === 'union-dict' && (typeof rec.dati !== 'object' || Array.isArray(rec.dati))) return 'dati devono essere un oggetto';
  if ((t.forma === 'last-wins' || t.forma === 'blind-down') && typeof rec.dati !== 'object') return 'dati devono essere un oggetto';
  return null;
}

// Il timbro dichiarato dal record, o quello dentro i dati (il contratto lo tiene lì), o niente.
export const timbroDi = (rec) => {
  const t = TIPI[rec.tipo];
  if (rec.timbro) return rec.timbro;
  if (!t.campoTimbro || !rec.dati || typeof rec.dati !== 'object') return null;
  const campi = Array.isArray(t.campoTimbro) ? t.campoTimbro : [t.campoTimbro];
  for (const c of campi) if (rec.dati[c]) return rec.dati[c];
  return null;
};

// ─── merge ───────────────────────────────────────────────────────────────────
// Decide cosa diventa il record. Ritorna {azione:'scrivi', valore} oppure
// {azione:'ignora', perche} — ignora NON e' un errore: e' il merge che ha deciso che vince
// l'altro lato, ed e' il caso normale di un LAST-WINS perso.
export function fondi(tipo, precedente, rec, lapidi) {
  const t = TIPI[tipo];
  const nuovoTimbro = timbroDi(rec);

  if (t.forma === 'append') {
    // UNION per chiave: la presenza vince, il contenuto non si riscrive. Fedele a
    // `unionBy(S.history, dd.history, 'date')`, dove il primo lato (il locale) vince. Nell'app
    // sedute e chat sono append-only (`finishSession` concatena, non modifica), quindi un
    // record che esiste gia' non va riscritto: sarebbe un modo silenzioso di riscrivere il
    // vissuto.
    if (precedente) return { azione: 'ignora', perche: 'esiste-gia' };
    return { azione: 'scrivi', valore: { tipo, chiave: rec.chiave, timbro: nuovoTimbro, dati: rec.dati } };
  }

  if (t.forma === 'blind-down') {
    // «Il valore server vince SEMPRE» (tabella maestra). Non e' un last-wins: qui arriva solo il
    // token del server, e il proprietario di un record non va rifiutato perche' non ha mosso il
    // suo timbro. Il coach puo' correggere il piano senza rigenerarlo, e `publish_metrics` puo'
    // ripubblicare un referto: con un confronto sul timbro quelle scritture cadrebbero mute.
    return { azione: 'scrivi', valore: { tipo, chiave: rec.chiave, timbro: nuovoTimbro || new Date().toISOString(), dati: rec.dati } };
  }

  if (t.forma === 'last-wins') {
    if (precedente && !piuFresco(nuovoTimbro, precedente.timbro))
      return { azione: 'ignora', perche: 'piu-vecchio' };
    return { azione: 'scrivi', valore: { tipo, chiave: rec.chiave, timbro: nuovoTimbro, dati: rec.dati } };
  }

  if (t.forma === 'union-array') {
    // UNIONE dedup per mealKey. Nessuna rimozione da qui: una rimozione passa SOLO dalle lapidi.
    // ⚠️ Le lapidi si applicano QUI, all'istante del push, non dopo. Un telefono che ha ancora il
    // pasto soppresso in localStorage lo ri-manda: con la sola potatura a valle rientrerebbe nello
    // store e tornerebbe il difetto del 04/08 (kcal giuste, elenco pasti doppio — l'unica colonna
    // che si legge davvero). Sotto una UNIONE l'assenza non si propaga: la lapide sì, ed e' lei a
    // dover vincere nel momento in cui il record arriva.
    const morti = new Set(Array.isArray(lapidi) ? lapidi : []);
    const have = (Array.isArray(precedente && precedente.dati) ? precedente.dati : [])
      .filter((v) => !morti.has(mealKey(v)));
    const seen = new Set();
    for (const v of have) { const k = mealKey(v); if (k != null) seen.add(k); }
    let aggiunti = 0, respinti = 0;
    for (const v of rec.dati) {
      const k = mealKey(v);
      if (k != null && morti.has(k)) { respinti++; continue; }
      if (k != null && !seen.has(k)) { have.push(v); seen.add(k); aggiunti++; }
    }
    const potati = (Array.isArray(precedente && precedente.dati) ? precedente.dati.length : 0) - (have.length - aggiunti);
    if (precedente && !aggiunti && !potati) {
      return { azione: 'ignora', perche: respinti ? 'soppresso-da-lapide' : 'niente-di-nuovo' };
    }
    return { azione: 'scrivi', valore: { tipo, chiave: rec.chiave, timbro: new Date().toISOString(), dati: have } };
  }

  if (t.forma === 'union-chiavi') {
    const have = Array.isArray(precedente && precedente.dati) ? precedente.dati.slice() : [];
    const seen = new Set(have);
    let aggiunti = 0;
    for (const k of rec.dati) {
      if (typeof k === 'string' && k && !seen.has(k)) { have.push(k); seen.add(k); aggiunti++; }
    }
    if (precedente && !aggiunti) return { azione: 'ignora', perche: 'niente-di-nuovo' };
    return { azione: 'scrivi', valore: { tipo, chiave: rec.chiave, timbro: new Date().toISOString(), dati: have } };
  }

  if (t.forma === 'union-dict') {
    const have = Object.assign({}, (precedente && precedente.dati) || {});
    let aggiunti = 0;
    for (const [k, v] of Object.entries(rec.dati)) {
      if (!Object.prototype.hasOwnProperty.call(have, k)) { have[k] = v; aggiunti++; }
    }
    if (precedente && !aggiunti) return { azione: 'ignora', perche: 'niente-di-nuovo' };
    return { azione: 'scrivi', valore: { tipo, chiave: rec.chiave, timbro: new Date().toISOString(), dati: have } };
  }

  return { azione: 'ignora', perche: 'forma non gestita' };
}

// ─── scrittura atomica (compare-and-swap) ────────────────────────────────────
// Il telefono e il Mac possono scrivere lo stesso record nello stesso istante. Si rilegge, si
// fonde, e si scrive solo se nel frattempo il valore non e' cambiato; altrimenti si rifonde sul
// nuovo. Stesso schema del CAS di Claudio Review.
const CAS = [
  "local c = redis.call('GET', KEYS[1])",
  "if (c or '') ~= ARGV[1] then return -1 end",
  "local s = redis.call('INCR', KEYS[3])",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "redis.call('ZADD', KEYS[2], s, KEYS[1])",
  "redis.call('HSET', KEYS[4], 'ultimo_delta', ARGV[3], 'ultimo_cursore', s)",
  "return s",
].join(' ');

export async function applica(rec) {
  const chiaveK = chiaveRedis(rec.tipo, rec.chiave);
  const chiaveT = rec.tipo === 'meal' ? chiaveRedis('tomb', rec.chiave) : null;
  for (let i = 0; i < 5; i++) {
    const letture = chiaveT ? [['GET', chiaveK], ['GET', chiaveT]] : [['GET', chiaveK]];
    const [grezzo, grezzoT] = await kv(...letture);
    let precedente = null;
    if (grezzo) {
      try { precedente = JSON.parse(grezzo); }
      catch { return { esito: 'rifiutato', perche: 'record esistente illeggibile' }; }
    }
    let lapidi = null;
    if (grezzoT) { try { lapidi = JSON.parse(grezzoT).dati; } catch { lapidi = null; } }
    const d = fondi(rec.tipo, precedente, rec, lapidi);
    if (d.azione === 'ignora') return { esito: 'ignorato', perche: d.perche };
    const [seq] = await kv(['EVAL', CAS, '4', chiaveK, IDX, SEQ, META,
      grezzo === null || grezzo === undefined ? '' : grezzo,
      JSON.stringify(d.valore), new Date().toISOString()]);
    if (seq !== -1) return { esito: 'ok', cursore: seq };
  }
  return { esito: 'rifiutato', perche: 'qualcuno ha scritto lo stesso record: riprova' };
}

// ─── lapidi ──────────────────────────────────────────────────────────────────
// Una cancellazione sotto una UNIONE viaggia come record PRESENTE, mai come assenza. Quindi:
// (1) la lapide si aggiunge a `wk:tomb:<data>` e resta lì per sempre (append-only), così anche
// un device mai aggiornato smette di resuscitare il pasto; (2) i pasti indicati vengono
// TOLTI DAVVERO da `wk:meal:<data>`, e la chiave resta — con l'array potato e un cursore nuovo —
// perche' un consumatore che legge `?since=` deve poter vedere la rimozione. Se la chiave
// sparisse, la rimozione sarebbe un'assenza, cioe' invisibile.
export async function sopprimi(data, chiavi) {
  const vive = (chiavi || []).filter((k) => typeof k === 'string' && k);
  if (!vive.length) return { esito: 'rifiutato', perche: 'nessuna chiave da sopprimere' };

  const lapide = await applica({ tipo: 'tomb', chiave: data, dati: vive });

  // ...poi si pota. Ordine obbligato: prima la lapide, poi la potatura — al contrario un push
  // concorrente rimetterebbe il pasto dentro senza che nessuna lapide lo fermi.
  const chiaveM = chiaveRedis('meal', data);
  let potati = 0;
  for (let i = 0; i < 5; i++) {
    const [grezzo] = await kv(['GET', chiaveM]);
    if (!grezzo) break;                       // nessun pasto per quel giorno: la lapide basta
    let rec;
    try { rec = JSON.parse(grezzo); } catch { break; }
    const restano = (Array.isArray(rec.dati) ? rec.dati : []).filter((m) => !vive.includes(mealKey(m)));
    potati = (Array.isArray(rec.dati) ? rec.dati.length : 0) - restano.length;
    if (!potati) break;
    const valore = { tipo: 'meal', chiave: data, timbro: new Date().toISOString(), dati: restano };
    const [seq] = await kv(['EVAL', CAS, '4', chiaveM, IDX, SEQ, META,
      grezzo, JSON.stringify(valore), new Date().toISOString()]);
    if (seq !== -1) break;
  }
  return { esito: lapide.esito === 'rifiutato' ? 'rifiutato' : 'ok', perche: lapide.perche, potati };
}

// ─── autenticazione ──────────────────────────────────────────────────────────
// Due token, perche' due ruoli diversi: il telefono scrive il vissuto, il Mac scrive anche
// cio' che e' BLIND-DOWN (piano del coach, referto). Con un solo token la regola BLIND-DOWN
// sarebbe solo una buona intenzione; con due e' un confine. Confronto a tempo costante su
// digest di pari lunghezza (timingSafeEqual pretende buffer uguali).
const digest = (s) => crypto.createHash('sha256').update(String(s || ''), 'utf8').digest();
const uguali = (a, b) => {
  const x = digest(a), y = digest(b);
  return crypto.timingSafeEqual(x, y);
};

export function ruolo(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const dato = (/^Bearer\s+(.+)$/i.exec(h.trim()) || [])[1] || '';
  const tApp = process.env.WORKOUT_API_TOKEN || '';
  const tSrv = process.env.WORKOUT_SERVER_TOKEN || '';
  if (!dato) return null;
  if (tSrv && uguali(dato, tSrv)) return 'server';
  if (tApp && uguali(dato, tApp)) return 'app';
  return null;
}

// ─── CORS ────────────────────────────────────────────────────────────────────
// L'app sta su GitHub Pages (origine diversa dalle funzioni), e manda `Authorization`: quindi
// il browser fa sempre il preflight. Allowlist esplicita: il token di scrittura non deve poter
// essere usato da una pagina qualunque che l'utente apra.
const ORIGINI = new Set([
  'https://simoneviscontigit.github.io',
  'https://workout.simonevisconti.it',
]);

export function cors(req, res) {
  const o = req.headers.origin || '';
  if (ORIGINI.has(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

export const corpo = (req) => {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  try { return JSON.parse(b || '{}'); } catch { return {}; }
};

export function errore(res, e) {
  if (e instanceof Rifiuto) return res.status(e.status).json({ errore: e.message });
  return res.status(502).json({ errore: String((e && e.message) || e) });
}
