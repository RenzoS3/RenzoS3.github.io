// src/lib/cartera.ts
// Cálculos compartidos entre Inversiones y Evolución: FIFO de lotes,
// ganancia realizada, liquidez y foto de cartera.
// UNA sola implementación para que las dos pantallas siempre den los mismos números.

import { query } from './db/client';
import { resolverPrecioEnFecha } from './db/precios_historicos';
import { cargarDolarSerie, dolarDeFecha } from './moneda';
import { fechaISO } from './format';
import { fotosProgreso } from './fotos.svelte';

export type Lote = { u: number; pNat: number; pUSD: number };

// Convierte un monto a USD usando el valor dólar de la operación.
export const aUSD = (monto: number, moneda: string, valorDolar: number | null): number =>
	moneda === 'USD' ? monto : valorDolar ? monto / valorDolar : 0;

// Último dólar bolsa conocido.
export async function dolarActual(): Promise<number> {
	const r = (await query(
		"SELECT valor FROM cotizacion_dolar WHERE perfil_id=1 AND casa='bolsa' ORDER BY fecha DESC LIMIT 1"
	)) as any[];
	return r[0]?.valor ?? 1;
}

// Recorre todas las transacciones con método FIFO y devuelve:
//   lotes:                 lo que queda en tenencia por activo (unidades + precio de compra)
//   realPorMes:            ganancia realizada por mes (USD), TODAS las ventas (para Evolución)
//   realizadoCerradoPorMes: ganancia realizada por mes (USD), SOLO de ciclos que volvieron a 0
//                          (para no duplicar con "Resultado Posiciones Abiertas": la venta parcial
//                          de una posición que seguís teniendo ya está adentro de ese cálculo)
//   episodioDesde:         fecha de inicio del episodio vivo por activo (última compra después de
//                          volver a 0, o la primera compra de todas). Si el activo terminó en 0,
//                          apunta al último episodio (que ya está cerrado) — quien lo use debe
//                          chequear la tenencia final antes de tratarlo como "abierto".
//   aMap:                  mapa id -> activo (nombre, tipo, renta, moneda, precio_actual)
//
// fechaCorte (Bloque 4, opcional): si se pasa, el FIFO se corta ahí — solo
// procesa transacciones con fecha <= fechaCorte, para poder valuar la cartera
// "como estaba" en cualquier día pasado (calcularValuacionEnFecha). Sin
// argumento, se comporta exactamente igual que antes (todas las transacciones,
// tenencia a hoy) — los llamados existentes no cambian.
export async function calcularFIFO(fechaCorte?: string): Promise<{
	lotes: Record<number, Lote[]>;
	realPorMes: Record<string, number>;
	realizadoCerradoPorMes: Record<string, number>;
	episodioDesde: Record<number, string>;
	aMap: Record<number, any>;
	txs: any[];
}> {
	const activos = (await query(
		'SELECT id, nombre, tipo, renta, moneda, precio_actual, exposicion FROM activo WHERE perfil_id=1'
	)) as any[];
	const aMap: Record<number, any> = {};
	for (const a of activos) aMap[a.id] = a;

	const txs = (await query(
		'SELECT activo_id, operacion, unidades, precio, fecha, valor_dolar FROM transaccion WHERE perfil_id=1' +
			(fechaCorte ? ' AND fecha <= ?' : '') +
			' ORDER BY activo_id, fecha, id',
		fechaCorte ? [fechaCorte] : []
	)) as any[];

	const lotes: Record<number, Lote[]> = {};
	const realPorMes: Record<string, number> = {};
	const realizadoCerradoPorMes: Record<string, number> = {};
	// Ganancia acumulada del episodio EN CURSO (todavía no se sabe si va a cerrar);
	// se vuelca a realizadoCerradoPorMes recién cuando la tenencia vuelve a 0, y se
	// descarta del acumulado "cerrado" si al final del recorrido sigue abierta.
	const pendienteAbierto: Record<number, Record<string, number>> = {};
	const episodioDesde: Record<number, string> = {};

	for (const t of txs) {
		const a = aMap[t.activo_id];
		lotes[t.activo_id] ??= [];
		if (t.operacion === 'Compra') {
			if (lotes[t.activo_id].length === 0) episodioDesde[t.activo_id] = t.fecha;
			lotes[t.activo_id].push({ u: t.unidades, pNat: t.precio, pUSD: aUSD(t.precio, a.moneda, t.valor_dolar) });
		} else {
			let rem = t.unidades;
			const pvUSD = aUSD(t.precio, a.moneda, t.valor_dolar);
			const mes = t.fecha.slice(0, 7);
			const q = lotes[t.activo_id];
			while (rem > 1e-9 && q.length) {
				const lote = q[0];
				const take = Math.min(rem, lote.u);
				const gain = take * (pvUSD - lote.pUSD);
				realPorMes[mes] = (realPorMes[mes] ?? 0) + gain;
				const pend = (pendienteAbierto[t.activo_id] ??= {});
				pend[mes] = (pend[mes] ?? 0) + gain;
				lote.u -= take;
				rem -= take;
				if (lote.u < 1e-9) q.shift();
			}
			// Posición cerrada del todo: el episodio recién terminado pasa a "cerrado".
			if (q.length === 0) {
				const pend = pendienteAbierto[t.activo_id];
				if (pend) {
					for (const [m, v] of Object.entries(pend)) realizadoCerradoPorMes[m] = (realizadoCerradoPorMes[m] ?? 0) + v;
					delete pendienteAbierto[t.activo_id];
				}
			}
		}
	}
	return { lotes, realPorMes, realizadoCerradoPorMes, episodioDesde, aMap, txs };
}

// Saldos líquidos por moneda: SOLO movimientos de caja (Ingreso/Retiro/
// Convertir/Apertura) + efecto caja de compras/ventas (monto_pago de
// transaccion) + renta/amortización cobrada. Bloque 3: se eliminó el ancla
// manual de `liquidez` — esa tabla ya no se lee acá. La caja cambia
// únicamente por movimientos; el saldo que tenía el ancla se migró una vez a
// un mov_caja de apertura (ver worker.ts, flag 'liquidez_migrada_v1').
//
// fechaCorte (Bloque 4, opcional): mismo criterio que calcularFIFO — sin
// argumento, se comporta igual que antes (todo el historial, saldo a hoy).
export async function calcularLiquidez(fechaCorte?: string): Promise<Record<string, number>> {
	const corte = fechaCorte ? ' AND fecha <= ?' : '';
	const bindCorte = fechaCorte ? [fechaCorte] : [];
	const movc = (await query(
		'SELECT moneda, COALESCE(SUM(monto),0) s FROM mov_caja WHERE perfil_id=1' + corte + ' GROUP BY moneda',
		bindCorte
	)) as any[];
	const tcash = (await query(
		"SELECT moneda_pago m, COALESCE(SUM(CASE WHEN operacion='Venta' THEN monto_pago ELSE -monto_pago END),0) s FROM transaccion WHERE perfil_id=1 AND monto_pago IS NOT NULL" + corte + ' GROUP BY moneda_pago',
		bindCorte
	)) as any[];
	// Renta y amortización cobradas: entran a liquidez en la moneda reportada
	// (mismo efecto caja que una venta; sin reconvertir).
	const rcash = (await query(
		'SELECT moneda m, COALESCE(SUM(monto_renta + monto_amort),0) s FROM renta_activo WHERE perfil_id=1' + corte + ' GROUP BY moneda',
		bindCorte
	)) as any[];
	const bal: Record<string, number> = { ARS: 0, USD: 0 };
	for (const r of movc) bal[r.moneda] = (bal[r.moneda] ?? 0) + r.s;
	for (const r of tcash) if (r.m) bal[r.m] = (bal[r.m] ?? 0) + r.s;
	for (const r of rcash) if (r.m) bal[r.m] = (bal[r.m] ?? 0) + r.s;
	return bal;
}

// Valor total de la cartera en USD (tenencias a precio actual + liquidez) y
// flujo neto de Ingresos/Retiros desde la última foto. Base de "Guardar foto".
// Si un activo no tiene precio_actual, usa su PPC (precio promedio de compra).
export async function calcularFoto(): Promise<{
	dolar: number;
	valorUSD: number;
	valorARS: number;
	flujo: number;
}> {
	const dolar = await dolarActual();
	const { lotes, aMap } = await calcularFIFO();

	let valorUSD = 0;
	for (const [aid, q] of Object.entries(lotes)) {
		const u = q.reduce((s, l) => s + l.u, 0);
		if (u < 1e-6) continue;
		const a = aMap[Number(aid)];
		const costo = q.reduce((s, l) => s + l.u * l.pNat, 0);
		const pa = a.precio_actual ?? costo / u;
		const mercado = u * pa;
		valorUSD += a.moneda === 'USD' ? mercado : mercado / dolar;
	}

	const liq = await calcularLiquidez();
	valorUSD += (liq.USD ?? 0) + (liq.ARS ?? 0) / dolar;

	const ult = (await query('SELECT fecha FROM snapshot WHERE perfil_id=1 ORDER BY fecha DESC LIMIT 1')) as any[];
	const ultFecha = ult[0]?.fecha ?? '2000-01-01';
	const fl = (await query(
		"SELECT COALESCE(SUM(CASE WHEN moneda='USD' THEN monto ELSE monto/? END),0) AS f FROM mov_caja WHERE perfil_id=1 AND accion IN ('Ingreso','Retiro') AND fecha > ?",
		[dolar, ultFecha]
	)) as any[];
	const flujo = Math.round((fl[0]?.f ?? 0) * 100) / 100;

	return { dolar, valorUSD, valorARS: valorUSD * dolar, flujo };
}

// Inserta/actualiza la foto del día en snapshot (upsert por fecha).
export async function guardarSnapshot(
	fecha: string,
	valorUSD: number,
	flujo: number,
	dolar: number,
	valorARS: number
): Promise<void> {
	await query(
		'INSERT INTO snapshot (perfil_id,fecha,valor_usd,flujo_usd,dolar,valor_ars) VALUES (1,?,?,?,?,?) ON CONFLICT(perfil_id,fecha) DO UPDATE SET valor_usd=excluded.valor_usd, flujo_usd=excluded.flujo_usd, dolar=excluded.dolar, valor_ars=excluded.valor_ars',
		[fecha, valorUSD, flujo, dolar, valorARS]
	);
}

// Bloque 4 — Fecha de corte del modelo de valuación derivado: se fija UNA vez
// (worker.ts, junto con la migración de liquidez del Bloque 3) al día en que
// esta base corrió por primera vez el código nuevo. Las fotos (snapshot)
// ANTERIORES a esa fecha son reserva fija — nunca se recalculan, se leen tal
// cual quedaron. De esa fecha en adelante rige el modelo derivado: precio vía
// precio_historico (Bloque 1), tenencia vía FIFO cortado, liquidez vía ledger.
export async function fechaCorteRearquitectura(): Promise<string | null> {
	const r = (await query("SELECT valor FROM meta WHERE clave='fecha_corte_rearquitectura'")) as any[];
	return r[0]?.valor ?? null;
}

// Valor de la cartera "como estaba" en una fecha pasada: tenencia vía FIFO
// cortado a esa fecha, precio de cada activo vía la cadena de respaldo del
// Bloque 1 (precio_historico → transacción propia → arrastre; si el activo no
// tiene NINGÚN precio conocido en o antes de esa fecha, se usa su PPC de ese
// momento como último recurso — mismo criterio que calcularFoto hoy), liquidez
// vía el ledger cortado a esa fecha, y MEP de esa fecha (o el último anterior).
// Rienda + Sheets: mientras se reconstruyen cientos de fotos seguidas, la serie
// del dólar se lee una sola vez (no cambia en el medio).
let serieDolarFija: Awaited<ReturnType<typeof cargarDolarSerie>> | null = null;

export async function calcularValuacionEnFecha(fecha: string): Promise<{
	dolar: number;
	valorUSD: number;
	valorARS: number;
}> {
	const serieDolar = serieDolarFija ?? (await cargarDolarSerie());
	const dolar = dolarDeFecha(serieDolar, fecha) ?? (await dolarActual());

	const { lotes, aMap } = await calcularFIFO(fecha);
	let valorUSD = 0;
	for (const [aid, q] of Object.entries(lotes)) {
		const u = q.reduce((s, l) => s + l.u, 0);
		if (u < 1e-6) continue;
		const a = aMap[Number(aid)];
		const resuelto = await resolverPrecioEnFecha(Number(aid), fecha);
		const costo = q.reduce((s, l) => s + l.u * l.pNat, 0);
		const pa = resuelto?.precio ?? costo / u;
		const mercado = u * pa;
		valorUSD += a.moneda === 'USD' ? mercado : mercado / dolar;
	}

	const liq = await calcularLiquidez(fecha);
	valorUSD += (liq.USD ?? 0) + (liq.ARS ?? 0) / dolar;

	return { dolar, valorUSD, valorARS: valorUSD * dolar };
}

// Recalcula y guarda (upsert in-place, MISMA fecha) la foto de UNA fecha ya
// existente en snapshot: valuación derivada (calcularValuacionEnFecha) +
// flujo_usd (ventana entre la foto anterior — la que sea, recalculada o
// vieja — y esta, por si en esa ventana hubo un Ingreso/Retiro). Pieza interna
// compartida entre invalidarFotosDesde, completarFotosFaltantes y la
// reparación única (repararFotosPPC) — así las tres calculan flujo_usd
// exactamente igual, en vez de reimplementar la ventana cada vez.
export async function recalcularYGuardarFoto(fecha: string): Promise<void> {
	const v = await calcularValuacionEnFecha(fecha);

	const anterior = (await query(
		'SELECT MAX(fecha) AS f FROM snapshot WHERE perfil_id=1 AND fecha < ?',
		[fecha]
	)) as any[];
	const fechaAnterior = anterior[0]?.f ?? '2000-01-01';
	const fl = (await query(
		"SELECT COALESCE(SUM(CASE WHEN moneda='USD' THEN monto ELSE monto/? END),0) AS f FROM mov_caja WHERE perfil_id=1 AND accion IN ('Ingreso','Retiro') AND fecha > ? AND fecha <= ?",
		[v.dolar, fechaAnterior, fecha]
	)) as any[];
	const flujo = Math.round((fl[0]?.f ?? 0) * 100) / 100;

	await guardarSnapshot(fecha, v.valorUSD, flujo, v.dolar, v.valorARS);
}

// Bloque 4/B — invalidación del caché de fotos: se llama después de cargar,
// editar o borrar una transacción, movimiento de caja o renta/amortización con
// fecha pasada. Recalcula todas las fotos ya guardadas en snapshot desde
// fechaEditada en adelante. No crea fotos nuevas: solo corrige las que ya
// existían, con los datos que cambiaron. No toca la fórmula del TWR (eso vive
// en /evolucion): esto solo corrige los insumos que esa fórmula lee.
//
// Bloque B: ya NO se limita a fecha >= fecha_corte_rearquitectura. Esa fecha
// de corte congelaba las fotos anteriores como "reserva fija" (modelo de
// liquidez con ancla manual); con el ancla eliminada, toda foto es un caché
// reconstruible y se recalcula si su fecha cae en el rango editado.
//
// Marca de pendiente (meta 'fotos_pendientes_desde'): antes de recalcular se
// guarda la fecha más antigua que quedó por recalcular (mínimo entre la marca
// actual y la fecha editada) y recién se borra cuando el barrido terminó sin
// error. Si la pestaña se cierra o iOS la mata a mitad de camino, la marca
// queda y retomarFotosPendientes() la retoma al arrancar. Se recalcula siempre
// desde la marca (no solo desde fechaEditada), así una corrida interrumpida
// anterior también queda cubierta.
const CLAVE_FOTOS_PENDIENTES = 'fotos_pendientes_desde';
const LOTE_FOTOS = 15; // fotos por lote antes de ceder el hilo a la UI
// Por debajo de este total no vale la pena mostrar el indicador (parpadearía en
// cada carga de una operación reciente).
export const MIN_FOTOS_INDICADOR = LOTE_FOTOS;

async function leerMarcaFotos(): Promise<string | null> {
	const r = (await query('SELECT valor FROM meta WHERE clave=?', [CLAVE_FOTOS_PENDIENTES])) as any[];
	return r[0]?.valor ?? null;
}

// Fija la marca en min(valor actual, f). Devuelve la marca resultante. La usan
// invalidarFotosDesde y los importadores (JSON / Excel).
export async function marcarFotosPendientesDesde(f: string): Promise<string> {
	const actual = await leerMarcaFotos();
	const min = actual && actual < f ? actual : f;
	if (min !== actual) {
		await query(
			'INSERT INTO meta (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor',
			[CLAVE_FOTOS_PENDIENTES, min]
		);
	}
	return min;
}

export async function invalidarFotosDesde(fechaEditada: string): Promise<void> {
	const desde = await marcarFotosPendientesDesde(fechaEditada);
	const fechas = (await query(
		'SELECT fecha FROM snapshot WHERE perfil_id=1 AND fecha >= ? ORDER BY fecha ASC',
		[desde]
	)) as any[];
	const mostrar = fechas.length >= MIN_FOTOS_INDICADOR;
	if (mostrar) fotosProgreso.iniciar(fechas.length);
	try {
		for (let i = 0; i < fechas.length; i++) {
			await recalcularYGuardarFoto(fechas[i].fecha);
			if (mostrar) fotosProgreso.avanzar();
			// Cede el hilo entre lotes (iOS: un loop largo sin ceder puede colgar Safari).
			if ((i + 1) % LOTE_FOTOS === 0) await new Promise((r) => setTimeout(r, 0));
		}
	} finally {
		if (mostrar) fotosProgreso.terminar();
	}
	// Terminó sin error: se borra la marca, salvo que mientras tanto haya entrado
	// una fecha anterior a la que acabamos de cubrir (otra edición/importación).
	const marca = await leerMarcaFotos();
	if (marca != null && marca >= desde) {
		await query('DELETE FROM meta WHERE clave=?', [CLAVE_FOTOS_PENDIENTES]);
	}
}

// Al arrancar la app (después de abrir la base, sin bloquear el inicio): si quedó
// una marca de pendiente, retoma el recálculo desde esa fecha. Idempotente y sin
// reentrada.
let retomandoFotos = false;
export async function retomarFotosPendientes(): Promise<void> {
	if (retomandoFotos) return;
	const marca = await leerMarcaFotos();
	if (!marca) return;
	retomandoFotos = true;
	try {
		await invalidarFotosDesde(marca);
	} finally {
		retomandoFotos = false;
	}
}

// Bloque A — completa las fotos de los días faltantes entre la última
// guardada y `hastaExcluyendo` (sin incluirla: ese día se guarda aparte, con
// el precio recién actualizado, más preciso que calcularValuacionEnFecha).
// Sin esto, una ventana de rendimiento podía no tener contra qué comparar si
// pasaron días sin que corriera el auto-refresh (± la app cerrada varios
// días). Si todavía no hay NINGUNA foto guardada, no hay "faltantes" que
// completar — la serie arranca con la próxima foto que se guarde. Devuelve
// cuántos días completó.
export async function completarFotosFaltantes(hastaExcluyendo: string): Promise<number> {
	const ultima = (await query('SELECT MAX(fecha) AS f FROM snapshot WHERE perfil_id=1')) as any[];
	const desde = ultima[0]?.f ?? null;
	if (!desde) return 0;

	let cursor = new Date(desde + 'T00:00:00');
	cursor.setDate(cursor.getDate() + 1);
	const limite = new Date(hastaExcluyendo + 'T00:00:00');
	let n = 0;
	while (cursor < limite) {
		const f = fechaISO(cursor); // local, no UTC — mismo helper que hoyISO()
		await recalcularYGuardarFoto(f);
		n++;
		cursor.setDate(cursor.getDate() + 1);
	}
	return n;
}

// Rienda + Sheets — reconstrucción del historial: completa una foto por día
// desde el primer movimiento hasta la foto más vieja que ya exista (o hasta
// `hasta`, inclusive, si todavía no hay ninguna). Es lo que la app habría
// guardado si se hubiera usado todos los días desde entonces: misma valuación
// que el recálculo (calcularValuacionEnFecha). Idempotente: si la serie ya
// arranca en el primer movimiento, no hace nada. Devuelve cuántas fotos armó.
let reconstruyendo = false;
export async function reconstruirFotosDesdeInicio(hasta: string): Promise<number> {
	if (reconstruyendo) return 0;
	const primer = await fechaPrimerMovimiento();
	if (!primer) return 0;
	const r = (await query('SELECT MIN(fecha) AS f FROM snapshot WHERE perfil_id=1')) as any[];
	const minFoto: string | null = r[0]?.f ?? null;
	if (minFoto && minFoto <= primer) return 0;
	const fin = minFoto ?? hasta;
	const dias: string[] = [];
	const cursor = new Date(primer + 'T00:00:00');
	for (;;) {
		const f = fechaISO(cursor);
		if (minFoto ? f >= fin : f > fin) break;
		dias.push(f);
		cursor.setDate(cursor.getDate() + 1);
	}
	if (!dias.length) return 0;
	reconstruyendo = true;
	fotosProgreso.iniciar(dias.length);
	try {
		serieDolarFija = await cargarDolarSerie();
		for (let i = 0; i < dias.length; i++) {
			await recalcularYGuardarFoto(dias[i]);
			fotosProgreso.avanzar();
			if ((i + 1) % LOTE_FOTOS === 0) await new Promise((res) => setTimeout(res, 0));
		}
		// La foto que ya existía calculó su flujo contra "nada antes": ahora tiene
		// una foto el día anterior, así que se recalcula con la ventana correcta.
		if (minFoto) await recalcularYGuardarFoto(minFoto);
	} finally {
		serieDolarFija = null;
		fotosProgreso.terminar();
		reconstruyendo = false;
	}
	return dias.length;
}

// Primera fecha con un movimiento REAL en la cuenta (transacción, movimiento
// de caja o renta/amortización) — antes de esa fecha no hay nada que calcular,
// cualquier foto ahí es un artefacto, nunca un valor real de cartera. null si
// todavía no hay ningún movimiento cargado.
async function fechaPrimerMovimiento(): Promise<string | null> {
	const r = (await query(
		`SELECT MIN(f) AS f FROM (
			SELECT MIN(fecha) AS f FROM transaccion WHERE perfil_id=1
			UNION ALL SELECT MIN(fecha) FROM mov_caja WHERE perfil_id=1
			UNION ALL SELECT MIN(fecha) FROM renta_activo WHERE perfil_id=1
		)`
	)) as any[];
	return r[0]?.f ?? null;
}

// Bloque A — migración única: repara las fotos ya guardadas que quedaron con
// precio de COMPRA (PPC) en vez de precio de MERCADO, secuela del bug donde
// backfillHistoricoActivo traía histórico nuevo sin invalidar las fotos que
// dependían de él (ver ese archivo). Recalcula TODAS las fotos existentes vía
// calcularValuacionEnFecha, ahora que el histórico de precios está más
// completo. Se corre a mano desde Tus datos (no automática al arrancar, para
// no trabar el inicio de la app con una base grande). El flag
// 'fotos_reparadas_v2' se escribe RECIÉN AL FINAL, si el barrido completo
// terminó sin tirar: así, si se corta a mitad de camino (la pestaña se cierra,
// iOS mata la tab), la próxima vez la pantalla vuelve a ofrecer correrla en
// vez de darla por hecha a medias.
//
// v2 (fix post-incidente): la v1 recalculaba TODAS las fotos sin filtrar por
// fecha. Si había fotos guardadas con fecha ANTERIOR al primer movimiento real
// (sobrantes del modelo viejo de ancla manual), calcularValuacionEnFecha no
// tiene nada que calcular ahí y devuelve $0 — pisando un valor que antes era
// real y rompiendo para siempre la cadena de rendimiento (ver calcularSerieTWR:
// una base en 0 no se recupera). v2 borra esas fotos fantasma en vez de
// recalcularlas, y sube el flag de versión para que a quien ya corrió v1 se le
// vuelva a ofrecer el botón una vez.
export async function fotosYaReparadas(): Promise<boolean> {
	const r = (await query("SELECT valor FROM meta WHERE clave='fotos_reparadas_v2'")) as any[];
	return r.length > 0;
}

const LOTE_REPARACION = 15; // fotos por lote, antes de ceder el hilo a la UI

export async function repararFotosPPC(onProgreso?: (hecho: number, total: number) => void): Promise<void> {
	const primerMov = await fechaPrimerMovimiento();
	if (primerMov) {
		// Fotos de antes de que existiera cualquier movimiento real: no son un
		// valor histórico, son un artefacto. Se borran, no se recalculan.
		await query('DELETE FROM snapshot WHERE perfil_id=1 AND fecha < ?', [primerMov]);
	}

	const fechas = (await query('SELECT fecha FROM snapshot WHERE perfil_id=1 ORDER BY fecha ASC')) as any[];
	const total = fechas.length;
	onProgreso?.(0, total);
	for (let i = 0; i < fechas.length; i++) {
		await recalcularYGuardarFoto(fechas[i].fecha);
		onProgreso?.(i + 1, total);
		// Cede el hilo entre lotes para que la UI pinte el progreso — clave en
		// iOS, donde un loop largo sin ceder puede colgar Safari (ver incidente).
		if ((i + 1) % LOTE_REPARACION === 0) await new Promise((r) => setTimeout(r, 0));
	}
	await query(
		"INSERT INTO meta (clave, valor) VALUES ('fotos_reparadas_v2', ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor",
		[new Date().toISOString()]
	);
}

// Bloque B — diagnóstico de liquidez negativa: para cada moneda con saldo HOY
// negativo, arma el saldo corriendo día por día (mov_caja + efecto caja de
// transacciones + renta/amortización, en orden cronológico) y busca desde qué
// fecha quedó en negativo de forma corrida — la primera fecha después de la
// cual el saldo nunca volvió a ser >= 0. Solo devuelve las monedas que HOY
// están negativas (no bloquea nada, es solo para el aviso persistente).
export type EstadoLiquidez = { moneda: 'ARS' | 'USD'; saldo: number; negativoDesde: string | null };

export async function diagnosticoLiquidez(): Promise<EstadoLiquidez[]> {
	const monedas: ('ARS' | 'USD')[] = ['ARS', 'USD'];
	const out: EstadoLiquidez[] = [];
	for (const moneda of monedas) {
		const movc = (await query('SELECT fecha, monto FROM mov_caja WHERE perfil_id=1 AND moneda=?', [moneda])) as any[];
		const tcash = (await query(
			"SELECT fecha, CASE WHEN operacion='Venta' THEN monto_pago ELSE -monto_pago END AS monto FROM transaccion WHERE perfil_id=1 AND moneda_pago=? AND monto_pago IS NOT NULL",
			[moneda]
		)) as any[];
		const rcash = (await query(
			'SELECT fecha, (monto_renta + monto_amort) AS monto FROM renta_activo WHERE perfil_id=1 AND moneda=?',
			[moneda]
		)) as any[];
		const porDia = new Map<string, number>();
		for (const r of [...movc, ...tcash, ...rcash]) porDia.set(r.fecha, (porDia.get(r.fecha) ?? 0) + r.monto);
		const dias = [...porDia.keys()].sort();
		let saldo = 0;
		let negativoDesde: string | null = null;
		for (const d of dias) {
			saldo += porDia.get(d)!;
			if (saldo < -1e-6) { if (negativoDesde === null) negativoDesde = d; }
			else negativoDesde = null; // volvió a 0/positivo: se resetea el conteo
		}
		if (saldo < -1e-6) out.push({ moneda, saldo, negativoDesde });
	}
	return out;
}

// ===== Bloques 5+6: tenencia agregada, compartida entre Tenencia Actual y
// Tenencia en montos (misma idea que calcularFIFO: UNA sola implementación). =====

export type Holding = {
	id: number;
	nombre: string;
	tipo: string;
	renta: string;
	moneda: string;
	exposicion: string;
	unidades: number;
	ppc: number; // precio promedio de compra (moneda del activo)
	ppv: number; // precio promedio de venta ponderado (moneda del activo)
	precioActual: number;
	mercado: number; // unidades × precioActual, moneda del activo
	mercadoUSD: number;
	invUSD: number; // costo TOTAL comprado en USD del episodio (no se reduce en ventas parciales — lo usa gananciaUSD/rendPct)
	gananciaUSD: number; // realizada+no realizada de la posición abierta, en USD
	rendPct: number | null; // gananciaUSD / invUSD
	peso: number; // % del total de la cartera (incluye líquido)
};

export type Tenencia = {
	dolar: number;
	hold: Holding[];
	totalUSD: number; // cartera + líquido
	invertidoUSD: number; // valor de MERCADO de la tenencia (no costo) — invertidoUSD + liqSaldos(en USD) = totalUSD, exacto
	resultadoAbiertoUSD: number; // suma de gananciaUSD de las posiciones abiertas (YA incluye renta/amortización cobrada, vía recUSD)
	liqSaldos: Record<string, number>;
	buckets: { renta: string; v: number; pct: number }[]; // Estructura de renta (incluye Líquido)
	exposicion: { tot: number; filas: { clave: string; label: string; v: number; pct: number; color: string }[] };
};

const COLOR_EXPOSICION: Record<string, string> = { Dolar: 'var(--accent)', CER: '#4ade80', Peso: '#e8975b' };

// Cartera completa "a hoy": tenencia por activo (PPC/PPV/precio de
// mercado/ganancia/rendimiento), liquidez, estructura de renta y exposición al
// tipo de cambio. Portado tal cual desde /inversiones (Bloque 5/6): misma
// lógica de episodios (se reinicia el acumulado cuando la tenencia de un
// activo vuelve a cero) y de renta/amortización (solo cuenta para la posición
// ABIERTA; si no, ya se contó como ganancia realizada en otro lado — ver
// calcularFIFO). No toca FIFO/PPC/PPV en sí, solo agrega sobre lo que ya
// calculan calcularFIFO/calcularLiquidez.
export async function calcularTenencia(): Promise<Tenencia> {
	const dolar = await dolarActual();
	const { lotes, episodioDesde, aMap, txs } = await calcularFIFO();

	const txAgg = txs.map((t: any) => ({ aid: t.activo_id, op: t.operacion, u: t.unidades, p: t.precio, vd: t.valor_dolar, f: t.fecha }));
	// invUSD/inv = costo de TODO lo comprado en el episodio (nunca se reduce en
	// una venta parcial, solo se resetea al cerrar del todo) — es lo que necesita
	// gananciaUSD más abajo: (recUSD + mercadoUSD) - invUSD da la ganancia total
	// (realizada + no realizada) correcta precisamente PORQUE invUSD es el costo
	// histórico completo, no lo que queda.
	type Agg = { compU: number; inv: number; invUSD: number; rec: number; recUSD: number };
	const nuevoAgg = (): Agg => ({ compU: 0, inv: 0, invUSD: 0, rec: 0, recUSD: 0 });
	const agg: Record<number, Agg> = {};
	const heldRun: Record<number, number> = {};
	for (const t of txAgg) {
		const a = aMap[t.aid];
		if (!a) continue;
		agg[t.aid] ??= nuevoAgg();
		heldRun[t.aid] ??= 0;
		const nat = t.u * t.p;
		const enUSD = aUSD(t.p, a.moneda, t.vd) * t.u;
		if (t.op === 'Compra') {
			heldRun[t.aid] += t.u;
			agg[t.aid].compU += t.u; agg[t.aid].inv += nat; agg[t.aid].invUSD += enUSD;
		} else {
			heldRun[t.aid] -= t.u;
			agg[t.aid].rec += nat; agg[t.aid].recUSD += enUSD;
			if (heldRun[t.aid] <= 1e-9) { heldRun[t.aid] = 0; agg[t.aid] = nuevoAgg(); }
		}
	}

	const posicionAbierta = (aid: number) => (lotes[aid]?.reduce((s, l) => s + l.u, 0) ?? 0) > 1e-6;

	const rentas = (await query(
		'SELECT activo_id, fecha, moneda, monto_renta, monto_amort, valor_dolar FROM renta_activo WHERE perfil_id=1 ORDER BY activo_id, fecha'
	)) as any[];
	const serieDolar = await cargarDolarSerie();
	const tcDe = (vd: any, fecha: string) => (Number.isFinite(vd) && vd > 0 ? vd : (dolarDeFecha(serieDolar, fecha) ?? dolar));
	const rentaAgg: Record<number, { rec: number; recUSD: number }> = {};
	for (const r of rentas) {
		const a = aMap[r.activo_id];
		if (!a) continue;
		const vd = tcDe(r.valor_dolar, r.fecha);
		const desde = episodioDesde[r.activo_id];
		const esAbierta = posicionAbierta(r.activo_id) && !!desde && r.fecha >= desde;
		if (!esAbierta) continue; // cerrada: ya cuenta como ganancia realizada en otro lado
		const total = (r.monto_renta ?? 0) + (r.monto_amort ?? 0);
		const rUSD = aUSD(total, r.moneda, vd);
		const rNat = a.moneda === 'USD' ? rUSD : rUSD * vd;
		(rentaAgg[r.activo_id] ??= { rec: 0, recUSD: 0 });
		rentaAgg[r.activo_id].rec += rNat;
		rentaAgg[r.activo_id].recUSD += rUSD;
	}

	const hold: Holding[] = [];
	const buck: Record<string, number> = { Fija: 0, Mixta: 0, Variable: 0, Liquido: 0 };
	let tUSD = 0;
	for (const [aid, q] of Object.entries(lotes)) {
		const u = q.reduce((s, l) => s + l.u, 0);
		if (u < 1e-6) continue;
		const a = aMap[Number(aid)];
		const costoNat = q.reduce((s, l) => s + l.u * l.pNat, 0);
		const costoUSD = q.reduce((s, l) => s + l.u * l.pUSD, 0);
		const g = agg[Number(aid)] ?? { compU: u, inv: costoNat, invUSD: costoUSD, rec: 0, recUSD: 0 };
		const rp = rentaAgg[Number(aid)];
		if (rp) { g.rec += rp.rec; g.recUSD += rp.recUSD; }
		const ppc = g.compU ? g.inv / g.compU : 0;
		const pa = a.precio_actual ?? ppc;
		const mercado = u * pa;
		const mercadoUSD = a.moneda === 'USD' ? mercado : mercado / dolar;
		const ppv = g.compU ? (g.rec + mercado) / g.compU : pa;
		const gananciaUSD = (g.recUSD + mercadoUSD) - g.invUSD;
		const rendPct = g.invUSD ? gananciaUSD / g.invUSD : null;
		buck[a.renta] = (buck[a.renta] ?? 0) + mercadoUSD; tUSD += mercadoUSD;
		hold.push({
			id: Number(aid), nombre: a.nombre, tipo: a.tipo, renta: a.renta, moneda: a.moneda,
			exposicion: a.exposicion ?? (a.moneda === 'USD' || a.tipo === 'CEDEAR' || a.tipo === 'Indice' ? 'Dolar' : 'Peso'),
			unidades: u, ppc, ppv, precioActual: pa, mercado, mercadoUSD,
			invUSD: g.invUSD, gananciaUSD, rendPct, peso: 0 // peso real se completa abajo, tras sumar tUSD
		});
	}
	const resultadoAbiertoUSD = hold.reduce((s, h) => s + h.gananciaUSD, 0);
	// "Invertido" = valor de mercado de la tenencia (lo que tenés puesto HOY, a
	// precio actual) — no el costo de compra. Definido así a propósito para que
	// Invertido + Liquidez = Valor cartera cierre siempre exacto (ver "Valor
	// invertido" en Tenencia en montos); "Resultado de tenencia" es una métrica
	// aparte (cómo viene rindiendo esa tenencia), no se suma a Invertido.
	const invertidoUSD = hold.reduce((s, h) => s + h.mercadoUSD, 0);

	const liqSaldos = await calcularLiquidez();
	for (const mon of ['ARS', 'USD']) {
		const saldo = liqSaldos[mon] ?? 0;
		const valUSD = mon === 'USD' ? saldo : saldo / dolar;
		buck['Liquido'] = (buck['Liquido'] ?? 0) + valUSD; tUSD += valUSD;
	}

	for (const h of hold) h.peso = tUSD ? h.mercadoUSD / tUSD : 0;
	hold.sort((x, y) => y.mercadoUSD - x.mercadoUSD);
	// Bloque B: antes se filtraba v > 0 (una categoría en cero no se dibuja). Con
	// liquidez negativa permitida, el bucket 'Liquido' puede terminar negativo y
	// tiene que seguir viéndose (en rojo, la UI lo resuelve) — solo se descarta
	// el cero exacto. pct NO se normaliza sobre la suma de los positivos: usa
	// tUSD tal cual (que ya está reducido por el negativo), así el total cierra
	// en 100% y las demás filas pueden superar el 100% — es la señal de que
	// falta información, no un bug.
	const buckets = Object.entries(buck).filter(([, v]) => Math.abs(v) > 1e-6).map(([renta, v]) => ({ renta, v, pct: tUSD ? v / tUSD : 0 })).sort((a, b) => b.v - a.v);

	const bDolar = liqSaldos.USD ?? 0, bPeso = (liqSaldos.ARS ?? 0) / dolar;
	let expDolar = bDolar, expCer = 0, expPeso = bPeso;
	for (const h of hold) {
		if (h.exposicion === 'Dolar') expDolar += h.mercadoUSD;
		else if (h.exposicion === 'CER') expCer += h.mercadoUSD;
		else expPeso += h.mercadoUSD;
	}
	const totExp = expDolar + expCer + expPeso;
	const exposicion = {
		tot: totExp,
		filas: [
			{ clave: 'Dolar', label: 'Dólar', v: expDolar, pct: totExp ? expDolar / totExp : 0, color: COLOR_EXPOSICION.Dolar },
			{ clave: 'CER', label: 'CER / Inflación', v: expCer, pct: totExp ? expCer / totExp : 0, color: COLOR_EXPOSICION.CER },
			{ clave: 'Peso', label: 'Peso', v: expPeso, pct: totExp ? expPeso / totExp : 0, color: COLOR_EXPOSICION.Peso }
		]
	};

	return { dolar, hold, totalUSD: tUSD, invertidoUSD, resultadoAbiertoUSD, liqSaldos, buckets, exposicion };
}

// ===== Bloque 5: rendimiento (TWR) rebasado a una ventana, para las tarjetas
// de Tenencia Actual (mes/trimestre/año). Misma fórmula que la curva de
// Evolución de cartera (encadenado, base 100) — NO se reimplementa ahí, esta
// es la versión reusable; evolucion/+page.svelte sigue con su propio cálculo
// intacto (no se tocó, por las dudas de no introducir una diferencia). =====

export type SnapConIdx = { fecha: string; valor_usd: number; flujo_usd: number; ret: number; idx: number };

// Encadena el índice TWR (base 100) sobre fotos YA ordenadas ascendente por fecha.
//
// Blindaje (post-incidente "Anual -100%"): el chequeo `prev > 0` ya evitaba
// dividir por una base en cero (el día ANTERIOR en $0). Faltaba el caso
// simétrico — el día ACTUAL en $0 (p. ej. una foto con dato faltante o un
// gap de liquidez histórica) — que hacía `idx *= 0` y dejaba el índice en
// cero PARA SIEMPRE: cero multiplicado por cualquier retorno futuro sigue
// siendo cero, así que un solo día podrido rompía todo el historial de ahí
// en más. Ahora también se exige `s.valor_usd > 0` para aplicar el paso: un
// día en (o cerca de) cero no actualiza el índice, solo queda "sin señal" —
// ni cuenta como caída al entrar, ni como suba al salir — y la cadena sigue
// desde el último valor bueno apenas vuelve a haber un dato real. Mismo
// criterio en ambos sentidos, sin inventar un piso/umbral arbitrario.
export function calcularSerieTWR(rows: { fecha: string; valor_usd: number; flujo_usd: number }[]): SnapConIdx[] {
	let idx = 100;
	let prev: number | null = null;
	return rows.map((s) => {
		let r = 0;
		if (prev !== null && prev > 0 && s.valor_usd > 0) { r = (s.valor_usd - s.flujo_usd) / prev - 1; idx *= 1 + r; }
		prev = s.valor_usd;
		return { ...s, ret: r, idx };
	});
}

// TWR de la ventana [cutoffISO, hoy] sobre una serie ya indexada. null si no
// hay al menos 2 fotos en la ventana ("sin datos suficientes", no un cero).
// Si NINGUNA foto tiene fecha <= cutoffISO (la cartera es más nueva que la
// ventana pedida, ej. "rendimiento anual" con 3 meses de historia), no hay
// base de comparación para esa ventana — antes caía a serie[0] por defecto y
// terminaba mostrando el retorno desde el inicio disfrazado de retorno anual.
export function rendimientoVentana(serie: SnapConIdx[], cutoffISO: string): number | null {
	if (!serie.length) return null;
	let base: SnapConIdx | null = null;
	for (const s of serie) if (s.fecha <= cutoffISO) base = s;
	if (base === null) return null;
	const vsnaps = serie.filter((s) => s.fecha >= base!.fecha);
	if (vsnaps.length < 2) return null;
	return vsnaps[vsnaps.length - 1].idx / base.idx - 1;
}
