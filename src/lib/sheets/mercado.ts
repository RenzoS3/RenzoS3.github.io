// src/lib/sheets/mercado.ts
// Rienda + Sheets: lo que la app de inversiones hace sola al abrir, en segundo
// plano y sin bloquear nada (mismo espíritu que el arranque de Rienda):
//   1) recupera la copia de precios del teléfono (cacheMercado.ts),
//   2) actualiza precios y deja la foto del día (autoPrecios de +layout),
//   3) si a este teléfono le falta el histórico de data912 de algún activo que
//      operás, lo baja (primera vez, o iOS borró la copia),
//   4) si la Evolución de cartera no arranca en tu primer movimiento, completa
//      las fotos que faltan hacia atrás (una sola vez: después quedan en la Sheet),
//   5) retoma un recálculo de fotos que haya quedado cortado.

import { query } from '../db/client';
import { backfillHistoricoActivo, tieneHistoricoData912 } from '../db/precios_historicos';
import { reconstruirFotosDesdeInicio, retomarFotosPendientes } from '../cartera';
import { restaurarMercado, guardarMercado } from './cacheMercado';
import { hoyISO } from '../format';

let corriendo = false;

async function completarHistorico(): Promise<{ intentados: number; conDatos: number }> {
	const activos = (await query(
		`SELECT a.id, a.tipo,
		        (SELECT COUNT(*) FROM precio_historico p WHERE p.activo_id = a.id AND p.origen = 'data912') AS n
		 FROM activo a
		 WHERE a.perfil_id=1 AND a.simbolo_cotizacion IS NOT NULL AND TRIM(a.simbolo_cotizacion) <> ''
		   AND (EXISTS (SELECT 1 FROM transaccion t WHERE t.activo_id = a.id) OR EXISTS (SELECT 1 FROM renta_activo r WHERE r.activo_id = a.id))`
	)) as any[];
	let intentados = 0;
	let conDatos = 0;
	for (const a of activos) {
		if (!tieneHistoricoData912(a.tipo)) continue;
		if (a.n > 0) { conDatos++; continue; }
		intentados++;
		try {
			const n = await backfillHistoricoActivo(a.id, false);
			if (n && n > 0) conDatos++;
		} catch (e) {
			console.warn('[mercado] no se pudo bajar el histórico de', a.id, e);
		}
	}
	return { intentados, conDatos };
}

// La reconstrucción valúa cada día al dólar bolsa de ese día: hace falta que la
// serie cubra desde el primer movimiento (si no, se reintenta en otra apertura).
async function dolarCubreDesde(): Promise<boolean> {
	const r = (await query(
		`SELECT (SELECT MIN(fecha) FROM cotizacion_dolar WHERE perfil_id=1 AND casa='bolsa') AS d,
		        (SELECT COUNT(*) FROM cotizacion_dolar WHERE perfil_id=1 AND casa='bolsa') AS n,
		        (SELECT MIN(f) FROM (SELECT MIN(fecha) AS f FROM transaccion UNION ALL SELECT MIN(fecha) FROM mov_caja UNION ALL SELECT MIN(fecha) FROM renta_activo)) AS p`
	)) as any[];
	const { d, n, p } = r[0] ?? {};
	if (!p) return true;
	// Serie diaria (no la mensual de arranque) que arranque a lo sumo 10 días después.
	return !!d && n > 300 && Date.parse(d) <= Date.parse(p) + 10 * 86400000;
}

export async function arrancarInversiones(
	autoPrecios: () => Promise<void>,
	dolarListo?: Promise<unknown>,
	opciones: { reconstruir?: boolean } = {}
): Promise<void> {
	if (corriendo) return;
	corriendo = true;
	try {
		try { await restaurarMercado(); } catch (e) { console.warn('[mercado] copia de precios ilegible', e); }
		await autoPrecios();
		const h = await completarHistorico();
		if (h.intentados) await guardarMercado();
		// Sin ningún histórico de mercado (sin señal, data912 caída) la reconstrucción
		// valuaría con precios de compra: se deja para la próxima apertura.
		try { await dolarListo; } catch { /* sigue con el dólar guardado */ }
		if (opciones.reconstruir !== false && (h.conDatos > 0 || h.intentados === 0) && (await dolarCubreDesde())) {
			const n = await reconstruirFotosDesdeInicio(hoyISO());
			if (n) console.info(`[mercado] historial reconstruido: ${n} fotos`);
		}
		await retomarFotosPendientes();
	} catch (e) {
		console.error('[mercado] arranque de inversiones', e);
	} finally {
		corriendo = false;
	}
}
