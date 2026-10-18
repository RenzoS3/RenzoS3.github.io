// src/lib/db/precios.ts
// Auto-actualización de precios de activos desde data912 (API pública y gratuita
// de mercado argentino). Para cada activo con `simbolo_cotizacion` configurado,
// busca su último precio y lo escribe en precio_actual. Best-effort: si la API
// falla o no hay internet, no rompe nada y se queda con los precios guardados.
//
// data912 expone paneles por tipo. Cada instrumento tiene 3 símbolos:
//   TICKER  -> precio en pesos        (ej. GD35)
//   TICKERD -> dólar MEP   (especie D, ej. GD35D)
//   TICKERC -> dólar CCL   (especie C, ej. GD35C)
// El campo de último precio es `c`. El sufijo del símbolo ya define la moneda,
// así que el usuario apunta cada activo al símbolo de la moneda que quiere.

import { query, queryBatch } from './client';
import { setMeta } from './meta';
import { hoyISO } from '../format';
import { BASE, ajustarEscala } from './data912';
import { sqlUpsertPrecioHistorico } from './precios_historicos';
import { controlarEscala } from './escala';
import { calcularFoto, guardarSnapshot, completarFotosFaltantes } from '../cartera';
import { actualizarDolar } from './cotizaciones';
import { ErrorValidacion, ErrorRed } from '../errores';
import { guardarMercado } from '../sheets/cacheMercado';

const PANELES = ['arg_bonds', 'arg_corp', 'arg_cedears', 'arg_stocks', 'arg_notes'];

// Aviso de sincronización de la última corrida de actualizarPrecios(), solo
// para esta sesión (se pisa en cada corrida, no persiste). Aparte del tipo de
// retorno de actualizarPrecios/actualizarPreciosYFoto a propósito: esas
// funciones las consumen 4 pantallas (config-tickers, inversiones/montos,
// inversiones, +layout) y cambiar su forma las rompería a todas. Acá solo
// entran los activos en tenencia actual sin coincidencia (mismo criterio que
// el mensaje de "sin coincidencia" del toast) — el catálogo sincronizado tiene
// cientos de símbolos irrelevantes que no aportan como aviso accionable.
export let ultimoSinMatchTodos: { id: number; tipo: string; simbolo: string }[] = [];

// Reexportada por compatibilidad: config-tickers y otros ya podrían importar
// ajustarEscala desde acá. La fuente real ahora es data912.ts.
export { ajustarEscala };

// Hora local (del navegador) a partir de la cual se considera "mercado
// abierto". Antes de esa hora, el panel en vivo de data912 todavía devuelve
// el cierre de la sesión anterior (no hay operado nuevo todavía).
const HORA_APERTURA = 11;

// día hábil anterior a una fecha 'yyyy-mm-dd' (salta sábado/domingo; no
// contempla feriados). Determinístico: opera sobre las partes de la fecha
// dada, no sobre "ahora".
function diaHabilAnterior(iso: string): string {
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
	let t = Date.UTC(y, m - 1, d) - 86400000;
	while ([0, 6].includes(new Date(t).getUTCDay())) t -= 86400000;
	const dt = new Date(t);
	return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

// Fecha a la que corresponde el precio que devuelve el panel en vivo AHORA MISMO:
// antes de la apertura, ese precio es todavía el cierre del día hábil anterior
// (Bloque 2 — ventana pre-apertura); de ahí en más, es el día de hoy. La usan
// tanto actualizarPrecios (para fechar precio_historico) como el auto-guardado
// de la foto (para que ambos queden fechados igual).
export function fechaCierreActual(): string {
	return new Date().getHours() < HORA_APERTURA ? diaHabilAnterior(hoyISO()) : hoyISO();
}

// Baja todos los paneles y arma un mapa SÍMBOLO(upper) -> último precio (c > 0).
// fechaPrecio sale del header Last-Modified (la fecha del dato en la fuente, no
// nuestro momento de fetch); nos quedamos con la más reciente entre los paneles.
async function bajarMapaPrecios(): Promise<{ mapa: Record<string, number>; panelesOk: number; fechaPrecio: string | null }> {
	const mapa: Record<string, number> = {};
	const resultados = await Promise.allSettled(
		PANELES.map((p) =>
			fetch(`${BASE}/live/${p}`).then(async (r) => {
				if (!r.ok) throw new Error('HTTP ' + r.status);
				const lm = r.headers.get('last-modified');
				const data = await r.json();
				return { data, lm };
			})
		)
	);
	let panelesOk = 0;
	let fechaPrecio: string | null = null;
	for (const r of resultados) {
		if (r.status !== 'fulfilled' || !Array.isArray(r.value.data)) continue;
		panelesOk++;
		if (r.value.lm) {
			const d = new Date(r.value.lm);
			if (!isNaN(d.getTime())) {
				const iso = d.toISOString();
				if (!fechaPrecio || iso > fechaPrecio) fechaPrecio = iso;
			}
		}
		for (const fila of r.value.data) {
			const sym = String(fila?.symbol ?? '').trim().toUpperCase();
			const px = Number(fila?.c);
			if (sym && Number.isFinite(px) && px > 0) mapa[sym] = px;
		}
	}
	return { mapa, panelesOk, fechaPrecio };
}

// Actualiza los precios de los activos con símbolo configurado (precio_actual,
// como siempre) y, además, deja el cierre del día en precio_historico (Bloque 1)
// — con recalc condicional: si el precio no cambió respecto al ya guardado para
// esa fecha, no se reescribe (evita marcar "cambios sin respaldar" cada 20 min
// solo porque el precio no se movió; mismo patrón que el auto-presupuesto).
// Devuelve un resumen legible. Lanza error solo si no se pudo conectar con
// ningún panel.
export async function actualizarPrecios(): Promise<string> {
	const activos = (await query(
		"SELECT id, simbolo_cotizacion, tipo FROM activo WHERE perfil_id=1 AND simbolo_cotizacion IS NOT NULL AND TRIM(simbolo_cotizacion) <> ''"
	)) as any[];
	if (activos.length === 0) {
		throw new ErrorValidacion('No hay activos con símbolo configurado. Cargalos en "Configurar tickers".');
	}

	const { mapa, panelesOk, fechaPrecio } = await bajarMapaPrecios();
	if (panelesOk === 0) {
		throw new ErrorRed('No se pudo conectar con data912 (¿sin internet o bloqueo CORS?).');
	}

	// Sello de tiempo = la fecha del dato en la fuente (Last-Modified) si la hay;
	// si no, nuestro momento de actualización como fallback.
	const sello = fechaPrecio ?? new Date().toISOString();
	// Fecha de "cierre" a la que corresponde este precio (hoy, o el día hábil
	// anterior si es antes de la apertura — ver fechaCierreActual).
	const fechaCierre = fechaCierreActual();

	const matches: { id: number; tipo: string; precio: number }[] = [];
	const sinMatch: { id: number; tipo: string; simbolo: string }[] = [];
	for (const a of activos) {
		const sym = String(a.simbolo_cotizacion).trim().toUpperCase();
		const px = mapa[sym];
		if (px == null) { sinMatch.push({ id: a.id, tipo: a.tipo, simbolo: a.simbolo_cotizacion }); continue; }
		matches.push({ id: a.id, tipo: a.tipo, precio: ajustarEscala(px, a.tipo) });
	}

	// Tenencia actual: activos con posición neta abierta (Compras - Ventas > 0).
	// Con el catálogo sincronizado, "sin coincidencia" puede listar cientos de
	// símbolos delistados o irrelevantes; acá se acota a lo que el usuario
	// realmente tiene en cartera hoy.
	const tenenciaRows = (await query(
		"SELECT activo_id FROM transaccion WHERE perfil_id=1 GROUP BY activo_id" +
			" HAVING SUM(CASE WHEN operacion='Compra' THEN unidades ELSE -unidades END) > 1e-6"
	)) as any[];
	const enTenencia = new Set<number>(tenenciaRows.map((r) => r.activo_id));
	const sinMatchTenencia = sinMatch.filter((m) => enTenencia.has(m.id));
	ultimoSinMatchTodos = sinMatchTenencia;

	// Activos que el usuario efectivamente opera (tienen alguna compra/venta o
	// alguna renta cobrada). SOLO estos loguean su cierre diario en
	// precio_historico: con el catálogo entero sincronizado, hacerlo para todos
	// serían cientos de filas nuevas por día — creciendo la base y el backup para
	// siempre, y ensuciando el flag de "cambios sin respaldar" en cada refresco.
	// El resto del catálogo igual actualiza su precio_actual (se pisa en el lugar,
	// no crece), que es lo único que necesita el listado de Mercado.
	const operadosRows = (await query(
		'SELECT DISTINCT activo_id FROM transaccion WHERE perfil_id=1' +
			' UNION SELECT DISTINCT activo_id FROM renta_activo WHERE perfil_id=1'
	)) as any[];
	const operados = new Set<number>(operadosRows.map((r) => r.activo_id));
	const conHistorico = matches.filter((m) => operados.has(m.id));

	// Precios ya guardados en precio_historico para la fecha de cierre, para el
	// guard de recalc condicional (una sola consulta, no una por activo).
	const yaGuardados = new Map<number, number>();
	if (conHistorico.length) {
		const ids = conHistorico.map((m) => m.id);
		const filas = (await query(
			`SELECT activo_id, precio FROM precio_historico WHERE perfil_id=1 AND fecha=? AND activo_id IN (${ids.map(() => '?').join(',')})`,
			[fechaCierre, ...ids]
		)) as any[];
		for (const f of filas) yaGuardados.set(f.activo_id, f.precio);
	}

	// Control de escala (solo aviso) para los activos que loguean cierre diario,
	// ANTES del batch: precio_actual todavía tiene el valor anterior.
	for (const m of conHistorico) await controlarEscala(m.id, fechaCierre, m.precio);

	const stmts: { sql: string; bind?: unknown[] }[] = [];
	for (const m of matches) {
		// precio_actual: se actualiza SIEMPRE, sin mirar si hubo corrección manual.
		// Es deliberado: para todo lo que la API cubre, el valor de la API manda.
		// La edición de precio en Tenencia en montos existe para los activos que NO
		// se actualizan solos (FCI y cualquiera sin símbolo, que quedan afuera de
		// esta consulta por el filtro de simbolo_cotizacion) y como escape puntual
		// si la fuente falla — no como una anulación permanente.
		// No dirtea el flag de backup: worker.ts excluye este UPDATE explícitamente.
		stmts.push({
			sql: 'UPDATE activo SET precio_actual=?, precio_actualizado_en=? WHERE id=? AND perfil_id=1',
			bind: [m.precio, sello, m.id]
		});
	}
	for (const m of conHistorico) {
		// precio_historico: solo si cambió respecto a lo ya guardado para ese día.
		const previo = yaGuardados.get(m.id);
		if (previo == null || Math.abs(previo - m.precio) > 1e-9) {
			stmts.push({ sql: sqlUpsertPrecioHistorico('panel_vivo'), bind: [m.id, fechaCierre, m.precio, 'panel_vivo'] });
		}
	}
	if (stmts.length) await queryBatch(stmts);
	await setMeta('precios_actualizados_en', sello);

	let msg = `Precios actualizados ✅ ${matches.length}/${activos.length} activos`;
	// "sin coincidencia" se acota a lo que está en tenencia actual: con el
	// catálogo sincronizado, mostrar el catálogo entero puede ser una lista larga
	// e irrelevante (símbolos delistados, tickers cargados a mano que no existen
	// en los paneles pero que tampoco se operan). Se muestran los primeros y se
	// cuenta el resto, para que el mensaje siga siendo legible.
	if (sinMatchTenencia.length) {
		const MUESTRA = 8;
		msg += ` · sin coincidencia: ${sinMatchTenencia.slice(0, MUESTRA).map((m) => m.simbolo).join(', ')}`;
		if (sinMatchTenencia.length > MUESTRA) msg += ` y ${sinMatchTenencia.length - MUESTRA} más`;
	}
	if (panelesOk < PANELES.length) msg += ` · (${panelesOk}/${PANELES.length} paneles ok)`;
	return msg;
}

// Trae los precios actuales de data912 SIN escribir nada (para previsualizar en
// la pantalla de configuración de tickers). Devuelve símbolo(upper) -> precio.
export async function previsualizarPrecios(): Promise<Record<string, number>> {
	const { mapa } = await bajarMapaPrecios();
	return mapa;
}

// Mapea cada panel de data912 a un `tipo` del schema de Rienda. Letras (arg_notes)
// y deuda corporativa (arg_corp) no tienen tipo propio en el enum de `activo`:
// se tratan como Bono y ON respectivamente (misma naturaleza de renta fija).
const PANEL_TIPO: Record<string, string> = {
	arg_bonds: 'Bono',
	arg_notes: 'Bono',
	arg_corp: 'ON',
	arg_cedears: 'CEDEAR',
	arg_stocks: 'Accion'
};

export type CatalogoItem = { simbolo: string; tipo: string; precio: number; moneda: 'ARS' | 'USD' };

// Especie de un símbolo, derivada del ticker + la moneda ya resuelta. NO se
// guarda en la base: es una etiqueta de lectura para el filtro de Mercado.
//   Pesos = ticker pelado (cotiza en ARS)
//   MEP   = especie D (dólar bolsa)
//   CCL   = especie C (contado con liquidación)
// El sufijo solo se interpreta si la moneda ya salió 'USD' (ver monedaDeSimbolo):
// así 'AMD' (CEDEAR de AMD, en pesos) no se confunde con una especie D.
// LÍMITE CONOCIDO: un activo cargado a mano en USD sin sufijo (p.ej. una ON
// suscripta en dólares) se etiqueta MEP por descarte — es la especie usual en
// el mercado local, pero es una suposición, no un dato.
export type Especie = 'Pesos' | 'MEP' | 'CCL';
export function especieDeTicker(ticker: string, moneda: string): Especie {
	if (moneda !== 'USD') return 'Pesos';
	const t = ticker.trim().toUpperCase();
	if (t.endsWith('C')) return 'CCL';
	return 'MEP';
}

// Moneda de cotización de un símbolo del panel. Los instrumentos aparecen hasta
// tres veces (TICKER en pesos, TICKERD en MEP, TICKERC en CCL), así que la regla
// natural sería "termina en D o C -> USD". Pero hay tickers propios que terminan
// en esas letras sin ser especie dólar (AMD y BBD son CEDEARs que cotizan en
// pesos; YPFD es el ticker de YPF, no la especie D de 'YPF'). Por eso el sufijo
// solo cuenta si el símbolo base TAMBIÉN está en el mismo panel: 'GD35D' es USD
// porque 'GD35' está al lado, 'AMD' no lo es porque 'AM' no existe. La regla sale
// del propio dato que se baja, no de una lista negra a mantener a mano.
function monedaDeSimbolo(sym: string, simbolosDelPanel: Set<string>): 'ARS' | 'USD' {
	const ultima = sym.slice(-1);
	if (ultima !== 'D' && ultima !== 'C') return 'ARS';
	return simbolosDelPanel.has(sym.slice(0, -1)) ? 'USD' : 'ARS';
}

// Catálogo completo de instrumentos que devuelven los paneles en vivo de
// data912, con tipo inferido por panel de origen y moneda derivada por la regla
// de arriba. El nombre real NO viene en los paneles (por eso el sync guarda
// nombre = ticker y el usuario lo corrige solo en los que opera). Si un símbolo
// aparece en más de un panel, gana la primera aparición (orden de PANELES).
export async function listarCatalogoData912(): Promise<CatalogoItem[]> {
	const out: CatalogoItem[] = [];
	const vistos = new Set<string>();
	const resultados = await Promise.allSettled(
		PANELES.map((p) =>
			fetch(`${BASE}/live/${p}`).then((r) => {
				if (!r.ok) throw new Error('HTTP ' + r.status);
				return r.json();
			})
		)
	);
	PANELES.forEach((p, i) => {
		const r = resultados[i];
		if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
		const tipo = PANEL_TIPO[p];
		// Primera pasada: todos los símbolos de ESTE panel, para poder chequear
		// si el símbolo base de un sufijo D/C existe (ver monedaDeSimbolo).
		const delPanel = new Set<string>();
		for (const fila of r.value) {
			const sym = String(fila?.symbol ?? '').trim().toUpperCase();
			if (sym) delPanel.add(sym);
		}
		for (const fila of r.value) {
			const sym = String(fila?.symbol ?? '').trim().toUpperCase();
			const px = Number(fila?.c);
			if (!sym || vistos.has(sym) || !Number.isFinite(px) || px <= 0) continue;
			vistos.add(sym);
			out.push({ simbolo: sym, tipo, precio: ajustarEscala(px, tipo), moneda: monedaDeSimbolo(sym, delPanel) });
		}
	});
	return out.sort((a, b) => a.simbolo.localeCompare(b.simbolo));
}

// Renta por defecto según el panel de origen: renta fija para deuda (bonos,
// letras y ONs), variable para lo demás (acciones y CEDEARs). Es un default de
// alta masiva — el usuario corrige a mano los pocos que efectivamente opera.
function rentaPorTipo(tipo: string): string {
	return tipo === 'Bono' || tipo === 'ON' ? 'Fija' : 'Variable';
}

// Exposición al tipo de cambio por defecto. Misma regla que ya usa el alta
// manual (exposicionSugerida en la pantalla de Mercado): no es la moneda de
// cotización — un CEDEAR cotiza en pesos pero sigue al dólar.
function exposicionPorRegla(moneda: string, tipo: string): string {
	return moneda === 'USD' || tipo === 'CEDEAR' || tipo === 'Indice' ? 'Dolar' : 'Peso';
}

// Sincroniza el catálogo de data912 contra la tabla `activo`: da de alta los
// símbolos que todavía no existen y NO toca ninguno de los que ya están (así
// las correcciones de renta/exposición/nombre que hizo el usuario nunca se
// pisan). Idempotente: volver a correrlo solo agrega lo que apareció nuevo.
//
// Los activos entran con nombre = ticker (los paneles no traen el nombre real),
// simbolo_cotizacion = ticker (para que el refresco de precios los encuentre) y
// precio_actual ya sembrado con el precio del panel — sin un fetch extra, porque
// el catálogo ya lo trae. NO se baja histórico: eso lo resuelve el gráfico de
// Mercado on-demand, en memoria, sin persistirlo.
export async function sincronizarCatalogoData912(): Promise<string> {
	const catalogo = await listarCatalogoData912();
	if (catalogo.length === 0) {
		throw new Error('No se pudo conectar con data912 (¿sin internet o bloqueo CORS?).');
	}

	// Tickers ya cargados, comparados en mayúsculas: el UNIQUE de la tabla es
	// sensible a mayúsculas, así que un 'cepu' cargado a mano no frenaría el
	// INSERT de 'CEPU' — este set sí lo frena y evita el duplicado por caja.
	const existentes = (await query('SELECT ticker FROM activo WHERE perfil_id=1')) as any[];
	const yaCargados = new Set(existentes.map((a) => String(a.ticker).trim().toUpperCase()));

	const sello = new Date().toISOString();
	const nuevos = catalogo.filter((c) => !yaCargados.has(c.simbolo));
	if (nuevos.length) {
		await queryBatch(
			nuevos.map((c) => ({
				// OR IGNORE como segunda red: si dos símbolos normalizan al mismo
				// ticker, el lote no se cae entero por una colisión.
				sql: `INSERT OR IGNORE INTO activo
					(perfil_id, ticker, nombre, tipo, renta, moneda, exposicion, simbolo_cotizacion, precio_actual, precio_actualizado_en)
					VALUES (1,?,?,?,?,?,?,?,?,?)`,
				bind: [
					c.simbolo, c.simbolo, c.tipo, rentaPorTipo(c.tipo), c.moneda,
					exposicionPorRegla(c.moneda, c.tipo), c.simbolo, c.precio, sello
				]
			}))
		);
	}

	// Resumen: sirve de diagnóstico real de la fuente (cuántos símbolos trae cada
	// tipo y cuántos son especie dólar), que es justo lo que no se puede saber sin
	// llamar a la API.
	const porTipo = new Map<string, number>();
	let mep = 0, ccl = 0;
	for (const c of catalogo) {
		porTipo.set(c.tipo, (porTipo.get(c.tipo) ?? 0) + 1);
		const e = especieDeTicker(c.simbolo, c.moneda);
		if (e === 'MEP') mep++; else if (e === 'CCL') ccl++;
	}
	const detalle = [...porTipo.entries()].sort().map(([t, n]) => `${t} ${n}`).join(' · ');
	return `Catálogo sincronizado ✅ ${nuevos.length} nuevos de ${catalogo.length} símbolos` +
		` · ${detalle} · especies: MEP ${mep}, CCL ${ccl}`;
}

// Bloque 2: la foto de cartera deja de ser una acción del usuario y pasa a ser
// consecuencia automática de actualizar precios. Se llama desde el auto-refresh
// (layout) y desde los botones manuales "Actualizar precios" (Tenencia Actual y
// Configurar tickers) — cualquier refresco exitoso, manual o automático, deja
// hecha la foto del día. Si actualizarPrecios falla (sin conexión), no se toca
// la foto. Recalc condicional también acá: si el valor calculado es igual al ya
// guardado para esa fecha, no se reescribe snapshot (mismo motivo que arriba —
// si no, la foto se "editaría" cada 20 min aunque no haya cambiado nada).
export async function actualizarPreciosYFoto(): Promise<string> {
	const mensaje = await actualizarPrecios();
	try {
		// Dólar de hoy (DolarApi.com): se cuelga acá para compartir el mismo gatillo
		// de 20 min que ya gobierna este refresco (ver autoPrecios en +layout.svelte)
		// y para que "Actualizar precios" (Mercado/Tenencia/Montos) también deje el
		// tipo de cambio al día. Best-effort, no bloquea el resultado de precios: si
		// falla, se sigue con el ya guardado (mismo criterio que la foto, abajo).
		await actualizarDolar();
	} catch (e) {
		console.error('[precios] no se pudo actualizar el dólar del día:', e);
	}
	try {
		const fecha = fechaCierreActual();
		// Bloque A: completa las fotos de los días faltantes entre la última
		// guardada y hoy (usando calcularValuacionEnFecha) ANTES de guardar la de
		// hoy — si pasaron días sin refresco (app cerrada, sin conexión), una
		// ventana de rendimiento no tenía contra qué comparar. Best-effort: no
		// bloquea el guardado de la foto de hoy si falla.
		try {
			await completarFotosFaltantes(fecha);
		} catch (e) {
			console.error('[precios] no se pudieron completar las fotos de días faltantes:', e);
		}
		const foto = await calcularFoto();
		const existente = (await query(
			'SELECT valor_usd, flujo_usd, dolar, valor_ars FROM snapshot WHERE perfil_id=1 AND fecha=?',
			[fecha]
		)) as any[];
		const e = existente[0];
		const igual =
			e &&
			Math.abs(e.valor_usd - foto.valorUSD) < 0.005 &&
			Math.abs(e.flujo_usd - foto.flujo) < 0.005 &&
			Math.abs((e.dolar ?? 0) - foto.dolar) < 0.005 &&
			Math.abs((e.valor_ars ?? 0) - foto.valorARS) < 0.5;
		if (!igual) await guardarSnapshot(fecha, foto.valorUSD, foto.flujo, foto.dolar, foto.valorARS);
	} catch (e) {
		// No bloquea el resultado de actualizarPrecios (que sí funcionó): la foto
		// automática es un efecto secundario, no la operación principal.
		console.error('[precios] no se pudo guardar la foto automática de cartera:', e);
	}
	// Rienda + Sheets: los cierres del día quedan también en la copia del teléfono.
	guardarMercado().catch(() => {});
	return mensaje;
}
