<script lang="ts">
    import { onMount } from 'svelte';
    import { query } from '$lib/db/client';
    import { addMonths, cargarModo, cargarCortes, crearAsignador, type ModoPeriodo } from '$lib/periodo';
    import { mesActual, parseNum, formatNum, soloNum, pesos, mesCorto, diasEntre, hoyISO } from '$lib/format';
    import { leerMeta } from '$lib/db/meta';
    import { exportarDatos } from '$lib/db/backup';
    import Guia from '$lib/Guia.svelte';
    import CountUp from '$lib/CountUp.svelte';
    import Skeleton from '$lib/Skeleton.svelte';

    let periodo = $state(mesActual());
    let grupos = $state<any[]>([]);
    let consolidado = $state<any[]>([]);
    let totales = $state<any>({ n2: 0, n1: 0, presup: 0, real: 0 });
    // Split de "Gasto total del mes" (Ítem 1): consumo real vs. plata apartada en
    // la categoría de Ahorro. Ninguno de los dos resta de Ingreso disponible; son
    // solo una apertura informativa de totales.real (que no cambia) — mismo patrón
    // colapsado/expandido que "Ingreso disponible": el total se ve siempre, el
    // desglose (Gasto real / Ahorro) aparece al abrir.
    let gastoRealMes = $state(0);
    let ahorroMes = $state(0);
    let nombreAhorro = $state('Ahorro'); // nombre editable de la categoría de ahorro
    let gastoAbierto = $state(typeof localStorage !== 'undefined' && localStorage.getItem('gasto_detalle') === '1');
    $effect(() => { try { localStorage.setItem('gasto_detalle', gastoAbierto ? '1' : '0'); } catch { /* ignore */ } });
    // Reserva para tarjetas: suma de cuotas de crédito que vencen en el mes
    // visible. Solo suma al total de PRESUPUESTO (los gastos en crédito ya
    // fueron contados como gasto real el día que se cargaron).
    let creditoMes = $state(0);
    let creditoMesUsd = $state(0);
    let gastoUsdMes = $state(0);   // gastos puntuales USD del período (informativo, sin convertir)
    let ingresoUsdMes = $state(0); // ingresos puntuales USD del período (informativo, sin convertir)
    let nombre = $state('');       // nombre del perfil, para el saludo del header
    // Ingresos TOTALES del período visible (primario + secundarios + otros),
    // en ARS (los USD se convierten al dólar del día de cobro).
    let ingresosMes = $state(0);
    // Ingresos REGULARES del período (Brief 1): solo tipo='Sueldo' en
    // 'Ingreso Principal'/'Ingresos Secundarios', en ARS (USD recurrente al dólar
    // del día). Base del semáforo de la categoría de ahorro. NO incluye 'Otros',
    // Extraordinarios ni 'Desahorro'.
    let ingresosRegularesMes = $state(0);
    // Umbral de tasa de ahorro (A/R): sticky en tabla meta (clave 'umbral_ahorro'),
    // default 0.10 (10%). Fuente ÚNICA compartida con Capacidad de ahorro (Brief 2).
    let umbralAhorro = $state(0.10);
    // Reserva de crédito apartada para el mes visible (plata separada para pagar
    // tarjetas). Netea el "Ingreso disponible para gasto" del Ítem 1.
    let reservaMes = $state(0);
    // Item 2: deuda en cuotas que vence el MES SIGUIENTE vs lo reservado para ese mes.
    let deudaSig = $state(0);
    let deudaSigUsd = $state(0);
    let reservaSig = $state(0);
    let mesSigLabel = $state('');
    // Ingreso disponible = ingresos − (vencimiento de tarjeta del mes − reserva).
    // Concientización de caja: el gasto se cuenta una sola vez (devengado), esto
    // solo ajusta cuánto te queda libre después de separar para las tarjetas.
    let ingresoDisponible = $derived(ingresosMes - (creditoMes - reservaMes));
    // Ingreso disponible en USD: solo aparece cuando hay ALGO que netear (ingreso
    // puntual en USD Y cuota en dólares ese mes). Sin cuota, mostrarlo sería
    // repetir el mismo número que ya se ve en "Ingreso del mes (USD)" sin restar
    // nada — no aporta. Cuando sí aplica, la cuota deja de listarse aparte bajo
    // Gasto y pasa a netear acá — ver disp-pie más abajo.
    let hayNetoUsd = $derived(ingresoUsdMes > 0 && creditoMesUsd > 0);
    let ingresoDisponibleUsd = $derived(hayNetoUsd ? ingresoUsdMes - creditoMesUsd : 0);
    let descubierto = $derived(deudaSig - reservaSig);
    // El valor del descubierto se pinta amarillo solo si supera el 10% del disponible.
    let deudaAlta = $derived(descubierto > 0 && (ingresoDisponible <= 0 || descubierto > ingresoDisponible * 0.10));
    // Detalle del Ingreso disponible: colapsable; recuerda la preferencia.
    let detalleAbierto = $state(typeof localStorage !== 'undefined' && localStorage.getItem('disp_detalle') === '1');
    $effect(() => { try { localStorage.setItem('disp_detalle', detalleAbierto ? '1' : '0'); } catch { /* ignore */ } });
    let deudaAbierto = $state(typeof localStorage !== 'undefined' && localStorage.getItem('deuda_detalle') === '1');
    $effect(() => { try { localStorage.setItem('deuda_detalle', deudaAbierto ? '1' : '0'); } catch { /* ignore */ } });
    // Halo que respira sobre "Cargar ingreso" hasta el primer ingreso cargado. El
    // checklist de primeros pasos se movió al centro de notificaciones.
    let sinIngresos = $state(false);
    let rango = $state('');
    let modo = $state<ModoPeriodo>('sueldo');
    let cargando = $state(true);
    // Navegación de período: límites y secuencia de cortes (fuente: cargarCortes).
    let primerPeriodo = $state('');   // límite inferior (primer corte / mes más viejo con datos)
    let ultimoPeriodo = $state('');   // límite superior (último corte abierto / mes actual en calendario)
    let cortePeriodos = $state<string[]>([]); // periodos de los cortes, en orden (modo sueldo)
    let mesInput: HTMLInputElement | undefined = $state(); // input month oculto que abre el picker nativo
    // Caches por montaje: datos que NO dependen del período visible. Evitan recargar
    // modo/cortes y recomputar la "categoría habitual" (GROUP BY sobre todo el
    // historial) en cada flecha/cambio de mes. Se recalculan al remontar la Home.
    let modoCache: ModoPeriodo | null = null;
    let cortesCache: { fecha: string; periodo: string }[] | null = null;
    let homeCatCache: Record<string, number | null> | null = null;

    // Etiquetas de mes para los encabezados (derivadas del período visible)
    let labN = $state(''); let labN1 = $state(''); let labN2 = $state('');

    // labelMes/labelPeriodo -> mesCorto de $lib/format (helper único, Brief H / A2+B2:
    // "jun '26" en todos lados, nunca mes completo — antes acá se mostraba "Junio 2026").
    const labelMes = mesCorto;
    const labelPeriodo = mesCorto;

    function desvio(real: number, presup: number): string {
        if (!presup) return '—';
        if (real <= presup) return 'En margen';
        if (real <= presup * 1.25) return 'Superado';
        return 'Muy superado';
    }

    async function cargar() {
        cargando = true;

        // Modo y cortes no cambian dentro de la Home -> se cachean (los setea el
        // init del selector; acá solo carga si faltara).
        if (modoCache === null) modoCache = await cargarModo();
        modo = modoCache;
        if (cortesCache === null) cortesCache = modo === 'sueldo' ? await cargarCortes() : [];
        const cortes = cortesCache;
        const asignar = crearAsignador(modo, cortes);

        const n = periodo;
        const n1 = addMonths(periodo, -1);
        const n2 = addMonths(periodo, -2);
        const objetivo = new Set([n, n1, n2]);
        const mesSig = addMonths(n, 1);
        mesSigLabel = labelMes(mesSig);
        // Robustez/escala: acotar la carga de gastos del consolidado al rango de
        // los 3 períodos visibles (no traer todo el historial). Límite inferior =
        // inicio del período más viejo; en modo sueldo, el corte real (puede caer
        // antes del día 1 si el sueldo se cobra anticipado).
        let desdeGastos = `${n2}-01`;
        if (modo === 'sueldo') {
            const fch = cortes.filter((c) => c.periodo === n2 || c.periodo === n1 || c.periodo === n).map((c) => c.fecha).sort();
            if (fch.length) desdeGastos = fch[0];
        }
        // Deuda de credito de un mes M: cuotas repartidas. ARS y USD se devuelven
        // POR SEPARADO (no se convierten: el costo real en pesos de pagar una
        // compra USD en tarjeta difiere del MEP por impuestos/percepciones).
        const CUOTAS_MES = `
            WITH RECURSIVE serie(total, cuotas, c, inicio, moneda, fecha) AS (
                SELECT monto, cuotas, 0, mes_inicio_pago, moneda, fecha
                FROM gasto WHERE perfil_id=1 AND medio='credito'
                UNION ALL
                SELECT total, cuotas, c+1, inicio, moneda, fecha FROM serie WHERE c+1 < cuotas
            )
            SELECT
                COALESCE(SUM(CASE WHEN moneda='USD' THEN 0 ELSE total*1.0/cuotas END),0) AS ars,
                COALESCE(SUM(CASE WHEN moneda='USD' THEN total*1.0/cuotas ELSE 0 END),0) AS usd
            FROM serie WHERE strftime('%Y-%m', date(inicio, '+'||c||' months')) = ?`;

        // Etiquetas de los encabezados
        labN = labelMes(n);
        labN1 = labelMes(n1);
        labN2 = labelMes(n2);

        // Rango de fechas del período visible
        if (modo === 'calendario') {
            rango = `mes calendario ${n}`;
        } else {
            const idx = cortes.findIndex((c) => c.periodo === n);
            if (idx >= 0) {
                const ini = cortes[idx].fecha;
                const fin = idx + 1 < cortes.length ? cortes[idx + 1].fecha : 'hoy';
                rango = `${ini} al ${fin === 'hoy' ? 'hoy' : fin}`;
            } else rango = '(sin sueldo cargado para este período)';
        }

        // Todas las lecturas independientes en paralelo: una sola tanda al worker
        // en vez de encadenarlas (más rápido, sobre todo en mobile).
        const [gastos, hab, subs, cats, presup, cred, ing, dolarBase, resv, deudaR, reservaR, umbralRow] = (await Promise.all([
            query(
                `SELECT g.fecha, g.monto, g.moneda,
                        g.categoria_id,
                        COALESCE(g.subcategoria_id, m.subcategoria_id) AS scid,
                        (SELECT cd.valor FROM cotizacion_dolar cd
                         WHERE cd.perfil_id=1 AND cd.casa='bolsa' AND cd.fecha <= g.fecha
                         ORDER BY cd.fecha DESC LIMIT 1) AS dolar_dia,
                        EXISTS(SELECT 1 FROM suscripcion_registro sr WHERE sr.gasto_id = g.id) AS es_fijo
                 FROM gasto g
                 LEFT JOIN mapeo_detalle m ON m.perfil_id = g.perfil_id AND m.detalle = g.detalle
                 WHERE g.perfil_id = 1 AND g.fecha >= ?`,
                [desdeGastos]
            ),
            homeCatCache === null
                ? query(
                    `SELECT scid, categoria_id, COUNT(*) AS c FROM (
                       SELECT COALESCE(g.subcategoria_id, m.subcategoria_id) AS scid, g.categoria_id
                       FROM gasto g LEFT JOIN mapeo_detalle m ON m.perfil_id=g.perfil_id AND m.detalle=g.detalle
                       WHERE g.perfil_id=1
                     ) GROUP BY scid, categoria_id`
                  )
                : Promise.resolve(null),
            query('SELECT id, nombre, es_meta_ahorro FROM subcategoria WHERE perfil_id=1 AND activa=1'),
            query('SELECT id, nombre, es_ahorro FROM categoria WHERE perfil_id=1'),
            query("SELECT subcategoria_id, monto, auto FROM presupuesto WHERE perfil_id=1 AND periodo='default'"),
            query(CUOTAS_MES, [n]),
            query(
                `SELECT i.monto, i.moneda, i.categoria, i.tipo,
                        (SELECT c.valor FROM cotizacion_dolar c
                         WHERE c.perfil_id=1 AND c.casa='bolsa' AND c.fecha <= i.fecha
                         ORDER BY c.fecha DESC LIMIT 1) AS dolar_dia,
                        EXISTS(SELECT 1 FROM ingreso_fijo_registro r WHERE r.ingreso_id = i.id) AS es_fijo
                 FROM ingreso i
                 WHERE i.perfil_id=1 AND i.periodo=?`,
                [n]
            ),
            query("SELECT valor FROM cotizacion_dolar WHERE perfil_id=1 AND casa='bolsa' ORDER BY fecha ASC LIMIT 1"),
            query('SELECT COALESCE(SUM(monto),0) AS t FROM reserva_credito WHERE perfil_id=1 AND periodo=?', [n]),
            query(CUOTAS_MES, [mesSig]),
            query('SELECT COALESCE(SUM(monto),0) AS t FROM reserva_credito WHERE perfil_id=1 AND periodo=?', [mesSig]),
            query("SELECT valor FROM meta WHERE clave='umbral_ahorro'")
        ])) as any[];
        // MEP base determinístico para ingresos USD sin cotización previa
        // (la más antigua conocida; no cambia con el auto-refresh).
        const dolarPrimero = dolarBase[0]?.valor ?? 1;

        // R = ingresos regulares (Brief 1): tipo 'Sueldo' en Principal/Secundarios,
        // en ARS (USD recurrente al MEP del día; USD puntual excluido, igual que
        // ingresosMes). Excluye 'Otros', Extraordinarios ('Aciclico') y 'Desahorro'.
        // Se calcula acá arriba (antes de presupMap/filas) porque la meta de
        // ahorro derivada de este valor necesita existir como presupuesto real
        // de la subcategoría "Meta ahorro" antes de armar filas/consolidado.
        ingresosRegularesMes = ing.reduce((s: number, r: any) => {
            if (r.tipo !== 'Sueldo') return s;
            if (r.categoria !== 'Ingreso Principal' && r.categoria !== 'Ingresos Secundarios') return s;
            if (r.moneda === 'USD' && !r.es_fijo) return s; // USD puntual: fuera del flujo ARS
            return s + (r.moneda === 'USD' ? r.monto * (r.dolar_dia ?? dolarPrimero) : r.monto);
        }, 0);

        // Umbral de ahorro sticky (meta). Sin valor guardado → default 0.10.
        umbralAhorro = umbralRow?.[0]?.valor != null ? (parseFloat(umbralRow[0].valor) || 0.10) : 0.10;

        // categoría habitual por subcategoría (no depende del período -> se cachea)
        if (homeCatCache === null) {
            const hc: Record<string, number | null> = {};
            const bestC: Record<string, number> = {};
            for (const h of hab) {
                const k = h.scid == null ? 'null' : String(h.scid);
                if (bestC[k] === undefined || h.c > bestC[k]) { bestC[k] = h.c; hc[k] = h.categoria_id; }
            }
            homeCatCache = hc;
        }
        const homeCat = homeCatCache;

        const nombreSub: Record<number, string> = {};
        for (const s of subs) nombreSub[s.id] = s.nombre;
        const nombreCat: Record<number, string> = {};
        const esAhorroCat: Record<number, boolean> = {};
        for (const c of cats) { nombreCat[c.id] = c.nombre; esAhorroCat[c.id] = !!c.es_ahorro; }
        const catAhorro = cats.find((c: any) => c.es_ahorro);
        if (catAhorro) nombreAhorro = catAhorro.nombre;
        const presupMap: Record<number, number> = {};
        const autoMap: Record<number, boolean> = {};
        for (const p of presup) { presupMap[p.subcategoria_id] = p.monto; autoMap[p.subcategoria_id] = !!p.auto; }

        // Meta de ahorro como presupuesto real de una subcategoría dedicada
        // (es_meta_ahorro=1), para que "Total general" la sume sola, sin tocar
        // ningún cálculo existente (Gasto real, Gasto total, umbral, fijos). El
        // monto es el mismo que ya se mostraba pisado visualmente en la fila
        // Ahorro del Consolidado: umbral% x ingresos regulares.
        const subMetaAhorro = subs.find((s: any) => !!s.es_meta_ahorro);
        if (subMetaAhorro) {
            const metaAhorroScid = subMetaAhorro.id;
            const metaAhorroDeseado = Math.round(
                ingresosRegularesMes > 0 ? umbralAhorro * ingresosRegularesMes : 0
            );
            const filaActual = presup.find((p: any) => p.subcategoria_id === metaAhorroScid && !!p.auto);
            const actualRedondeado = filaActual ? Math.round(filaActual.monto) : null;
            // Diff antes de escribir (mismo patrón que recalcPresupuestoFijos en
            // Suscripciones): no reescribe si no cambió, para no disparar el aviso
            // de backup en cada carga de Home.
            if (actualRedondeado !== metaAhorroDeseado) {
                await query(
                    "INSERT INTO presupuesto (perfil_id, subcategoria_id, periodo, monto, auto) VALUES (1, ?, 'default', ?, 1) ON CONFLICT(perfil_id, subcategoria_id, periodo) DO UPDATE SET monto=excluded.monto, auto=1",
                    [metaAhorroScid, metaAhorroDeseado]
                );
            }
            // Pisa en memoria para que se refleje en este mismo render, sin
            // esperar una recarga (presup/presupMap ya se leyeron antes del write).
            presupMap[metaAhorroScid] = metaAhorroDeseado;
            autoMap[metaAhorroScid] = true;
        }

        // Acumular por subcategoría, solo para los 3 períodos objetivo
        const key = (id: any) => (id == null ? 'null' : String(id));
        const acc: Record<string, any> = {};

        let gastoUsdAcc = 0;
        for (const g of gastos) {
            const per = asignar(g.fecha);
            if (!per || !objetivo.has(per)) continue;
            // Puntual en USD (NO originado en un fijo): sale del stock de dólares,
            // se aísla del flujo ARS y se muestra informativo (período visible).
            if (g.moneda === 'USD' && !g.es_fijo) {
                if (per === n) gastoUsdAcc += g.monto;
                continue;
            }
            const k = key(g.scid);
            // ARS directo; USD recurrente (fijo) -> ARS al MEP de la fecha de compra.
            const monto = g.moneda === 'USD' ? g.monto * (g.dolar_dia ?? dolarPrimero) : g.monto;
            acc[k] ??= { scid: g.scid, n2: 0, n1: 0, real: 0 };
            if (per === n2) acc[k].n2 += monto;
            else if (per === n1) acc[k].n1 += monto;
            else if (per === n) acc[k].real += monto;
        }
        gastoUsdMes = gastoUsdAcc;

        for (const p of presup) {
            const k = key(p.subcategoria_id);
            acc[k] ??= { scid: p.subcategoria_id, n2: 0, n1: 0, real: 0 };
        }
        // La subcategoría de meta de ahorro puede no tener gasto ni presupuesto
        // previo (recién creada) -> se asegura su fila igual, para que aparezca
        // en Detalle por subcategoría sin esperar un gasto.
        if (subMetaAhorro) {
            const k = key(subMetaAhorro.id);
            acc[k] ??= { scid: subMetaAhorro.id, n2: 0, n1: 0, real: 0 };
        }

        const filas = Object.values(acc).map((a: any) => {
            const esMetaAhorro = subMetaAhorro != null && a.scid === subMetaAhorro.id;
            const presupVal = a.scid != null ? presupMap[a.scid] ?? 0 : 0;
            // La subcategoría de meta de ahorro es fija: no depende de la
            // inferencia de historial (homeCat) para caer en la categoría Ahorro
            // ni de esAhorroCat — siempre se agrupa y suma como Ahorro.
            const catId = esMetaAhorro ? (catAhorro?.id ?? homeCat[key(a.scid)]) : homeCat[key(a.scid)];
            return {
                scid: a.scid,
                nombre: a.scid == null ? '(sin subcategoría)' : nombreSub[a.scid] ?? '?',
                catNombre: catId != null ? nombreCat[catId] ?? '(sin categoría)' : '(sin categoría)',
                n2: a.n2, n1: a.n1, presup: presupVal, real: a.real,
                autoPresup: a.scid != null ? (autoMap[a.scid] ?? false) : false,
                estado: desvio(a.real, presupVal),
                // Categoría "habitual" de la subcategoría marcada como Ahorro: separa
                // consumo real de plata apartada, sin tocar el resto de las métricas
                // (esta fila sigue sumando igual a totales.real/consolidado).
                esAhorro: esMetaAhorro ? true : (catId != null && !!esAhorroCat[catId])
            };
        });

        // Split informativo para el panel "Ingreso disponible": Gasto real vs Ahorro.
        // No reemplaza a totales.real (que sigue siendo el total de todo, para el
        // consolidado de abajo) — es solo una apertura de esa misma plata.
        gastoRealMes = filas.filter((f) => !f.esAhorro).reduce((s, f) => s + f.real, 0);
        ahorroMes = filas.filter((f) => f.esAhorro).reduce((s, f) => s + f.real, 0);

        const map: Record<string, any[]> = {};
        for (const f of filas) (map[f.catNombre] ??= []).push(f);
        const gr = Object.keys(map).sort((a, b) => a.localeCompare(b, 'es')).map((cat) => {
            const rows = map[cat].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
            const sub = rows.reduce((t, r) => ({ n2: t.n2 + r.n2, n1: t.n1 + r.n1, presup: t.presup + r.presup, real: t.real + r.real }), { n2: 0, n1: 0, presup: 0, real: 0 });
            return { cat, rows, sub, esAhorro: rows.some((r: any) => r.esAhorro) };
        });

        creditoMes = cred[0]?.ars ?? 0;
        creditoMesUsd = cred[0]?.usd ?? 0;

        grupos = gr;
        consolidado = gr.map((g: any) => ({ cat: g.cat, ...g.sub, esAhorro: g.esAhorro, estado: desvio(g.sub.real, g.sub.presup) }));
        totales = filas.reduce((t, r) => ({ n2: t.n2 + r.n2, n1: t.n1 + r.n1, presup: t.presup + r.presup, real: t.real + r.real }), { n2: 0, n1: 0, presup: 0, real: 0 });

        // Ingresos del período en ARS (USD recurrente al MEP del día de cobro,
        // fallback al último). El USD PUNTUAL se aísla (sale del stock de dólares).
        ingresosMes = ing.reduce(
            (s: number, r: any) => (r.moneda === 'USD' && !r.es_fijo) ? s : s + (r.moneda === 'USD' ? r.monto * (r.dolar_dia ?? dolarPrimero) : r.monto),
            0
        );
        ingresoUsdMes = ing.reduce((s: number, r: any) => (r.moneda === 'USD' && !r.es_fijo) ? s + r.monto : s, 0);

        // Reserva de crédito apartada para el mes visible (vacío = 0)
        reservaMes = resv[0]?.t ?? 0;
        deudaSig = deudaR[0]?.ars ?? 0;
        deudaSigUsd = deudaR[0]?.usd ?? 0;
        reservaSig = reservaR[0]?.t ?? 0;

        cargando = false;
    }

    async function guardarPresup(scid: number, valor: string) {
        // Campo vacío = presupuesto 0 (comportamiento histórico de "borrar" el valor).
        // El input está en MILES (consistencia visual con el resto de la tabla) -> se
        // multiplica x1000 antes de guardar el monto real en pesos. parseNum ya soporta
        // coma decimal, así que "45,5" sigue guardando $45.500 sin perder precisión.
        const montoMil = valor.trim() === '' ? 0 : parseNum(valor);
        const monto = montoMil * 1000;
        if (scid == null || !Number.isFinite(monto) || monto < 0) return;
        await query("INSERT INTO presupuesto (perfil_id, subcategoria_id, periodo, monto) VALUES (1, ?, 'default', ?) ON CONFLICT(perfil_id, subcategoria_id, periodo) DO UPDATE SET monto = excluded.monto", [scid, monto]);
        await cargar();
    }

    // Halo de "Cargar ingreso": se apaga en cuanto hay al menos un ingreso cargado.
    async function cargarHaloIngreso() {
        const ni = (await query('SELECT COUNT(*) AS n FROM ingreso WHERE perfil_id=1')) as any[];
        sinIngresos = (ni[0]?.n ?? 0) === 0;
    }

    async function cargarNombre() {
        const r = (await query('SELECT nombre FROM perfil WHERE id=1')) as any[];
        nombre = r[0]?.nombre ?? '';
    }
    // ===== Selector de período: sticky de sesión + límites de navegación =====
    // sessionStorage (NO localStorage): al reabrir la app en una sesión nueva,
    // arranca en el último período abierto a propósito. Guardamos también el
    // "último corte" conocido como baseline, para detectar un corte NUEVO.
    const SS_PERIODO = 'cc_periodo';
    function guardarSel() {
        try { sessionStorage.setItem(SS_PERIODO, JSON.stringify({ periodo, ultimoCorte: ultimoPeriodo })); } catch { /* ignore */ }
    }

    // Resuelve límites + período inicial. Reusa cargarCortes (no reimplementa la
    // secuencia). Corre una vez al montar, antes del primer cargar().
    async function resolverPeriodoInicial() {
        modoCache = await cargarModo();
        modo = modoCache;
        cortesCache = modoCache === 'sueldo' ? await cargarCortes() : [];
        const cortes = cortesCache;
        cortePeriodos = modo === 'sueldo' ? [...new Set(cortes.map((c) => c.periodo))] : [];
        // Límite superior: último corte abierto (sueldo) o mes actual (calendario):
        // no tiene sentido navegar a futuros sin corte.
        ultimoPeriodo = modo === 'sueldo' ? (cortePeriodos[cortePeriodos.length - 1] ?? mesActual()) : mesActual();
        // Límite inferior: primer corte (sueldo) o mes más viejo con datos (calendario).
        if (modo === 'sueldo') {
            primerPeriodo = cortePeriodos[0] ?? ultimoPeriodo;
        } else {
            const r = (await query(
                "SELECT MIN(f) AS m FROM (SELECT MIN(fecha) AS f FROM gasto WHERE perfil_id=1 UNION ALL SELECT MIN(fecha) AS f FROM ingreso WHERE perfil_id=1)"
            )) as any[];
            primerPeriodo = r[0]?.m ? String(r[0].m).slice(0, 7) : ultimoPeriodo;
        }
        // Sticky: default al último corte; si hay guardado, respetarlo SALVO que
        // haya aparecido un corte nuevo (último corte posterior al baseline) -> saltar.
        let guardado: { periodo?: string; ultimoCorte?: string } | null = null;
        try { guardado = JSON.parse(sessionStorage.getItem(SS_PERIODO) ?? 'null'); } catch { /* ignore */ }
        if (guardado?.periodo) {
            periodo = ultimoPeriodo > (guardado.ultimoCorte ?? '') ? ultimoPeriodo : guardado.periodo;
        } else {
            periodo = ultimoPeriodo;
        }
        guardarSel();
    }

    // Cambia el período (flecha o dropdown), clampeado a los límites, persiste y recarga.
    function seleccionar(p: string) {
        if (primerPeriodo && p < primerPeriodo) p = primerPeriodo;
        if (ultimoPeriodo && p > ultimoPeriodo) p = ultimoPeriodo;
        periodo = p;
        guardarSel();
        cargar();
    }
    // Vecino anterior/siguiente: en sueldo recorre la secuencia de cortes; en
    // calendario, mes a mes. Los límites ya están cubiertos por seleccionar().
    function vecino(dir: -1 | 1) {
        if (modo === 'sueldo' && cortePeriodos.length) {
            const i = cortePeriodos.indexOf(periodo);
            if (i >= 0) {
                const j = i + dir;
                if (j >= 0 && j < cortePeriodos.length) seleccionar(cortePeriodos[j]);
                return;
            }
        }
        seleccionar(addMonths(periodo, dir));
    }
    // Abre el dropdown nativo (saltos largos). El input month está como overlay
    // transparente sobre el texto, así que el click suele bastar; showPicker es el
    // camino explícito donde está soportado.
    function abrirDropdown() {
        try { (mesInput as any)?.showPicker(); } catch { mesInput?.focus(); }
    }

    // ===== Aviso de copia de seguridad en Home (Blindaje iOS, Bloque 5) =====
    // Umbral propio para este aviso visual (distinto del de /datos, que es a 30
    // días, y del badge de notificaciones, que dispara a los 7): amarillo a los
    // 3 días sin copia, rojo a los 7. null (nunca exportó) se trata como rojo,
    // mismo criterio que ya usa /datos para "copiaVieja".
    // Rienda + Sheets: la Sheet es el respaldo, no hace falta pedir copias.
    let diasCopia = $state<number | null>(0);
    let compartiendoCopia = $state(false);
    const nivelAvisoCopia = $derived.by((): 'rojo' | 'amarillo' | null => {
        if (diasCopia === null) return 'rojo';
        if (diasCopia >= 7) return 'rojo';
        if (diasCopia >= 3) return 'amarillo';
        return null;
    });

    async function cargarAvisoCopia() {
        try {
            const m = await leerMeta();
            diasCopia = m.ultima_exportacion ? diasEntre(m.ultima_exportacion, hoyISO()) : null;
        } catch {
            /* silencioso: si falla, no se muestra aviso (no molesta) */
        }
    }

    async function onCompartirCopia() {
        compartiendoCopia = true;
        try {
            await exportarDatos();
            diasCopia = 0;
        } catch (e) {
            console.error(e);
        } finally {
            compartiendoCopia = false;
        }
    }

    onMount(async () => { await resolverPeriodoInicial(); cargar(); cargarHaloIngreso(); cargarNombre(); });
    // Alias locales al helper único de format.ts (mismo comportamiento de antes,
    // ya no reimplementado acá — ver Brief H / A1).
    const peso = pesos;
    // Consolidado por categoría: montos en miles (÷1000, redondeado). Solo presentación
    // de esa vista agregada; el dato guardado y las cuentas siguen en pesos enteros.
    const pesoMil = (n: number) => pesos((n || 0) / 1000);
    const usd = (n: number) => pesos(n, 'USD');
    // Semáforo completo de Presupuesto/Gasto: verde si entra en el ingreso
    // disponible, amarillo entre disponible e ingreso total, rojo si supera el total.
    function semColor(v: number): string {
        if (ingresosMes <= 0 && ingresoDisponible <= 0) return '';
        if (v <= ingresoDisponible) return 'ok';
        if (v <= ingresosMes) return 'warn';
        return 'bad';
    }
    // Gasto: con presupuesto, verde/rojo vs presupuesto; sin presupuesto, semáforo
    // completo contra el ingreso (igual que Presupuesto).
    function gastoColor(): string {
        if (totales.presup > 0) return totales.real <= totales.presup ? 'ok' : 'bad';
        return semColor(totales.real);
    }
    const claseEstado = (e: string) => e === 'En margen' ? 'ok' : e === 'Superado' ? 'warn' : e === 'Muy superado' ? 'bad' : 'none';

    // Presupuesto de ahorro DERIVADO de la meta (fuente única = objetivo % editable en
    // Capacidad de ahorro, tabla meta `umbral_ahorro`): monto = umbral% × ingreso
    // regular del período. Es el "target" de la categoría de ahorro; se muestra como
    // Presup. en su fila y el semáforo compara contra él. R=0 → sin target (neutro).
    let metaAhorroMonto = $derived(ingresosRegularesMes > 0 ? umbralAhorro * ingresosRegularesMes : 0);
    // Semáforo de la categoría de ahorro: polaridad INVERTIDA vs una categoría de
    // gasto — verde si el ahorro real ALCANZA el target derivado, rojo si no llega,
    // neutro si no hay ingreso regular (no hay target y no se pinta rojo).
    // Semáforo de ahorro: a diferencia del de gastos (techo, ver desvio()), la
    // meta de ahorro es un piso — ahorrar de más nunca es malo, por eso no hay
    // límite superior (>=90% ya es verde, y sigue siendo verde sin importar
    // cuánto te pases para arriba). Cortes definidos con Julián: <50% de la
    // meta = rojo, 50-90% = amarillo (intentaste, te quedaste corto), >=90% =
    // verde. Sin ingreso regular cargado, no hay meta calculable -> 'none'.
    function claseAhorro(real: number): string {
        if (ingresosRegularesMes <= 0) return 'none';
        if (metaAhorroMonto <= 0) return 'none';
        const pct = real / metaAhorroMonto;
        if (pct >= 0.9) return 'ok';
        if (pct >= 0.5) return 'warn';
        return 'bad';
    }
    function tituloAhorro(real: number): string {
        if (ingresosRegularesMes <= 0) return 'Sin ingreso regular cargado — objetivo se edita en Capacidad de ahorro';
        const tasa = real / ingresosRegularesMes;
        return `Ahorrás ${(tasa * 100).toFixed(1)}% del ingreso regular · objetivo ${(umbralAhorro * 100).toFixed(1)}%`;
    }
</script>

<div class="titulo-guia">
    <h1>Cuenta Corriente</h1>
    <Guia
		clave="home"
		para="Ver cuánto gastaste este período y cómo venís contra tu presupuesto."
		uso="Las flechas cambian de período; tocá el casillero de Presupuesto de una subcategoría para fijarle un monto. Dos reglas que sorprenden: en modo sueldo el período lo abre el día que cobrás, no el calendario, y los dólares sueltos quedan aparte de tus pesos."
		verMas
	/>
</div>
{#if nombre}<p class="saludo">Hola, {nombre}!</p>{/if}

<div class="accesos">
    <a href="/gastos" class="btn btn-primary">Gastos</a>
    <a href="/carga-ingresos" class="btn btn-primary" class:pulsa={sinIngresos}>Ingresos</a>
    <a href="/credito" class="btn btn-secondary">Crédito</a>
    <a href="/evolucion-finanzas?tab=resumen" class="btn btn-secondary">Balance</a>
</div>

<div class="sel">
    <span class="sel-label">{modo === 'calendario' ? 'Mes' : 'Período de sueldo'}:</span>
    <div class="periodo-nav">
        <button class="nav-flecha" onclick={() => vecino(-1)} disabled={!primerPeriodo || periodo <= primerPeriodo} aria-label="Período anterior" title="Período anterior">‹</button>
        <span class="periodo-medio">
            <button class="periodo-texto" onclick={abrirDropdown} title="Tocar para elegir otro período">{labelPeriodo(periodo)}</button>
            <input type="month" bind:this={mesInput} bind:value={periodo} onchange={() => seleccionar(periodo)} class="periodo-overlay" aria-label="Elegir período" />
        </span>
        <button class="nav-flecha" onclick={() => vecino(1)} disabled={!ultimoPeriodo || periodo >= ultimoPeriodo} aria-label="Período siguiente" title="Período siguiente">›</button>
    </div>
</div>
<p class="rango">
    {#if modo === 'calendario'}
        Gastos del <strong>{rango}</strong> (mes calendario, del 1 al último día).
    {:else}
        Gastos del <strong>{rango}</strong> (el período lo abre la fecha real de tu sueldo).
    {/if}
</p>

{#if nivelAvisoCopia}
    <div class="aviso-copia {nivelAvisoCopia}">
        <span>{nivelAvisoCopia === 'rojo' ? '⚠️ ' : ''}{diasCopia === null ? 'Todavía no hiciste una copia de seguridad.' : `Hace ${diasCopia} día(s) que no hacés una copia de seguridad.`}</span>
        <button class="btn btn-secondary" disabled={compartiendoCopia} onclick={onCompartirCopia}>{compartiendoCopia ? 'Compartiendo…' : '⬆ Compartir copia'}</button>
    </div>
{/if}

{#if cargando}
    <div class="disponible sk-panel">
        <div class="sk-row"><Skeleton w="150px" h="1rem" /><Skeleton w="130px" h="1.35rem" /></div>
    </div>
    <div class="deuda-panel sk-panel">
        <div class="sk-row"><Skeleton w="210px" h="1rem" /><Skeleton w="120px" h="1.35rem" /></div>
    </div>
    <div class="sk-accesos">
        <Skeleton w="50%" h="46px" radius="10px" />
        <Skeleton w="50%" h="46px" radius="10px" />
    </div>
{:else}

    <!-- ===== Ingreso disponible (Ítem 1) ===== -->
    <div class="disponible">
        <button class="disp-toggle" onclick={() => (detalleAbierto = !detalleAbierto)} aria-expanded={detalleAbierto} title="Ver/ocultar cómo se calcula">
            <span class="flecha">{detalleAbierto ? '▾' : '▸'}</span>
            <span class="disp-titulo">Ingreso disponible</span>
            <span class="disp-valor"><span class="dv-ars"><CountUp value={ingresoDisponible} format={peso} /></span>{#if hayNetoUsd}<span class="dv-usd">{usd(ingresoDisponibleUsd)}</span>{/if}</span>
        </button>
        {#if detalleAbierto}
            <table class="disp-tabla disp-detalle">
                <tbody>
                    <tr><td>Ingresos totales del mes</td><td class="num">{peso(ingresosMes)}</td></tr>
                    {#if ingresoUsdMes > 0}<tr class="disp-usd"><td>Ingreso del mes (USD)</td><td class="num">{usd(ingresoUsdMes)}</td></tr>{/if}
                    <tr><td>− Pago de Tarjetas del Mes Corriente</td><td class="num">{creditoMes ? '−' + peso(creditoMes) : peso(0)}</td></tr>
                    <tr><td>+ Reservado para el Mes Corriente</td><td class="num">{reservaMes ? '+' + peso(reservaMes) : peso(0)}</td></tr>
                    {#if hayNetoUsd}<tr class="disp-usd"><td>− Cuotas en dólares (netean el ingreso USD)</td><td class="num">{usd(creditoMesUsd)}</td></tr>{/if}
                </tbody>
            </table>
            <p class="disp-nota">La reserva se edita por mes en <a href="/credito">Crédito</a>.</p>
        {/if}
        <div class="disp-pie">
            {#if totales.presup > 0}
                <div class="disp-linea {semColor(totales.presup)}"
                    title="Verde: entra en tu ingreso disponible · Amarillo: entre el disponible y tu ingreso total · Rojo: supera tu ingreso total">
                    <span>Presupuesto</span><strong><CountUp value={totales.presup} format={peso} /></strong>
                </div>
            {/if}
            <button class="disp-linea disp-linea-btn {gastoColor()}" onclick={() => (gastoAbierto = !gastoAbierto)} aria-expanded={gastoAbierto}
                title={totales.presup > 0 ? 'Gasto vs presupuesto (tocá para ver el desglose)' : 'Sin presupuesto: verde si entra en tu ingreso disponible · amarillo entre el disponible y el total · rojo si supera tu ingreso total (tocá para ver el desglose)'}>
                <span><span class="flecha-mini">{gastoAbierto ? '▾' : '▸'}</span> Gasto del mes (ARS)</span><strong><CountUp value={totales.real} format={peso} /></strong>
            </button>
            {#if gastoAbierto}
                <table class="disp-tabla disp-detalle">
                    <tbody>
                        <tr><td>Gasto real</td><td class="num">{peso(gastoRealMes)}</td></tr>
                        <tr><td>{nombreAhorro}</td><td class="num">{peso(ahorroMes)}</td></tr>
                    </tbody>
                </table>
            {/if}
            {#if gastoUsdMes > 0}
                <div class="disp-linea disp-usdrow"><span>Gasto del mes (USD)</span><strong>{usd(gastoUsdMes)}</strong></div>
            {/if}
            {#if creditoMesUsd > 0 && !hayNetoUsd}
                <div class="disp-linea disp-usdrow"><span>Cuotas en dólares (aparte)</span><strong>{usd(creditoMesUsd)}</strong></div>
            {/if}
        </div>
    </div>

    <!-- ===== Crédito del mes que viene (Ítem 2, lectura pura) ===== -->
    {#if descubierto !== 0 || deudaSigUsd !== 0}
    <div class="deuda-panel" class:ok={descubierto <= 0} class:warn={descubierto > 0}>
        <button class="disp-toggle" onclick={() => (deudaAbierto = !deudaAbierto)} aria-expanded={deudaAbierto} title="Ver/ocultar el detalle">
            <span class="flecha">{deudaAbierto ? '▾' : '▸'}</span>
            <span class="disp-titulo">Crédito Neto del Mes Siguiente</span>
            <span class="disp-valor" class:alta={deudaAlta}><span class="dv-ars"><CountUp value={descubierto} format={peso} /></span>{#if deudaSigUsd > 0}<span class="dv-usd">{usd(deudaSigUsd)}</span>{/if}</span>
        </button>
        {#if deudaAbierto}
            <table class="disp-tabla disp-detalle">
                <tbody>
                    <tr><td>Cuotas a pagar ({mesSigLabel})</td><td class="num">{peso(deudaSig)}{#if deudaSigUsd > 0}<div class="usd">{usd(deudaSigUsd)}</div>{/if}</td></tr>
                    <tr><td>− Reservado para mes siguiente</td><td class="num">{reservaSig ? '−' + peso(reservaSig) : peso(0)}</td></tr>
                    {#if deudaSigUsd > 0}<tr class="disp-usd"><td>Cuotas en dólares (se pagan aparte)</td><td class="num">{usd(deudaSigUsd)}</td></tr>{/if}
                </tbody>
            </table>
            <p class="disp-nota">Reservá plata para el pago de próximos vencimientos desde <a href="/credito">Crédito</a>.</p>
        {/if}
    </div>
    {/if}


    <div class="consol-head">
        <h2>Consolidado por categoría · en miles</h2>
    </div>
    <div class="tabla-scroll">
    <table class="consol">
        <thead><tr><th>Categoría</th><th>{labN2}</th><th>{labN1}</th><th>Presup.</th><th>{labN}</th></tr></thead>
        <tbody>
            {#each consolidado as c (c.cat)}
                <tr class={c.esAhorro ? 'fila-ahorro' : 'fila-gasto'}>
                    {#if c.esAhorro}
                        <td><a class="consol-link" href="/evolucion-finanzas?tab=capacidad"><strong>{c.cat}</strong></a>{#if metaAhorroMonto > 0}<span class="presubar {claseAhorro(c.real)}" aria-hidden="true"><i style="width:{Math.min(c.real / metaAhorroMonto, 1) * 100}%"></i></span>{/if}</td>
                        <td class="num">{pesoMil(c.n2)}</td><td class="num">{pesoMil(c.n1)}</td>
                        <td class="num">{metaAhorroMonto > 0 ? pesoMil(metaAhorroMonto) : '—'}</td>
                        <td class="num real {claseAhorro(c.real)}" title={tituloAhorro(c.real)}>{pesoMil(c.real)}</td>
                    {:else}
                        <td><strong>{c.cat}</strong>{#if c.presup > 0}<span class="presubar {claseEstado(c.estado)}" aria-hidden="true"><i style="width:{Math.min(c.real / c.presup, 1) * 100}%"></i></span>{/if}</td>
                        <td class="num">{pesoMil(c.n2)}</td><td class="num">{pesoMil(c.n1)}</td>
                        <td class="num">{pesoMil(c.presup)}</td>
                        <td class="num real {claseEstado(c.estado)}" title={c.estado}>{pesoMil(c.real)}</td>
                    {/if}
                </tr>
            {/each}
        </tbody>
        <tfoot>
            <tr><td><strong>Total general</strong></td>
                <td class="num">{pesoMil(totales.n2)}</td><td class="num">{pesoMil(totales.n1)}</td>
                <td class="num">{pesoMil(totales.presup)}</td><td class="num">{pesoMil(totales.real)}</td></tr>
        </tfoot>
    </table>
    </div>

    <h2>Detalle por subcategoría · en miles</h2>
    <div class="tabla-scroll">
    <table class="detalle">
        <thead><tr><th>Subcategoría</th><th>{labN2}</th><th>{labN1}</th><th>Presup.</th><th>{labN}</th></tr></thead>
        <tbody>
            {#each grupos as g (g.cat)}
                <tr class="cat"><td colspan="5">{g.cat}</td></tr>
                {#each g.rows as f (f.scid ?? 'null')}
                    <tr>
                        <td class="ind">
                            {#if f.scid != null && f.autoPresup && f.esAhorro}
                                <a class="sub-link" href="/evolucion-finanzas?tab=capacidad" title="Se edita en Capacidad de ahorro, no acá.">{f.nombre}</a>
                            {:else if f.scid != null && f.autoPresup}
                                <a class="sub-link" href="/suscripciones" title="Se edita en Gastos, tab Recurrente, no acá.">{f.nombre}</a>
                            {:else}
                                {f.nombre}
                            {/if}
                        </td>
                        <td class="num">{pesoMil(f.n2)}</td>
                        <td class="num">{pesoMil(f.n1)}</td>
                        <td class="num">
                            {#if f.scid == null}
                                —
                            {:else if f.autoPresup && f.esAhorro}
                                <span class="auto-presup" title="Definido por tu meta de ahorro. Se edita en Capacidad de ahorro, no acá.">{formatNum(f.presup / 1000, 0)}</span>
                            {:else if f.autoPresup}
                                <span class="auto-presup" title="Definido por tus gastos recurrentes. Se edita en Gastos, tab Recurrente, no acá.">{formatNum(f.presup / 1000, 0)}</span>
                            {:else}
                                <input class="presup" type="text" inputmode="decimal" use:soloNum value={f.presup ? formatNum(f.presup / 1000, 0) : ''} placeholder="—"
                                    onchange={(e) => guardarPresup(f.scid, e.currentTarget.value)} />
                            {/if}
                        </td>
                        <td class="num real {claseEstado(f.estado)}" title={f.estado}>{pesoMil(f.real)}</td>
                    </tr>
                {/each}
            {/each}
        </tbody>
        <tfoot>
            <tr><td><strong>Total general</strong></td>
                <td class="num">{pesoMil(totales.n2)}</td><td class="num">{pesoMil(totales.n1)}</td>
                <td class="num">{pesoMil(totales.presup)}</td><td class="num">{pesoMil(totales.real)}</td></tr>
        </tfoot>
    </table>
    </div>
{/if}

<style>
    :global(body) { max-width: 820px; margin: 0 auto; padding: 16px; }
    .sel { font-size: 0.9rem; display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
    .sel-label { color: var(--text-dim); }
    .periodo-nav { display: inline-flex; align-items: stretch; gap: 4px; }
    .nav-flecha { font-size: 1.2rem; line-height: 1; padding: 4px 12px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; cursor: pointer; color: var(--text); }
    .nav-flecha:disabled { opacity: 0.3; cursor: default; }
    .periodo-medio { position: relative; display: inline-flex; }
    .periodo-texto { font-size: 0.95rem; font-weight: 600; padding: 4px 12px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; cursor: pointer; color: var(--text); min-width: 120px; text-align: center; }
    /* El input month va encima del texto, transparente: el tap abre el picker
       nativo (dropdown), pero el usuario ve el texto formateado de abajo. */
    .periodo-overlay { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; margin: 0; }
    .rango { font-size: 0.82rem; color: var(--text-dim); margin: 0 0 12px; }
    .saludo { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; font-family: var(--font-display); font-size: 1.15rem; color: var(--text); font-weight: 600; margin: 2px 0 14px; }
    .auto { font-size: 0.75rem; font-weight: 400; color: var(--text-dim); white-space: nowrap; }

    /* Tarjetas de resumen del período */

    /* Skeletons de carga (Home) */
    .sk-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .sk-accesos { display: flex; gap: 10px; margin-top: 8px; }
    /* Panel Ingreso disponible (borrador, pendiente de revisión) */
    .disponible {
        border: 1px solid transparent; border-left: 3px solid var(--accent);
        background: var(--surface); border-radius: 0 8px 8px 0; padding: 12px 14px; margin: 0 0 16px;
    }
    .disp-toggle { width: 100%; display: flex; align-items: baseline; gap: 8px; background: none; border: none; padding: 0 0 6px; cursor: pointer; color: var(--text); text-align: left; }
    .disp-toggle .flecha { color: var(--text-dim); font-size: 0.8rem; width: 12px; display: inline-block; }
    .disp-toggle .disp-titulo { font-family: var(--font-display); font-size: 0.74rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }
    .disp-toggle .disp-valor { margin-left: auto; font-family: var(--font-num); font-size: 1.35rem; font-weight: 300; color: var(--text); white-space: nowrap; }
    .disp-tabla { width: 100%; border-collapse: collapse; font-size: 0.90rem; }
    .disp-tabla td { border: none !important; padding: 4px 2px; color: var(--text-dim); }
    .disp-tabla td.num { text-align: right; white-space: nowrap; }
    .disp-pie { display: flex; flex-direction: column; border-top: 1px solid var(--border); margin-top: 8px; }
    .disp-linea { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 7px 0 7px 20px; border-bottom: 1px solid var(--border); }
    .disp-linea:last-child { border-bottom: none; }
    .disp-linea span { font-family: var(--font-display); font-size: 0.74rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }
    .disp-linea strong { font-family: var(--font-num); font-size: 1.35rem; font-weight: 300; white-space: nowrap; }
    .disp-linea.ok strong { color: var(--pos); }
    .disp-linea.warn strong { color: var(--warn); }
    .disp-linea.bad strong { color: var(--neg); }
    .disp-nota { font-size: 0.76rem; color: var(--text-dim); margin: 8px 0 0; }
    .disp-nota a { color: var(--accent); }
    .deuda-panel { border: 1px solid transparent; border-left: 3px solid var(--text-dim); background: var(--surface); border-radius: 0 8px 8px 0; padding: 12px 14px; margin: 0 0 16px; }
    .deuda-panel.ok { border-left-color: var(--pos); }
    .deuda-panel.warn { border-left-color: var(--warn); }
    .deuda-panel.ok .disp-valor { color: var(--pos); }
    .deuda-panel .disp-valor.alta { color: var(--warn); }
    /* Credito neto e Ingreso disponible: cuando hay monto en USD además del de
       ARS (.dv-ars/.dv-usd), van en lineas separadas, alineadas a la derecha —
       mismo patrón visual en los dos paneles, sin diferencia de tamaño entre
       ARS y USD (igual que ya se veía en Crédito neto). */
    .deuda-panel .disp-valor, .disponible .disp-toggle .disp-valor { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.15; }

    h2 { font-size: 1.02rem; margin-top: 26px; border-left: 3px solid var(--accent); padding-left: 12px; }
    /* Título del consolidado + input de meta de ahorro en una sola fila. El
       "· en miles" ahora va dentro del h2 (mismo tamaño), no como label chico. */
    .consol-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .consol-head h2 { margin-top: 26px; }
    table { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin-bottom: 8px; table-layout: fixed; }
    /* Brief 1: consolidado con tipografía más grande que el resto de las tablas,
       para legibilidad general de todas sus filas (no solo la de ahorro). */
    table.consol { font-size: 0.98rem; }
    table.consol th, table.consol td { padding: 7px 6px; }
    /* Detalle por subcategoría: un poco menor que el consolidado (tiene una
       columna más densa: badge "recurrente" + input editable), pero bien por
       encima del tamaño base de tabla para que se lea igual de cómodo. */
    table.detalle { font-size: 0.94rem; }
    tr.fila-gasto { background: var(--surface-2); }
    tr.fila-ahorro { background: var(--surface-3); }
    /* Azul + subrayado permanente (no solo hover): que se note a simple vista
       que el nombre de categoría es un link a su configuración (ej. Ahorro ->
       Capacidad de ahorro), sin afectar categorías sin vínculo (esas quedan
       en <strong> plano, fuera de esta clase). */
    .consol-link { text-decoration: underline; color: #6f93c4; }
    .consol-link:hover strong { color: #6f93c4; }
    .sub-link { text-decoration: underline; color: #6f93c4; }
    th, td { padding: 5px 6px; text-align: left; overflow: hidden; }
    /* Columna de nombre: corta con … si no entra */
    table th:first-child, table td:first-child {
        width: 24%;
        white-space: nowrap; text-overflow: ellipsis;
    }
    /* Columnas de valores: número completo, alineado a la derecha */
    table th:not(:first-child), table td:not(:first-child) {
        width: 19%;
        text-align: right; white-space: nowrap;
    }
    td.ind { padding-left: 20px; }
    tr.cat td { background: none; font-family: var(--font-display); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); padding-top: 14px; white-space: normal; overflow: visible; }
    /* Mini-barra de presupuesto por categoria (solo visual: real / presupuesto) */
    .presubar { display: block; height: 3px; background: var(--surface-2); border-radius: 2px; margin-top: 5px; max-width: 140px; }
    .presubar i { display: block; height: 100%; border-radius: 2px; background: var(--text-dim); }
    .presubar.ok i { background: var(--pos); }
    .presubar.warn i { background: var(--warn); }
    .presubar.bad i { background: var(--neg); }
    input.presup { width: 100%; max-width: 90px; text-align: right; padding: 3px 4px; box-sizing: border-box; font: inherit; }
    .auto-presup { font-size: 1em; color: var(--text-dim); white-space: nowrap; }
    td.real { font-weight: 600; }
    td.real.ok { color: var(--pos); }
    td.real.warn { color: var(--warn); }
    td.real.bad { color: var(--neg); }
    td.real.none { color: inherit; font-weight: 400; }
    tfoot td { border-top: 2px solid var(--border); font-weight: 600; }
    .accesos { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 4px 0 14px; }
    /* Halo que respira sobre "Cargar ingreso" hasta el primer ingreso (se apaga
       solo al cargarlo o al cerrar el checklist de primeros pasos). Solo visual. */
    .accesos a.pulsa { animation: halo-ingreso 2s ease-in-out infinite; }
    @keyframes halo-ingreso {
        0%, 100% { box-shadow: 0 0 0 0 rgba(91, 157, 255, 0); }
        50% { box-shadow: 0 0 14px 2px rgba(91, 157, 255, 0.55); }
    }
    @media (prefers-reduced-motion: reduce) { .accesos a.pulsa { animation: none; } }
    .usd { color: var(--text-dim); font-size: 0.85em; }
    .disp-usd td { color: var(--text-dim); }
    .disp-usdrow span, .disp-usdrow strong { color: var(--text-dim); font-weight: 600; }
    .disp-usdrow strong { font-size: 0.9rem; font-weight: 400; }
    /* "Gasto total del mes" como toggle: mismo look de .disp-linea, pero clickeable
       (reset de estilos de <button>) y con flechita, igual patrón que "Ingreso
       disponible" de arriba. El detalle (Gasto real / Ahorro) sale en .disp-tabla,
       sin semáforo por fila — igual criterio visual que el detalle de Ingreso disponible. */
    .disp-linea-btn { width: 100%; background: none; border: none; padding: 7px 0; font: inherit; color: inherit; cursor: pointer; text-align: left; }
    .disp-linea.disp-linea-btn { padding-left: 0; }
    .flecha-mini { color: var(--text-dim); font-size: 0.75rem; width: 12px; display: inline-block; margin-right: 8px; letter-spacing: 0; }

    /* ===== Aviso de copia de seguridad (Blindaje iOS, Bloque 5) ===== */
    .aviso-copia {
        display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
        border: 1px solid var(--border); background: var(--surface); border-radius: 8px;
        padding: 10px 12px; margin: 0 0 12px; font-size: 0.85rem;
    }
    .aviso-copia.amarillo { border-color: var(--warn); color: var(--warn); }
    .aviso-copia.rojo { border-color: var(--neg); color: var(--neg); }
</style>