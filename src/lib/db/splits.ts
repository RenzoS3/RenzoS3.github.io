// src/lib/db/splits.ts
// Rienda + Sheets: cambios de ratio / splits de un activo.
//
// Cuando un CEDEAR cambia de ratio (SPY 3:1 en jun'26) o una acción hace un
// split (YPFD 10:1 en ago'26), las unidades viejas se cargan ya multiplicadas
// (así la tenencia de hoy cierra con el broker), pero el histórico de data912
// viene SIN ajustar: antes de esa fecha el precio está en la escala vieja. Sin
// corregirlo, la cartera valuada a cualquier fecha anterior daría 3x o 10x.
//
// Se configura en la Sheet Inversiones, pestaña _activos, columna "splits":
//   2026-06-01:3            (un cambio)
//   2026-06-01:3; 2026-08-04:10
// La fecha es aproximada: el corte real se busca en la propia serie (el día en
// que el precio cae ~factor veces, dentro de ±20 días). Si la serie no muestra
// ese salto, se asume que ya viene ajustada y no se toca.

export type Split = { fecha: string; factor: number };

export function parsearSplits(txt: string | null | undefined): Split[] {
	if (!txt) return [];
	const out: Split[] = [];
	for (const parte of String(txt).split(/[;\n]+/)) {
		const m = parte.trim().match(/^(\d{4}-\d{2}-\d{2})\s*[:x×=]\s*(\d+(?:[.,]\d+)?)$/i);
		if (!m) continue;
		const factor = Number(m[2].replace(',', '.'));
		if (Number.isFinite(factor) && factor > 0 && factor !== 1) out.push({ fecha: m[1], factor });
	}
	return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export function splitsValidos(txt: string | null | undefined): boolean {
	if (txt == null || String(txt).trim() === '') return true;
	const partes = String(txt).split(/[;\n]+/).filter((p) => p.trim());
	return parsearSplits(txt).length === partes.length;
}

const DIA = 86400000;
const t = (iso: string) => Date.parse(iso + 'T00:00:00Z');

// Busca el día de corte real de un split cerca de la fecha aproximada: el par de
// cierres consecutivos cuyo cociente (anterior / siguiente) se parece más al
// factor. Devuelve la fecha del primer cierre en escala nueva, o null.
export function corteDeSplit(serie: { fecha: string; precio: number }[], s: Split, margenDias = 20): string | null {
	const centro = t(s.fecha);
	let mejor: { fecha: string; err: number } | null = null;
	for (let i = 1; i < serie.length; i++) {
		const f = serie[i].fecha;
		if (Math.abs(t(f) - centro) > margenDias * DIA) continue;
		const prev = serie[i - 1].precio;
		const cur = serie[i].precio;
		if (!(prev > 0 && cur > 0)) continue;
		const err = Math.abs(prev / cur / s.factor - 1);
		if (err < 0.3 && (!mejor || err < mejor.err)) mejor = { fecha: f, err };
	}
	return mejor?.fecha ?? null;
}

// Devuelve la serie con los precios anteriores a cada split divididos por su
// factor. La serie de entrada puede venir desordenada.
export function ajustarSerie<T extends { fecha: string; precio: number }>(serie: T[], splits: Split[]): T[] {
	if (!splits.length || !serie.length) return serie;
	const ord = serie.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
	const cortes: { fecha: string; factor: number }[] = [];
	for (const s of splits) {
		const f = corteDeSplit(ord, s);
		if (f) cortes.push({ fecha: f, factor: s.factor });
	}
	if (!cortes.length) return ord;
	return ord.map((p) => {
		let div = 1;
		for (const c of cortes) if (p.fecha < c.fecha) div *= c.factor;
		return div === 1 ? p : { ...p, precio: p.precio / div };
	});
}
