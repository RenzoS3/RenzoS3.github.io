// tools/sheets-falso.mjs
// Servidor de prueba para desarrollar Rienda + Sheets sin tocar la Sheet real:
// corre el MISMO apps-script/Code.gs dentro de una imitación mínima de Google
// Apps Script (SpreadsheetApp, Properties, Content...), con los datos en un
// archivo JSON local.
//
//   node tools/sheets-falso.mjs <estado.json> [puerto]
//
// El estado.json tiene { hojas: { Nombre: { valores: [[...]], formatos: [[...]] } } }.
// Se reescribe después de cada pedido, así se puede inspeccionar qué quedó.

import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const archivo = process.argv[2];
const puerto = Number(process.argv[3] ?? 8787);
if (!archivo) { console.error('uso: node tools/sheets-falso.mjs <estado.json> [puerto]'); process.exit(1); }

const TZ_OFFSET_MIN = -180; // America/Argentina/Buenos_Aires
const estado = JSON.parse(fs.readFileSync(archivo, 'utf8'));
estado.props ??= {};

// ---- Imitación de Sheets ----------------------------------------------------
function auto(v, formato) {
	// Como Sheets: si la celda no es texto, "2026-10-05" se vuelve fecha y "12" número.
	if (typeof v !== 'string' || formato === '@') return v;
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { __fecha: v + 'T00:00:00' };
	if (/^\d{4}-\d{2}$/.test(v)) return { __fecha: v + '-01T00:00:00' };
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	return v;
}
const aJS = (v) => (v && typeof v === 'object' && v.__fecha ? new Date(v.__fecha + '-03:00') : v);
const deJS = (v) => (v instanceof Date ? { __fecha: new Date(v.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 19) } : v);

class Hoja {
	constructor(nombre, h) {
		this.nombre = nombre;
		this.h = h;
		h.valores ??= [];
		h.formatos ??= [];
		h.maxRows ??= Math.max(1000, h.valores.length + 50);
		h.maxCols ??= 26;
	}
	getName() { return this.nombre; }
	getMaxRows() { return this.h.maxRows; }
	getLastRow() {
		for (let r = this.h.valores.length - 1; r >= 0; r--) if ((this.h.valores[r] ?? []).some((v) => v !== '' && v != null)) return r + 1;
		return 0;
	}
	getLastColumn() {
		let m = 0;
		for (const f of this.h.valores) for (let c = (f ?? []).length - 1; c >= 0; c--) if (f[c] !== '' && f[c] != null) { m = Math.max(m, c + 1); break; }
		return m;
	}
	getRange(r, c, nr = 1, nc = 1) {
		if (typeof r !== 'number') throw new Error('getRange A1 no soportado en el falso');
		if (r < 1 || c < 1 || r + nr - 1 > this.h.maxRows) throw new Error(`Rango fuera de la hoja (${r},${c},${nr},${nc}) max ${this.h.maxRows}`);
		return new Rango(this, r, c, nr, nc);
	}
	setFrozenRows() { return this; }
	hideSheet() { this.h.oculta = true; return this; }
	deleteRow(r) { this.h.valores.splice(r - 1, 1); this.h.formatos.splice(r - 1, 1); this.h.maxRows--; }
	insertRowsAfter(_after, n) { this.h.maxRows += n; }
	celda(r, c) { return this.h.valores[r - 1]?.[c - 1] ?? ''; }
	set(r, c, v) {
		while (this.h.valores.length < r) this.h.valores.push([]);
		const f = this.h.valores[r - 1];
		while (f.length < c) f.push('');
		f[c - 1] = v;
	}
	fmt(r, c) { return this.h.formatos[r - 1]?.[c - 1] ?? ''; }
	setFmt(r, c, v) {
		while (this.h.formatos.length < r) this.h.formatos.push([]);
		const f = this.h.formatos[r - 1];
		while (f.length < c) f.push('');
		f[c - 1] = v;
	}
}
class Rango {
	constructor(s, r, c, nr, nc) { Object.assign(this, { s, r, c, nr, nc }); }
	getValues() {
		const out = [];
		for (let i = 0; i < this.nr; i++) { const f = []; for (let j = 0; j < this.nc; j++) f.push(aJS(this.s.celda(this.r + i, this.c + j))); out.push(f); }
		return out;
	}
	setValues(v) {
		if (v.length !== this.nr || v.some((f) => f.length !== this.nc)) throw new Error(`setValues: tamaño ${v.length}x${v[0]?.length} no coincide con ${this.nr}x${this.nc}`);
		for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.s.set(this.r + i, this.c + j, deJS(auto(v[i][j], this.s.fmt(this.r + i, this.c + j))));
		return this;
	}
	setValue(x) { return this.setValues([[x]]); }
	setNumberFormat(f) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.s.setFmt(this.r + i, this.c + j, f); return this; }
	setFontWeight() { return this; }
}
const libro = {
	getSheets: () => Object.keys(estado.hojas).map((n) => new Hoja(n, estado.hojas[n])),
	getSheetByName: (n) => (estado.hojas[n] ? new Hoja(n, estado.hojas[n]) : null),
	insertSheet: (n) => { estado.hojas[n] = { valores: [], formatos: [] }; return new Hoja(n, estado.hojas[n]); },
	getName: () => 'Finanzas (prueba)',
	getUrl: () => 'https://docs.google.com/spreadsheets/d/PRUEBA/edit',
	getId: () => 'PRUEBA',
	getSpreadsheetTimeZone: () => 'America/Argentina/Buenos_Aires'
};
function formatDate(d, _tz, fmt) {
	const t = new Date(d.getTime() + TZ_OFFSET_MIN * 60000).toISOString();
	return fmt.replace('yyyy', t.slice(0, 4)).replace('MM', t.slice(5, 7)).replace('dd', t.slice(8, 10)).replace('HH', t.slice(11, 13)).replace('mm', t.slice(14, 16)).replace('ss', t.slice(17, 19));
}
const contexto = {
	SpreadsheetApp: { getActive: () => libro, openById: () => libro, flush: () => {} },
	PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => estado.props[k] ?? null, setProperty: (k, v) => { estado.props[k] = v; } }) },
	LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
	ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
	Utilities: { formatDate, getUuid: () => 'prueba-clave-0000-0000-000000000000' },
	ScriptApp: { getService: () => ({ getUrl: () => `http://localhost:${puerto}/exec` }) },
	Logger: { log: (...a) => console.log('[gas]', ...a) },
	console,
	Date // mismo Date que el resto del falso (instanceof Date entre "realms")
};
vm.createContext(contexto);
vm.runInContext(fs.readFileSync(path.join(dir, '..', 'apps-script', 'Code.gs'), 'utf8'), contexto);

const guardar = () => fs.writeFileSync(archivo, JSON.stringify(estado));
if (!estado.props.RIENDA_CLAVE) { contexto.configurar(); guardar(); }

const LATENCIA = Number(process.env.LATENCIA ?? 0);
http.createServer((req, res) => {
	const u = new URL(req.url, `http://localhost:${puerto}`);
	const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
	if (u.pathname === '/__estado') { res.writeHead(200, cors); res.end(JSON.stringify(estado)); return; }
	if (estado.caido) { res.destroy(); return; } // para probar "sin señal"
	let body = '';
	req.on('data', (d) => (body += d));
	req.on('end', () => {
		setTimeout(() => {
			let out;
			try {
				const e = { parameter: Object.fromEntries(u.searchParams), postData: body ? { contents: body } : undefined };
				out = req.method === 'POST' ? contexto.doPost(e) : contexto.doGet(e);
				guardar();
			} catch (err) {
				out = { s: JSON.stringify({ ok: false, error: 'falso: ' + err.message }) };
			}
			res.writeHead(200, cors);
			res.end(out.s);
		}, LATENCIA);
	});
}).listen(puerto, () => console.log(`Sheets falsa en http://localhost:${puerto}/exec (clave ${estado.props.RIENDA_CLAVE})`));

// Para simular cortes: kill -USR1 <pid> alterna "sin señal".
process.on('SIGUSR1', () => { estado.caido = !estado.caido; console.log('caído:', !!estado.caido); });
