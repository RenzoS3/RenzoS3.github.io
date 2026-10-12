// src/lib/notificaciones.ts
// Reglas del Centro de notificaciones: cada regla se materializa SOLO si se rompe.
// Sin new Date() para "hoy"/"hace N días": se usa hoyISO() y diasEntre() (parseo de
// strings, regla UTC-3). Solo LEE fechas ya guardadas; no toca nada.

import { query, queryBatch } from './db/client';
import { leerMeta } from './db/meta';
import { hoyISO, diasEntre, mesActual, unidades } from './format';
import { leerAvisosEscala } from './db/escala';
import { proximaOcurrencia, addDias, periodoActivoCC, periodoRegla, cargarModo } from './periodo';

export type LineaRegla = {
	tipo: 'mep' | 'copia' | 'escala';
	// Identifica la regla dentro de la lista (hay una 'escala' por activo y fecha).
	clave: string;
	// Solo 'escala': clave del aviso persistido, para descartarlo.
	avisoClave?: string;
	texto: string;
	href?: string; // navegación (copia)
	accion?: 'cotiz'; // acción inline (MEP: actualizar tipo de cambio)
};
export type ItemRecurrente = { id: number; nombre: string; dias: number };
export type Notificaciones = {
	pagos: ItemRecurrente[]; // gastos fijos próximos (ventana [hoy, hoy+3], no registrados)
	cobros: ItemRecurrente[]; // ingresos fijos próximos
	reglas: LineaRegla[]; // MEP / copia (vejez) — persistentes hasta resolverse
	// Conteo del badge de la campana: reglas rotas (persistentes) + recurrentes en
	// ventana AÚN NO vistos (por evento). Al entrar al centro se marcan vistos y bajan.
	badge: number;
};

// Clave de período para el estado "visto" de los recurrentes (el período activo de
// Cuenta Corriente; fallback al mes actual si no hay ninguno guardado).
function periodoVisto(): string {
	return periodoActivoCC() ?? mesActual();
}

// Texto "hoy" / "mañana" / "en N días".
export function faltanTxt(dias: number): string {
	return dias <= 0 ? 'hoy' : dias === 1 ? 'mañana' : `en ${dias} días`;
}

export async function cargarNotificaciones(): Promise<Notificaciones> {
	const hoy = hoyISO();

	// Guard de primera semana de uso: un perfil recién creado no se alarma.
	const pr = (await query('SELECT creado_en FROM perfil WHERE id=1')) as any[];
	const creado = pr[0]?.creado_en ? String(pr[0].creado_en).slice(0, 10) : hoy;
	const enPrimeraSemana = diasEntre(creado, hoy) < 7;

	const reglas: LineaRegla[] = [];

	// Regla 1 — MEP: última cotización 'bolsa' con más de 7 días.
	const cot = (await query(
		"SELECT fecha FROM cotizacion_dolar WHERE perfil_id=1 AND casa='bolsa' ORDER BY fecha DESC LIMIT 1"
	)) as any[];
	const cotFecha = cot[0]?.fecha ?? null;
	if (cotFecha) {
		const d = diasEntre(cotFecha, hoy);
		if (d > 7) reglas.push({ tipo: 'mep', clave: 'mep', texto: `El tipo de cambio no se actualiza hace ${d} días.`, accion: 'cotiz' });
	} else if (!enPrimeraSemana) {
		reglas.push({ tipo: 'mep', clave: 'mep', texto: 'El tipo de cambio nunca se actualizó.', accion: 'cotiz' });
	}

	// Regla 2 — Copia: más de 7 días desde la última exportación (Blindaje iOS).
	// Rienda + Sheets: apagada — los datos viven en la Sheet, no hay copia que hacer.
	const ultExp = null as string | null;
	if (ultExp) {
		const d = diasEntre(ultExp, hoy);
		if (d > 7) reglas.push({ tipo: 'copia', clave: 'copia', texto: `Hace ${d} días que no hacés una copia de seguridad.`, href: '/datos' });
	}

	// Regla 2b — Saltos de escala de precio (ver db/escala.ts): persistente hasta
	// que el usuario descarta cada aviso. No bloquea ni corrige nada.
	for (const a of await leerAvisosEscala()) {
		reglas.push({
			tipo: 'escala',
			clave: 'escala:' + a.clave,
			avisoClave: a.clave,
			texto: `Precio con salto de escala: ${a.ticker} el ${a.fecha} pasó de ${unidades(a.anterior, 2)} a ${unidades(a.nuevo, 2)}. Revisá moneda y símbolo.`
		});
	}

	// (Ex-Regla 3 — "sin foto hace N días": eliminada. Desde el Bloque 2 la foto de
	// cartera es automática en cada refresco de precios (auto cada 20 min o botón
	// "Actualizar precios"), ya no es una acción manual que pueda quedar atrasada.)

	// Regla 3 — Recurrentes próximos [hoy, hoy+3] no registrados en el período activo.
	// NOTA: usa dia_esperado crudo (comportamiento actual). Cuando exista el Brief 1
	// (paga_con_sueldo), este dia_esperado se reemplaza por diaEfectivo().
	const hasta = addDias(hoy, 3);
	const per = periodoActivoCC(); // 'yyyy-mm' o null
	const proximos = (rows: any[]): ItemRecurrente[] =>
		rows
			.map((r) => ({ id: r.id as number, nombre: r.nombre as string, fecha: proximaOcurrencia(r.dia_esperado, hoy) }))
			.filter((x) => x.fecha >= hoy && x.fecha <= hasta)
			.map((x) => ({ id: x.id, nombre: x.nombre, dias: diasEntre(hoy, x.fecha) }))
			.sort((a, b) => a.dias - b.dias);

	// Gastos fijos: disparabilidad contra el período activo (sin cambios).
	const gs = (await query(
		`SELECT s.id, s.nombre, s.dia_esperado FROM suscripcion s
		 WHERE s.perfil_id=1 AND s.activa=1 AND s.dia_esperado IS NOT NULL
		   AND NOT EXISTS (SELECT 1 FROM suscripcion_registro r WHERE r.suscripcion_id=s.id AND r.periodo=?)`,
		[per]
	)) as any[];

	// Ingresos fijos: el SUELDO (Ingreso Principal Regular) en modo sueldo evalúa su
	// disparabilidad contra periodoRegla(hoy) — la regla del 20 — para romper el
	// deadlock (registrado el sueldo del período, no reaparece porque el período no
	// avanza hasta disparar el sueldo). Del 5 al 19 mapea al mes actual (registrado →
	// no disparable); a partir del 20 mapea al mes siguiente (no registrado → disparable,
	// abre el período nuevo). El resto de los recurrentes: contra el período activo.
	const modo = await cargarModo();
	const isCand = (await query(
		`SELECT i.id, i.nombre, i.dia_esperado, i.categoria, i.tipo FROM ingreso_fijo i
		 WHERE i.perfil_id=1 AND i.activa=1 AND i.dia_esperado IS NOT NULL`
	)) as any[];
	const perObjetivo = (r: any): string | null =>
		modo === 'sueldo' && r.categoria === 'Ingreso Principal' && r.tipo === 'Sueldo'
			? periodoRegla(hoy, 'Ingreso Principal')
			: per;
	const ids = isCand.map((r) => r.id);
	const regsIF = ids.length
		? ((await query(
				`SELECT ingreso_fijo_id, periodo FROM ingreso_fijo_registro WHERE ingreso_fijo_id IN (${ids.map(() => '?').join(',')})`,
				ids
			)) as any[])
		: [];
	const regIFSet = new Set(regsIF.map((x) => x.ingreso_fijo_id + ':' + x.periodo));
	const is = isCand.filter((r) => !regIFSet.has(r.id + ':' + perObjetivo(r)));

	const pagos = proximos(gs);
	const cobros = proximos(is);

	// Recurrentes ya vistos en el período activo (no cuentan al badge; siguen en lista).
	const perKey = periodoVisto();
	const vistos = (await query(
		'SELECT tipo, ref_id FROM notif_visto WHERE perfil_id=1 AND periodo=?',
		[perKey]
	)) as any[];
	const vistoSet = new Set(vistos.map((v) => v.tipo + ':' + v.ref_id));
	const noVistos = (arr: ItemRecurrente[], tipo: string) =>
		arr.reduce((n, x) => n + (vistoSet.has(tipo + ':' + x.id) ? 0 : 1), 0);

	// Badge: reglas rotas (persistentes) + recurrentes en ventana aún no vistos (por evento).
	const badge = reglas.length + noVistos(pagos, 'pago') + noVistos(cobros, 'cobro');
	return { pagos, cobros, reglas, badge };
}

// Marca como vistos (para el período activo) todos los recurrentes actualmente en la
// ventana [hoy, hoy+3]. Lo llama el centro de notificaciones al abrirse: apaga esos
// eventos del badge sin sacarlos de la lista. Idempotente (INSERT OR IGNORE por UNIQUE).
export async function marcarRecurrentesVistos(): Promise<void> {
	const n = await cargarNotificaciones();
	const perKey = periodoVisto();
	const stmts = [
		...n.pagos.map((p) => ({
			sql: "INSERT OR IGNORE INTO notif_visto (perfil_id, tipo, ref_id, periodo) VALUES (1, 'pago', ?, ?)",
			bind: [p.id, perKey] as any[]
		})),
		...n.cobros.map((c) => ({
			sql: "INSERT OR IGNORE INTO notif_visto (perfil_id, tipo, ref_id, periodo) VALUES (1, 'cobro', ?, ?)",
			bind: [c.id, perKey] as any[]
		}))
	];
	if (stmts.length) await queryBatch(stmts);
}
