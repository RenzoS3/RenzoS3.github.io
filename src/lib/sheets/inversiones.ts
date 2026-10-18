// src/lib/sheets/inversiones.ts
// Rienda + Sheets (fase 2): cómo se guardan las tablas de Inversiones de Rienda
// en la Google Sheet "Inversiones".
//
// Pestañas visibles (las de siempre, formato de la planilla de Rienda):
//   Activos               fecha · operacion · ticker · nombre · tipo · renta ·
//                         moneda · cuenta · unidades · monto_total · valor_dolar · id
//   Renta y amortización  fecha · ticker · nombre · tipo · renta · moneda ·
//                         monto_renta · monto_amort · valor_dolar · id
//   Caja                  fecha · accion · moneda · monto · grupo · nota · id
// Pestañas ocultas (lo que Rienda guarda aparte):
//   _activos   catálogo de tickers (exposición, símbolo de cotización, splits,
//              precio de los que se operan)
//   _cuentas   brokers
//   _precios   precios corregidos a mano (Tenencia en montos)
//   _fotos     valor diario de la cartera (Evolución de cartera)
//
// En Activos, "moneda" y "monto_total" son la moneda y el monto que se pagaron
// (o cobraron) en esa operación. El precio por unidad que usa Rienda va en la
// moneda del activo; si la operación se pagó en la otra moneda, se convierte
// con el valor_dolar de la fila (igual que la carga manual de la app).
// Las columnas que la app no conoce (monto_ars, por ejemplo) no se tocan.

import { query } from '../db/client';
import { splitsValidos } from '../db/splits';

export type Valor = string | number | null;
export type Fila = Valor[];
type Obj = Record<string, Valor>;

export const TIPOS_ACTIVO = ['Bono', 'ON', 'FCI', 'Accion', 'CEDEAR', 'Indice'];
export const RENTAS = ['Fija', 'Mixta', 'Variable', 'Liquido'];
const EXPOSICIONES = ['Dolar', 'CER', 'Peso'];
const ACCIONES_CAJA = ['Ingreso', 'Retiro', 'Convertir', 'Apertura'];

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esFecha = (v: Valor) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const lc = (v: Valor) => String(v ?? '').trim().toLowerCase();

export function exposicionPorRegla(moneda: string, tipo: string): string {
	return moneda === 'USD' || tipo === 'CEDEAR' || tipo === 'Indice' ? 'Dolar' : 'Peso';
}

function canon(lista: string[], v: Valor): string | null {
	const s = sinTildes(String(v ?? '').trim());
	return lista.find((x) => sinTildes(x) === s) ?? null;
}

// ---------------------------------------------------------------------------
// Render: base -> filas de cada pestaña (clave -> fila)
// ---------------------------------------------------------------------------
const n = (v: unknown): Valor => (v == null ? '' : Number(v));
const s = (v: unknown): Valor => (v == null ? '' : String(v));

export async function renderActivos(): Promise<Map<string, Fila>> {
	const rows = (await query(
		`SELECT t.id, t.fecha, t.operacion, a.ticker, a.nombre, a.tipo, a.renta, a.moneda AS amon, c.nombre AS cuenta,
		        t.unidades, t.precio, t.valor_dolar, t.moneda_pago, t.monto_pago
		 FROM transaccion t JOIN activo a ON a.id = t.activo_id LEFT JOIN cuenta_inversion c ON c.id = t.cuenta_inversion_id`
	)) as any[];
	const m = new Map<string, Fila>();
	for (const r of rows) {
		const moneda = r.moneda_pago ?? r.amon;
		const monto = r.monto_pago ?? r.unidades * r.precio;
		m.set(String(r.id), [s(r.fecha), s(r.operacion), s(r.ticker), s(r.nombre), s(r.tipo), s(r.renta), s(moneda), s(r.cuenta),
			n(r.unidades), n(monto), n(r.valor_dolar), Number(r.id)]);
	}
	return m;
}

export async function renderRenta(): Promise<Map<string, Fila>> {
	const rows = (await query(
		`SELECT r.id, r.fecha, a.ticker, a.nombre, a.tipo, a.renta, r.moneda, r.monto_renta, r.monto_amort, r.valor_dolar
		 FROM renta_activo r JOIN activo a ON a.id = r.activo_id`
	)) as any[];
	const m = new Map<string, Fila>();
	for (const r of rows)
		m.set(String(r.id), [s(r.fecha), s(r.ticker), s(r.nombre), s(r.tipo), s(r.renta), s(r.moneda), n(r.monto_renta), n(r.monto_amort), n(r.valor_dolar), Number(r.id)]);
	return m;
}

export async function renderCaja(): Promise<Map<string, Fila>> {
	const rows = (await query('SELECT id, fecha, accion, moneda, monto, grupo, nota FROM mov_caja')) as any[];
	const m = new Map<string, Fila>();
	for (const r of rows) m.set(String(r.id), [s(r.fecha), s(r.accion), s(r.moneda), n(r.monto), s(r.grupo), s(r.nota), Number(r.id)]);
	return m;
}

export async function renderCatalogo(): Promise<Map<string, Fila>> {
	const rows = (await query(
		`SELECT a.id, a.ticker, a.nombre, a.tipo, a.renta, a.moneda, a.exposicion, a.simbolo_cotizacion, a.splits, a.activo,
		        a.precio_actual, a.precio_actualizado_en,
		        (EXISTS (SELECT 1 FROM transaccion t WHERE t.activo_id = a.id) OR EXISTS (SELECT 1 FROM renta_activo r WHERE r.activo_id = a.id)) AS operado
		 FROM activo a`
	)) as any[];
	const m = new Map<string, Fila>();
	for (const r of rows) {
		// El precio viaja solo para lo que se opera o no se actualiza solo (FCI,
		// sin símbolo). El catálogo sincronizado de data912 (cientos de símbolos)
		// lo vuelve a traer el refresco de precios: subirlo cada 20 min sería ruido.
		const conPrecio = r.operado || !r.simbolo_cotizacion;
		m.set(String(r.id), [
			Number(r.id), s(r.ticker), s(r.nombre), s(r.tipo), s(r.renta), s(r.moneda),
			s(r.exposicion ?? exposicionPorRegla(r.moneda, r.tipo)), s(r.simbolo_cotizacion), s(r.splits), Number(r.activo ?? 1),
			conPrecio ? n(r.precio_actual) : '', conPrecio ? s(r.precio_actualizado_en) : ''
		]);
	}
	return m;
}

export async function renderCuentas(): Promise<Map<string, Fila>> {
	const rows = (await query('SELECT id, nombre, tipo, activa FROM cuenta_inversion')) as any[];
	const m = new Map<string, Fila>();
	for (const r of rows) m.set(String(r.id), [Number(r.id), s(r.nombre), s(r.tipo), Number(r.activa ?? 1)]);
	return m;
}

export async function renderPrecios(): Promise<Map<string, Fila>> {
	const rows = (await query(
		"SELECT p.id, a.ticker, p.fecha, p.precio FROM precio_historico p JOIN activo a ON a.id = p.activo_id WHERE p.origen = 'manual'"
	)) as any[];
	const m = new Map<string, Fila>();
	for (const r of rows) m.set(String(r.id), [Number(r.id), s(r.ticker), s(r.fecha), n(r.precio)]);
	return m;
}

export async function renderFotos(): Promise<Map<string, Fila>> {
	const rows = (await query('SELECT fecha, valor_usd, flujo_usd, dolar, valor_ars FROM snapshot')) as any[];
	const m = new Map<string, Fila>();
	for (const r of rows) m.set(String(r.fecha), [s(r.fecha), n(r.valor_usd), n(r.flujo_usd), n(r.dolar), n(r.valor_ars)]);
	return m;
}

// ---------------------------------------------------------------------------
// Carga: filas de la Sheet (ya normalizadas por columna) -> sentencias SQL
// ---------------------------------------------------------------------------
export type DatosInv = {
	activos: Obj[]; // pestaña Activos
	renta: Obj[];
	caja: Obj[];
	catalogo: Obj[]; // _activos
	cuentas: Obj[];
	precios: Obj[];
	fotos: Obj[];
};
export type Stmt = { sql: string; bind: unknown[]; hoja: string; ref: Valor };

export function prepararInversiones(
	d: DatosInv,
	avisos: string[],
	marcarCreada: (hoja: string, clave: number | string) => void
): Stmt[] {
	const stmts: Stmt[] = [];
	const add = (hoja: string, ref: Valor, sql: string, bind: unknown[]) => stmts.push({ sql, bind, hoja, ref });

	// ----- Cuentas -----
	const cuentaPorNombre = new Map<string, number>();
	let maxCuenta = 0;
	const cuentas: Obj[] = [];
	for (const o of d.cuentas) {
		const id = o.id as number | null;
		if (id == null || o.nombre == null || cuentaPorNombre.has(lc(o.nombre)) || cuentas.some((c) => c.id === id)) {
			avisos.push(`_cuentas fila ${o._fila}: id o nombre vacío o repetido`);
			continue;
		}
		cuentas.push(o);
		cuentaPorNombre.set(lc(o.nombre), id);
		maxCuenta = Math.max(maxCuenta, id);
	}
	function cuentaDe(nombre: Valor): number {
		const k = lc(nombre);
		const ya = cuentaPorNombre.get(k);
		if (ya != null) return ya;
		const id = ++maxCuenta;
		cuentas.push({ id, nombre: String(nombre).trim(), tipo: 'broker', activa: 1 });
		cuentaPorNombre.set(k, id);
		marcarCreada('_cuentas', id);
		return id;
	}

	// ----- Catálogo de activos -----
	type Act = { id: number; ticker: string; nombre: string; tipo: string; renta: string; moneda: string; exposicion: string; simbolo: string | null; splits: string | null; activo: number; precio: number | null; precioEn: string | null };
	const porTicker = new Map<string, Act>();
	let maxActivo = 0;
	for (const o of d.catalogo) {
		const err = (m: string) => avisos.push(`_activos fila ${o._fila}: ${m}`);
		const id = o.id as number | null;
		const ticker = String(o.ticker ?? '').trim();
		if (id == null || !ticker || porTicker.has(ticker.toLowerCase()) || [...porTicker.values()].some((a) => a.id === id)) { err('id o ticker vacío o repetido'); continue; }
		const tipo = canon(TIPOS_ACTIVO, o.tipo);
		const renta = canon(RENTAS, o.renta);
		const moneda = String(o.moneda ?? '').trim().toUpperCase();
		if (!tipo) { err(`tipo "${o.tipo ?? ''}" inválido`); continue; }
		if (!renta) { err(`renta "${o.renta ?? ''}" inválida`); continue; }
		if (moneda !== 'ARS' && moneda !== 'USD') { err('moneda inválida'); continue; }
		let splits = o.splits == null ? null : String(o.splits).trim();
		if (!splitsValidos(splits)) { err(`splits "${splits}" con formato inválido (se ignora; usá AAAA-MM-DD:factor)`); splits = null; }
		const precio = typeof o.precio_actual === 'number' && o.precio_actual > 0 ? o.precio_actual : null;
		porTicker.set(ticker.toLowerCase(), {
			id, ticker, nombre: String(o.nombre ?? ticker).trim() || ticker, tipo, renta, moneda,
			exposicion: canon(EXPOSICIONES, o.exposicion) ?? exposicionPorRegla(moneda, tipo),
			simbolo: o.simbolo_cotizacion == null ? null : String(o.simbolo_cotizacion).trim().toUpperCase() || null,
			splits, activo: o.activo === 0 ? 0 : 1, precio, precioEn: precio != null && o.precio_actualizado_en != null ? String(o.precio_actualizado_en) : null
		});
		maxActivo = Math.max(maxActivo, id);
	}

	// ----- Activos (compras y ventas) -----
	type Tx = { o: Obj; id: number; fecha: string; op: string; ticker: string; cuenta: string; u: number; monto: number; moneda: string; vd: number | null };
	const txs: Tx[] = [];
	const idsTx = new Set<number>();
	for (const o of d.activos) {
		const err = (m: string) => avisos.push(`Activos fila ${o._fila}: ${m}`);
		const id = o.id as number | null;
		if (id == null || idsTx.has(id)) { err('id vacío o repetido'); continue; }
		if (!esFecha(o.fecha)) { err('fecha inválida'); continue; }
		const op = canon(['Compra', 'Venta'], o.operacion);
		if (!op) { err(`operación "${o.operacion ?? ''}" (solo Compra o Venta)`); continue; }
		const ticker = String(o.ticker ?? '').trim();
		if (!ticker) { err('falta el ticker'); continue; }
		if (o.cuenta == null) { err('falta la cuenta'); continue; }
		const u = o.unidades as number | null;
		if (u == null || !(u > 0)) { err('unidades vacías o no positivas'); continue; }
		const monto = o.monto_total as number | null;
		if (monto == null || !(monto > 0)) { err('monto_total vacío o no positivo'); continue; }
		const moneda = String(o.moneda ?? '').trim().toUpperCase();
		if (moneda !== 'ARS' && moneda !== 'USD') { err('moneda inválida'); continue; }
		const vd = typeof o.valor_dolar === 'number' && o.valor_dolar > 0 ? o.valor_dolar : null;
		idsTx.add(id);
		txs.push({ o, id, fecha: String(o.fecha), op, ticker, cuenta: String(o.cuenta).trim(), u, monto, moneda, vd });
	}

	// ----- Renta y amortización -----
	type Rt = { o: Obj; id: number; fecha: string; ticker: string; moneda: string; renta: number; amort: number; vd: number | null };
	const rentas: Rt[] = [];
	const idsRenta = new Set<number>();
	for (const o of d.renta) {
		const err = (m: string) => avisos.push(`Renta y amortización fila ${o._fila}: ${m}`);
		const id = o.id as number | null;
		if (id == null || idsRenta.has(id)) { err('id vacío o repetido'); continue; }
		if (!esFecha(o.fecha)) { err('fecha inválida'); continue; }
		const ticker = String(o.ticker ?? '').trim();
		if (!ticker) { err('falta el ticker'); continue; }
		const moneda = String(o.moneda ?? '').trim().toUpperCase();
		if (moneda !== 'ARS' && moneda !== 'USD') { err('moneda inválida'); continue; }
		const renta = (o.monto_renta as number | null) ?? 0;
		const amort = (o.monto_amort as number | null) ?? 0;
		if (!(renta >= 0) || !(amort >= 0) || renta + amort <= 0) { err('cargá un monto de renta o amortización positivo'); continue; }
		const vd = typeof o.valor_dolar === 'number' && o.valor_dolar > 0 ? o.valor_dolar : null;
		idsRenta.add(id);
		rentas.push({ o, id, fecha: String(o.fecha), ticker, moneda, renta, amort, vd });
	}

	// ----- Tickers que aparecen en las filas y no están en _activos: se crean -----
	// Moneda del activo = la de la mayoría de sus operaciones (un CEDEAR comprado
	// casi siempre en pesos queda en pesos aunque una compra se haya pagado en
	// dólares). tipo / renta / nombre: los de la primera fila que los tenga bien.
	const fuentes = new Map<string, Obj[]>();
	for (const t of txs) (fuentes.get(t.ticker.toLowerCase()) ?? fuentes.set(t.ticker.toLowerCase(), []).get(t.ticker.toLowerCase())!).push(t.o);
	for (const r of rentas) (fuentes.get(r.ticker.toLowerCase()) ?? fuentes.set(r.ticker.toLowerCase(), []).get(r.ticker.toLowerCase())!).push(r.o);
	const sinActivo = new Set<string>();
	for (const [k, filas] of fuentes) {
		if (porTicker.has(k)) continue;
		const tipo = filas.map((f) => canon(TIPOS_ACTIVO, f.tipo)).find(Boolean) ?? null;
		const renta = filas.map((f) => canon(RENTAS, f.renta)).find(Boolean) ?? null;
		if (!tipo || !renta) {
			sinActivo.add(k);
			avisos.push(`Ticker "${String(filas[0].ticker)}": falta tipo o renta válidos para darlo de alta (se saltean sus filas)`);
			continue;
		}
		const cuenta: Record<string, number> = {};
		const deActivos = filas.filter((f) => f.operacion != null);
		for (const f of deActivos.length ? deActivos : filas) {
			const m = String(f.moneda ?? '').toUpperCase();
			if (m === 'ARS' || m === 'USD') cuenta[m] = (cuenta[m] ?? 0) + 1;
		}
		const moneda = (cuenta.ARS ?? 0) === (cuenta.USD ?? 0)
			? (['CEDEAR', 'Accion', 'Indice'].includes(tipo) ? 'ARS' : String(filas[0].moneda ?? 'ARS').toUpperCase())
			: (cuenta.ARS ?? 0) > (cuenta.USD ?? 0) ? 'ARS' : 'USD';
		const ticker = String(filas[0].ticker).trim();
		const nombre = filas.map((f) => (f.nombre == null ? '' : String(f.nombre).trim())).find(Boolean) ?? ticker;
		const id = ++maxActivo;
		porTicker.set(k, {
			id, ticker, nombre, tipo, renta, moneda: moneda === 'USD' ? 'USD' : 'ARS',
			exposicion: exposicionPorRegla(moneda, tipo),
			// Misma regla que el alta en Mercado: los FCI no cotizan en data912.
			simbolo: tipo === 'FCI' ? null : ticker.toUpperCase(),
			splits: null, activo: 1, precio: null, precioEn: null
		});
		marcarCreada('_activos', id);
	}

	// Precio de la operación en la moneda del activo.
	function precioDe(t: Tx, a: Act): number | null {
		if (t.moneda === a.moneda) return t.monto / t.u;
		if (!t.vd) return null;
		return a.moneda === 'ARS' ? (t.monto * t.vd) / t.u : t.monto / t.vd / t.u;
	}

	type TxOk = Tx & { activoId: number; cuentaId: number; precio: number };
	const txOk: TxOk[] = [];
	for (const t of txs) {
		const a = porTicker.get(t.ticker.toLowerCase());
		if (!a) { if (!sinActivo.has(t.ticker.toLowerCase())) avisos.push(`Activos fila ${t.o._fila}: ticker desconocido`); continue; }
		const precio = precioDe(t, a);
		if (precio == null || !(precio > 0)) {
			avisos.push(`Activos fila ${t.o._fila}: se pagó en ${t.moneda} y ${a.ticker} cotiza en ${a.moneda}; falta valor_dolar para convertir`);
			continue;
		}
		txOk.push({ ...t, activoId: a.id, cuentaId: cuentaDe(t.cuenta), precio });
	}

	// Activos nuevos sin precio: el de su operación más nueva (como el import de Rienda).
	const ultimaTx = new Map<number, TxOk>();
	for (const t of txOk) {
		const u = ultimaTx.get(t.activoId);
		if (!u || t.fecha > u.fecha || (t.fecha === u.fecha && t.id > u.id)) ultimaTx.set(t.activoId, t);
	}
	for (const a of porTicker.values()) {
		if (a.precio != null) continue;
		const u = ultimaTx.get(a.id);
		if (u) { a.precio = u.precio; a.precioEn = u.fecha; }
	}

	// ----- Sentencias (padres antes que hijas) -----
	for (const c of cuentas)
		add('_cuentas', c.id, 'INSERT INTO cuenta_inversion (id, perfil_id, nombre, tipo, activa) VALUES (?,1,?,?,?)', [c.id, c.nombre, c.tipo ?? 'broker', c.activa === 0 ? 0 : 1]);
	for (const a of porTicker.values())
		add('_activos', a.id,
			'INSERT INTO activo (id, perfil_id, ticker, nombre, tipo, renta, moneda, exposicion, simbolo_cotizacion, splits, activo, precio_actual, precio_actualizado_en) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?)',
			[a.id, a.ticker, a.nombre, a.tipo, a.renta, a.moneda, a.exposicion, a.simbolo, a.splits, a.activo, a.precio, a.precioEn]);
	for (const t of txOk)
		add('Activos', t.id,
			'INSERT INTO transaccion (id, perfil_id, activo_id, cuenta_inversion_id, fecha, operacion, unidades, precio, valor_dolar, moneda_pago, monto_pago) VALUES (?,1,?,?,?,?,?,?,?,?,?)',
			[t.id, t.activoId, t.cuentaId, t.fecha, t.op, t.u, t.precio, t.vd, t.moneda, t.monto]);
	for (const r of rentas) {
		const a = porTicker.get(r.ticker.toLowerCase());
		if (!a) { if (!sinActivo.has(r.ticker.toLowerCase())) avisos.push(`Renta y amortización fila ${r.o._fila}: ticker desconocido`); continue; }
		add('Renta y amortización', r.id,
			'INSERT INTO renta_activo (id, perfil_id, activo_id, fecha, moneda, monto_renta, monto_amort, valor_dolar) VALUES (?,1,?,?,?,?,?,?)',
			[r.id, a.id, r.fecha, r.moneda, r.renta, r.amort, r.vd]);
	}

	// ----- Caja -----
	const idsCaja = new Set<number>();
	const grupos = new Map<string, number>();
	for (const o of d.caja) {
		const err = (m: string) => avisos.push(`Caja fila ${o._fila}: ${m}`);
		const id = o.id as number | null;
		if (id == null || idsCaja.has(id)) { err('id vacío o repetido'); continue; }
		if (!esFecha(o.fecha)) { err('fecha inválida'); continue; }
		const accionCruda = sinTildes(String(o.accion ?? '').trim());
		const accion = accionCruda === 'egreso' ? 'Retiro' : canon(ACCIONES_CAJA, o.accion);
		if (!accion) { err(`acción "${o.accion ?? ''}" (Ingreso, Retiro, Convertir o Apertura)`); continue; }
		const moneda = String(o.moneda ?? '').trim().toUpperCase();
		if (moneda !== 'ARS' && moneda !== 'USD') { err('moneda inválida'); continue; }
		let monto = o.monto as number | null;
		if (monto == null || monto === 0) { err('monto vacío'); continue; }
		// Rienda guarda los retiros en negativo; en la Sheet se acepta con o sin signo.
		if (accion === 'Ingreso') monto = Math.abs(monto);
		if (accion === 'Retiro') monto = -Math.abs(monto);
		const grupo = o.grupo == null ? null : String(o.grupo);
		if (accion === 'Convertir') {
			if (!grupo) { err('conversión sin grupo (las dos patas tienen que compartir el mismo grupo)'); continue; }
			grupos.set(grupo, (grupos.get(grupo) ?? 0) + 1);
		}
		idsCaja.add(id);
		add('Caja', id, 'INSERT INTO mov_caja (id, perfil_id, fecha, accion, moneda, monto, grupo, nota) VALUES (?,1,?,?,?,?,?,?)',
			[id, o.fecha, accion, moneda, monto, grupo, o.nota == null ? null : String(o.nota)]);
	}
	for (const [g, k] of grupos) if (k !== 2) avisos.push(`Caja: la conversión "${g}" tiene ${k} pata(s); tendría que tener 2 (sale una moneda, entra la otra)`);

	// ----- Precios corregidos a mano -----
	const idsPrecio = new Set<number>();
	const diaPrecio = new Set<string>();
	for (const o of d.precios) {
		const err = (m: string) => avisos.push(`_precios fila ${o._fila}: ${m}`);
		const a = porTicker.get(lc(o.ticker));
		const id = o.id as number | null;
		if (id == null || idsPrecio.has(id)) { err('id vacío o repetido'); continue; }
		if (!a) { err('ticker desconocido'); continue; }
		if (!esFecha(o.fecha) || !((o.precio as number) > 0)) { err('fecha o precio inválido'); continue; }
		const k = a.id + '|' + o.fecha;
		if (diaPrecio.has(k)) { err('precio repetido para el mismo día'); continue; }
		idsPrecio.add(id);
		diaPrecio.add(k);
		add('_precios', id, "INSERT INTO precio_historico (id, perfil_id, activo_id, fecha, precio, origen) VALUES (?,1,?,?,?,'manual')", [id, a.id, o.fecha, o.precio]);
	}
	// Precio de cada operación como cierre del día (lo que hace la carga manual de
	// Rienda con registrarPrecioTransaccion): solo llena huecos.
	for (const t of txOk)
		add('Activos', t.id, "INSERT OR IGNORE INTO precio_historico (perfil_id, activo_id, fecha, precio, origen) VALUES (1,?,?,?,'transaccion')", [t.activoId, t.fecha, t.precio]);

	// ----- Fotos de cartera -----
	const fechasFoto = new Set<string>();
	for (const o of d.fotos) {
		if (!esFecha(o.fecha) || fechasFoto.has(String(o.fecha)) || typeof o.valor_usd !== 'number') {
			avisos.push(`_fotos fila ${o._fila}: fecha repetida o valor inválido`);
			continue;
		}
		fechasFoto.add(String(o.fecha));
		add('_fotos', o.fecha, 'INSERT INTO snapshot (perfil_id, fecha, valor_usd, flujo_usd, dolar, valor_ars) VALUES (1,?,?,?,?,?)',
			[o.fecha, o.valor_usd, (o.flujo_usd as number | null) ?? 0, o.dolar ?? null, o.valor_ars ?? null]);
	}

	return stmts;
}

export function hayDatosInversiones(d: DatosInv): boolean {
	return d.activos.length + d.renta.length + d.caja.length > 0;
}
