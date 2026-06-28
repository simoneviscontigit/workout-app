// ═══════════════════════════════════════════════════════════════
//  WORKOUT PWA — Google Apps Script Backend
//  Incolla questo codice nel tuo AppScript e fai "Deploy > Manage deployments > Update"
// ═══════════════════════════════════════════════════════════════

var FILE_NAME  = 'workout_data.json';
var SHEET_NAME = 'Workout Storia';
// Cartella canonica su Drive: l'app deve usare SEMPRE i file qui dentro,
// non cercarli per nome in tutto il Drive (evita doppioni → dati persi).
var FOLDER_ID  = '1PU5FwW9LXPTAqdfXhsffjBSNQ8oF7qk_';

// ── GET: restituisce il JSON completo di backup ───────────────
function doGet(e) {
  try {
    var file = findFile_(FILE_NAME);
    if (!file) return jsonResp_({ ok: false, error: 'Nessun backup trovato' });
    var data = JSON.parse(file.getBlob().getDataAsString());
    data.ok = true;
    return jsonResp_(data);
  } catch(err) {
    return jsonResp_({ ok: false, error: err.message });
  }
}

// ── POST: salva JSON + aggiorna Sheet ─────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    saveJson_(payload);
    updateSheet_(payload);
    return jsonResp_({ ok: true, savedAt: payload.savedAt });
  } catch(err) {
    return jsonResp_({ ok: false, error: err.message });
  }
}

// ── Salva / sovrascrive il file JSON su Drive ─────────────────
function saveJson_(data) {
  var content = JSON.stringify(data, null, 2);
  var existing = findFile_(FILE_NAME);
  if (existing) {
    existing.setContent(content);
  } else {
    DriveApp.getFolderById(FOLDER_ID).createFile(FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

// ── Aggiorna il Google Sheet ──────────────────────────────────
function updateSheet_(data) {
  var ss = findOrCreateSheet_();
  var aiDB = data.aiDB || {};

  writeSessionsTab_(ss, data.history || [], aiDB.nutritionLog || {});
  writeNutritionTab_(ss, aiDB.nutritionLog || {}, data.history || []);
  var mealLog = aiDB.mealLog || [];
  if (!Array.isArray(mealLog)) mealLog = Object.values(mealLog);
  writeMealLogTab_(ss, mealLog);
  writeProfileTab_(ss, aiDB.profile || {}, aiDB.adaptation || {});
  writeChatTab_(ss, aiDB.chatLog || []);
}

// ─────────────────────────────────────────────────────────────
//  TAB 1 — SESSIONI (dettagliata)
// ─────────────────────────────────────────────────────────────
function writeSessionsTab_(ss, history, nutritionLog) {
  var sheet = getOrCreateTab_(ss, '📋 Sessioni');
  sheet.clearContents();

  var headers = [
    'Data', 'Giorno', 'Split', 'Durata (min)', 'Serie totali',
    // Quiz post-allenamento
    'Energia (1-4)', 'Difficoltà (1-4)', 'Soddisfazione (1-4)',
    'Pump muscolare (1-4)', 'DOMS attesi (1-4)',
    // Pre-check sessione successiva
    'DOMS effettivi (1-4)', 'Recupero pre (1-4)', 'Muscoli doloranti',
    // Nutrizione del giorno
    'Score nutrizione', 'Calorie kcal', 'Proteine g', 'Carbs g', 'Grassi g',
    // Esercizi
    'Esercizi (nome)', 'Esercizi (dettaglio serie×rip)'
  ];

  var rows = [headers];

  history.slice().reverse().forEach(function(s) {
    var d = s.date ? new Date(s.date) : null;
    var dateStr = d ? Utilities.formatDate(d, 'Europe/Rome', 'yyyy-MM-dd') : '';
    var q = s.quiz || {};
    var pre = s.preCheck || {};

    // Muscoli doloranti (array di stringhe)
    var soreMuscles = '';
    if (pre.soreMuscles && pre.soreMuscles.length) {
      soreMuscles = pre.soreMuscles.join(', ');
    }

    // Esercizi: nomi e dettaglio
    var exNames = [];
    var exDetail = [];
    (s.exercises || []).forEach(function(ex) {
      exNames.push(ex.name || ex.id || '');
      // Cerca di costruire un sommario "3×8 @80kg"
      var detail = ex.name || ex.id || '';
      if (ex.sets && ex.reps) {
        detail += ' ' + ex.sets + '×' + ex.reps;
        if (ex.weight) detail += ' @' + ex.weight + 'kg';
      }
      exDetail.push(detail);
    });

    // Nutrizione del giorno dall'nutritionLog
    var nut = nutritionLog[dateStr] || s.nutrition || {};

    rows.push([
      d ? Utilities.formatDate(d, 'Europe/Rome', 'dd/MM/yyyy') : '',
      d ? Utilities.formatDate(d, 'Europe/Rome', 'EEEE') : '',
      s.split ? (s.split.name || s.split.id || '') : '',
      s.duration || '',
      s.sets || '',
      // Quiz
      q.energy        || '',
      q.difficulty    || '',
      q.mood          || '',
      q.muscleWork    || '',
      q.domsExpected  || '',
      // Pre-check
      pre.domsActual    || '',
      pre.recoveryFeel  || '',
      soreMuscles,
      // Nutrizione
      nut.score         || '',
      nut.calories_kcal || '',
      nut.protein_g     || '',
      nut.carbs_g       || '',
      nut.fats_g        || '',
      // Esercizi
      exNames.join(', '),
      exDetail.join(' | ')
    ]);
  });

  sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

  // Formattazione header
  var hdr = sheet.getRange(1, 1, 1, headers.length);
  hdr.setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(1);

  // Larghezze
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(13, 180);  // muscoli doloranti
  sheet.setColumnWidth(19, 220);  // esercizi nomi
  sheet.setColumnWidth(20, 320);  // esercizi dettaglio

  // Colora righe alternate
  for (var i = 2; i <= rows.length; i++) {
    sheet.getRange(i, 1, 1, headers.length)
         .setBackground(i % 2 === 0 ? '#f8f8ff' : '#ffffff');
  }

  // Colore condizionale per valori survey
  colorScale_(sheet, rows.length, 6, 4);   // Energia
  colorScale_(sheet, rows.length, 7, 4);   // Difficoltà (inverso: alto = più duro)
  colorScale_(sheet, rows.length, 8, 4);   // Soddisfazione
  colorScale_(sheet, rows.length, 9, 4);   // Pump
  colorScale_(sheet, rows.length, 10, 4);  // DOMS attesi
  colorScale_(sheet, rows.length, 11, 4);  // DOMS effettivi
  colorScale_(sheet, rows.length, 12, 4);  // Recupero

  // Colore score nutrizione (colonna 14, scala 0-100)
  for (var r = 2; r <= rows.length; r++) {
    var cell = sheet.getRange(r, 14);
    var val = cell.getValue();
    if (!val) continue;
    if (val >= 75) cell.setBackground('#ccffcc');
    else if (val >= 50) cell.setBackground('#ffeecc');
    else cell.setBackground('#ffcccc');
  }
}

// ─────────────────────────────────────────────────────────────
//  TAB 2 — NUTRIZIONE (dettagliata)
// ─────────────────────────────────────────────────────────────
function writeNutritionTab_(ss, nutritionLog, history) {
  var sheet = getOrCreateTab_(ss, '🥗 Nutrizione');
  sheet.clearContents();

  // Costruisci mappa date → split allenamento
  var workoutByDate = {};
  (history || []).forEach(function(s) {
    if (s.date) {
      var d = new Date(s.date);
      var dateStr = Utilities.formatDate(d, 'Europe/Rome', 'yyyy-MM-dd');
      workoutByDate[dateStr] = s.split ? (s.split.name || s.split.id || 'Sì') : 'Sì';
    }
  });

  var headers = [
    'Data', 'Giorno', 'Score',
    // Valori stimati in grammi/kcal/litri/ore
    'Calorie (kcal)', 'Proteine (g)', 'Carbs (g)', 'Grassi (g)',
    'Acqua (L)', 'Sonno (h)',
    // Survey 1-N
    'Proteine survey (1-5)', 'Carbs survey (1-5)', 'Grassi survey (1-5)',
    'Calorie survey (1-4)', 'Acqua survey (1-4)', 'Sonno survey (1-4)',
    'Stress (1-4)',
    // Metadati
    'Da foto', 'Giorno allenamento', 'Note'
  ];

  var rows = [headers];
  var dates = Object.keys(nutritionLog).sort().reverse();

  dates.forEach(function(date) {
    var n = nutritionLog[date];
    if (n.skipped) return;  // salta giorni esplicitamente skippati
    var d = new Date(date + 'T12:00:00');
    var dateFormatted = Utilities.formatDate(d, 'Europe/Rome', 'yyyy-MM-dd');

    rows.push([
      Utilities.formatDate(d, 'Europe/Rome', 'dd/MM/yyyy'),
      Utilities.formatDate(d, 'Europe/Rome', 'EEEE'),
      n.score    || '',
      // Valori stimati
      n.calories_kcal || '',
      n.protein_g     || '',
      n.carbs_g       || '',
      n.fats_g        || '',
      n.water_l       || '',
      n.sleep_h       || '',
      // Survey
      n.protein  || '',
      n.carbs    || '',
      n.fats     || '',
      n.calories || '',
      n.water    || '',
      n.sleep    || '',
      n.stress   || '',
      // Metadati
      n.fromPhotos ? 'Sì' : 'No',
      workoutByDate[dateFormatted] || 'Riposo',
      n.note     || ''
    ]);
  });

  sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

  // Header
  var hdr = sheet.getRange(1, 1, 1, headers.length);
  hdr.setBackground('#0d2b1f').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(1);

  // Larghezze
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(19, 260);  // Note

  // Righe alternate
  for (var i = 2; i <= rows.length; i++) {
    sheet.getRange(i, 1, 1, headers.length)
         .setBackground(i % 2 === 0 ? '#f0fff4' : '#ffffff');
  }

  // Score colorato (colonna 3)
  for (var r = 2; r <= rows.length; r++) {
    var cell = sheet.getRange(r, 3);
    var val = cell.getValue();
    if (!val) continue;
    if (val >= 75) cell.setBackground('#ccffcc');
    else if (val >= 50) cell.setBackground('#ffeecc');
    else cell.setBackground('#ffcccc');
  }

  // Scale colorate per survey
  colorScale_(sheet, rows.length, 10, 5);  // Proteine
  colorScale_(sheet, rows.length, 11, 5);  // Carbs
  colorScale_(sheet, rows.length, 12, 5);  // Grassi
  colorScale_(sheet, rows.length, 13, 4);  // Calorie
  colorScale_(sheet, rows.length, 14, 4);  // Acqua
  colorScale_(sheet, rows.length, 15, 4);  // Sonno
}

// ─────────────────────────────────────────────────────────────
//  TAB 3 — MEAL LOG (log pasti da foto AI)
// ─────────────────────────────────────────────────────────────
function writeMealLogTab_(ss, mealLog) {
  var sheet = getOrCreateTab_(ss, '🍽️ Meal Log');
  sheet.clearContents();

  var headers = [
    'Data', 'Giorno', 'Pasto', 'Calorie stimate (kcal)',
    'Proteine (g)', 'Carbs (g)', 'Grassi (g)', 'Descrizione'
  ];
  var rows = [headers];

  (mealLog || []).slice().reverse().forEach(function(m) {
    var d = m.date ? new Date(m.date) : null;
    var macros = m.macros || {};
    rows.push([
      d ? Utilities.formatDate(d, 'Europe/Rome', 'dd/MM/yyyy') : '',
      d ? Utilities.formatDate(d, 'Europe/Rome', 'EEEE') : '',
      m.meal || m.type || '',
      macros.calories || m.calories || '',
      macros.protein  || m.protein  || '',
      macros.carbs    || m.carbs    || '',
      macros.fats     || m.fats     || '',
      m.description || m.note || ''
    ]);
  });

  if (rows.length === 1) {
    rows.push(['Nessun dato pasto disponibile', '', '', '', '', '', '', '']);
  }

  sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

  var hdr = sheet.getRange(1, 1, 1, headers.length);
  hdr.setBackground('#3b1f00').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(8, 300);
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 100);

  for (var i = 2; i <= rows.length; i++) {
    sheet.getRange(i, 1, 1, headers.length)
         .setBackground(i % 2 === 0 ? '#fff8f0' : '#ffffff');
  }
}

// ─────────────────────────────────────────────────────────────
//  TAB 4 — PROFILO + ADATTAMENTO AI
// ─────────────────────────────────────────────────────────────
function writeProfileTab_(ss, profile, adaptation) {
  var sheet = getOrCreateTab_(ss, '👤 Profilo & AI');
  sheet.clearContents();

  var rows = [
    ['PROFILO', ''],
    ['Peso (kg)', profile.peso || ''],
    ['Altezza (cm)', profile.altezza || ''],
    ['Età', profile.eta || ''],
    ['Obiettivo', profile.obiettivo || ''],
    ['', ''],
    ['ADATTAMENTO AI', ''],
    ['Intensità', adaptation.intensity || ''],
    ['Focus prossimo', adaptation.nextFocus || ''],
    ['Reps multiplier', adaptation.repsMultiplier || 1],
    ['Sets adjustment', adaptation.setsAdjustment || 0],
    ['Recovery flag', adaptation.recoveryFlag ? 'SÌ' : 'No'],
    ['Recovery action', adaptation.recoveryAction || ''],
    ['Ragionamento', adaptation.reasoning || ''],
    ['Raccomandazione breve', adaptation.shortRec || ''],
    ['Esercizi da evitare', (adaptation.avoidExercises || []).join(', ')],
    ['Esercizi suggeriti', (adaptation.suggestExercises || []).join(', ')],
  ];

  sheet.getRange(1, 1, rows.length, 2).setValues(rows);

  // Header sezioni
  sheet.getRange(1, 1, 1, 2).setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange(7, 1, 1, 2).setBackground('#2d1b4e').setFontColor('#ffffff').setFontWeight('bold');

  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 400);
  sheet.getRange(2, 1, rows.length - 1, 1).setFontWeight('bold').setFontColor('#555555');
}

// ─────────────────────────────────────────────────────────────
//  TAB 5 — CHAT LOG
// ─────────────────────────────────────────────────────────────
function writeChatTab_(ss, chatLog) {
  var sheet = getOrCreateTab_(ss, '💬 Chat & Feedback');
  sheet.clearContents();

  var headers = ['Data', 'Contesto', 'Esercizio', 'Messaggio', 'Risposta Coach'];
  var rows = [headers];

  chatLog.slice().reverse().forEach(function(c) {
    var d = c.date ? new Date(c.date) : null;
    rows.push([
      d ? Utilities.formatDate(d, 'Europe/Rome', 'dd/MM/yyyy HH:mm') : '',
      c.contextType || '',
      c.exerciseName || c.exercise || '',
      c.userMsg || '',
      c.reply === '[nota post-allenamento]' ? c.userMsg : (c.reply || '')
    ]);
  });

  sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

  var hdr = sheet.getRange(1, 1, 1, headers.length);
  hdr.setBackground('#1a1a1a').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(4, 2, 350);
  sheet.setColumnWidth(1, 130);
  sheet.setColumnWidth(3, 160);

  for (var i = 2; i <= rows.length; i++) {
    sheet.getRange(i, 1, 1, headers.length)
         .setBackground(i % 2 === 0 ? '#f8f8f8' : '#ffffff');
  }
}

// ─────────────────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────────────────
function findFile_(name) {
  // Cerca SOLO dentro la cartella canonica (deterministico, niente doppioni)
  var files = DriveApp.getFolderById(FOLDER_ID).getFilesByName(name);
  return files.hasNext() ? files.next() : null;
}

function findOrCreateSheet_() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByName(SHEET_NAME);
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }
  var ss = SpreadsheetApp.create(SHEET_NAME);
  try { DriveApp.getFileById(ss.getId()).moveTo(folder); } catch (e) {}
  return ss;
}

function getOrCreateTab_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// Scala di colori verde/giallo/rosso per valori 1-maxVal
function colorScale_(sheet, numRows, col, maxVal) {
  var palettes = {
    4: ['#ffcccc', '#ffeecc', '#d4edda', '#aaffaa'],
    5: ['#ffcccc', '#ffddcc', '#ffeecc', '#d4edda', '#aaffaa']
  };
  var colors = palettes[maxVal] || palettes[4];
  for (var r = 2; r <= numRows; r++) {
    var cell = sheet.getRange(r, col);
    var val = cell.getValue();
    if (!val) continue;
    cell.setBackground(colors[Math.min(val - 1, colors.length - 1)] || '');
  }
}

function jsonResp_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Aggiorna il Sheet dal backup Drive (esegui manualmente dall'editor) ──
function backfillSheetFromDrive() {
  var file = findFile_(FILE_NAME);
  if (!file) { Logger.log('Nessun backup trovato'); return; }
  var data = JSON.parse(file.getBlob().getDataAsString());
  updateSheet_(data);
  Logger.log('Sheet aggiornato con ' + (data.history || []).length + ' sessioni');
}
