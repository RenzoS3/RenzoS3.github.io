// src/lib/sheets/cacheMercado.ts
// Rienda + Sheets: copia en el teléfono de los precios de mercado.
//
// El histórico de data912 y los cierres del panel en vivo se pueden volver a
// bajar cuando sea, así que no van a la Sheet (serían miles de filas). Se guardan
// en el teléfono para no bajarlos en cada apertura; si iOS borra esta copia, la
// app los vuelve a traer sola (ver mercado.ts). Lo que el usuario corrige a mano
// (origen 'manual') sí viaja a la Sheet, en la pestaña _precios.

import { query, queryBatch } from '../db/client';
import { sqlUpsertPrecioHistorico } from '../db/precios_historicos';

const LS = 'rienda_sheets_mercado';
const ORIGENES = ['data912', 'panel_vivo'];

type Copia = { v: 1; ts: string; precios: Record<string, [string, number, string][]>; actualizados?: string | null };

export async function guardarMercado(): Promise<void> {
	try {
		const rows = (await query(
			`SELECT a.ticker, p.fecha, p.precio, p.origen FROM precio_historico p JOIN activo a ON a.id = p.activo_id
			 WHERE p.perfil_id=1 AND p.origen IN (${ORIGENES.map(() => '?').join(',')}) ORDER BY a.ticker, p.fecha`,
			ORIGENES
		)) as any[];
		const precios: Copia['precios'] = {};
		for (const r of rows) (precios[r.ticker] ??= []).push([r.fecha, r.precio, r.origen === 'data912' ? 'd' : 'p']);
		// Cuándo se actualizaron los precios por última vez (lo muestra Tenencia y
		// gobierna el refresco de 20 min); es un dato de este teléfono.
		const m = (await query("SELECT valor FROM meta WHERE clave='precios_actualizados_en'")) as any[];
		localStorage.setItem(LS, JSON.stringify({ v: 1, ts: new Date().toISOString(), precios, actualizados: m[0]?.valor ?? null } satisfies Copia));
	} catch (e) {
		console.warn('[mercado] no se pudo guardar la copia de precios', e);
	}
}

// Vuelve a cargar la copia en la base. Devuelve cuántos precios restauró.
export async function restaurarMercado(): Promise<number> {
	let copia: Copia | null = null;
	try { copia = JSON.parse(localStorage.getItem(LS) ?? 'null'); } catch { /* copia corrupta */ }
	if (!copia?.precios) return 0;
	const activos = (await query('SELECT id, ticker FROM activo WHERE perfil_id=1')) as any[];
	const idDe = new Map<string, number>(activos.map((a) => [a.ticker, a.id]));
	const stmts: { sql: string; bind: unknown[] }[] = [];
	for (const [ticker, filas] of Object.entries(copia.precios)) {
		const id = idDe.get(ticker);
		if (id == null) continue;
		for (const [fecha, precio, o] of filas) {
			const origen = o === 'd' ? 'data912' : 'panel_vivo';
			stmts.push({ sql: sqlUpsertPrecioHistorico(origen), bind: [id, fecha, precio, origen] });
		}
	}
	if (copia.actualizados)
		stmts.push({ sql: "INSERT OR IGNORE INTO meta (clave, valor) VALUES ('precios_actualizados_en', ?)", bind: [copia.actualizados] });
	if (stmts.length) await queryBatch(stmts);
	return stmts.length;
}
