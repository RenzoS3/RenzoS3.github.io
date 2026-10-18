// src/lib/sheets/conexion.ts
// Rienda + Sheets: el "enlace de conexión" (URL del Apps Script + clave) y las
// tres llamadas al puente: ping, bajar todo y subir cambios.

import type { Payload } from './tablas';
import { HOJAS_CON_ID } from './tablas';

const LS = 'rienda_sheets_conexion';

export type Conexion = { url: string; clave: string };

export function leerConexion(): Conexion | null {
	try {
		const c = JSON.parse(localStorage.getItem(LS) ?? 'null');
		return c?.url && c?.clave ? c : null;
	} catch {
		return null;
	}
}

export function guardarConexion(c: Conexion) {
	try { localStorage.setItem(LS, JSON.stringify(c)); } catch { /* sin storage: dura la sesión */ }
}

export function borrarConexion() {
	try { localStorage.removeItem(LS); } catch { /* ignore */ }
}

// Acepta el enlace tal cual lo muestra el Apps Script:
// https://script.google.com/macros/s/XXXX/exec?k=CLAVE
// También acepta la URL y la clave pegadas juntas, separadas por un espacio.
export function parsearEnlace(texto: string): Conexion | null {
	try {
		const partes = texto.trim().split(/\s+/);
		const u = new URL(partes[0]);
		const clave = u.searchParams.get('k') ?? partes.slice(1).find((p) => /^[0-9a-f]{32}$/i.test(p)) ?? null;
		if (!clave) return null;
		u.search = '';
		u.hash = '';
		return { url: u.toString(), clave };
	} catch {
		return null;
	}
}

// Enlace que viene en la URL de la app (#conectar=...): se guarda y se limpia.
export function tomarEnlaceDeLaUrl(): Conexion | null {
	try {
		const m = location.hash.match(/conectar=([^&]+)/);
		if (!m) return null;
		const c = parsearEnlace(decodeURIComponent(m[1]));
		history.replaceState(null, '', location.pathname + location.search);
		if (!c) return null;
		// Si ya había otra Sheet conectada, se pide confirmación: un enlace ajeno
		// no puede cambiar en silencio a dónde van tus datos.
		const actual = leerConexion();
		if (actual && (actual.url !== c.url || actual.clave !== c.clave)) {
			if (!confirm('Este enlace conecta la app con otra Sheet. ¿Cambiar la conexión?')) return actual;
		}
		guardarConexion(c);
		return c;
	} catch {
		return null;
	}
}

export class ErrorPuente extends Error {
	sinRed: boolean;
	constructor(msg: string, sinRed = false) {
		super(msg);
		this.sinRed = sinRed;
	}
}

async function pedir(c: Conexion, init: RequestInit & { params?: Record<string, string> }, ms = 45000): Promise<any> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ms);
	let resp: Response;
	try {
		const u = new URL(c.url);
		for (const [k, v] of Object.entries(init.params ?? {})) u.searchParams.set(k, v);
		resp = await fetch(u.toString(), { ...init, signal: ctrl.signal, redirect: 'follow', cache: 'no-store' });
	} catch (e: any) {
		throw new ErrorPuente(e?.name === 'AbortError' ? 'La Sheet tardó demasiado en contestar.' : 'No hay conexión con la Sheet.', true);
	} finally {
		clearTimeout(timer);
	}
	let data: any;
	try {
		data = await resp.json();
	} catch {
		throw new ErrorPuente(`La Sheet contestó algo inesperado (HTTP ${resp.status}). ¿El enlace es el correcto?`);
	}
	if (!data?.ok) throw new ErrorPuente(data?.error ?? 'Error desconocido del puente.');
	return data;
}

export async function ping(c: Conexion): Promise<{ hoja: string }> {
	return pedir(c, { method: 'GET', params: { op: 'ping', k: c.clave } }, 20000);
}

export async function bajar(c: Conexion): Promise<Payload & { ts: string }> {
	return pedir(c, { method: 'GET', params: { op: 'load', k: c.clave, ids: HOJAS_CON_ID.join(',') } });
}

export type CambiosHoja = {
	hoja: string;
	libro: 'finanzas' | 'inversiones';
	header: string[];
	clave: string;
	formatos: Record<string, string>;
	upserts: { clave: string; fila: unknown[]; nuevo: boolean }[];
	deletes: string[];
};

export async function subir(c: Conexion, cambios: CambiosHoja[]): Promise<{ remap: Record<string, Record<string, string>> }> {
	// text/plain evita el preflight CORS (Apps Script no contesta OPTIONS).
	return pedir(c, {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain;charset=utf-8' },
		body: JSON.stringify({ k: c.clave, op: 'push', cambios })
	});
}
