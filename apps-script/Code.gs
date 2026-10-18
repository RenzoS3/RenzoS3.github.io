/**
 * Rienda + Sheets — puente entre la app Rienda y esta Google Sheet.
 *
 * Se pega UNA vez en la Sheet "Finanzas" (Extensiones → Apps Script) y se
 * implementa como App web. La app lo llama para:
 *   - ping:  verificar el enlace.
 *   - load:  bajar todas las pestañas (y ponerle id a las filas que no tengan).
 *   - push:  subir cambios fila por fila (por id): altas, ediciones y bajas.
 *
 * No toca nada fuera de esta Sheet y no manda datos a ningún otro lado.
 * Pasos de instalación: ver apps-script/LEEME.md en el repo.
 */

// ---- Ajustes ----------------------------------------------------------------
// Pegá entre las comillas la "URL de la aplicación web" que te da Implementar
// (termina en /exec). Hace falta para que configurar() arme el link del iPhone.
const URL_WEBAPP = '';
const APP_URL = 'https://renzos3.github.io/'; // URL de la app (GitHub Pages)
const MAX_BORRADOS = 30;       // borrados por pestaña en un solo envío: más que esto se frena
const COLS_TEXTO = { Gastos: ['fecha', 'mes_inicio_pago'], Ingresos: ['fecha', 'periodo'] };
const COLS_MES = ['mes_inicio_pago', 'periodo'];

// ---- Entrada web --------------------------------------------------------------
function doGet(e) {
  return responder_(function () { return manejar_((e && e.parameter) || {}, null); });
}

function doPost(e) {
  return responder_(function () {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return manejar_(body, body);
  });
}

function responder_(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function manejar_(p, body) {
  const props = PropertiesService.getScriptProperties();
  const clave = props.getProperty('RIENDA_CLAVE');
  if (!clave) throw new Error('Falta correr configurar() en el editor de Apps Script.');
  if (String(p.k || '') !== clave) throw new Error('Clave incorrecta: revisá el enlace de conexión.');
  const ss = libro_();
  if (p.op === 'ping') return { ok: true, hoja: ss.getName() };
  if (p.op === 'load') return cargar_(ss, String(p.ids || '').split(',').filter(String));
  if (p.op === 'push') return subir_(ss, (body && body.cambios) || [], !!(body && body.forzar));
  throw new Error('Operación desconocida: ' + p.op);
}

function libro_() {
  const id = PropertiesService.getScriptProperties().getProperty('RIENDA_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function conLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---- Bajar ---------------------------------------------------------------------
function cargar_(ss, conId) {
  return conLock_(function () {
    const tz = ss.getSpreadsheetTimeZone();
    const hojas = {};
    ss.getSheets().forEach(function (sh) {
      const nombre = sh.getName();
      const lastRow = sh.getLastRow();
      const lastCol = sh.getLastColumn();
      if (lastRow < 1 || lastCol < 1) {
        hojas[nombre] = { header: [], filas: [] };
        return;
      }
      const vals = sh.getRange(1, 1, lastRow, lastCol).getValues();
      const header = vals[0].map(function (h) { return String(h).trim(); });
      let ci = header.indexOf('id');
      if (ci < 0 && conId.indexOf(nombre) >= 0 && header.some(String)) {
        ci = header.length;
        sh.getRange(1, ci + 1).setValue('id').setFontWeight('bold');
        header.push('id');
        vals.forEach(function (r, i) { r.push(i === 0 ? 'id' : ''); });
      }
      if (ci >= 0) asignarIds_(sh, vals, ci);
      const filas = vals.slice(1).map(function (r) {
        return r.map(function (v, j) { return celda_(v, header[j], tz); });
      });
      hojas[nombre] = { header: header, filas: filas };
    });
    return { ok: true, ts: new Date().toISOString(), hoja: { nombre: ss.getName(), url: ss.getUrl() }, hojas: hojas };
  });
}

// Pone id a las filas que no tienen (o lo tienen repetido): siempre más grande
// que todos los existentes, así nunca choca con uno que ya use la app.
function asignarIds_(sh, vals, ci) {
  let max = 0;
  for (let i = 1; i < vals.length; i++) {
    const n = Number(vals[i][ci]);
    if (n > max) max = n;
  }
  const vistos = {};
  let cambio = false;
  for (let i = 1; i < vals.length; i++) {
    const fila = vals[i];
    const vacia = fila.every(function (v, j) { return j === ci || v === '' || v === null; });
    if (vacia) continue;
    let n = Number(fila[ci]);
    if (!(n > 0) || vistos[n]) {
      n = ++max;
      fila[ci] = n;
      cambio = true;
    }
    vistos[n] = true;
  }
  if (cambio) sh.getRange(2, ci + 1, vals.length - 1, 1).setValues(vals.slice(1).map(function (r) { return [r[ci]]; }));
}

function celda_(v, col, tz) {
  if (v instanceof Date) {
    if (COLS_MES.indexOf(col) >= 0) return Utilities.formatDate(v, tz, 'yyyy-MM');
    const conHora = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, tz, conHora ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  return v;
}

// ---- Subir ---------------------------------------------------------------------
function subir_(ss, cambios, forzar) {
  return conLock_(function () {
    cambios.forEach(function (ch) {
      if (!forzar && (ch.deletes || []).length > MAX_BORRADOS)
        throw new Error('Se frenó: ' + ch.deletes.length + ' borrados en "' + ch.hoja + '" de una sola vez.');
    });
    const remap = {};
    cambios.forEach(function (ch) {
      const r = subirHoja_(ss, ch);
      if (Object.keys(r).length) remap[ch.hoja] = r;
    });
    SpreadsheetApp.flush();
    return { ok: true, remap: remap, ts: new Date().toISOString() };
  });
}

function subirHoja_(ss, ch) {
  let sh = ss.getSheetByName(ch.hoja);
  if (!sh) {
    sh = ss.insertSheet(ch.hoja);
    sh.getRange(1, 1, 1, ch.header.length).setValues([ch.header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    aplicarFormatos_(sh, ch, 2, sh.getMaxRows() - 1);
    if (ch.hoja.charAt(0) === '_') sh.hideSheet();
  }
  // Encabezado: se agregan al final las columnas que falten (no se reordena nada).
  const lastCol = Math.max(sh.getLastColumn(), 1);
  let header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (header.every(function (h) { return h === ''; })) header = [];
  ch.header.forEach(function (h) {
    if (header.indexOf(h) < 0) {
      header.push(h);
      sh.getRange(1, header.length).setValue(h).setFontWeight('bold');
    }
  });
  const ancho = header.length;
  const col = {};
  header.forEach(function (h, i) { col[h] = i; });
  const ck = col[ch.clave];

  const lastRow = sh.getLastRow();
  const vals = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, ancho).getValues() : [];
  const filaDe = {};
  let max = 0;
  vals.forEach(function (r, i) {
    const k = String(r[ck]);
    if (k !== '') {
      filaDe[k] = i;
      if (Number(k) > max) max = Number(k);
    }
  });
  (ch.upserts || []).forEach(function (u) { if (Number(u.clave) > max) max = Number(u.clave); });

  function armar(previa, u, clave) {
    const r = previa ? previa.slice() : [];
    while (r.length < ancho) r.push('');
    ch.header.forEach(function (h, j) { r[col[h]] = u.fila[j] === null ? '' : u.fila[j]; });
    r[ck] = ch.clave === 'id' ? Number(clave) : clave;
    return r;
  }

  const remap = {};
  const modificadas = [];
  const nuevas = [];
  (ch.upserts || []).forEach(function (u) {
    let clave = String(u.clave);
    const i = filaDe[clave];
    if (i != null && u.nuevo && ch.clave === 'id') {
      // Otro dispositivo ya usó ese id: va con uno nuevo y se le avisa a la app.
      const otro = String(++max);
      remap[clave] = otro;
      nuevas.push(armar(null, u, otro));
      return;
    }
    if (i != null) {
      vals[i] = armar(vals[i], u, clave);
      modificadas.push(i);
    } else {
      nuevas.push(armar(null, u, clave));
    }
  });

  if (modificadas.length > 25) {
    sh.getRange(2, 1, vals.length, ancho).setValues(vals);
  } else {
    modificadas.forEach(function (i) { sh.getRange(i + 2, 1, 1, ancho).setValues([vals[i]]); });
  }
  if (nuevas.length) {
    const desde = sh.getLastRow() + 1;
    const faltan = desde + nuevas.length - 1 - sh.getMaxRows();
    if (faltan > 0) sh.insertRowsAfter(sh.getMaxRows(), faltan);
    aplicarFormatos_(sh, ch, desde, nuevas.length, col);
    sh.getRange(desde, 1, nuevas.length, ancho).setValues(nuevas);
  }
  // Bajas: de abajo hacia arriba para que no se corran los índices.
  (ch.deletes || [])
    .map(function (k) { return filaDe[String(k)]; })
    .filter(function (i) { return i != null; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (i) { sh.deleteRow(i + 2); });
  return remap;
}

function aplicarFormatos_(sh, ch, desde, n, col) {
  if (n < 1) return;
  const f = ch.formatos || {};
  Object.keys(f).forEach(function (h) {
    const c = col ? col[h] : ch.header.indexOf(h);
    if (c != null && c >= 0) sh.getRange(desde, c + 1, n, 1).setNumberFormat(f[h]);
  });
}

// ---- Instalación (se corre a mano desde el editor) ------------------------------
function configurar() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('RIENDA_SHEET_ID', ss.getId());
  let clave = props.getProperty('RIENDA_CLAVE');
  if (!clave) {
    clave = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('RIENDA_CLAVE', clave);
  }
  // Fechas y meses como texto (si no, Sheets los convierte solo en fechas).
  Object.keys(COLS_TEXTO).forEach(function (nombre) { prepararTexto_(ss, nombre, COLS_TEXTO[nombre]); });
  // El nombre y el tipo de período los pregunta la app la primera vez que se abre.
  // La URL buena es la de la implementación (/exec). Desde el editor Google a veces
  // devuelve la de prueba (/dev), que no sirve para el teléfono.
  const url = String(URL_WEBAPP || ScriptApp.getService().getUrl() || '').trim();
  if (!/\/exec$/.test(url)) {
    Logger.log('Falta un paso: copiá la "URL de la aplicación web" (Implementar → Gestionar implementaciones; termina en /exec), ' +
      'pegala arriba de todo entre las comillas de URL_WEBAPP, guardá y volvé a ejecutar configurar.');
    return;
  }
  const enlace = url + '?k=' + clave;
  Logger.log('LISTO. Abrí este link en el iPhone (no lo compartas con nadie):\n' + APP_URL + '#conectar=' + encodeURIComponent(enlace));
  Logger.log('Si la app instalada te pide el enlace de conexión, pegá este:\n' + enlace);
}

function prepararTexto_(ss, nombre, cols) {
  const sh = ss.getSheetByName(nombre);
  if (!sh || sh.getLastRow() < 1) return;
  const tz = ss.getSpreadsheetTimeZone();
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  cols.forEach(function (c) {
    const i = header.indexOf(c);
    if (i < 0) return;
    const filas = Math.max(sh.getLastRow() - 1, 0);
    if (filas) {
      const r = sh.getRange(2, i + 1, filas, 1);
      const v = r.getValues().map(function (x) { return [celda_(x[0], c, tz)]; });
      sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
      r.setValues(v);
    } else {
      sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    }
  });
}
