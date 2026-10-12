// src/lib/db/cotizaciones.ts
// Cotización del dólar e inflación. Dos fuentes, dos cadencias, mismo autor
// (bajo riesgo de discontinuidad):
//   - DolarApi.com: solo el valor de HOY, liviano, se cuelga del mismo gatillo
//     de 20 min que actualizarPrecios (ver actualizarPreciosYFoto en precios.ts).
//     No tiene serie histórica, por eso no reemplaza a ArgentinaDatos.
//   - ArgentinaDatos: serie histórica completa del dólar + inflación, pesado
//     (2 fetches + reemplazo de tabla), se queda en su cadencia actual de
//     ~1x/día (ver autoCotizaciones en +layout.svelte), nunca colgado del
//     gatillo de 20 min.
// Regla entre escritores de cotizacion_dolar: HOY lo escribe siempre DolarApi.com
// (upsert de una sola fila); todo lo anterior a hoy lo escribe siempre el resync
// de ArgentinaDatos, que trae la serie completa y de paso ya revisa los últimos
// días — no hace falta gap-detection aparte.

import { queryBatch } from './client';
import { setMeta } from './meta';
import { hoyISO } from '../format';
import { guardarMacro } from '../sheets/sync.svelte';

const URL_DOLARAPI = 'https://dolarapi.com/v1/dolares';
const URL_DOLARES = 'https://api.argentinadatos.com/v1/cotizaciones/dolares';
const URL_INFLACION = 'https://api.argentinadatos.com/v1/finanzas/indices/inflacion';

// Casas que nos interesan. 'bolsa' es el MEP (referencia real); 'oficial' para el spread.
const CASAS = ['bolsa', 'oficial'];

// ===== Liviano: cotización de HOY (DolarApi.com) =====
// Escribe SOLO la fila de hoy por casa (upsert), sin tocar el resto de la serie.
// La hora de esta corrida queda en meta (dolar_actualizado_en) — la columna
// `fecha` de cotizacion_dolar no se toca, sigue siendo un valor por día para no
// romper las consultas históricas (poder adquisitivo, evolución).
export async function actualizarDolar(): Promise<string> {
	const fecha = hoyISO();
	const resultados = await Promise.allSettled(
		CASAS.map((casa) =>
			fetch(`${URL_DOLARAPI}/${casa}`).then(async (r) => {
				if (!r.ok) throw new Error('HTTP ' + r.status);
				const d = await r.json();
				return { casa, venta: Number(d?.venta) };
			})
		)
	);

	const ok: string[] = [];
	const stmts: { sql: string; bind?: unknown[] }[] = [];
	for (const r of resultados) {
		if (r.status !== 'fulfilled' || !(r.value.venta > 0)) continue;
		stmts.push({
			sql: `INSERT INTO cotizacion_dolar (perfil_id, casa, fecha, valor) VALUES (1, ?, ?, ?)
				ON CONFLICT(perfil_id, casa, fecha) DO UPDATE SET valor=excluded.valor`,
			bind: [r.value.casa, fecha, r.value.venta]
		});
		ok.push(r.value.casa);
	}
	if (stmts.length === 0) {
		throw new Error('No se pudo conectar con DolarApi.com (¿sin internet o API caída?).');
	}

	await queryBatch(stmts);
	await setMeta('dolar_actualizado_en', new Date().toISOString());
	await guardarMacro(); // Rienda + Sheets: queda en el teléfono para la próxima apertura

	return `Dólar actualizado ✅ (${ok.join(', ')})`;
}

// ===== Pesado: serie histórica del dólar + inflación (ArgentinaDatos) =====
// Reemplazo limpio de ambas tablas, igual que antes. Queda en su cadencia de
// ~1x/día — ver autoCotizaciones en +layout.svelte, que ahora chequea la
// frescura contra meta (cotizaciones_resync_en) en vez de MAX(fecha) de
// cotizacion_dolar (esa columna ya se actualiza a diario vía actualizarDolar,
// así que dejaría de servir como señal de "cuándo corrió el resync pesado").
export async function actualizarInflacionYHistorico(): Promise<string> {
	// ===== 1) DÓLAR (serie completa) =====
	let datos: any[];
	try {
		const resp = await fetch(URL_DOLARES);
		if (!resp.ok) throw new Error('HTTP ' + resp.status);
		datos = await resp.json();
	} catch (e: any) {
		throw new Error('No se pudo conectar con la API de dólar: ' + (e?.message ?? e));
	}
	if (!Array.isArray(datos) || datos.length === 0) {
		throw new Error('La API de dólar no devolvió datos.');
	}

	const casasDisponibles = [...new Set(datos.map((d) => d.casa))].sort();
	console.log('[cotizaciones] Casas disponibles en la API:', casasDisponibles);

	const filtrados = datos.filter((d) => CASAS.includes(d.casa) && d.fecha && d.venta > 0);
	if (filtrados.length === 0) {
		throw new Error(
			'No se encontraron datos para las casas ' + CASAS.join(', ') +
			'. Casas disponibles: ' + casasDisponibles.join(', ')
		);
	}

	// ===== 2) INFLACIÓN =====
	let inflacion: any[];
	try {
		const resp = await fetch(URL_INFLACION);
		if (!resp.ok) throw new Error('HTTP ' + resp.status);
		inflacion = await resp.json();
	} catch (e: any) {
		throw new Error('No se pudo conectar con la API de inflación: ' + (e?.message ?? e));
	}
	// La API da fecha fin de mes (2025-09-30) y valor en % (2.1). Convertimos a
	// periodo 'YYYY-MM' y a decimal (2.1 -> 0.021) para respetar la convención local.
	const inflFiltrada = (Array.isArray(inflacion) ? inflacion : [])
		.filter((x) => x.fecha && typeof x.valor === 'number')
		.map((x) => ({ periodo: x.fecha.slice(0, 7), valor: x.valor / 100 }));

	// ===== 3) GUARDAR (reemplazo limpio, un solo lote atómico al worker) =====
	const stmts: { sql: string; bind?: unknown[] }[] = [];
	for (const casa of CASAS) {
		stmts.push({ sql: 'DELETE FROM cotizacion_dolar WHERE perfil_id=1 AND casa=?', bind: [casa] });
	}
	for (const d of filtrados) {
		stmts.push({
			sql: 'INSERT OR IGNORE INTO cotizacion_dolar (perfil_id, casa, fecha, valor) VALUES (1, ?, ?, ?)',
			bind: [d.casa, d.fecha, d.venta]
		});
	}
	stmts.push({ sql: 'DELETE FROM inflacion WHERE perfil_id=1' });
	for (const i of inflFiltrada) {
		stmts.push({
			sql: 'INSERT OR IGNORE INTO inflacion (perfil_id, periodo, valor) VALUES (1, ?, ?)',
			bind: [i.periodo, i.valor]
		});
	}
	try {
		await queryBatch(stmts);
	} catch (e: any) {
		throw new Error('Falló al guardar, no se modificó nada: ' + (e?.message ?? e));
	}
	await setMeta('cotizaciones_resync_en', new Date().toISOString());
	await guardarMacro(); // Rienda + Sheets

	const porCasa = CASAS.map((c) => `${c}: ${filtrados.filter((d) => d.casa === c).length}`).join(' · ');
	return `Actualizado ✅ Dólar (${porCasa}) · Inflación: ${inflFiltrada.length} meses`;
}

// ===== Combinado: dólar de hoy + histórico/inflación, una detrás de otra. Lo
// usa el botón manual "Actualizar tipo de cambio" del menú hamburguesa y el
// centro de notificaciones — sigue llamando a ambas, como antes de separarlas. =====
export async function actualizarCotizaciones(): Promise<string> {
	const msgDolar = await actualizarDolar();
	const msgHist = await actualizarInflacionYHistorico();
	return `${msgDolar} · ${msgHist}`;
}
