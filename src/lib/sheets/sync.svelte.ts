// src/lib/sheets/sync.svelte.ts
// Rienda + Sheets: el motor de sincronización.
//
//  Arranque:  sube lo que quedó pendiente → baja la Sheet → la carga en la base
//             en memoria. Sin señal, usa la última copia guardada en el teléfono.
//  Uso:       después de cada escritura compara la base contra el último estado
//             conocido, encola las diferencias (por id) y las sube a la Sheet.
//             La cola se guarda en el teléfono hasta que la Sheet confirma, así
//             que cargar sin señal (subte) no pierde nada.
//  Seguridad: nunca sube una base vacía ni borrados masivos.

import { query, queryBatch, onEscritura, onWorkerRoto, sinAvisar, estaRoto } from '../db/client';
import { TABLAS, render, cargar, encabezado, formatos, libroDe, invDisponible, type Render, type Fila, type Payload, type Tabla } from './tablas';
import { leerConexion, tomarEnlaceDeLaUrl, bajar, subir, ErrorPuente, type Conexion, type CambiosHoja } from './conexion';
import { SEED_MACRO } from '../db/seed_macro';

type Estado = 'sin_conexion' | 'cargando' | 'listo' | 'error_carga';
type Guardado = 'ok' | 'guardando' | 'pendiente' | 'error';

export const sync = $state({
	estado: 'cargando' as Estado,
	guardado: 'ok' as Guardado,
	mensaje: '',
	offline: false, // se abrió con la copia del teléfono (sin señal)
	avisos: [] as string[], // filas de la Sheet que no se pudieron leer
	frenado: '', // borrado masivo frenado
	pendientes: 0,
	ultimaCarga: null as string | null,
	ultimoGuardado: null as string | null,
	hoja: null as { nombre: string; url: string } | null,
	// Sheet "Inversiones" (fase 2). invEstado: 'ok' | 'script_viejo' (el Apps Script
	// todavía no la conoce) | 'error' (no la encontró). Mientras no esté 'ok', lo de
	// inversiones no se sube a ningún lado.
	invEstado: 'ok' as 'ok' | 'script_viejo' | 'error',
	invMensaje: '',
	// La pestaña _activos no existía y la creó la app en esta apertura: todavía no
	// hubo chance de cargar splits, así que no se reconstruye el historial.
	catalogoNuevo: false,
	hojaInv: null as { nombre: string; url: string } | null
});

const LS_PEND = 'rienda_sheets_pendiente';
const LS_COPIA = 'rienda_sheets_copia';
const LS_MACRO = 'rienda_sheets_macro';

let conexion: Conexion | null = null;
let base: Render = {}; // último estado ya encolado / confirmado
type Op = { fila: Fila | null; nuevo: boolean }; // fila null = borrar
type Cola = Map<string, Map<string, Op>>; // hoja -> clave -> op
let pend: Cola = new Map();
let enVuelo: Cola | null = null;
let listo = false;
let invOk = false; // se pueden guardar cambios en la Sheet Inversiones

const TABLA_DE = new Map(TABLAS.map((t) => [t.hoja, t]));
const sincroniza = (t: Tabla) => libroDe(t) === 'finanzas' || invOk;

// ---------------------------------------------------------------------------
// Persistencia local (cola y copia para abrir sin señal)
// ---------------------------------------------------------------------------
function contar(c: Cola | null) {
	let n = 0;
	if (c) for (const m of c.values()) n += m.size;
	return n;
}
function persistirCola() {
	const todo: Record<string, Record<string, Op>> = {};
	for (const c of [enVuelo, pend]) {
		if (!c) continue;
		for (const [h, m] of c) for (const [k, op] of m) {
			const prev = (todo[h] ??= {})[k];
			todo[h][k] = prev ? { fila: op.fila, nuevo: prev.nuevo || op.nuevo } : op;
		}
	}
	sync.pendientes = contar(enVuelo) + contar(pend);
	try {
		if (sync.pendientes) localStorage.setItem(LS_PEND, JSON.stringify(todo));
		else localStorage.removeItem(LS_PEND);
	} catch { /* sin storage */ }
}
function restaurarCola() {
	try {
		const raw = JSON.parse(localStorage.getItem(LS_PEND) ?? 'null') as Record<string, Record<string, Op>> | null;
		if (!raw) return;
		for (const [h, m] of Object.entries(raw)) {
			if (!TABLA_DE.has(h)) continue;
			pend.set(h, new Map(Object.entries(m)));
		}
		sync.pendientes = contar(pend);
	} catch { /* copia corrupta: se ignora */ }
}
function guardarCopia(r: Render) {
	const hojas: Payload['hojas'] = {};
	const inv: Payload['hojas'] = {};
	for (const t of TABLAS) {
		if (!sincroniza(t)) continue;
		(libroDe(t) === 'inversiones' ? inv : hojas)[t.hoja] = { header: encabezado(t), filas: [...(r[t.hoja]?.values() ?? [])] };
	}
	const copia: Payload & { ts: string } = { ts: new Date().toISOString(), hojas };
	if (invOk) copia.inv = { hojas: inv, nombre: sync.hojaInv?.nombre, url: sync.hojaInv?.url };
	try { localStorage.setItem(LS_COPIA, JSON.stringify(copia)); } catch { /* lleno */ }
}
function leerCopia(): (Payload & { ts: string }) | null {
	try { return JSON.parse(localStorage.getItem(LS_COPIA) ?? 'null'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Detección de cambios
// ---------------------------------------------------------------------------
const MAX_BORRADOS = { principal: 10, otras: 30 }; // por cambio: más que esto, se frena
const PRINCIPALES = new Set(['Gastos', 'Ingresos', 'Activos', 'Renta y amortización', 'Caja']);

let detectando = false;
let otraVez = false;
let timerDetectar: ReturnType<typeof setTimeout> | null = null;

function programarDeteccion() {
	if (!listo) return;
	if (timerDetectar) clearTimeout(timerDetectar);
	timerDetectar = setTimeout(() => { timerDetectar = null; detectar(); }, 350);
}

async function detectar() {
	if (!listo || estaRoto()) return;
	if (detectando) { otraVez = true; return; }
	detectando = true;
	try {
		const actual = await render();
		if (estaRoto()) return;
		for (const t of TABLAS) {
			if (!sincroniza(t)) continue;
			const a = actual[t.hoja] ?? new Map();
			const b = base[t.hoja] ?? new Map();
			const ups: [string, Fila, boolean][] = [];
			const dels: string[] = [];
			for (const [k, fila] of a) {
				const prev = b.get(k);
				if (!prev || JSON.stringify(prev) !== JSON.stringify(fila)) ups.push([k, fila, !prev]);
			}
			for (const k of b.keys()) if (!a.has(k)) dels.push(k);
			const tope = PRINCIPALES.has(t.hoja) ? MAX_BORRADOS.principal : MAX_BORRADOS.otras;
			const frenar = dels.length > tope;
			if (frenar) {
				sync.frenado = `Se frenó el borrado de ${dels.length} filas de "${t.hoja}" en la Sheet. Tus datos siguen ahí: recargá la app.`;
				console.warn('[sync] borrado masivo frenado', t.hoja, dels.length);
			}
			if (!ups.length && (!dels.length || frenar)) continue;
			const cola = pend.get(t.hoja) ?? new Map<string, Op>();
			for (const [k, fila, nuevo] of ups) {
				const prev = cola.get(k);
				cola.set(k, { fila, nuevo: nuevo || (prev?.nuevo ?? false) });
			}
			if (!frenar) for (const k of dels) {
				const prev = cola.get(k);
				// Si nunca llegó a la Sheet (alta pendiente que no está en vuelo), basta con olvidarla.
				if (prev?.nuevo && !enVuelo?.get(t.hoja)?.has(k)) cola.delete(k);
				else cola.set(k, { fila: null, nuevo: false });
			}
			if (cola.size) pend.set(t.hoja, cola); else pend.delete(t.hoja);
		}
		base = actual;
		persistirCola();
		guardarCopia(actual);
	} catch (e) {
		console.error('[sync] no se pudo comparar', e);
	} finally {
		detectando = false;
	}
	if (otraVez) { otraVez = false; await detectar(); return; }
	vaciarCola();
}

// ---------------------------------------------------------------------------
// Subida
// ---------------------------------------------------------------------------
let timerReintento: ReturnType<typeof setTimeout> | null = null;
let intentos = 0;

function armarCambios(c: Cola): CambiosHoja[] {
	const out: CambiosHoja[] = [];
	for (const [hoja, m] of c) {
		const t = TABLA_DE.get(hoja)!;
		const ch: CambiosHoja = { hoja, libro: libroDe(t), header: encabezado(t), clave: t.clave, formatos: formatos(t), upserts: [], deletes: [] };
		for (const [k, op] of m) {
			if (op.fila) ch.upserts.push({ clave: k, fila: op.fila, nuevo: op.nuevo });
			else ch.deletes.push(k);
		}
		out.push(ch);
	}
	return out;
}

function fusionarDeVuelta() {
	if (!enVuelo) return;
	for (const [h, m] of enVuelo) {
		const cola = pend.get(h) ?? new Map<string, Op>();
		for (const [k, op] of m) {
			const nueva = cola.get(k);
			cola.set(k, nueva ? { fila: nueva.fila, nuevo: nueva.nuevo || op.nuevo } : op);
		}
		pend.set(h, cola);
	}
	enVuelo = null;
}

export async function vaciarCola(): Promise<boolean> {
	if (!conexion || enVuelo || !pend.size || estaRoto()) return !pend.size && !enVuelo;
	if (timerReintento) { clearTimeout(timerReintento); timerReintento = null; }
	enVuelo = pend;
	pend = new Map();
	persistirCola();
	sync.guardado = 'guardando';
	try {
		const res = await subir(conexion, armarCambios(enVuelo));
		enVuelo = null;
		await aplicarRemap(res.remap ?? {});
		persistirCola();
		intentos = 0;
		sync.guardado = 'ok';
		sync.mensaje = '';
		sync.ultimoGuardado = new Date().toISOString();
	} catch (e: any) {
		fusionarDeVuelta();
		persistirCola();
		const sinRed = e instanceof ErrorPuente && e.sinRed;
		sync.guardado = sinRed ? 'pendiente' : 'error';
		sync.mensaje = e?.message ?? String(e);
		intentos++;
		const espera = Math.min(60000, 4000 * 2 ** Math.min(intentos, 4));
		timerReintento = setTimeout(() => { timerReintento = null; vaciarCola(); }, espera);
		return false;
	}
	if (pend.size) return vaciarCola();
	return true;
}

// Ids que la Sheet tuvo que cambiar (otro dispositivo usó el mismo id).
const HIJOS: Record<string, [string, string][]> = {
	categoria: [['gasto', 'categoria_id'], ['suscripcion', 'categoria_id']],
	subcategoria: [['gasto', 'subcategoria_id'], ['mapeo_detalle', 'subcategoria_id'], ['presupuesto', 'subcategoria_id']],
	tarjeta: [['gasto', 'tarjeta_id'], ['suscripcion', 'tarjeta_id']],
	gasto: [['suscripcion_registro', 'gasto_id']],
	ingreso: [['ingreso_fijo_registro', 'ingreso_id']],
	suscripcion: [['suscripcion_registro', 'suscripcion_id']],
	ingreso_fijo: [['ingreso_fijo_registro', 'ingreso_fijo_id']],
	activo: [['transaccion', 'activo_id'], ['renta_activo', 'activo_id'], ['precio_historico', 'activo_id']],
	cuenta_inversion: [['transaccion', 'cuenta_inversion_id']]
};
async function aplicarRemap(remap: Record<string, Record<string, string>>) {
	const pares = Object.entries(remap).flatMap(([h, m]) => Object.entries(m).map(([a, b]) => [h, a, b] as const));
	if (!pares.length) return;
	await sinAvisar(async () => {
		await query('PRAGMA foreign_keys=OFF');
		try {
			for (const [hoja, viejo, nuevo] of pares) {
				const t = TABLA_DE.get(hoja);
				if (!t || t.clave !== 'id') continue;
				await query(`UPDATE ${t.tabla} SET id=? WHERE id=?`, [Number(nuevo), Number(viejo)]);
				for (const [hija, col] of HIJOS[t.tabla] ?? []) await query(`UPDATE ${hija} SET ${col}=? WHERE ${col}=?`, [Number(nuevo), Number(viejo)]);
				if (t.tabla === 'subcategoria') await query("UPDATE meta SET valor=? WHERE clave='susc_subcat_id' AND valor=?", [nuevo, viejo]);
				if (t.tabla === 'suscripcion' || t.tabla === 'ingreso_fijo')
					await query('UPDATE notif_visto SET ref_id=? WHERE tipo=? AND ref_id=?', [Number(nuevo), t.tabla === 'suscripcion' ? 'pago' : 'cobro', Number(viejo)]);
				// El estado conocido pasa a la clave nueva (la fila ya está en la Sheet con ese id).
				const b = base[hoja];
				const fila = b?.get(viejo);
				if (b && fila) {
					const ik = t.cols.findIndex((c) => c.hoja === 'id');
					const f2 = [...fila]; f2[ik] = Number(nuevo);
					b.delete(viejo); b.set(nuevo, f2);
				}
				const p = pend.get(hoja)?.get(viejo);
				if (p) { pend.get(hoja)!.delete(viejo); if (p.fila) { const ik = t.cols.findIndex((c) => c.hoja === 'id'); p.fila[ik] = Number(nuevo); } pend.get(hoja)!.set(nuevo, { ...p, nuevo: false }); }
			}
		} finally {
			await query('PRAGMA foreign_keys=ON');
		}
	});
	programarDeteccion(); // las filas hijas cambiaron de id: se suben
}

// ---------------------------------------------------------------------------
// Macro (dólar / inflación): datos públicos, se guardan en el teléfono para no
// bajar toda la serie en cada apertura. Si se pierden, se vuelven a bajar.
// ---------------------------------------------------------------------------
export async function guardarMacro() {
	try {
		const d = (await query("SELECT casa, fecha, valor FROM cotizacion_dolar WHERE perfil_id=1 AND fecha >= '2023-01-01'")) as any[];
		const i = (await query('SELECT periodo, valor FROM inflacion WHERE perfil_id=1')) as any[];
		const m = (await query("SELECT clave, valor FROM meta WHERE clave IN ('cotizaciones_resync_en','dolar_actualizado_en')")) as any[];
		const obj = {
			dolar: d.map((x) => [x.casa, x.fecha, x.valor]),
			infl: i.map((x) => [x.periodo, x.valor]),
			meta: Object.fromEntries(m.map((x) => [x.clave, x.valor]))
		};
		localStorage.setItem(LS_MACRO, JSON.stringify(obj));
	} catch (e) {
		console.warn('[sync] no se pudo guardar el dólar/inflación', e);
	}
}

async function cargarMacro() {
	// Usuario nuevo (Sheet vacía): todavía no hay perfil y las cotizaciones lo
	// referencian. crearPerfil() carga las de arranque después de crearlo.
	const hayPerfil = ((await query('SELECT COUNT(*) AS n FROM perfil')) as any[])[0].n > 0;
	if (!hayPerfil) return;
	let obj: any = null;
	try { obj = JSON.parse(localStorage.getItem(LS_MACRO) ?? 'null'); } catch { /* ignore */ }
	if (obj?.dolar?.length) {
		const stmts: { sql: string; bind: unknown[] }[] = [];
		for (const [casa, fecha, valor] of obj.dolar)
			stmts.push({ sql: 'INSERT OR IGNORE INTO cotizacion_dolar (perfil_id, casa, fecha, valor) VALUES (1,?,?,?)', bind: [casa, fecha, valor] });
		for (const [periodo, valor] of obj.infl ?? [])
			stmts.push({ sql: 'INSERT OR IGNORE INTO inflacion (perfil_id, periodo, valor) VALUES (1,?,?)', bind: [periodo, valor] });
		for (const [clave, valor] of Object.entries(obj.meta ?? {}))
			stmts.push({ sql: 'INSERT OR REPLACE INTO meta (clave, valor) VALUES (?,?)', bind: [clave, valor] });
		await queryBatch(stmts);
	} else if (SEED_MACRO && SEED_MACRO.trim()) {
		await query(SEED_MACRO);
	}
}

// Lo que el worker hacía al arrancar con un perfil existente (con la base en
// memoria el perfil recién aparece después de cargar la Sheet).
async function arreglosPostCarga() {
	const hayPerfil = ((await query('SELECT COUNT(*) AS n FROM perfil')) as any[])[0].n > 0;
	if (!hayPerfil) return;
	const ra = (await query('SELECT COUNT(*) AS n FROM categoria WHERE perfil_id=1 AND es_ahorro=1')) as any[];
	if (ra[0].n === 0) {
		const ya = (await query("SELECT id FROM categoria WHERE perfil_id=1 AND TRIM(nombre)='Ahorro' COLLATE NOCASE")) as any[];
		if (ya.length) await query('UPDATE categoria SET es_ahorro=1 WHERE id=?', [ya[0].id]);
		else await query("INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Ahorro', 1)");
	}
	const rm = (await query('SELECT COUNT(*) AS n FROM subcategoria WHERE perfil_id=1 AND es_meta_ahorro=1')) as any[];
	if (rm[0].n === 0) {
		const ya = (await query("SELECT id FROM subcategoria WHERE perfil_id=1 AND TRIM(nombre)='Meta ahorro' COLLATE NOCASE")) as any[];
		if (ya.length) await query('UPDATE subcategoria SET es_meta_ahorro=1 WHERE id=?', [ya[0].id]);
		else await query("INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Meta ahorro', 1)");
	}
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
let enganchado = false;
let ocultoDesde = 0;
const RECARGAR_TRAS_MS = 15 * 60 * 1000;

function enganchar() {
	if (enganchado) return;
	enganchado = true;
	onEscritura(programarDeteccion);
	onWorkerRoto(() => {
		sync.estado = 'error_carga';
		sync.mensaje = 'La base se reinició. Recargando desde la Sheet…';
		setTimeout(() => location.reload(), 1500);
	});
	window.addEventListener('online', () => { vaciarCola(); });
	document.addEventListener('visibilitychange', async () => {
		if (document.hidden) { ocultoDesde = Date.now(); persistirCola(); return; }
		const fuera = ocultoDesde ? Date.now() - ocultoDesde : 0;
		ocultoDesde = 0;
		await vaciarCola();
		// Volviste después de un rato: se recarga para traer lo que haya cambiado en la Sheet.
		if (fuera > RECARGAR_TRAS_MS && !pend.size && !enVuelo) location.reload();
	});
}

export async function iniciar(): Promise<void> {
	enganchar();
	conexion = tomarEnlaceDeLaUrl() ?? leerConexion();
	if (!conexion) { sync.estado = 'sin_conexion'; return; }
	sync.estado = 'cargando';
	sync.mensaje = '';
	restaurarCola();

	// 1) Lo que quedó sin subir de la vez anterior.
	let colaVieja = pend.size > 0;
	if (colaVieja) colaVieja = !(await vaciarCola());

	// 2) Bajar la Sheet (o, sin señal, la copia del teléfono).
	let payload: Payload | null = null;
	if (!colaVieja) {
		try {
			payload = await bajar(conexion);
			sync.hoja = (payload as any).hoja ?? null;
			sync.hojaInv = payload.inv?.url ? { nombre: payload.inv.nombre ?? 'Inversiones', url: payload.inv.url } : null;
			try { localStorage.setItem('rienda_sheets_hoja', JSON.stringify(sync.hoja)); } catch { /* ignore */ }
			sync.offline = false;
			sync.ultimaCarga = new Date().toISOString();
		} catch (e: any) {
			if (!(e instanceof ErrorPuente && e.sinRed)) { sync.estado = 'error_carga'; sync.mensaje = e?.message ?? String(e); return; }
		}
	}
	if (!payload) {
		const copia = leerCopia();
		if (!copia) {
			sync.estado = 'error_carga';
			sync.mensaje = navigator.onLine
				? 'No pudimos llegar a la Sheet. Si es la primera vez: revisá que el Apps Script esté implementado con acceso "Cualquier usuario" y que el enlace termine en /exec (no en /dev).'
				: 'No hay conexión y todavía no hay una copia en este teléfono.';
			return;
		}
		payload = copia;
		try { sync.hoja = JSON.parse(localStorage.getItem('rienda_sheets_hoja') ?? 'null'); } catch { /* ignore */ }
		sync.hojaInv = copia.inv?.url ? { nombre: copia.inv.nombre ?? 'Inversiones', url: copia.inv.url } : null;
		sync.offline = true;
		sync.ultimaCarga = copia.ts;
	}

	// 3) Cargar en la base.
	invOk = invDisponible(payload);
	sync.invEstado = invOk ? 'ok' : payload.inv?.error ? 'error' : 'script_viejo';
	sync.invMensaje = payload.inv?.error ?? '';
	const res = await sinAvisar(() => cargar(payload!));
	sync.avisos = res.avisos;
	sync.catalogoNuevo = invOk && !res.hojasPresentes.has('_activos');
	base = await render();
	for (const [hoja, claves] of Object.entries(res.creadas)) for (const k of claves) base[hoja]?.delete(k);
	// Sin señal, la copia ya incluye lo pendiente; la cola se sube igual cuando
	// vuelva la conexión (por id, así que repetir un cambio no duplica nada).
	await sinAvisar(cargarMacro);
	listo = true;
	await arreglosPostCarga();
	sync.estado = 'listo';
	await detectar();
}

// Compara y encola YA lo que haya cambiado, y trata de subirlo. Se usa antes
// de recargar la página (crear el perfil, restaurar una copia): si no hay señal,
// la cola queda guardada en el teléfono y se sube al volver a abrir.
export async function guardarAhora(): Promise<boolean> {
	if (timerDetectar) { clearTimeout(timerDetectar); timerDetectar = null; }
	while (detectando) await new Promise((r) => setTimeout(r, 50));
	await detectar();
	while (enVuelo) await new Promise((r) => setTimeout(r, 100));
	return vaciarCola();
}

// Recarga completa desde la Sheet (botón en "Tus datos").
export async function recargarDesdeSheet(): Promise<boolean> {
	const ok = await vaciarCola();
	if (!ok && (pend.size || enVuelo)) return false;
	location.reload();
	return true;
}

export function hayConexion(): boolean {
	return !!conexion;
}
