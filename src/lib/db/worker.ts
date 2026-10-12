import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { SCHEMA } from './schema';
import { SEED_MACRO } from './seed_macro';

let db: any = null;

// ===== Clasificación de tablas por módulo (para registrar última edición) =====
const TABLAS_FINANZAS = new Set([
	'gasto', 'ingreso', 'categoria', 'subcategoria', 'mapeo_detalle',
	'tarjeta', 'suscripcion', 'suscripcion_registro', 'presupuesto', 'reserva_credito'
]);
const TABLAS_INVERSIONES = new Set([
	'activo', 'transaccion', 'renta_activo', 'cuenta_inversion', 'snapshot', 'liquidez', 'mov_caja',
	'precio_historico'
]);
// Neutras (no cuentan como edición del usuario): cotizacion_dolar, inflacion,
// perfil, meta. No actualizan ninguna fecha.

// Detecta si un SQL es de escritura y a qué tabla apunta.
function tablaAfectada(sql: string): string | null {
	const s = sql.trim().toLowerCase();
	let m: RegExpMatchArray | null = null;
	if (s.startsWith('insert')) m = s.match(/insert\s+(?:or\s+\w+\s+)?into\s+["']?(\w+)/);
	else if (s.startsWith('update')) m = s.match(/update\s+["']?(\w+)/);
	else if (s.startsWith('delete')) m = s.match(/delete\s+from\s+["']?(\w+)/);
	return m ? m[1] : null;
}

// Clave de meta que corresponde a un SQL de escritura (o null si es neutro).
function claveEdicion(sql: string): string | null {
	const tabla = tablaAfectada(sql);
	if (!tabla) return null;
	// Las actualizaciones de precio (mark de mercado, manual o automático) no son
	// edición de datos del usuario: no deben marcar "cambios sin respaldar".
	if (tabla === 'activo' && /^\s*update\s+activo\s+set\s+precio_actual\b/i.test(sql)) return null;
	if (TABLAS_FINANZAS.has(tabla)) return 'ultima_edicion_finanzas';
	if (TABLAS_INVERSIONES.has(tabla)) return 'ultima_edicion_inversiones';
	return null; // tabla neutra
}

function escribirClaves(claves: Set<string>) {
	const ahora = new Date().toISOString();
	for (const clave of claves) {
		db.exec({
			sql: "INSERT INTO meta (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor",
			bind: [clave, ahora]
		});
	}
}

// Registra la última edición del módulo correspondiente (si aplica).
function registrarEdicion(sql: string) {
	const clave = claveEdicion(sql);
	if (clave) escribirClaves(new Set([clave]));
}

async function init() {
	const sqlite3 = await sqlite3InitModule();
	// Rienda + Sheets: la base vive en MEMORIA. La fuente de verdad es la Google
	// Sheet "Finanzas": al abrir, sync.svelte.ts la baja y la carga acá; cada
	// cambio se vuelve a escribir en la Sheet. Nada importante queda en el
	// almacenamiento del navegador, así que si iOS lo borra no se pierde nada
	// (y desaparecen los cuelgues por el lock exclusivo del pool OPFS).
	db = new sqlite3.oo1.DB(':memory:', 'c');
	db.exec(SCHEMA);

	// Columna periodo en ingreso (agregada después del schema original)
	const cols = db.exec({ sql: 'PRAGMA table_info(ingreso)', rowMode: 'object', returnValue: 'resultRows' });
	if (!cols.some((c: any) => c.name === 'periodo')) {
		db.exec('ALTER TABLE ingreso ADD COLUMN periodo TEXT');
	}

	// Columnas de pago en transaccion (para mover liquidez en la moneda de pago)
	const tcols = db.exec({ sql: 'PRAGMA table_info(transaccion)', rowMode: 'object', returnValue: 'resultRows' });
	if (!tcols.some((c: any) => c.name === 'moneda_pago')) {
		db.exec('ALTER TABLE transaccion ADD COLUMN moneda_pago TEXT');
	}
	if (!tcols.some((c: any) => c.name === 'monto_pago')) {
		db.exec('ALTER TABLE transaccion ADD COLUMN monto_pago REAL');
	}

	// Columna simbolo_cotizacion en activo: el símbolo exacto de data912 para
	// auto-actualizar el precio (p.ej. 'DICP', 'MELID'). NULL = solo manual.
	const acols = db.exec({ sql: 'PRAGMA table_info(activo)', rowMode: 'object', returnValue: 'resultRows' });
	if (!acols.some((c: any) => c.name === 'simbolo_cotizacion')) {
		db.exec('ALTER TABLE activo ADD COLUMN simbolo_cotizacion TEXT');
	}
	// Columna exposicion (Dolar | CER | Peso): a qué tipo de cambio está atado el
	// valor del activo. Se agrega sin CHECK (ALTER) y se backfillea por regla: USD,
	// CEDEAR o Indice -> Dolar (los índices en ARS son igual que un CEDEAR: cotizan
	// en pesos pero siguen el activo/commodity en USD), el resto -> Peso. El usuario
	// ajusta CER y dollar-linked a mano.
	if (!acols.some((c: any) => c.name === 'exposicion')) {
		db.exec('ALTER TABLE activo ADD COLUMN exposicion TEXT');
		db.exec("UPDATE activo SET exposicion = CASE WHEN moneda='USD' OR tipo IN ('CEDEAR','Indice') THEN 'Dolar' ELSE 'Peso' END WHERE exposicion IS NULL");
	}

	// Columna es_ahorro en categoria (0|1): marca la categoría reservada para
	// plata que el usuario aparta del consumo (dólares, plazo fijo, colchón, etc.).
	// Se agrega sin CHECK (ALTER), igual criterio que exposicion en activo.
	const catcols = db.exec({ sql: 'PRAGMA table_info(categoria)', rowMode: 'object', returnValue: 'resultRows' });
	if (!catcols.some((c: any) => c.name === 'es_ahorro')) {
		db.exec('ALTER TABLE categoria ADD COLUMN es_ahorro INTEGER NOT NULL DEFAULT 0');
	}

	// Columna es_meta_ahorro en subcategoria (0|1): marca la subcategoría cuyo
	// presupuesto se autocompleta con la meta de ahorro (umbral% x ingresos
	// regulares), calculada en Home. Mismo criterio que es_ahorro en categoria.
	const subcols = db.exec({ sql: 'PRAGMA table_info(subcategoria)', rowMode: 'object', returnValue: 'resultRows' });
	if (!subcols.some((c: any) => c.name === 'es_meta_ahorro')) {
		db.exec('ALTER TABLE subcategoria ADD COLUMN es_meta_ahorro INTEGER NOT NULL DEFAULT 0');
	}

	// Columna modo_periodo en perfil (sueldo | calendario). Default 'sueldo'
	// mantiene el comportamiento histórico para perfiles ya existentes.
	const pcols = db.exec({ sql: 'PRAGMA table_info(perfil)', rowMode: 'object', returnValue: 'resultRows' });
	if (!pcols.some((c: any) => c.name === 'modo_periodo')) {
		db.exec("ALTER TABLE perfil ADD COLUMN modo_periodo TEXT NOT NULL DEFAULT 'sueldo'");
	}

	// Columna detalle en suscripcion (Item 2: los pagos fijos aterrizan en su
	// subcategoria via mapeo_detalle, igual que un gasto). Migra los existentes
	// usando el nombre como detalle.
	const scols = db.exec({ sql: 'PRAGMA table_info(suscripcion)', rowMode: 'object', returnValue: 'resultRows' });
	if (!scols.some((c: any) => c.name === 'detalle')) {
		db.exec('ALTER TABLE suscripcion ADD COLUMN detalle TEXT');
		db.exec('UPDATE suscripcion SET detalle = nombre WHERE detalle IS NULL');
	}

	// Columna dia_esperado en suscripcion e ingreso_fijo: día estimado de pago/cobro
	// del recurrente, que ordena la lista. Sin backfill (queda NULL = "sin día", va
	// al final). Ojo: SQLite no permite agregar un CHECK vía ALTER, así que en bases
	// existentes el rango 1-31 lo garantiza el dropdown de la UI, no la tabla; las
	// bases nuevas sí lo traen desde el CREATE de schema.ts.
	if (!scols.some((c: any) => c.name === 'dia_esperado')) {
		db.exec('ALTER TABLE suscripcion ADD COLUMN dia_esperado INTEGER');
	}
	const ifcols = db.exec({ sql: 'PRAGMA table_info(ingreso_fijo)', rowMode: 'object', returnValue: 'resultRows' });
	if (!ifcols.some((c: any) => c.name === 'dia_esperado')) {
		db.exec('ALTER TABLE ingreso_fijo ADD COLUMN dia_esperado INTEGER');
	}

	// Reset one-time de dia_esperado (v38 → v39). La primera versión cargó el campo
	// con semántica de POSICIÓN en el período (modo sueldo: 1 = día de cobro, 2 = el
	// siguiente…). v39 lo redefine como día CALENDARIO real (1-31) en todos los modos,
	// así que los valores viejos quedan corruptos con la interpretación nueva. Se
	// resetean a NULL una sola vez, guardado por un flag en meta: sin el guard cada
	// arranque volvería a borrar lo que el usuario recargue con la semántica nueva.
	const resetFlag = db.exec({
		sql: "SELECT valor FROM meta WHERE clave='reset_dia_esperado_v2'",
		rowMode: 'object', returnValue: 'resultRows'
	});
	if (resetFlag.length === 0) {
		db.exec('UPDATE suscripcion SET dia_esperado = NULL');
		db.exec('UPDATE ingreso_fijo SET dia_esperado = NULL');
		db.exec("INSERT INTO meta (clave, valor) VALUES ('reset_dia_esperado_v2', '1')");
	}

	// Columna auto en presupuesto (Item 2: el presupuesto de una subcat con pago
	// fijo se autocompleta y no se edita desde la tabla; auto=1 lo marca).
	const prcols = db.exec({ sql: 'PRAGMA table_info(presupuesto)', rowMode: 'object', returnValue: 'resultRows' });
	if (!prcols.some((c: any) => c.name === 'auto')) {
		db.exec('ALTER TABLE presupuesto ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
	}

	// Migración: renombrar categorías de ingreso (Salario→Ingreso Principal),
	// ampliar el CHECK para 'Ingresos Secundarios' y RELAJAR el CHECK compuesto
	// que ataba tipo a la categoría (ahora tipo es libre en cualquier categoría).
	// El CHECK está cocido en el CREATE, así que hay que recrear la tabla.
	// Idempotente: corre si el esquema NO menciona 'Ingreso Principal' (base vieja)
	// O si todavía arrastra el CHECK compuesto viejo (base renombrada pero no relajada).
	const isql = db.exec({
		sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='ingreso'",
		rowMode: 'object', returnValue: 'resultRows'
	});
	const ingDef: string = isql[0]?.sql ?? '';
	const faltaRenombrar = ingDef && !ingDef.includes('Ingreso Principal');
	const tieneCheckViejo = ingDef.includes('AND tipo IS NOT NULL');
	// Brief 6: cuarto valor 'Desahorro' en el enum de categoria. El CHECK está cocido
	// en el CREATE, así que si la tabla existente no lo menciona hay que recrearla.
	const faltaDesahorro = ingDef && !ingDef.includes('Desahorro');
	if (faltaRenombrar || tieneCheckViejo || faltaDesahorro) {
		db.exec(`
			PRAGMA legacy_alter_table=ON;
			BEGIN;
			ALTER TABLE ingreso RENAME TO ingreso_old;
			CREATE TABLE ingreso (
				id          INTEGER PRIMARY KEY,
				perfil_id   INTEGER NOT NULL REFERENCES perfil(id),
				fecha       TEXT NOT NULL,
				monto       REAL NOT NULL CHECK (monto > 0),
				moneda      TEXT NOT NULL CHECK (moneda IN ('ARS','USD')),
				categoria   TEXT NOT NULL CHECK (categoria IN ('Ingreso Principal','Ingresos Secundarios','Otros','Desahorro')),
				tipo        TEXT CHECK (tipo IN ('Sueldo','Aciclico')),
				detalle     TEXT,
				periodo     TEXT
			);
			INSERT INTO ingreso (id, perfil_id, fecha, monto, moneda, categoria, tipo, detalle, periodo)
				SELECT id, perfil_id, fecha, monto, moneda,
					CASE categoria WHEN 'Salario' THEN 'Ingreso Principal' ELSE categoria END,
					tipo, detalle, periodo
				FROM ingreso_old;
			DROP TABLE ingreso_old;
			CREATE INDEX IF NOT EXISTS idx_ingreso_periodo ON ingreso(perfil_id, periodo);
			COMMIT;
			PRAGMA legacy_alter_table=OFF;
		`);
	}

	// Reparación (Brief D): en bases donde la recreación de `ingreso` ya corrió con el
	// default moderno (legacy_alter_table OFF), el RENAME reescribió la FK de la tabla
	// hija ingreso_fijo_registro (ingreso_id -> ingreso(id)) para apuntar a `ingreso_old`;
	// al dropear ingreso_old la FK quedó colgada y registrar un recurrente tiraba
	// "no such table: main.ingreso_old". Corregir el helper no repara las bases ya rotas,
	// así que se reconstruye la tabla hija con la FK correcta. Guard idempotente sobre
	// sqlite_master: solo corre si queda alguna tabla con referencia colgada a un `*_old`.
	// El ÚNICO objeto que puede quedar colgado es ingreso_fijo_registro (única hija de las
	// tablas recreadas por RENAME; cotizacion_dolar no tiene hijas). Corre con foreign_keys
	// OFF (estado durante las migraciones, antes del PRAGMA foreign_keys=ON final).
	const colgados = db.exec({
		sql: "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%ingreso_old%'",
		rowMode: 'object', returnValue: 'resultRows'
	});
	if (colgados.some((r: any) => r.name === 'ingreso_fijo_registro')) {
		db.exec(`
			PRAGMA legacy_alter_table=ON;
			BEGIN;
			ALTER TABLE ingreso_fijo_registro RENAME TO ingreso_fijo_registro_roto;
			CREATE TABLE ingreso_fijo_registro (
				id               INTEGER PRIMARY KEY,
				ingreso_fijo_id  INTEGER NOT NULL REFERENCES ingreso_fijo(id),
				ingreso_id       INTEGER NOT NULL REFERENCES ingreso(id),
				periodo          TEXT NOT NULL,
				UNIQUE (ingreso_fijo_id, periodo)
			);
			INSERT INTO ingreso_fijo_registro (id, ingreso_fijo_id, ingreso_id, periodo)
				SELECT id, ingreso_fijo_id, ingreso_id, periodo FROM ingreso_fijo_registro_roto;
			DROP TABLE ingreso_fijo_registro_roto;
			CREATE INDEX IF NOT EXISTS idx_ifreg_ingreso ON ingreso_fijo_registro(ingreso_id);
			COMMIT;
			PRAGMA legacy_alter_table=OFF;
		`);
	}

	// Migración: si la tabla cotizacion_dolar no tiene columna 'casa', la recreamos.
	const cdcols = db.exec({ sql: 'PRAGMA table_info(cotizacion_dolar)', rowMode: 'object', returnValue: 'resultRows' });
	if (!cdcols.some((c: any) => c.name === 'casa')) {
		db.exec(`
			PRAGMA legacy_alter_table=ON;
			BEGIN;
			ALTER TABLE cotizacion_dolar RENAME TO cotizacion_dolar_old;
			CREATE TABLE cotizacion_dolar (
				id INTEGER PRIMARY KEY,
				perfil_id INTEGER NOT NULL REFERENCES perfil(id),
				casa TEXT NOT NULL DEFAULT 'bolsa',
				fecha TEXT NOT NULL,
				valor REAL NOT NULL CHECK (valor > 0),
				UNIQUE (perfil_id, casa, fecha)
			);
			INSERT INTO cotizacion_dolar (perfil_id, casa, fecha, valor)
				SELECT perfil_id, 'bolsa', fecha, valor FROM cotizacion_dolar_old;
			DROP TABLE cotizacion_dolar_old;
			COMMIT;
			PRAGMA legacy_alter_table=OFF;
		`);
	}

	// Datos macro (dólar/inflación): públicos, fallback inicial. Solo si hay perfil.
	const rp = db.exec({ sql: 'SELECT COUNT(*) AS n FROM perfil', rowMode: 'object', returnValue: 'resultRows' });
	if (rp[0].n > 0) {
		const rm = db.exec({ sql: 'SELECT COUNT(*) AS n FROM cotizacion_dolar', rowMode: 'object', returnValue: 'resultRows' });
		if (rm[0].n === 0 && SEED_MACRO && SEED_MACRO.trim()) {
			db.exec(SEED_MACRO);
		}

		// Backfill de la categoría de Ahorro para perfiles que ya existían antes de
		// esta función (el seed de un perfil nuevo ya la trae). Idempotente: solo
		// actúa si todavía no hay ninguna categoría marcada es_ahorro=1. Si el
		// usuario ya tenía una categoría llamada "Ahorro" (creada a mano), se
		// promueve esa en vez de insertar una duplicada (chocaría con el UNIQUE
		// perfil_id+nombre). Si no existe, se crea.
		const ra = db.exec({
			sql: "SELECT COUNT(*) AS n FROM categoria WHERE perfil_id=1 AND es_ahorro=1",
			rowMode: 'object', returnValue: 'resultRows'
		});
		if (ra[0].n === 0) {
			const yaExiste = db.exec({
				sql: "SELECT id FROM categoria WHERE perfil_id=1 AND TRIM(nombre) = 'Ahorro' COLLATE NOCASE",
				rowMode: 'object', returnValue: 'resultRows'
			});
			if (yaExiste.length > 0) {
				db.exec({ sql: 'UPDATE categoria SET es_ahorro=1 WHERE id=?', bind: [yaExiste[0].id] });
			} else {
				db.exec("INSERT INTO categoria (perfil_id, nombre, es_ahorro) VALUES (1, 'Ahorro', 1)");
			}
		}

		// Backfill de la subcategoría de Meta de ahorro (columna es_meta_ahorro).
		// Idempotente: solo actúa si no hay ninguna subcategoría marcada
		// es_meta_ahorro=1 para este perfil. A diferencia de la categoría Ahorro,
		// NO se promueve ninguna subcategoría existente por uso (no se toca
		// "Inversión" ni ninguna otra) — solo se reutiliza si YA existe una
		// literalmente llamada "Meta ahorro" (choca con el UNIQUE perfil_id+nombre
		// si no), si no, se crea nueva.
		const rsma = db.exec({
			sql: "SELECT COUNT(*) AS n FROM subcategoria WHERE perfil_id=1 AND es_meta_ahorro=1",
			rowMode: 'object', returnValue: 'resultRows'
		});
		if (rsma[0].n === 0) {
			const subYaExiste = db.exec({
				sql: "SELECT id FROM subcategoria WHERE perfil_id=1 AND TRIM(nombre) = 'Meta ahorro' COLLATE NOCASE",
				rowMode: 'object', returnValue: 'resultRows'
			});
			if (subYaExiste.length > 0) {
				db.exec({ sql: 'UPDATE subcategoria SET es_meta_ahorro=1 WHERE id=?', bind: [subYaExiste[0].id] });
			} else {
				db.exec("INSERT INTO subcategoria (perfil_id, nombre, es_meta_ahorro) VALUES (1, 'Meta ahorro', 1)");
			}
		}
	}

	// Barrido idempotente de registros de ingreso fijo sucios, de disparos viejos
	// (antes de unificar el período del disparo en una sola fuente):
	//   1) Huérfanos: registro cuyo ingreso_id ya no existe -> se borran.
	//   2) Desalineados: registro cuyo período difiere del ingreso referenciado ->
	//      se realinea al período del ingreso, SOLO si no colisiona con el
	//      UNIQUE(ingreso_fijo_id, periodo). Deja al ingreso volver a ser borrable
	//      y arregla el guard "Registrado ✓". En try para no abortar el arranque.
	try {
		db.exec('DELETE FROM ingreso_fijo_registro WHERE ingreso_id NOT IN (SELECT id FROM ingreso)');
		db.exec(`
			UPDATE ingreso_fijo_registro
			SET periodo = (SELECT i.periodo FROM ingreso i WHERE i.id = ingreso_fijo_registro.ingreso_id)
			WHERE EXISTS (
				SELECT 1 FROM ingreso i
				WHERE i.id = ingreso_fijo_registro.ingreso_id
				  AND i.periodo IS NOT NULL AND i.periodo <> ingreso_fijo_registro.periodo)
			AND NOT EXISTS (
				SELECT 1 FROM ingreso_fijo_registro r2
				WHERE r2.ingreso_fijo_id = ingreso_fijo_registro.ingreso_fijo_id
				  AND r2.id <> ingreso_fijo_registro.id
				  AND r2.periodo = (SELECT i.periodo FROM ingreso i WHERE i.id = ingreso_fijo_registro.ingreso_id))
		`);
	} catch { /* la limpieza no debe bloquear el arranque */ }

	// Migración de liquidez (Bloque 3), UNA sola vez: el ancla manual desaparece
	// — el saldo de cada fila de `liquidez` se migra a un movimiento de apertura
	// en mov_caja, fechado a HOY (el día en que este código corre por primera
	// vez en esta base). El guard (meta liquidez_migrada_v1) es necesario: sin
	// él, cada arranque volvería a insertar el movimiento y duplicaría el saldo.
	const migLiq = db.exec({
		sql: "SELECT valor FROM meta WHERE clave='liquidez_migrada_v1'",
		rowMode: 'object', returnValue: 'resultRows'
	});
	if (migLiq.length === 0) {
		const d = new Date();
		const hoy = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
		const anclas = db.exec({
			sql: 'SELECT perfil_id, moneda, saldo FROM liquidez WHERE saldo <> 0',
			rowMode: 'object', returnValue: 'resultRows'
		});
		if (anclas.length > 0) {
			// Esto preserva el total exacto de antes: es la misma suma reordenada,
			// no una estimación — calcularLiquidez() sumaba ancla+movimientos sin
			// filtrar por fecha, así que mover el ancla a un movimiento más no
			// cambia el resultado.
			db.exec('BEGIN');
			try {
				for (const a of anclas) {
					db.exec({
						sql: 'INSERT INTO mov_caja (perfil_id,fecha,accion,moneda,monto,nota) VALUES (?,?,?,?,?,?)',
						bind: [a.perfil_id, hoy, 'Apertura', a.moneda, a.saldo, 'Migración: saldo inicial (ex-ancla de liquidez)']
					});
				}
				db.exec('COMMIT');
			} catch (err) {
				try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
				throw err;
			}
		}
		db.exec("INSERT INTO meta (clave, valor) VALUES ('liquidez_migrada_v1', '1')");
	}

	// Integridad referencial: la base rechaza datos huérfanos (un gasto apuntando
	// a una categoría inexistente, etc.). Se activa DESPUÉS de las migraciones.
	// El import la apaga temporalmente para tolerar backups viejos con huérfanos.
	db.exec('PRAGMA foreign_keys=ON');
}

const ready = init();

self.onmessage = async (e: MessageEvent) => {
	const { id, sql, bind, batch } = e.data;
	try {
		await ready;

		// Lote: muchas sentencias en UN solo mensaje, dentro de una transacción
		// atómica (o entra todo o no entra nada). Usado por import, reset y
		// actualización de cotizaciones para no pagar un viaje por fila.
		if (batch) {
			db.exec('BEGIN');
			try {
				for (const s of batch) db.exec({ sql: s.sql, bind: s.bind ?? [] });
				db.exec('COMMIT');
			} catch (err) {
				try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
				throw err;
			}
			// Una sola marca de edición por módulo afectado (no una por fila)
			try {
				const claves = new Set<string>();
				for (const s of batch) { const c = claveEdicion(s.sql); if (c) claves.add(c); }
				escribirClaves(claves);
			} catch { /* no romper el lote por esto */ }
			self.postMessage({ id, rows: [] });
			return;
		}

		const rows = db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' });
		// Registrar última edición por módulo (después de ejecutar, si fue escritura)
		try { registrarEdicion(sql); } catch { /* no romper la query principal por esto */ }
		self.postMessage({ id, rows });
	} catch (err: any) {
		self.postMessage({ id, error: err?.message ?? String(err) });
	}
};