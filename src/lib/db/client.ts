// Este archivo es el "puente" entre tu pantalla y el worker.
// Le pedís consultas con query(...) y te devuelve los resultados.

let worker: Worker | null = null;
let nextId = 0;
const pendientes = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// Si el worker no contesta en este tiempo, asumimos que quedó colgado (encolado
// detrás de un `await ready` que nunca resuelve, por ejemplo) y lo descartamos
// en vez de dejar la pantalla esperando para siempre sin error ni aviso.
const TIMEOUT_MS = 15000;

// Rechaza TODAS las consultas pendientes (no solo la que venció el timeout: si
// el worker quedó colgado, cualquier otra query encolada detrás de la misma
// nunca va a recibir respuesta tampoco) y descarta el worker roto. La próxima
// query dispara uno nuevo desde cero.
function romperWorker(motivo: string) {
  const err = new Error(motivo);
  for (const p of pendientes.values()) p.reject(err);
  pendientes.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  // Rienda + Sheets: la base está en memoria, así que un worker nuevo arrancaría
  // VACÍO. Nunca seguir trabajando con una base vacía (la sincronización la
  // tomaría como "se borró todo"): se avisa y se recarga la app desde la Sheet.
  workerRoto = true;
  for (const cb of alRomperse) { try { cb(); } catch { /* ignore */ } }
}

// ===== Rienda + Sheets: avisos a la sincronización =====
// La sincronización se entera de cada escritura (para subir el cambio a la
// Sheet) y de si el worker se rompió (para no subir nunca una base vacía).
let workerRoto = false;
const alEscribir = new Set<() => void>();
const alRomperse = new Set<() => void>();
export function onEscritura(cb: () => void): () => void { alEscribir.add(cb); return () => alEscribir.delete(cb); }
export function onWorkerRoto(cb: () => void): () => void { alRomperse.add(cb); return () => alRomperse.delete(cb); }
export function estaRoto(): boolean { return workerRoto; }
const RE_ESCRITURA = /^\s*(insert|update|delete|replace)\b/i;
function avisarEscritura(sql: string) {
  if (!RE_ESCRITURA.test(sql)) return;
  for (const cb of alEscribir) { try { cb(); } catch { /* ignore */ } }
}
// Mientras se carga la base desde la Sheet no se avisa nada (no son cambios).
let silencio = 0;
export async function sinAvisar<T>(fn: () => Promise<T>): Promise<T> {
  silencio++;
  try { return await fn(); } finally { silencio--; }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const { id, rows, error } = e.data;
      const p = pendientes.get(id);
      if (!p) return;
      pendientes.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(rows);
    };
  }
  return worker;
}

// Liberación proactiva del worker en background sostenido. El VFS OPFS-SAHPool
// que usa worker.ts exige lock exclusivo (una sola instancia puede tenerlo
// abierto a la vez): si el sistema operativo congela o mata la pestaña
// mientras el worker sigue "vivo" con el lock tomado, la próxima apertura se
// cuelga esperando ese lock — es la causa de fondo del banner de error
// global. Soltarlo nosotros mismos antes de que eso pase reduce la ventana en
// la que puede ocurrir. Se usa `visibilitychange` (confiable en mobile) y NO
// `pagehide` (no dispara en el escenario real de background + kill, según
// MDN). Con debounce: no actúa en cambios de pantalla cortos (chequear otra
// app, notificación) — solo en background sostenido de 5s+, que es donde el
// SO puede llegar a evaluar descartar la pestaña. Si hay una query en vuelo
// en ese momento se la deja terminar tranquila (no se fuerza el corte): es un
// caso raro y cortarla a la fuerza generaría un error visible falso apenas se
// vuelva a foreground; en el peor caso, si el SO igual mata la pestaña con
// esa query en curso, el timeout de 15s y el banner ya cubren esa red.
// Rienda + Sheets: ese cierre en segundo plano se sacó. Con la base en memoria,
// terminar el worker borraría los datos cargados; ya no hay lock OPFS que liberar.

// Registra una promesa pendiente con watchdog: si nadie la resuelve/rechaza
// dentro de TIMEOUT_MS, se corta el worker y se avisa con un error claro.
function encolarConTimeout(
  id: number,
  resolve: (v: any) => void,
  reject: (e: any) => void
) {
  const timer = setTimeout(() => {
    romperWorker('La base no respondió a tiempo. Cerrá la app por completo y volvé a abrirla.');
  }, TIMEOUT_MS);
  pendientes.set(id, {
    resolve: (v: any) => { clearTimeout(timer); resolve(v); },
    reject: (e: any) => { clearTimeout(timer); reject(e); }
  });
}

// Ejecuta una consulta SQL y devuelve las filas como objetos.
export function query(sql: string, bind: unknown[] = []): Promise<any[]> {
  const id = nextId++;
  if (workerRoto) return Promise.reject(new Error('La base se reinició. Recargando desde la Sheet…'));
  return new Promise<any[]>((resolve, reject) => {
    encolarConTimeout(id, resolve, reject);
    getWorker().postMessage({ id, sql, bind });
  }).then((rows) => {
    if (silencio === 0) avisarEscritura(sql);
    return rows;
  });
}

// Solo para las pruebas automáticas en la compu (nunca en el sitio publicado).
if (typeof location !== 'undefined' && location.hostname === 'localhost') (globalThis as any).__riendaQuery = query;

// Ejecuta MUCHAS sentencias en un solo viaje al worker, dentro de una
// transacción atómica (o entra todo o nada). Para operaciones masivas:
// importar backup, resetear base, actualizar cotizaciones.
export function queryBatch(stmts: { sql: string; bind?: unknown[] }[]): Promise<void> {
  const id = nextId++;
  if (workerRoto) return Promise.reject(new Error('La base se reinició. Recargando desde la Sheet…'));
  return new Promise<void>((resolve, reject) => {
    encolarConTimeout(id, resolve, reject);
    getWorker().postMessage({ id, batch: stmts });
  }).then(() => {
    if (silencio === 0 && stmts.some((s) => RE_ESCRITURA.test(s.sql))) avisarEscritura('insert');
  });
}
