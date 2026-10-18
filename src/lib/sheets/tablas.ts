// src/lib/sheets/tablas.ts
// Rienda + Sheets: cómo se guarda cada tabla de Rienda en una pestaña de la
// Google Sheet, y cómo se pasa de una a otra.
//
//  - "Gastos" e "Ingresos" son las pestañas de siempre (formato RIENDA), con
//    nombres en vez de ids (categoría, subcategoría, tarjeta) + una columna id.
//  - Lo que Rienda guarda aparte (categorías, diccionario, recurrentes,
//    presupuestos, etc.) va en pestañas ocultas que empiezan con "_".
//
// Todo lo de acá es puro (no habla con la red): render() lee la base y arma las
// filas tal como van en la Sheet; cargar() hace lo inverso.

import { query, queryBatch } from '../db/client';

export type Valor = string | number | null;
type Ref = 'categoria' | 'subcategoria' | 'tarjeta';
type Tipo = 'texto' | 'num' | 'int';

type Col = {
	hoja: string; // nombre de la columna en la Sheet
	sql?: string; // columna en la base (default = hoja)
	tipo: Tipo;
	ref?: Ref; // en la Sheet va el NOMBRE; en la base, el id
	formato?: string; // formato de celda en la Sheet ('@' = texto)
};

export type Tabla = {
	tabla: string; // tabla SQLite
	hoja: string; // pestaña de la Sheet
	clave: 'id' | 'clave';
	cols: Col[];
	perfil: boolean; // la tabla tiene perfil_id
};

const T = (hoja: string, f?: string): Col => ({ hoja, tipo: 'texto', formato: f });
const N = (hoja: string, f?: string): Col => ({ hoja, tipo: 'num', formato: f });
const I = (hoja: string): Col => ({ hoja, tipo: 'int' });
const R = (hoja: string, sql: string, ref: Ref): Col => ({ hoja, sql, tipo: 'texto', ref });
const ID = I('id');
const MONTO = N('monto', '#,##0.00');

// Orden = orden de carga (padres antes que hijas, por las foreign keys).
export const TABLAS: Tabla[] = [
	{ tabla: 'perfil', hoja: '_perfil', clave: 'id', perfil: false, cols: [ID, T('nombre'), T('modo_periodo'), T('creado_en', '@')] },
	{ tabla: 'categoria', hoja: '_categorias', clave: 'id', perfil: true, cols: [ID, T('nombre'), I('activa'), I('es_ahorro')] },
	{ tabla: 'subcategoria', hoja: '_subcategorias', clave: 'id', perfil: true, cols: [ID, T('nombre'), I('activa'), I('es_meta_ahorro')] },
	{ tabla: 'tarjeta', hoja: '_tarjetas', clave: 'id', perfil: true, cols: [ID, T('nombre'), T('proveedor'), T('tipo'), I('activa')] },
	{ tabla: 'mapeo_detalle', hoja: '_diccionario', clave: 'id', perfil: true, cols: [ID, T('detalle'), R('subcategoria', 'subcategoria_id', 'subcategoria')] },
	{
		tabla: 'gasto', hoja: 'Gastos', clave: 'id', perfil: true,
		cols: [
			T('fecha', '@'), MONTO, T('moneda'), R('categoria', 'categoria_id', 'categoria'),
			R('subcategoria', 'subcategoria_id', 'subcategoria'), T('detalle'), T('medio'),
			R('tarjeta', 'tarjeta_id', 'tarjeta'), I('cuotas'), T('mes_inicio_pago', '@'), ID
		]
	},
	{
		tabla: 'ingreso', hoja: 'Ingresos', clave: 'id', perfil: true,
		cols: [T('fecha', '@'), MONTO, T('moneda'), T('categoria'), T('tipo'), T('detalle'), T('periodo', '@'), ID]
	},
	{
		tabla: 'suscripcion', hoja: '_recurrentes', clave: 'id', perfil: true,
		cols: [ID, T('nombre'), T('detalle'), MONTO, T('moneda'), R('categoria', 'categoria_id', 'categoria'), R('tarjeta', 'tarjeta_id', 'tarjeta'), I('activa'), I('dia_esperado')]
	},
	{
		tabla: 'ingreso_fijo', hoja: '_ingresos_fijos', clave: 'id', perfil: true,
		cols: [ID, T('nombre'), T('detalle'), MONTO, T('moneda'), T('categoria'), T('tipo'), I('activa'), I('dia_esperado')]
	},
	{ tabla: 'suscripcion_registro', hoja: '_recurrentes_reg', clave: 'id', perfil: false, cols: [ID, I('suscripcion_id'), I('gasto_id'), T('periodo', '@')] },
	{ tabla: 'ingreso_fijo_registro', hoja: '_ingresos_fijos_reg', clave: 'id', perfil: false, cols: [ID, I('ingreso_fijo_id'), I('ingreso_id'), T('periodo', '@')] },
	{ tabla: 'presupuesto', hoja: '_presupuestos', clave: 'id', perfil: true, cols: [ID, R('subcategoria', 'subcategoria_id', 'subcategoria'), T('periodo', '@'), MONTO, I('auto')] },
	{ tabla: 'reserva_credito', hoja: '_reserva_credito', clave: 'id', perfil: true, cols: [ID, T('periodo', '@'), MONTO] },
	{ tabla: 'meta', hoja: '_ajustes', clave: 'clave', perfil: false, cols: [T('clave', '@'), T('valor', '@')] },
	{ tabla: 'notif_visto', hoja: '_notif_visto', clave: 'id', perfil: true, cols: [ID, T('tipo'), I('ref_id'), T('periodo', '@')] }
];

export const HOJAS_CON_ID = TABLAS.filter((t) => t.clave === 'id').map((t) => t.hoja);
export const sqlDe = (c: Col) => c.sql ?? c.hoja;

// Claves de meta que son estado técnico de ESTE dispositivo (timestamps de
// refresco, marcas de migración, copias): no viajan a la Sheet.
const META_LOCAL = /^(ultima_|autobackup_|cotizaciones_|dolar_actualizado|precios_actualizados|reset_|liquidez_migrada|fotos_|fecha_corte_)/;
export const metaSincroniza = (clave: string) => !META_LOCAL.test(clave);

// ---------------------------------------------------------------------------
// Normalización de valores leídos de la Sheet
// ---------------------------------------------------------------------------
function vacio(v: unknown): boolean {
	return v == null || (typeof v === 'string' && v.trim() === '');
}

// Monto: la Sheet devuelve número; si alguien escribió texto, se acepta
// formato argentino ("1.234,56") y también "1234.56".
export function aNumero(v: unknown): number | null {
	if (vacio(v)) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'boolean') return v ? 1 : 0;
	let s = String(v).trim().replace(/^\$\s*/, '').replace(/^U\$S\s*/i, '');
	if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
	else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

function aTexto(v: unknown): string | null {
	if (vacio(v)) return null;
	return String(v).trim();
}

function normalizar(c: Col, v: unknown): Valor {
	if (c.tipo === 'num') return aNumero(v);
	if (c.tipo === 'int') {
		if (v === true || v === 'TRUE' || v === 'true') return 1;
		if (v === false || v === 'FALSE' || v === 'false') return 0;
		const n = aNumero(v);
		return n == null ? null : Math.round(n);
	}
	return aTexto(v);
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------------------------------------------------------------------------
// Render: base -> filas de la Sheet
// ---------------------------------------------------------------------------
export type Fila = Valor[];
export type Render = Record<string, Map<string, Fila>>; // hoja -> clave -> fila

export function encabezado(t: Tabla): string[] {
	return t.cols.map((c) => c.hoja);
}
export function formatos(t: Tabla): Record<string, string> {
	const f: Record<string, string> = {};
	for (const c of t.cols) if (c.formato) f[c.hoja] = c.formato;
	return f;
}
const idxClave = (t: Tabla) => t.cols.findIndex((c) => c.hoja === t.clave);

async function nombres(tabla: string): Promise<Map<number, string>> {
	const r = (await query(`SELECT id, nombre FROM ${tabla}`)) as any[];
	return new Map(r.map((x) => [x.id, x.nombre]));
}

export async function render(): Promise<Render> {
	const refs: Record<Ref, Map<number, string>> = {
		categoria: await nombres('categoria'),
		subcategoria: await nombres('subcategoria'),
		tarjeta: await nombres('tarjeta')
	};
	// Subcategoría efectiva de un gasto (igual que Rienda): la propia o, si no
	// tiene, la del diccionario por detalle.
	const dicc = (await query('SELECT detalle, subcategoria_id FROM mapeo_detalle')) as any[];
	const porDetalle = new Map<string, number>(dicc.map((d) => [d.detalle, d.subcategoria_id]));

	const out: Render = {};
	for (const t of TABLAS) {
		const sqlCols = t.cols.map(sqlDe);
		const extra = t.tabla === 'gasto' ? ', detalle AS _det' : '';
		const rows = (await query(`SELECT ${sqlCols.join(', ')}${extra} FROM ${t.tabla}`)) as any[];
		const m = new Map<string, Fila>();
		const ik = idxClave(t);
		for (const r of rows) {
			if (t.tabla === 'meta' && !metaSincroniza(r.clave)) continue;
			const fila: Fila = t.cols.map((c) => {
				let v = r[sqlDe(c)];
				if (t.tabla === 'gasto' && c.hoja === 'subcategoria' && v == null) v = porDetalle.get(r._det) ?? null;
				if (c.ref) return v == null ? '' : (refs[c.ref].get(v) ?? '');
				if (t.tabla === 'gasto' && c.hoja === 'mes_inicio_pago') return v ? String(v).slice(0, 7) : '';
				if ((t.tabla === 'ingreso' || t.tabla === 'ingreso_fijo') && c.hoja === 'tipo')
					return v === 'Sueldo' ? 'Regular' : v === 'Aciclico' ? 'Extraordinario' : '';
				if (v == null) return '';
				if (c.tipo === 'num' || c.tipo === 'int') return Number(v);
				return String(v);
			});
			m.set(String(fila[ik]), fila);
		}
		out[t.hoja] = m;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Carga: filas de la Sheet -> base
// ---------------------------------------------------------------------------
export type HojaCruda = { header: string[]; filas: unknown[][] };
export type Payload = { hojas: Record<string, HojaCruda> };
export type ResultadoCarga = {
	avisos: string[]; // filas que no se pudieron leer
	creadas: Record<string, string[]>; // hoja -> claves creadas por la app al cargar (hay que subirlas)
	hojasPresentes: Set<string>;
};

type Obj = Record<string, Valor>;

// Pasa una pestaña cruda a objetos por nombre de columna de la Sheet.
function objetos(h: HojaCruda | undefined): { obj: Obj; fila: number }[] {
	if (!h) return [];
	const header = h.header.map((x) => String(x ?? '').trim());
	const out: { obj: Obj; fila: number }[] = [];
	h.filas.forEach((f, i) => {
		if (!f.some((v) => !vacio(v))) return;
		const o: Obj = {};
		header.forEach((name, j) => { if (name) o[name] = (f[j] ?? null) as Valor; });
		out.push({ obj: o, fila: i + 2 });
	});
	return out;
}

const INGRESO_CATS = new Set(['Ingreso Principal', 'Ingresos Secundarios', 'Otros', 'Desahorro']);

function tipoIngreso(v: Valor): 'Sueldo' | 'Aciclico' | null | undefined {
	if (v == null) return null;
	const s = sinTildes(String(v));
	if (s === 'regular' || s === 'sueldo') return 'Sueldo';
	if (s === 'extraordinario' || s === 'aciclico') return 'Aciclico';
	return undefined; // inválido
}

export async function cargar(p: Payload): Promise<ResultadoCarga> {
	const avisos: string[] = [];
	const creadas: Record<string, string[]> = {};
	const hojasPresentes = new Set(Object.keys(p.hojas));
	const marcarCreada = (hoja: string, clave: number | string) => { (creadas[hoja] ??= []).push(String(clave)); };

	// Filas normalizadas por tabla (objetos con columnas SQL).
	const datos: Record<string, Obj[]> = {};
	for (const t of TABLAS) {
		const filas: Obj[] = [];
		for (const { obj, fila } of objetos(p.hojas[t.hoja])) {
			const o: Obj = { _fila: fila };
			for (const c of t.cols) o[c.hoja] = normalizar(c, obj[c.hoja]);
			filas.push(o);
		}
		datos[t.tabla] = filas;
	}

	// ----- Referencias por nombre (categoría / subcategoría / tarjeta) -----
	const ids: Record<Ref, Map<string, number>> = { categoria: new Map(), subcategoria: new Map(), tarjeta: new Map() };
	const filasRef: Record<Ref, Obj[]> = { categoria: datos.categoria, subcategoria: datos.subcategoria, tarjeta: datos.tarjeta };
	const hojaRef: Record<Ref, string> = { categoria: '_categorias', subcategoria: '_subcategorias', tarjeta: '_tarjetas' };
	for (const r of ['categoria', 'subcategoria', 'tarjeta'] as Ref[]) {
		const vistos = new Set<number>();
		filasRef[r] = filasRef[r].filter((o) => {
			if (o.id == null || o.nombre == null || vistos.has(o.id as number) || ids[r].has(o.nombre as string)) {
				avisos.push(`${hojaRef[r]} fila ${o._fila}: id o nombre vacío o repetido`);
				return false;
			}
			vistos.add(o.id as number);
			ids[r].set(o.nombre as string, o.id as number);
			if (r === 'tarjeta' && o.tipo == null) o.tipo = 'credito';
			return true;
		});
	}
	const maxId = (r: Ref) => Math.max(0, ...filasRef[r].map((o) => o.id as number));
	// Devuelve el id de un nombre; si no existe lo crea (y queda para subir).
	function idDe(r: Ref, nombre: Valor, extra: Obj = {}): number | null {
		if (nombre == null) return null;
		const n = String(nombre);
		const ya = ids[r].get(n);
		if (ya != null) return ya;
		const id = maxId(r) + 1;
		const fila: Obj = { id, nombre: n, activa: 1, ...extra };
		if (r === 'categoria') fila.es_ahorro = fila.es_ahorro ?? 0;
		if (r === 'subcategoria') fila.es_meta_ahorro = fila.es_meta_ahorro ?? 0;
		if (r === 'tarjeta') fila.tipo = fila.tipo ?? 'credito';
		filasRef[r].push(fila);
		ids[r].set(n, id);
		marcarCreada(hojaRef[r], id);
		return id;
	}

	// ----- Perfil -----
	// El nombre puede estar vacío (perfil creado por la app sin nombre): en la
	// Sheet queda '' y se lee como null, pero la base exige texto.
	let perfiles = datos.perfil.filter((o) => o.id === 1).map((o) => ({ ...o, nombre: o.nombre ?? '' }));
	const hayDatos = datos.gasto.length + datos.ingreso.length > 0;
	if (!perfiles.length && hayDatos) {
		perfiles = [{ id: 1, nombre: '', modo_periodo: 'sueldo', creado_en: null }];
		marcarCreada('_perfil', 1);
	}

	// ----- Gastos -----
	const gastos: Obj[] = [];
	const idsGasto = new Set<number>();
	for (const o of datos.gasto) {
		const err = (m: string) => avisos.push(`Gastos fila ${o._fila}: ${m}`);
		const id = o.id as number | null;
		if (id == null || idsGasto.has(id)) { err('id vacío o repetido'); continue; }
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.fecha ?? ''))) { err('fecha inválida'); continue; }
		const monto = o.monto as number | null;
		if (monto == null || !(monto > 0)) { err('monto vacío o no positivo'); continue; }
		const moneda = String(o.moneda ?? '').toUpperCase();
		if (moneda !== 'ARS' && moneda !== 'USD') { err('moneda inválida'); continue; }
		if (o.categoria == null) { err('sin categoría'); continue; }
		if (o.detalle == null) { err('sin detalle'); continue; }
		const medio = sinTildes(String(o.medio ?? ''));
		if (medio !== 'debito' && medio !== 'credito') { err('medio inválido'); continue; }
		const g: Obj = {
			id, fecha: o.fecha, monto, moneda, detalle: o.detalle, medio,
			categoria_id: idDe('categoria', o.categoria),
			subcategoria_id: idDe('subcategoria', o.subcategoria),
			tarjeta_id: null, cuotas: 1, mes_inicio_pago: null
		};
		if (medio === 'credito') {
			if (o.tarjeta == null) { err('crédito sin tarjeta'); continue; }
			const mes = String(o.mes_inicio_pago ?? '').slice(0, 7);
			if (!/^\d{4}-\d{2}$/.test(mes)) { err('crédito sin mes_inicio_pago'); continue; }
			const cuotas = (o.cuotas as number | null) ?? 1;
			if (!(cuotas >= 1)) { err('cuotas inválidas'); continue; }
			g.tarjeta_id = idDe('tarjeta', o.tarjeta, { tipo: 'credito' });
			g.cuotas = cuotas;
			g.mes_inicio_pago = mes + '-01';
		}
		idsGasto.add(id);
		gastos.push(g);
	}

	// ----- Ingresos -----
	const ingresos: Obj[] = [];
	const idsIngreso = new Set<number>();
	for (const o of datos.ingreso) {
		const err = (m: string) => avisos.push(`Ingresos fila ${o._fila}: ${m}`);
		const id = o.id as number | null;
		if (id == null || idsIngreso.has(id)) { err('id vacío o repetido'); continue; }
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.fecha ?? ''))) { err('fecha inválida'); continue; }
		const monto = o.monto as number | null;
		if (monto == null || !(monto > 0)) { err('monto vacío o no positivo'); continue; }
		const moneda = String(o.moneda ?? '').toUpperCase();
		if (moneda !== 'ARS' && moneda !== 'USD') { err('moneda inválida'); continue; }
		let cat = String(o.categoria ?? '');
		if (cat === 'Ingreso Secundario') cat = 'Ingresos Secundarios';
		if (!INGRESO_CATS.has(cat)) { err(`categoría "${cat}" inválida`); continue; }
		const tipo = tipoIngreso(o.tipo);
		if (tipo === undefined) { err(`tipo "${o.tipo}" inválido`); continue; }
		const periodo = o.periodo ? String(o.periodo).slice(0, 7) : null;
		idsIngreso.add(id);
		ingresos.push({ id, fecha: o.fecha, monto, moneda, categoria: cat, tipo, detalle: o.detalle, periodo });
	}

	// ----- Diccionario (si la pestaña no existe todavía, se arma desde Gastos) -----
	let dicc: Obj[] = [];
	if (hojasPresentes.has('_diccionario')) {
		const vistos = new Set<string>();
		for (const o of datos.mapeo_detalle) {
			if (o.id == null || o.detalle == null || o.subcategoria == null || vistos.has(o.detalle as string)) {
				avisos.push(`_diccionario fila ${o._fila}: incompleta o repetida`);
				continue;
			}
			vistos.add(o.detalle as string);
			dicc.push({ id: o.id, detalle: o.detalle, subcategoria_id: idDe('subcategoria', o.subcategoria) });
		}
	} else {
		// La subcategoría más usada para cada detalle.
		const cuenta = new Map<string, Map<number, number>>();
		for (const g of gastos) {
			if (g.subcategoria_id == null) continue;
			const m = cuenta.get(g.detalle as string) ?? new Map();
			m.set(g.subcategoria_id as number, (m.get(g.subcategoria_id as number) ?? 0) + 1);
			cuenta.set(g.detalle as string, m);
		}
		let n = 0;
		for (const [detalle, m] of [...cuenta.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const scid = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
			dicc.push({ id: ++n, detalle, subcategoria_id: scid });
			marcarCreada('_diccionario', n);
		}
	}

	// ----- Recurrentes, fijos, registros, presupuestos, etc. -----
	const sus: Obj[] = [];
	for (const o of datos.suscripcion) {
		if (o.id == null || o.nombre == null || !(((o.monto as number) ?? 0) > 0) || o.categoria == null) {
			avisos.push(`_recurrentes fila ${o._fila}: incompleta`); continue;
		}
		sus.push({
			id: o.id, nombre: o.nombre, detalle: o.detalle, monto: o.monto, moneda: String(o.moneda ?? 'ARS').toUpperCase(),
			categoria_id: idDe('categoria', o.categoria), tarjeta_id: idDe('tarjeta', o.tarjeta),
			activa: o.activa ?? 1, dia_esperado: o.dia_esperado
		});
	}
	const idsSus = new Set(sus.map((s) => s.id as number));
	const fijos: Obj[] = [];
	for (const o of datos.ingreso_fijo) {
		const tipo = tipoIngreso(o.tipo);
		if (o.id == null || o.nombre == null || !(((o.monto as number) ?? 0) > 0) || !INGRESO_CATS.has(String(o.categoria)) || !tipo) {
			avisos.push(`_ingresos_fijos fila ${o._fila}: incompleta`); continue;
		}
		fijos.push({
			id: o.id, nombre: o.nombre, detalle: o.detalle, monto: o.monto, moneda: String(o.moneda ?? 'ARS').toUpperCase(),
			categoria: o.categoria, tipo, activa: o.activa ?? 1, dia_esperado: o.dia_esperado
		});
	}
	const idsFijo = new Set(fijos.map((s) => s.id as number));
	const regSus = datos.suscripcion_registro.filter((o) => {
		const ok = o.id != null && idsSus.has(o.suscripcion_id as number) && idsGasto.has(o.gasto_id as number) && o.periodo != null;
		if (!ok) avisos.push(`_recurrentes_reg fila ${o._fila}: apunta a algo que no existe`);
		return ok;
	});
	const regFijo = datos.ingreso_fijo_registro.filter((o) => {
		const ok = o.id != null && idsFijo.has(o.ingreso_fijo_id as number) && idsIngreso.has(o.ingreso_id as number) && o.periodo != null;
		if (!ok) avisos.push(`_ingresos_fijos_reg fila ${o._fila}: apunta a algo que no existe`);
		return ok;
	});
	const presup = datos.presupuesto
		.filter((o) => o.id != null && o.subcategoria != null && o.monto != null)
		.map((o) => ({ id: o.id, subcategoria_id: idDe('subcategoria', o.subcategoria), periodo: o.periodo ?? 'default', monto: o.monto, auto: o.auto ?? 0 }));
	const reserva = datos.reserva_credito.filter((o) => o.id != null && o.periodo != null && o.monto != null)
		.map((o) => ({ id: o.id, periodo: String(o.periodo).slice(0, 7), monto: o.monto }));
	const meta = datos.meta.filter((o) => o.clave != null && metaSincroniza(o.clave as string))
		.map((o) => ({ clave: o.clave, valor: o.valor == null ? '' : String(o.valor) }));
	const notif = datos.notif_visto.filter((o) => o.id != null && (o.tipo === 'pago' || o.tipo === 'cobro') && o.ref_id != null && o.periodo != null)
		.map((o) => ({ id: o.id, tipo: o.tipo, ref_id: o.ref_id, periodo: o.periodo }));

	// ----- Escritura en la base (en orden de foreign keys) -----
	const porTabla: [string, Obj[]][] = [
		['perfil', perfiles],
		['categoria', filasRef.categoria],
		['subcategoria', filasRef.subcategoria],
		['tarjeta', filasRef.tarjeta],
		['mapeo_detalle', dicc],
		['gasto', gastos],
		['ingreso', ingresos],
		['suscripcion', sus],
		['ingreso_fijo', fijos],
		['suscripcion_registro', regSus],
		['ingreso_fijo_registro', regFijo],
		['presupuesto', presup],
		['reserva_credito', reserva],
		['meta', meta],
		['notif_visto', notif]
	];
	const stmts: { sql: string; bind: unknown[]; tabla: string; fila: Obj }[] = [];
	for (const [tabla, filas] of porTabla) {
		const t = TABLAS.find((x) => x.tabla === tabla)!;
		for (const f of filas) {
			// Las columnas vacías no se mandan: así aplica el default de la tabla
			// (activa=1, cuotas=1, creado_en=ahora...) y las opcionales quedan NULL.
			const cols = Object.keys(f).filter((k) => !k.startsWith('_') && f[k] != null);
			if (t.perfil) cols.push('perfil_id');
			const vals = cols.map((k) => (k === 'perfil_id' ? 1 : f[k]));
			stmts.push({ sql: `INSERT INTO ${tabla} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, bind: vals, tabla, fila: f });
		}
	}
	try {
		await queryBatch(stmts.map((s) => ({ sql: s.sql, bind: s.bind })));
	} catch {
		// Algo violó una regla de la base: se carga de a una fila y se informa cuál.
		for (const s of stmts) {
			try { await query(s.sql, s.bind); }
			catch (e: any) { avisos.push(`${TABLAS.find((x) => x.tabla === s.tabla)!.hoja} id ${s.fila.id ?? s.fila.clave}: ${e?.message ?? e}`); }
		}
	}
	return { avisos, creadas, hojasPresentes };
}
