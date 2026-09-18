/* test-storage — il tetto di localStorage e' un modo di perdere dati, quindi ha dei test.
 *
 * Il 18/09/2026 la nutrizione del 15, 16 e 17 e' sparita cosi': `sv()` in QuotaExceededError,
 * dato rimasto in RAM, primo reload e via. Qui si verifica che le tre difese reggano —
 * la potatura dell'annullamento scaduto, il secondo tentativo dopo aver buttato la zavorra,
 * e la sonda che vede il pieno PRIMA che si perda qualcosa.
 *
 * Il codice NON e' copiato: si estrae da index.html, cosi' il test non puo' verificare
 * una versione che non e' quella spedita.  Uso:  node test-storage.js
 */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8');
const a = src.indexOf('var BKP_TTL_MS');
const b = src.indexOf('// RIPRISTINO NON DISTRUTTIVO');
if (a < 0 || b < 0 || b <= a) { console.error('FAIL — blocco storage non trovato in index.html'); process.exit(1); }
const code = src.slice(a, b);

// localStorage finto col tetto contato in UTF-16 (2 byte per char), come Safari.
function mkLS(capBytes) {
  const m = {};
  const used = () => Object.keys(m).reduce((n, k) => n + (k.length + m[k].length) * 2, 0);
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    removeItem: k => { delete m[k]; },
    setItem: (k, v) => {
      v = String(v);
      const prev = Object.prototype.hasOwnProperty.call(m, k) ? (k.length + m[k].length) * 2 : 0;
      if (used() - prev + (k.length + v.length) * 2 > capBytes) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      m[k] = v;
    },
  };
}

let S, alerted, _ioAlerted;
const KB = n => 'x'.repeat(n * 1024);
let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failed++; };

// Il blocco estratto dichiara le sue funzioni; S, alert e _ioAlerted glieli passa il test.
// `_ioAlerted` sta appena sopra il blocco estratto (e' del salvataggio rumoroso del 19/08):
// glielo si ridichiara qui, azzerato a ogni caso, che e' esattamente il suo ciclo di vita reale.
const load = () => new Function('S', 'alert', 'localStorage',
  'var _ioAlerted=false;\n' + code + '\nreturn {sv,freeSpace,pruneRestoreBackup,storageHeadroomProbe};');
const build = cap => {
  S = { ioError: '' }; alerted = []; _ioAlerted = false;
  const ls = mkLS(cap);
  const api = load()(S, x => alerted.push(x), ls);
  return { ls, api };
};

(async () => {
  // 1. l'annullamento scade: dopo 48h e' zavorra, non e' piu' una rete
  let { ls, api } = build(10 * 1024 * 1024);
  ls.setItem('bkp-pre-restore', JSON.stringify({ at: new Date(Date.now() - 72 * 3600e3).toISOString() }));
  api.pruneRestoreBackup();
  ok('bkp di 72h viene buttato', ls.getItem('bkp-pre-restore') === null);
  ls.setItem('bkp-pre-restore', JSON.stringify({ at: new Date().toISOString() }));
  api.pruneRestoreBackup();
  ok('bkp fresco resta', ls.getItem('bkp-pre-restore') !== null);
  ls.setItem('bkp-pre-restore', 'non-json');
  api.pruneRestoreBackup();
  ok('bkp illeggibile viene buttato', ls.getItem('bkp-pre-restore') === null);

  // 2. sotto il tetto: si butta la zavorra, MAI un dato, e il salvataggio riesce
  ({ ls, api } = build(1200 * 1024));
  ls.setItem('wh', KB(200));
  ls.setItem('bkp-pre-restore', KB(200));
  ls.setItem('syncOk', '2026-09-16T04:54:32Z');
  ok('sv riesce dopo aver liberato la zavorra', (await api.sv('ai', KB(250))) === true);
  ok('ioError spento dopo il recupero', S.ioError === '');
  ok('zavorra bkp rimossa', ls.getItem('bkp-pre-restore') === null);
  ok('il dato vero wh non e stato toccato', ls.getItem('wh') !== null);
  ok('ai scritto davvero', ls.getItem('ai') !== null);
  ok('nessun alert quando il recupero riesce', alerted.length === 0);

  // 3. pieno davvero: fallisce, lo dice una volta, e non sacrifica nulla
  ({ ls, api } = build(500 * 1024));
  ls.setItem('wh', KB(200));
  ok('sv fallisce quando non basta nemmeno la pulizia', (await api.sv('ai', KB(200))) === false);
  ok('ioError acceso', /FALLITO/.test(S.ioError));
  ok('alert una volta sola', alerted.length === 1);
  ok('wh intatto anche nel fallimento', ls.getItem('wh') !== null);

  // 4. la sonda: il pieno si vede PRIMA di perdere un dato, e a ogni avvio
  ({ ls, api } = build(500 * 1024));
  ls.setItem('wh', KB(240)); // restano ~20 KB: meno dei 64 che servono
  ok('sonda rossa con meno di 64 KB liberi', api.storageHeadroomProbe() === false);
  ok('sonda lascia detto perche', /Spazio esaurito/.test(S.ioError));
  ok('sonda senza residui', ls.getItem('__probe') === null);
  ({ ls, api } = build(10 * 1024 * 1024));
  ok('sonda verde con spazio', api.storageHeadroomProbe() === true && S.ioError === '');
  ok('sonda senza residui anche da verde', ls.getItem('__probe') === null);

  // 5. se a togliere il respiro e' la zavorra, la sonda la butta e torna verde
  ({ ls, api } = build(700 * 1024));
  ls.setItem('wh', KB(200));
  ls.setItem('bkp-pre-restore', KB(140));
  ok('sonda verde dopo aver buttato la zavorra', api.storageHeadroomProbe() === true);
  ok('zavorra buttata dalla sonda', ls.getItem('bkp-pre-restore') === null);

  console.log(failed ? '\n' + failed + ' test rossi' : '\ntutti verdi');
  process.exit(failed ? 1 : 0);
})();
