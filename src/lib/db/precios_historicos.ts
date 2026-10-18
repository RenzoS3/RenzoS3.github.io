// src/lib/db/precios_historicos.ts
// Precio de cierre por activo por fecha (tabla precio_historico). Reemplaza el
// modelo de "precio_actual" que se pisa: acá la historia queda, así que
// corregir un movimiento viejo puede recalcular la historia hacia atrás.
//
// Dos responsabilidades separadas:
//   1) Completar la tabla: backfill de histórico data912 (backfillHistoricoActivo,
//      disparado al alta/edición en Configurar tickers) y el registro automático
//      del precio de una transacción propia (registrarPrecioTransaccion). El
//      logueo del panel en vivo y el refresco periódico (cada 20 min, con
//      recalc condicional) viven en precios.ts (Bloque 2: actualizarPrecios /
//      actualizarPreciosYFoto), que arma sus upserts con sqlUpsertPrecioHistorico
//      para respetar la misma regla de prioridad.
//   2) Leer un precio para una fecha con la cadena de respaldo (resolverPrecioEnFecha),
//      pensada para la valuación a fecha del Bloque 4.
//
// Prioridad al ESCRIBIR (de más a menos confiable): data912 > panel_vivo >
// transaccion. 'manual' es la corrección del usuario en Tenencia en montos y
// siempre gana. Por eso el upsert de un origen automático NUNCA pisa una fila
// 'manual' ya guardada (WHERE origen != 'manual'), y 'transaccion' nunca pisa
// nada (INSERT OR IGNORE): es el último recurso automático, solo llena huecos.

import { query, queryBatch } from './client';
import { BASE, ajustarEscala } from './data912';
// Import circular con cartera.ts (que a su vez importa resolverPrecioEnFecha de
// este archivo): funciona porque invalidarFotosDesde solo se usa DENTRO de una
// función async, nunca en la evaluación del módulo — ESM resuelve el ciclo por
// referencia en vivo. Se necesita acá porque backfillHistoricoActivo (abajo)
// tiene que invalidar las fotos que dependían del histórico que acaba de traer.
import { invalidarFotosDesde } from '../cartera';
import { cargarDolarSerie, dolarDeFecha } from '../moneda';
import { controlarEscala, ultimoPrecioConocido } from './escala';
import { parsearSplits, ajustarSerie } from './splits';

// Umbral del backfill de activos USD: si el último cierre de la serie bajada
// supera en más de 200x al precio de referencia del activo, la serie viene en
// pesos (data912 publica el histórico de las especies D en pesos, no en USD).
const UMBRAL_SERIE_EN_PESOS = 200;

// Tipo de activo -> slug del endpoint histórico de data912. ON y FCI no están:
// ON no tiene endpoint histórico propio (se loguea desde el panel en vivo, ver
// Bloque 2); FCI no tiene ninguna de las dos cosas (precio manual).
export const ENDPOINT_HISTORICO: Record<string, string> = {
	Accion: 'stocks',
	CEDEAR: 'cedears',
	// Los índices que se cargan en Rienda son CEDEARs en la práctica; el tipo
	// 'Indice' se deja intacto (Julián lo usa para agrupar por exposición al
	// riesgo), solo se lo apunta al mismo endpoint que CEDEAR.
	Indice: 'cedears',
	Bono: 'bonds'
};

export function tieneHistoricoData912(tipo: string): boolean {
	return tipo in ENDPOINT_HISTORICO;
}

export type PuntoHistorico = {
	fecha: string;
	precio: number;
	// Volumen NOCIONAL de la rueda (campo `v` de data912): es MONTO operado en la
	// moneda de cotización, no cantidad de papeles. Importa para leerlo: una barra
	// alta significa mucha plata movida, no muchos nominales. Opcional porque no
	// está garantizado que todos los endpoints lo publiquen.
	volumen?: number;
};

// Baja la serie completa de un símbolo desde el histórico de data912. Devuelve
// [] (no lanza) si el símbolo no tiene serie (típico: VIST, GLD, NU y otros
// activos que cotizan pero no están en el histórico) o si falla la conexión.
// Versión completa (con volumen), para el gráfico. El backfill que persiste en
// `precio_historico` usa el wrapper de abajo: esa tabla solo guarda precio.
export async function descargarSerieData912(simbolo: string, tipo: string): Promise<PuntoHistorico[]> {
	const endpoint = ENDPOINT_HISTORICO[tipo];
	if (!endpoint) return [];
	let data: any;
	try {
		const r = await fetch(`${BASE}/historical/${endpoint}/${encodeURIComponent(simbolo)}`);
		if (!r.ok) return [];
		data = await r.json();
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const out: PuntoHistorico[] = [];
	for (const fila of data) {
		const fecha = String(fila?.date ?? '').slice(0, 10);
		const c = Number(fila?.c);
		if (!fecha || !Number.isFinite(c) || c <= 0) continue;
		// Nombre del campo de volumen: 'v' es la convención OHLCV que sigue el resto
		// de la respuesta (o/h/l/c), pero se prueban también los alias habituales
		// por si el endpoint lo publica con otro nombre. Si no viene ninguno, el
		// punto queda sin volumen y la banda no se dibuja.
		const vRaw = fila?.v ?? fila?.volume ?? fila?.vol;
		const v = Number(vRaw);
		const p: PuntoHistorico = { fecha, precio: ajustarEscala(c, tipo) };
		if (Number.isFinite(v) && v >= 0) p.volumen = v;
		out.push(p);
	}
	// Rienda + Sheets: splits / cambios de ratio cargados en _activos (ver splits.ts).
	try {
		const r = (await query(
			"SELECT splits FROM activo WHERE perfil_id=1 AND splits IS NOT NULL AND TRIM(splits) <> '' AND (UPPER(simbolo_cotizacion)=UPPER(?) OR UPPER(ticker)=UPPER(?)) LIMIT 1",
			[simbolo, simbolo]
		)) as any[];
		const splits = parsearSplits(r[0]?.splits);
		if (splits.length) return ajustarSerie(out, splits);
	} catch {
		/* sin splits: la serie va tal cual */
	}
	return out;
}

// Wrapper histórico (solo fecha + precio), que es lo que persiste el backfill.
export async function descargarHistoricoData912(
	simbolo: string,
	tipo: string
): Promise<{ fecha: string; precio: number }[]> {
	const serie = await descargarSerieData912(simbolo, tipo);
	return serie.map((p) => ({ fecha: p.fecha, precio: p.precio }));
}

// Upsert de una fila. origen decide la regla de conflicto:
//  - 'manual'                 -> siempre pisa (corrección explícita del usuario).
//  - 'data912' | 'panel_vivo' -> pisan cualquier cosa, incluida una fila 'manual',
//                                SALVO que el activo no tenga símbolo de cotización.
//  - 'transaccion'            -> nunca pisa nada ya guardado (solo llena huecos).
//
// Sobre la excepción de 'manual': la corrección a mano existe para los activos que
// NO se actualizan solos (FCI y cualquiera sin `simbolo_cotizacion`), y como escape
// puntual si la fuente falla. Para todo lo que la API cubre, el valor de la API
// manda — es la misma regla que aplica `actualizarPrecios` sobre `precio_actual`.
// Antes 'manual' ganaba siempre acá, y eso dejaba las dos cosas en desacuerdo: la
// pantalla mostraba el precio de la API y la fila guardada de ese día conservaba la
// corrección para siempre, alimentando la valuación histórica con otro número.
//
// Exportada: el refresco de precios (Bloque 2) arma sus propios lotes con esta
// misma regla para no reimplementarla ni pagar N viajes por activo.
export function sqlUpsertPrecioHistorico(origen: string): string {
	if (origen === 'manual') {
		return `INSERT INTO precio_historico (perfil_id,activo_id,fecha,precio,origen) VALUES (1,?,?,?,?)
			ON CONFLICT(perfil_id,activo_id,fecha) DO UPDATE SET precio=excluded.precio, origen=excluded.origen`;
	}
	if (origen === 'transaccion') {
		return `INSERT OR IGNORE INTO precio_historico (perfil_id,activo_id,fecha,precio,origen) VALUES (1,?,?,?,?)`;
	}
	// data912 / panel_vivo: una fila 'manual' solo se respeta si ese activo no tiene
	// cobertura automática. Si la tiene, la fuente gana y la corrección se pisa.
	return `INSERT INTO precio_historico (perfil_id,activo_id,fecha,precio,origen) VALUES (1,?,?,?,?)
		ON CONFLICT(perfil_id,activo_id,fecha) DO UPDATE SET precio=excluded.precio, origen=excluded.origen
		WHERE precio_historico.origen != 'manual'
		   OR EXISTS (
		        SELECT 1 FROM activo a
		        WHERE a.id = precio_historico.activo_id AND a.perfil_id = precio_historico.perfil_id
		          AND a.simbolo_cotizacion IS NOT NULL AND TRIM(a.simbolo_cotizacion) <> ''
		      )`;
}

export async function upsertPrecioHistorico(
	activoId: number,
	fecha: string,
	precio: number,
	origen: 'data912' | 'panel_vivo' | 'transaccion' | 'manual'
): Promise<void> {
	if (!Number.isFinite(precio) || precio <= 0) return;
	// Control de escala (solo aviso): ANTES de escribir, para comparar contra el
	// último precio conocido y no contra el que se está por guardar.
	await controlarEscala(activoId, fecha, precio);
	await query(sqlUpsertPrecioHistorico(origen), [activoId, fecha, precio, origen]);
}

// Se llama al cargar una Compra/Venta en carga-inversiones: registra el precio
// de la propia operación como precio del día, SOLO si no había nada mejor ya
// guardado para esa fecha (INSERT OR IGNORE). Best-effort: nunca bloquea el
// guardado de la transacción si esto falla.
export async function registrarPrecioTransaccion(activoId: number, fecha: string, precio: number): Promise<void> {
	try {
		await upsertPrecioHistorico(activoId, fecha, precio, 'transaccion');
	} catch {
		/* no bloquear la carga de la operación por esto */
	}
}

// Backfill completo del histórico data912 de un activo (se dispara al darlo de
// alta con símbolo, o desde un refresco manual). Trae toda la serie disponible
// y la upsertea en lote. Devuelve cuántos puntos se guardaron, o null si el
// activo no tiene endpoint histórico (ON, FCI) o no hay símbolo configurado.
// invalidar=false (Rienda + Sheets): completar el histórico en un teléfono que no
// lo tenía guardado no cambia ninguna foto ya calculada en la Sheet.
export async function backfillHistoricoActivo(activoId: number, invalidar = true): Promise<number | null> {
	const rows = (await query(
		'SELECT tipo, simbolo_cotizacion, moneda FROM activo WHERE id=? AND perfil_id=1',
		[activoId]
	)) as any[];
	const a = rows[0];
	if (!a || !a.simbolo_cotizacion || !tieneHistoricoData912(a.tipo)) return null;

	let serie = await descargarHistoricoData912(a.simbolo_cotizacion, a.tipo);
	if (serie.length === 0) return 0;

	// Referencia para decidir la escala y para el control de salto (precio_actual,
	// o el último cierre guardado si no hay). Sin referencia: se guarda sin
	// convertir y no hay contra qué marcar.
	const ref = await ultimoPrecioConocido(activoId);
	const ultimo = serie.reduce((m, p) => (p.fecha > m.fecha ? p : m), serie[0]);

	// Activo en USD con la serie en escala pesos: cada punto se divide por el MEP
	// de su fecha (con arrastre). Los puntos anteriores al primer MEP cargado no
	// se pueden convertir y se descartan: guardarlos sin convertir sería peor.
	if (a.moneda === 'USD' && ref != null && ultimo.precio / ref > UMBRAL_SERIE_EN_PESOS) {
		const dolares = await cargarDolarSerie();
		const conv: { fecha: string; precio: number }[] = [];
		for (const p of serie) {
			const d = dolarDeFecha(dolares, p.fecha);
			if (d != null && d > 0) conv.push({ fecha: p.fecha, precio: p.precio / d });
		}
		serie = conv;
		if (serie.length === 0) return 0;
	}

	// Control de escala (solo aviso) sobre el último cierre, ya convertido si hizo
	// falta. Antes de escribir, para comparar contra lo que había.
	const ultimoFinal = serie.reduce((m, p) => (p.fecha > m.fecha ? p : m), serie[0]);
	await controlarEscala(activoId, ultimoFinal.fecha, ultimoFinal.precio, ref);

	const stmts = serie.map((p) => ({
		sql: sqlUpsertPrecioHistorico('data912'),
		bind: [activoId, p.fecha, p.precio, 'data912']
	}));
	await queryBatch(stmts);

	// Bloque A: cualquier foto guardada desde la fecha más antigua de esta serie
	// dependía del arrastre (o de la PPC) para este activo en esos días — ahora
	// que hay histórico real, hay que recalcularlas. Sin esto, backfillear un
	// activo viejo dejaba las fotos ya guardadas con el precio equivocado para
	// siempre (de ahí la migración única de reparación, ver repararFotosPPC en
	// cartera.ts). Best-effort: no bloquea el backfill si falla.
	const fechaMin = serie.reduce((min, p) => (p.fecha < min ? p.fecha : min), serie[0].fecha);
	if (invalidar) invalidarFotosDesde(fechaMin).catch(() => {});

	return serie.length;
}

export type PrecioResuelto = {
	precio: number;
	origen: string;
	fechaFuente: string; // fecha real de la que sale el valor (puede ser anterior a `fecha` si es arrastre)
	arrastrado: boolean;
};

// Cadena de respaldo para obtener el precio de un activo en una fecha, sin
// preguntarle nada al usuario:
//   1) Fila ya guardada en precio_historico para esa fecha exacta (viene de
//      data912, panel en vivo o corrección manual — lo que haya, con la
//      prioridad ya resuelta al escribir).
//   2) Precio de la propia transacción del usuario en esa fecha exacta (red
//      para operaciones cargadas antes de que existiera este registro
//      automático; las nuevas ya quedan cubiertas por (1) vía registrarPrecioTransaccion).
//   3) Arrastre: el último precio conocido (cualquier origen) anterior a esa fecha.
// Devuelve null si el activo no tiene ningún precio conocido en o antes de esa fecha.
//
// LÍMITE CONOCIDO (documentado, no implementado acá): cuando una ON amortiza
// capital, el arrastre debería descontar la amortización por unidad para no
// sobrevaluar lo que queda vivo. Calcularlo requiere saber la tenencia del
// activo A ESA FECHA (FIFO cortado, no el FIFO a hoy que existe hoy en
// cartera.ts) — esa pieza recién existe en el Bloque 4. Se retoma ahí.
export async function resolverPrecioEnFecha(activoId: number, fecha: string): Promise<PrecioResuelto | null> {
	const exacto = (await query(
		'SELECT precio, origen FROM precio_historico WHERE perfil_id=1 AND activo_id=? AND fecha=?',
		[activoId, fecha]
	)) as any[];
	if (exacto[0]) return { precio: exacto[0].precio, origen: exacto[0].origen, fechaFuente: fecha, arrastrado: false };

	const tx = (await query(
		"SELECT precio FROM transaccion WHERE perfil_id=1 AND activo_id=? AND fecha=? ORDER BY id DESC LIMIT 1",
		[activoId, fecha]
	)) as any[];
	if (tx[0]) return { precio: tx[0].precio, origen: 'transaccion', fechaFuente: fecha, arrastrado: false };

	const previo = (await query(
		'SELECT precio, origen, fecha FROM precio_historico WHERE perfil_id=1 AND activo_id=? AND fecha<? ORDER BY fecha DESC LIMIT 1',
		[activoId, fecha]
	)) as any[];
	if (previo[0]) {
		return { precio: previo[0].precio, origen: previo[0].origen, fechaFuente: previo[0].fecha, arrastrado: true };
	}
	return null;
}
