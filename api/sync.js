// POST /api/sync — riceve un DELTA e applica il merge lato server.
//
// Corpo:
//   { fonte?: 'app'|'server',
//     records: [ { tipo, chiave, timbro?, dati }, … ],
//     tombstones: [ { data, chiavi: [mealKey, …] }, … ] }
//
// Risposta:
//   { ok: [nome, …],
//     ignorati:  [ { chiave, perche } ],   ← il merge ha deciso che vince l'altro lato (normale)
//     rifiutati: [ { chiave, perche } ],   ← non e' passato: QUESTA e' la spia che prima non c'era
//     cursore, ultimoDelta, adesso }
//
// La distinzione fra `ignorati` e `rifiutati` e' il punto: con il blob intero un salvataggio
// rispondeva `{ok:true}` o niente, e «l'ho compilato» e «e' arrivato» erano la stessa cosa. Un
// LAST-WINS perso non e' un guasto; un record malformato o non ammesso sì, e il banner dell'app
// deve poter dire QUALE.
import { applica, sopprimi, valida, nome, TIPI, ruolo, cors, corpo, errore, Rifiuto, kv, META, IDX } from './_store.js';

const MAX_RECORDS = 400;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    if (req.method !== 'POST') throw new Rifiuto(405, 'serve POST');
    const r = ruolo(req);
    if (!r) throw new Rifiuto(401, 'token assente o non valido');

    const b = corpo(req);
    const records = Array.isArray(b.records) ? b.records : [];
    const tombstones = Array.isArray(b.tombstones) ? b.tombstones : [];
    if (records.length + tombstones.length > MAX_RECORDS)
      throw new Rifiuto(413, 'delta troppo grande: ' + (records.length + tombstones.length) + ' record (max ' + MAX_RECORDS + ')');

    const ok = [], ignorati = [], rifiutati = [];
    let cursore = 0;

    for (const rec of records) {
      const motivo = valida(rec);
      const etichetta = rec && rec.tipo ? nome(rec.tipo, rec && rec.chiave) : 'record senza tipo';
      if (motivo) { rifiutati.push({ chiave: etichetta, perche: motivo }); continue; }

      // BLIND-DOWN: il piano del coach e il referto li scrive SOLO chi gira sul Mac. Con il blob
      // intero il telefono li ri-pubblicava per forza (omettere una chiave la cancellava) ed e'
      // da lì che nasce R166. Qui non e' una raccomandazione: e' un rifiuto.
      if (TIPI[rec.tipo].forma === 'blind-down' && r !== 'server') {
        rifiutati.push({ chiave: etichetta, perche: 'record del server: il client non lo scrive (BLIND-DOWN)' });
        continue;
      }

      const esito = await applica(rec);
      if (esito.esito === 'ok') { ok.push(etichetta); if (esito.cursore > cursore) cursore = esito.cursore; }
      else if (esito.esito === 'ignorato') ignorati.push({ chiave: etichetta, perche: esito.perche });
      else rifiutati.push({ chiave: etichetta, perche: esito.perche });
    }

    for (const t of tombstones) {
      const data = t && t.data;
      const etichetta = 'tomb:' + (data || '?');
      if (!data || typeof data !== 'string') { rifiutati.push({ chiave: etichetta, perche: 'data mancante' }); continue; }
      if (!Array.isArray(t.chiavi) || !t.chiavi.length) { rifiutati.push({ chiave: etichetta, perche: 'chiavi mancanti' }); continue; }
      const esito = await sopprimi(data, t.chiavi);
      if (esito.esito === 'ok') ok.push(etichetta + ' (' + (esito.potati || 0) + ' potati)');
      else rifiutati.push({ chiave: etichetta, perche: esito.perche });
    }

    // Il bump di `server_updated_at` lo fa SOLO il Mac: e' il marker con cui l'app capisce che
    // c'e' qualcosa di nuovo da scaricare. Se lo scrivesse anche il telefono, tornerebbe il
    // deadlock del 30/08 in cui il marker lo muoveva chi non aveva scritto niente di nuovo.
    // Un contatore per AUTORE: «da quanto non consegna il telefono» non si puo' leggere da
    // `ultimo_delta`, che lo muove anche il Mac ogni notte (e' il tell di R104: il file Drive
    // restava fresco grazie al coach mentre la sorgente taceva da tre giorni).
    const ora = new Date().toISOString();
    const meta_set = [];
    if (ok.length) meta_set.push(r === 'server' ? 'ultimo_delta_server' : 'ultimo_delta_app', ora);
    if (r === 'server' && ok.length) meta_set.push('server_updated_at', ora);
    // Anche il rifiuto si registra: un telefono che consegna ma a cui lo store respinge i record
    // e' il guasto che prima non si vedeva da nessuna parte — di qui lo legge il Vigile.
    if (rifiutati.length) meta_set.push('ultimo_rifiuto', ora, 'ultimo_rifiuto_che',
      JSON.stringify(rifiutati.slice(0, 5)).slice(0, 500));
    if (meta_set.length) await kv(['HSET', META, ...meta_set]);

    const [meta, totale] = await kv(['HGETALL', META], ['ZCARD', IDX]);
    const m = {};
    for (let i = 0; i < (meta || []).length; i += 2) m[meta[i]] = meta[i + 1];

    res.status(200).json({
      ok, ignorati, rifiutati,
      cursore: Number(m.ultimo_cursore || cursore || 0),
      ultimoDelta: m.ultimo_delta || null,
      ultimoDeltaApp: m.ultimo_delta_app || null,
      ultimoDeltaServer: m.ultimo_delta_server || null,
      ultimoRifiuto: m.ultimo_rifiuto || null,
      serverUpdatedAt: m.server_updated_at || null,
      totaleRecord: totale || 0,
      adesso: new Date().toISOString(),
    });
  } catch (e) { errore(res, e); }
}
