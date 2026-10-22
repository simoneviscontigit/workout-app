// GET /api/state[?since=<cursore|ISO>] — lo stato, o solo cio' che e' cambiato dopo il marker.
//
// `since` accetta due forme:
//   - un CURSORE (intero): il valore `cursore` restituito dalla chiamata precedente. E' la via
//     buona — il cursore e' una sequenza del server, quindi non dipende dall'orologio di
//     nessuno e non puo' perdere due scritture dello stesso millisecondo.
//   - un ISO: comodo a mano, ma si paga con una lettura di tutto l'indice e un filtro sul
//     `timbro` dei record. A ~330 record e' una pipeline sola, quindi passa; non e' il modo
//     con cui si costruisce un consumatore.
//
// Risposta: { adesso, cursore, serverUpdatedAt, ultimoDelta, totaleRecord, records: [ {tipo,
// chiave, timbro, dati, cursore} ] }. Le lapidi escono come record `tipo:'tomb'` come tutto il
// resto: una rimozione e' un record presente, non un'assenza.
import { kv, ts, ruolo, cors, errore, Rifiuto, IDX, META } from './_store.js';

const LOTTO = 100;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    if (req.method !== 'GET') throw new Rifiuto(405, 'serve GET');
    if (!ruolo(req)) throw new Rifiuto(401, 'token assente o non valido');

    const q = (req.query && req.query.since) || '';
    const since = Array.isArray(q) ? q[0] : q;
    const perCursore = since !== '' && /^\d+$/.test(String(since).trim());

    const [chiavi, meta, totale] = await kv(
      perCursore
        ? ['ZRANGEBYSCORE', IDX, '(' + String(since).trim(), '+inf', 'WITHSCORES']
        : ['ZRANGE', IDX, 0, -1, 'WITHSCORES'],
      ['HGETALL', META],
      ['ZCARD', IDX],
    );

    const m = {};
    for (let i = 0; i < (meta || []).length; i += 2) m[meta[i]] = meta[i + 1];

    const coppie = [];
    for (let i = 0; i < (chiavi || []).length; i += 2) coppie.push([chiavi[i], Number(chiavi[i + 1])]);

    const records = [];
    let cursore = Number(m.ultimo_cursore || 0);
    for (let i = 0; i < coppie.length; i += LOTTO) {
      const lotto = coppie.slice(i, i + LOTTO);
      const valori = await kv(...lotto.map(([k]) => ['GET', k]));
      valori.forEach((v, j) => {
        if (!v) return;                                  // chiave svanita fra ZRANGE e GET
        let rec;
        try { rec = JSON.parse(v); } catch { return; }
        rec.cursore = lotto[j][1];
        records.push(rec);
      });
    }

    // Filtro per istante solo nella forma ISO. `Date.parse`, mai il confronto lessicografico.
    let fuori = 0;
    let usciti = records;
    if (since !== '' && !perCursore) {
      const soglia = ts(String(since));
      if (soglia === -Infinity) throw new Rifiuto(400, 'since non e\' ne\' un cursore ne\' una data ISO');
      usciti = records.filter((r) => ts(r.timbro) > soglia);
      fuori = records.length - usciti.length;
    }

    res.status(200).json({
      adesso: new Date().toISOString(),
      cursore,
      serverUpdatedAt: m.server_updated_at || null,
      ultimoDelta: m.ultimo_delta || null,
      // Separati per autore: il Vigile ne ha bisogno per distinguere «il telefono non consegna»
      // da «il Mac non scrive» — con un solo contatore il coach notturno maschera il telefono.
      ultimoDeltaApp: m.ultimo_delta_app || null,
      ultimoDeltaServer: m.ultimo_delta_server || null,
      ultimoRifiuto: m.ultimo_rifiuto || null,
      ultimoRifiutoChe: m.ultimo_rifiuto_che || null,
      totaleRecord: totale || 0,
      records: usciti,
      ...(fuori ? { fuoriFinestra: fuori } : {}),
    });
  } catch (e) { errore(res, e); }
}
