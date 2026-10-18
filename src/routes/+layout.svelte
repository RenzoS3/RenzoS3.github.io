<script lang="ts">
	import { page } from '$app/stores';
	import { onNavigate, afterNavigate, goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { hayPerfil, crearPerfil } from '$lib/db/perfil';
	import { autobackupDiarioSiHaceFalta, listarAutobackups, leerAutobackup, type AutobackupItem } from '$lib/db/autobackup';
	import {
		leerSenalPool, leerMarcaPerfil, escribirMarcaPerfil, leerEstadoStorage,
		type SenalPool, type MarcaPerfil, type EstadoStorage
	} from '$lib/db/senales';
	import { actualizarCotizaciones, actualizarInflacionYHistorico } from '$lib/db/cotizaciones';
	import { notif } from '$lib/notif.svelte';
	import { fotosProgreso } from '$lib/fotos.svelte';
	import { retomarFotosPendientes } from '$lib/cartera';
	import { query } from '$lib/db/client';
	import type { ModoPeriodo } from '$lib/periodo';
	import InstalarApp from '$lib/InstalarApp.svelte';
	import { esIOS } from '$lib/pwa.svelte';
	import { ErrorValidacion } from '$lib/errores';
	import { compartirOdescargarTexto } from '$lib/db/backup';
	import DiagnosticoTecnico from '$lib/DiagnosticoTecnico.svelte';
	import { sync, iniciar, guardarAhora } from '$lib/sheets/sync.svelte';
	import { parsearEnlace, guardarConexion, ping, borrarConexion } from '$lib/sheets/conexion';

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
	let { children } = $props();

	// ===== Red global para promesas de datos no atrapadas =====
	// Pantallas como Datos o Inversiones hacen sus propias query() en cargar()
	// sin try/catch. Si esa query rechaza (worker colgado, timeout de client.ts,
	// etc.) la pantalla se queda trabada sin avisar nada. Este listener es la
	// red de contención para CUALQUIER promesa así en cualquier pantalla: no
	// distingue causas, un solo mensaje genérico y una recarga completa como
	// única vía de recuperación real.
	let errorGlobal = $state('');
	// true si el Reintentar del banner ya se probó hace <60s en este mismo
	// arranque y volvió a colgarse: ahí se oculta el botón (ver reintentarConReload
	// / onRechazoNoAtrapado más abajo), porque un segundo reload en caliente no
	// resuelve nada — hace falta el cierre real de la PWA (Brief 0).
	let errorGlobalEscalado = $state(false);
	// Error crudo del rechazo no atrapado (para el diagnóstico técnico copiable).
	let errorGlobalCrudo = $state<unknown>(null);

	// ===== Perfil / bienvenida =====
	let perfilListo = $state(false);
	let chequeando = $state(true);
	// true solo cuando hayPerfil() efectivamente pudo consultar la base y falló
	// la conexión/consulta (worker colgado, timeout, etc.) — nunca cuando la
	// consulta contestó "0 perfiles". Sin esto, cualquier error de query se
	// confundía con "no hay perfil creado" y mandaba a un usuario con datos
	// reales a la pantalla de Bienvenida (onboarding desde cero).
	let perfilError = $state(false);
	// Escalada (Brief 0): si ya se reintentó hace <60s en esta pantalla y volvió
	// a fallar, se oculta Reintentar y se muestra la instrucción de cerrar la app.
	let perfilErrorEscalado = $state(false);
	// Señales de arranque (Blindaje iOS) — ver leerSenalesArranque().
	let senalPool = $state<SenalPool>(null);
	let marcaPerfil = $state<MarcaPerfil | null>(null);
	let estadoStorage = $state<EstadoStorage>({ persistido: null, usage: null, quota: null });
	// Error crudo (para el diagnóstico técnico copiable, Bloque 3).
	let errorCrudo = $state<unknown>(null);
	let nombreNuevo = $state('');
	let modoNuevo = $state<ModoPeriodo>('calendario'); // preseleccionado (Capa 1)
	let creando = $state(false);
	let bienvenidaMsg = $state('');
	let bienvenidaMsgErr = $state(false);
	let importInputBienvenida: HTMLInputElement | undefined = $state();

	// ===== Pantalla diferenciada de arranque (Blindaje iOS, Bloque 2) =====
	// Clasifica las señales leídas en leerSenalesArranque(). null = sin señales
	// concluyentes: se muestra la bienvenida de siempre, sin cambios.
	type DiagArranque = 'borrado_total' | 'borrado_parcial' | 'pool_con_bytes';
	let diagArranque = $derived.by((): DiagArranque | null => {
		if (!senalPool) return null; // pool no se pudo leer: no concluyente
		if (senalPool.existe && senalPool.bytes > 0) return 'pool_con_bytes';
		if (!senalPool.existe) return marcaPerfil ? 'borrado_parcial' : 'borrado_total';
		return null; // pool existe pero vacío: no concluyente
	});
	let forzarBienvenidaNormal = $state(false); // "Empezar de cero" / confirmación de crear igual
	let confirmarCrearNuevo = $state(false);
	let confirmandoCrearNuevo = $state(false); // Brief 0: deshabilita el botón mientras espera el reload

	// Brief 0 — Bloque 4: crear perfil nuevo desde el caso B ya no pasa por
	// forzarBienvenidaNormal directo (sería crear en el mismo documento donde
	// la base no abría, con el mismo riesgo de lock que Reintentar). Pasa por
	// el mismo reload: se guarda la confirmación en sessionStorage, se recarga,
	// y onMount la lee y la consume para saltar directo al stepper.
	async function onCrearNuevoConfirmado() {
		confirmandoCrearNuevo = true;
		try { sessionStorage.setItem('forzar_bienvenida', '1'); } catch { /* no soportado */ }
		await new Promise((r) => setTimeout(r, 1000));
		location.reload();
	}

	// Copia de rescate (Blindaje iOS, Brief 2): en el caso "pool con bytes, no
	// se pudo leer", los autobackups viven en un directorio OPFS aparte y se
	// pueden listar/leer SIN abrir la base rota. null = todavía no se buscó.
	let autobackupsRescate = $state<AutobackupItem[] | null>(null);
	// Escalada (Brief 0): misma idea que perfilErrorEscalado, clave propia para
	// no interferir con la del banner ni la de perfilError.
	let poolBytesEscalado = $state(false);
	$effect(() => {
		if (diagArranque === 'pool_con_bytes' && autobackupsRescate === null) {
			poolBytesEscalado = reciente('poolbytes_reintento_ts');
			listarAutobackups().then((items) => { autobackupsRescate = items; });
		}
	});
	async function onDescargarRescate() {
		if (!autobackupsRescate?.length) return;
		try {
			const mas = autobackupsRescate[0]; // listarAutobackups() ya ordena mas nueva primero
			const texto = await leerAutobackup(mas.nombre);
			await compartirOdescargarTexto(texto, mas.nombre.replace(/\.json$/, ''));
		} catch (e) {
			console.error(e);
		}
	}

	// Stepper de bienvenida (Capa 1): 1 Filosofía · 2 Nombre · 3 Modo · 4 Data · 5 Cierre.
	const TOTAL_PASOS = 5;
	let paso = $state(1);
	const puedeAvanzar = $derived(paso !== 2 || nombreNuevo.trim().length > 0); // el nombre es obligatorio
	function siguiente() { if (puedeAvanzar && paso < TOTAL_PASOS) paso++; }
	function atras() { if (paso > 1) paso--; }

	async function chequearPerfil() {
		perfilError = false;
		try {
			perfilListo = await hayPerfil();
			chequeando = false;
			if (perfilListo) {
				// Rienda + Sheets: sin copias locales (la Sheet es el respaldo) y sin
				// precios/fotos de inversiones hasta la fase 2. Queda el dólar/inflación.
				autoCotizaciones(); // en segundo plano, no bloquea la app
			}
		} catch (e) {
			// La consulta falló (worker colgado, timeout, etc.): NO sabemos si hay
			// perfil o no, así que no tocamos perfilListo ni mostramos onboarding.
			console.error(e);
			errorCrudo = e; // para el diagnóstico técnico copiable (Bloque 3)
			chequeando = false;
			perfilError = true;
			perfilErrorEscalado = reciente('perfilerror_reintento_ts'); // Brief 0
		}
	}

	// Señales de arranque (Blindaje iOS), leídas ANTES de abrir la base — best
	// effort, nunca bloquean ni rompen el arranque si algo falla. El pedido de
	// almacenamiento persistente vivía suelto en onMount; se sumó acá para que
	// su resultado (antes descartado) quede reflejado en estadoStorage.
	async function leerSenalesArranque() {
		senalPool = await leerSenalPool();
		marcaPerfil = leerMarcaPerfil();
		let concedido: boolean | null = null;
		try {
			concedido = (await navigator.storage?.persist?.()) ?? null;
		} catch { /* no soportado */ }
		estadoStorage = await leerEstadoStorage();
		if (concedido !== null) estadoStorage = { ...estadoStorage, persistido: concedido };
	}

	// Orden de arranque (Brief 0): leerSenalesArranque() (incluye leerSenalPool(),
	// que abre archivos del directorio 'rienda-pool' con getFile()) tiene que
	// terminar ANTES del primer query() de chequearPerfil() — es la misma
	// carpeta que el SAHPool necesita montar, y aunque getFile() es lectura y
	// no debería tomar locks, no conviene competir por ella. El await
	// secuencial de acá abajo es la garantía: no correrlos en paralelo.
	async function iniciarArranque() {
		// Rienda + Sheets: los datos vienen de la Google Sheet. Primero se bajan y
		// se cargan en la base en memoria; recién ahí se chequea el perfil. Las
		// señales de "el navegador borró la base" ya no aplican (no hay base local).
		await iniciar();
		if (sync.estado !== 'listo') { chequeando = false; return; }
		await chequearPerfil();
	}

	// ===== Conexión con la Sheet (Rienda + Sheets) =====
	let enlaceTexto = $state('');
	let conectando = $state(false);
	let conectarMsg = $state('');
	async function onConectar() {
		conectarMsg = '';
		const c = parsearEnlace(enlaceTexto);
		if (!c) { conectarMsg = 'Ese enlace no parece el del Apps Script (tiene que terminar en …/exec?k=…).'; return; }
		conectando = true;
		try {
			await ping(c);
			guardarConexion(c);
			location.reload();
		} catch (e: any) {
			conectarMsg = e?.message ?? 'No se pudo conectar.';
			conectando = false;
		}
	}
	function onCambiarEnlace() {
		if (!confirm('¿Desconectar esta app de la Sheet? Tus datos siguen en la Sheet; vas a tener que pegar el enlace de nuevo.')) return;
		borrarConexion();
		location.reload();
	}

	// Resync pesado (histórico completo de dólar + inflación, ArgentinaDatos) si
	// la última corrida tiene más de 1 día. Chequea contra meta
	// (cotizaciones_resync_en) y no contra MAX(fecha) de cotizacion_dolar: esa
	// columna ahora también la escribe actualizarDolar() (liviano, todos los días
	// vía el refresco de precios de 20 min), así que dejó de servir como señal de
	// "cuándo corrió el resync pesado". No distingue feriados/fin de semana a
	// propósito: si no hay cotización nueva la fuente sigue devolviendo el último
	// cierre disponible, así que no hace falta lógica de días hábiles acá — de
	// última, se reintenta sin romper nada. Silencioso: sin internet o con la API
	// caída, sigue con lo guardado.
	async function autoCotizaciones() {
		try {
			const r = (await query("SELECT valor FROM meta WHERE clave='cotizaciones_resync_en'")) as any[];
			const ult = r[0]?.valor;
			if (ult && Date.now() - new Date(ult).getTime() < 24 * 60 * 60 * 1000) return; // corrió hace <24h: fresco
			await actualizarInflacionYHistorico();
		} catch { /* sin conexión o API caída: no molestar */ }
	}

	// Actualiza precios de activos desde data912 al abrir (y deja hecha la foto
	// automática del día — Bloque 2), en días hábiles y si pasó más de 20 min del
	// último refresh. Ventana horaria: hasta las 18 ART (cierre); no hay piso a la
	// mañana temprano (pre-apertura) porque ahí el panel en vivo todavía devuelve
	// el cierre de la sesión anterior, que sigue siendo un dato válido para
	// guardar (fechaCierreActual, en precios.ts, lo fecha al día hábil anterior).
	// Silencioso: sin internet, API caída o sin símbolos configurados no molesta.
	async function autoPrecios() {
		try {
			const ahora = new Date();
			const dia = ahora.getDay();
			if (dia === 0 || dia === 6) return;        // fin de semana
			if (ahora.getHours() >= 18) return;        // ya cerró: nada nuevo hasta mañana
			const r = (await query("SELECT valor FROM meta WHERE clave='precios_actualizados_en'")) as any[];
			const ult = r[0]?.valor;
			if (ult && Date.now() - new Date(ult).getTime() < 20 * 60 * 1000) return; // refrescado hace <20min
			const { actualizarPreciosYFoto } = await import('$lib/db/precios');
			await actualizarPreciosYFoto();
		} catch { /* sin conexión, API caída o sin símbolos configurados: no molestar */ }
	}

	async function onCrearPerfil() {
		bienvenidaMsgErr = false;
		if (!nombreNuevo.trim()) { bienvenidaMsg = 'Escribí tu nombre.'; return; }
		if (!modoNuevo) { bienvenidaMsg = 'Elegí una opción de ingresos.'; return; }
		creando = true; bienvenidaMsg = '';
		// Rienda + Sheets: el perfil y las categorías se guardan en la Sheet antes de recargar.
		try { await crearPerfil(nombreNuevo, modoNuevo); await guardarAhora(); location.href = '/'; } // salir del onboarding siempre en Cuenta Corriente
		catch (e: any) {
			console.error(e); // Brief H / B3: detalle a consola, no crudo en pantalla.
			bienvenidaMsgErr = true;
			bienvenidaMsg = 'Ocurrió un error. Contactá al administrador.';
			creando = false;
		}
	}

	// Import en la bienvenida (para recuperar backup en instalación nueva)
	async function onImportarBienvenida(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const { importarDatos } = await import('$lib/db/backup');
			const { setMeta } = await import('$lib/db/meta');
			await importarDatos(file);
			await setMeta('ultima_importacion', new Date().toISOString());
			await guardarAhora(); // Rienda + Sheets: lo restaurado se guarda en la Sheet
			alert('Importación completa. La página se va a recargar.');
			location.href = '/'; // salir del onboarding siempre en Cuenta Corriente
		} catch (err: any) {
			if (err instanceof ErrorValidacion) {
				alert(err.message);
			} else {
				// Brief H / B3: detalle técnico solo a consola, nunca crudo en pantalla.
				// Sigue siendo alert() nativo (no hay dónde mostrar UI inline acá antes
				// de salir del onboarding), pero el contenido ya no expone el error crudo.
				console.error(err);
				alert('Ocurrió un error. Contactá al administrador.');
			}
		} finally {
			input.value = '';
		}
	}

	// ===== Menú hamburguesa =====
	let menuAbierto = $state(false);
	let actualizandoCotiz = $state(false);
	// Badge de la campana (store reactivo app-wide). Reglas rotas persistentes +
	// recurrentes en ventana aún no vistos. Se recalcula en cada navegación
	// (afterNavigate corre también en la carga inicial) y cuando el centro marca vistos.
	afterNavigate(() => { notif.refrescar(); });

	function irA(href: string) {
		menuAbierto = false;
		goto(href);
	}

	async function onActualizarCotiz() {
		menuAbierto = false;
		actualizandoCotiz = true;
		try {
			const msg = await actualizarCotizaciones();
			alert(msg);
			// Pequeño margen antes de recargar: le da tiempo al navegador de liberar
			// el handle del worker viejo antes de que el reload cree uno nuevo. No
			// elimina la carrera (es una limitación del navegador/OPFS), solo la reduce.
			await new Promise((r) => setTimeout(r, 400));
			location.reload();
		} catch (e: any) {
			console.error(e); // Brief H / B3: detalle a consola, no crudo en pantalla.
			alert('Ocurrió un error. Contactá al administrador.');
			actualizandoCotiz = false;
		}
	}

	// ===== Botón "subir arriba" =====
	let mostrarSubir = $state(false);

	function alScrollear() {
		mostrarSubir = window.scrollY > 400;
	}

	function subirArriba() {
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	let actual = $derived($page.url.pathname);
	// evolucion-finanzas comparte pathname entre Gastos e Ingresos (se distinguen por
	// ?tab): sin esto, "Evolución de Gastos" quedaba marcado activo aunque estuvieras
	// en Ingresos (o en sus hijos poder/categorias/capacidad), y "Evolución de Ingresos"
	// nunca se marcaba. tabQS null = default 'gastos' del componente.
	let tabQS = $derived($page.url.searchParams.get('tab'));
	let enEvolGastos = $derived(actual === '/evolucion-finanzas' && (tabQS === null || tabQS === 'gastos' || tabQS === 'categorias' || tabQS === 'capacidad'));
	let enEvolIngresos = $derived(actual === '/evolucion-finanzas' && (tabQS === 'ingresos' || tabQS === 'poder'));

	// ===== Escalada y reload unificados (Brief 0) =====
	// Mismo patrón para las 3 pantallas de falla (banner global, perfilError,
	// caso B de pool con bytes), cada una con su propia clave de sessionStorage
	// para no pisarse entre sí (un reintento del banner no debe ocultar el
	// botón de la pantalla de perfil, ni al revés).
	function reciente(clave: string): boolean {
		try {
			const ts = sessionStorage.getItem(clave);
			return ts != null && Date.now() - Number(ts) < 60000;
		} catch {
			return false; // sessionStorage no disponible: no escala, se comporta como antes
		}
	}

	// Guarda el timestamp de este intento (para que la próxima falla en la
	// misma pantalla pueda escalar) y recarga tras el margen — le da tiempo al
	// navegador de liberar el worker/lock viejo antes de que el documento nuevo
	// abra otro. Un reload no mata procesos colgados del documento anterior,
	// por eso el escalón siguiente sigue siendo cerrar la app, no un segundo reload.
	async function reintentarConReload(clave: string, margenMs: number) {
		try { sessionStorage.setItem(clave, String(Date.now())); } catch { /* no soportado */ }
		await new Promise((r) => setTimeout(r, margenMs));
		location.reload();
	}

	// El reload ya no alcanzó: hay que cerrar la app de verdad. Pasos concretos
	// en iOS (sin gesto de recarga ni barra de direcciones en standalone); el
	// texto genérico de siempre en el resto.
	function textoCerrarApp(): string {
		return esIOS()
			? 'Cerrá la app por completo: deslizá desde abajo, mantené, deslizá la tarjeta de Rienda hacia arriba y volvé a abrir desde el ícono.'
			: 'Cerrá la app por completo (no solo minimizarla) y volvé a abrirla.';
	}

	// Red global: cualquier promesa rechazada que nadie atrapó en toda la app
	// cae acá. No parsea el error ni distingue causas a propósito — un solo
	// texto genérico, porque no hay forma confiable de saber desde acá qué
	// pantalla era ni qué estaba cargando.
	function onRechazoNoAtrapado(e: PromiseRejectionEvent) {
		console.error(e.reason);
		errorGlobalCrudo = e.reason;
		// sessionStorage se resetea solo al cerrar la PWA y reabrirla, así que la
		// próxima sesión real vuelve a ofrecer Reintentar.
		errorGlobalEscalado = reciente('banner_reintento_ts');
		errorGlobal = 'Algo se colgó cargando datos. Cerrá la app por completo (no solo minimizarla) y volvé a abrirla.';
	}

	onMount(() => {
		// Brief 0 — Bloque 4: si venimos de "Sí, crear de todos modos" (reload
		// desde el caso B), la clave se lee y se consume ACA, antes de
		// iniciarArranque(), para que este arranque salte directo al stepper de
		// bienvenida sin importar cómo clasifiquen las señales. Se borra al leer
		// para que un reload posterior no la fuerce de nuevo.
		try {
			if (sessionStorage.getItem('forzar_bienvenida')) {
				sessionStorage.removeItem('forzar_bienvenida');
				forzarBienvenidaNormal = true;
			}
		} catch { /* sessionStorage no disponible: se comporta como si no se hubiera confirmado */ }
		iniciarArranque();
		if (!dev && 'serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js');
		}
		// El pedido de almacenamiento persistente (navigator.storage.persist()) se
		// movió a leerSenalesArranque(): sin esto, el navegador puede desalojar el
		// OPFS bajo presión de espacio. Crítico en iOS, donde Safari borra los datos
		// creados por script tras 7 días sin abrir la app (apps agregadas a la
		// pantalla de inicio quedan exentas). Best-effort. Su resultado ahora queda
		// reflejado en estadoStorage en vez de descartarse.
		// La captura de beforeinstallprompt / standalone vive en pwa.svelte.ts (a
		// nivel módulo, se evalúa temprano vía el import de InstalarApp).
		window.addEventListener('scroll', alScrollear, { passive: true });
		window.addEventListener('unhandledrejection', onRechazoNoAtrapado);
		return () => {
			window.removeEventListener('scroll', alScrollear);
			window.removeEventListener('unhandledrejection', onRechazoNoAtrapado);
		};
	});

</script>

{#if errorGlobal}
	<div class="banner-global-err">
		<span class="err-x">✗</span>
		<p>{errorGlobal}</p>
		<div class="banner-global-acciones">
			{#if !errorGlobalEscalado}
				<button class="crear" onclick={() => reintentarConReload('banner_reintento_ts', 400)}>Reintentar</button>
			{:else}
				<p class="bmsg err"><span class="err-x">✗</span> {textoCerrarApp()}</p>
			{/if}
			<button class="banner-global-cerrar" onclick={() => (errorGlobal = '')} aria-label="Cerrar aviso">✕</button>
		</div>
		<DiagnosticoTecnico pantalla="Banner global (promesa no atrapada)" {senalPool} {marcaPerfil} {estadoStorage} errorCrudo={errorGlobalCrudo} abierto={false} />
	</div>
{/if}

{#if fotosProgreso.activo}
	<div class="banner-fotos" role="status">Recalculando historial… {fotosProgreso.hecho}/{fotosProgreso.total}</div>
{/if}

{#if sync.estado === 'sin_conexion'}
	<div class="bienvenida">
		<div class="bcard">
			<h2 class="bq">Conectá Rienda con tu Sheet</h2>
			<p>Pegá el enlace de conexión que te dio el Apps Script de tu Sheet "Finanzas" (termina en <code>…/exec?k=…</code>). Se pide una sola vez en este teléfono.</p>
			<input class="enlace" type="url" placeholder="https://script.google.com/macros/s/…/exec?k=…" bind:value={enlaceTexto} autocomplete="off" autocapitalize="off" spellcheck="false" />
			<button class="crear" disabled={conectando || !enlaceTexto.trim()} onclick={onConectar}>{conectando ? 'Conectando…' : 'Conectar'}</button>
			{#if conectarMsg}<p class="bmsg err"><span class="err-x">✗</span> {conectarMsg}</p>{/if}
		</div>
	</div>
{:else if sync.estado === 'error_carga'}
	<div class="bienvenida">
		<div class="bcard">
			<h2 class="bq">No pudimos bajar tus datos de la Sheet</h2>
			<p>{sync.mensaje}</p>
			<p>Tus datos no se tocaron: siguen en la Sheet.</p>
			<button class="crear" onclick={() => location.reload()}>Reintentar</button>
			<button class="bback" onclick={onCambiarEnlace}>Cambiar enlace de conexión</button>
		</div>
	</div>
{:else if chequeando}
	<div class="cargando-app"><p>{sync.estado === 'cargando' ? 'Bajando tus datos de la Sheet…' : 'Cargando…'}</p></div>
{:else if perfilError}
	<div class="bienvenida">
		<div class="bcard">
			<h2 class="bq">No pudimos verificar tu perfil</h2>
			<p>Puede ser un problema pasajero de la base local. Tus datos no se tocaron.</p>
			{#if !perfilErrorEscalado}
				<button class="crear" onclick={() => reintentarConReload('perfilerror_reintento_ts', 1000)}>Reintentar</button>
			{:else}
				<p class="bmsg err"><span class="err-x">✗</span> {textoCerrarApp()}</p>
			{/if}
			<DiagnosticoTecnico pantalla="No pudimos verificar tu perfil" {senalPool} {marcaPerfil} {estadoStorage} {errorCrudo} abierto={false} />
		</div>
	</div>
{:else if !perfilListo}
	{#if diagArranque && !forzarBienvenidaNormal}
		<!-- Pantalla diferenciada de arranque (Blindaje iOS, Bloque 2) -->
		<div class="bienvenida">
			<div class="bcard">
				{#if diagArranque === 'pool_con_bytes'}
					<h2 class="bq">Encontramos tu base pero no pudimos leerla</h2>
					<p>No crees un perfil nuevo todavía.</p>
					<!-- Copia de rescate (Blindaje iOS, Brief 2): arriba de Reintentar, que
					     puede terminar creando una base nueva al lado y empeorar la cosa. -->
					{#if autobackupsRescate === null}
						<!-- buscando copias locales, no bloquea nada -->
					{:else if autobackupsRescate.length === 0}
						<p class="bmsg err"><span class="err-x">✗</span> No hay copias locales disponibles.</p>
					{:else}
						<p class="bp">Última copia local: {autobackupsRescate[0].fecha}.</p>
						<div class="bnav">
							<button class="crear" onclick={onDescargarRescate}>⬇ Descargar/compartir copia de rescate</button>
						</div>
					{/if}
					{#if !poolBytesEscalado}
						<div class="bnav">
							<button class="crear" onclick={() => reintentarConReload('poolbytes_reintento_ts', 1000)}>Reintentar</button>
						</div>
					{:else}
						<p class="bmsg err"><span class="err-x">✗</span> {textoCerrarApp()}</p>
					{/if}
					{#if !confirmarCrearNuevo}
						<button type="button" class="bback" onclick={() => (confirmarCrearNuevo = true)}>Crear perfil nuevo</button>
					{:else}
						<p class="bmsg err"><span class="err-x">✗</span> Si creás un perfil nuevo no vamos a poder recuperar la base anterior desde acá. ¿Confirmás?</p>
						<div class="bnav">
							<button class="bback" onclick={() => (confirmarCrearNuevo = false)} disabled={confirmandoCrearNuevo}>Cancelar</button>
							<button class="crear" onclick={onCrearNuevoConfirmado} disabled={confirmandoCrearNuevo}>{confirmandoCrearNuevo ? 'Recargando…' : 'Sí, crear de todos modos'}</button>
						</div>
					{/if}
					<DiagnosticoTecnico pantalla="Arranque: pool con bytes, no se pudo leer" {senalPool} {marcaPerfil} {estadoStorage} {errorCrudo} abierto={true} />
				{:else}
					<h2 class="bq">El navegador borró los datos de Rienda en este dispositivo.</h2>
					<p>No lo hizo la app.{#if diagArranque === 'borrado_parcial'} Parece un borrado parcial: encontramos una marca de que tuviste un perfil, pero no la base.{/if}</p>
					<div class="bnav">
						<button class="crear" onclick={() => importInputBienvenida?.click()}>⬆ Importar copia</button>
					</div>
					<button type="button" class="bback" onclick={() => (forzarBienvenidaNormal = true)}>Empezar de cero</button>
					<input type="file" accept=".json,.txt,text/plain,application/json" bind:this={importInputBienvenida} onchange={onImportarBienvenida} style="display:none" />
					<DiagnosticoTecnico pantalla={diagArranque === 'borrado_parcial' ? 'Arranque: borrado parcial' : 'Arranque: borrado total'} {senalPool} {marcaPerfil} {estadoStorage} {errorCrudo} abierto={false} />
				{/if}
			</div>
		</div>
	{:else}
		<!-- Bienvenida -->
		<div class="bienvenida">
			<div class="bcard">
				<div class="bdots" aria-hidden="true">
					{#each Array.from({ length: TOTAL_PASOS }) as _, i}<span class="bdot" class:on={i + 1 === paso}></span>{/each}
				</div>

				{#if paso === 1}
					<h1>Tomá el control de tu plata, a tu manera.</h1>
				{:else if paso === 2}
					<h2 class="bq">¿Cómo te llamás?</h2>
					<input class="bin" bind:value={nombreNuevo} placeholder="Tu nombre" onkeydown={(e) => e.key === 'Enter' && siguiente()} />
				{:else if paso === 3}
					<h2 class="bq">¿Cuándo arranca tu mes financiero?</h2>
					<div class="modo-btns">
						<button type="button" class:activo={modoNuevo === 'calendario'} onclick={() => (modoNuevo = 'calendario')}>📅 Del 1 al 30 — calendario</button>
						<button type="button" class:activo={modoNuevo === 'sueldo'} onclick={() => (modoNuevo = 'sueldo')}>💸 El día que cobrás — sueldo</button>
					</div>
					<p class="bsub">Lo cambiás cuando quieras en Configuración.</p>
				{:else if paso === 4}
					<p class="bp">Tus datos se guardan en tu Google Sheet. Conviene instalar la app:</p>
					<InstalarApp compacto mostrarInstalada dismissible={false} />
				{:else}
					<p class="bp">Listo. Cargá un gasto y arrancá. Lo demás aparece cuando lo quieras.</p>
				{/if}

				<div class="bnav">
					{#if paso > 1}<button class="bback" onclick={atras}>Atrás</button>{/if}
					{#if paso < TOTAL_PASOS}
						<button class="crear" onclick={siguiente} disabled={!puedeAvanzar}>Siguiente</button>
					{:else}
						<button class="crear" onclick={onCrearPerfil} disabled={creando || !nombreNuevo.trim()}>{creando ? 'Creando…' : 'Empezar'}</button>
					{/if}
				</div>
				{#if bienvenidaMsg}<p class="bmsg" class:err={bienvenidaMsgErr}>{#if bienvenidaMsgErr}<span class="err-x">✗</span> {/if}{bienvenidaMsg}</p>{/if}

				{#if paso === 1}
					<div class="separador"><span>o</span></div>
					<button class="importar-b" onclick={() => importInputBienvenida?.click()}>⬆ Ya tengo una copia de seguridad</button>
					<input type="file" accept=".json,.txt,text/plain,application/json" bind:this={importInputBienvenida} onchange={onImportarBienvenida} style="display:none" />
				{/if}
			</div>
		</div>
	{/if}
{:else}
	<!-- App normal -->
	<div class="topacc">
		<button class="hamb" onclick={() => (menuAbierto = true)} aria-label="Abrir menú">☰</button>
		<a class="campana" href="/notificaciones" aria-label="Notificaciones{notif.count > 0 ? ` (${notif.count})` : ''}">
			<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
				<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
			</svg>
			{#if notif.count > 0}<span class="badge">{notif.count > 9 ? '9+' : notif.count}</span>{/if}
		</a>
	</div>

	{#if menuAbierto}
		<!-- Fondo oscurecido -->
		<div class="overlay" onclick={() => (menuAbierto = false)} role="presentation"></div>
		<!-- Panel lateral derecho -->
		<aside class="panel">
			<button class="cerrar" onclick={() => (menuAbierto = false)} aria-label="Cerrar menú">✕</button>

			<span class="marca-menu">Rienda</span>

			<div class="grupo">
				<span class="gtit">Finanzas</span>
				<button class="item" class:activo={actual === '/'} onclick={() => irA('/')}>Cuenta Corriente</button>
				<button class="item" class:activo={enEvolGastos} onclick={() => irA('/evolucion-finanzas')}>Evolución de Gastos</button>
				<button class="item" class:activo={enEvolIngresos} onclick={() => irA('/evolucion-finanzas?tab=ingresos')}>Evolución de Ingresos</button>
				<button class="item" class:activo={actual === '/configuracion'} onclick={() => irA('/configuracion')}>Configuración</button>
			</div>

			<!-- Rienda + Sheets: Inversiones queda para la fase 2 (Sheet "Inversiones"). -->

			<div class="grupo">
				<span class="gtit">Datos</span>
				<button class="item" class:activo={actual === '/datos'} onclick={() => irA('/datos')}>Tus datos</button>
				<button class="item" class:activo={actual === '/sobre-rienda'} onclick={() => irA('/sobre-rienda')}>Sobre Rienda</button>
				<button class="item" onclick={onActualizarCotiz} disabled={actualizandoCotiz}>
					{actualizandoCotiz ? 'Actualizando…' : 'Actualizar tipo de cambio'}
				</button>
			</div>
		</aside>
	{/if}

	{#if sync.offline}
		<div class="sync-aviso">Sin conexión con la Sheet: estás viendo la copia de este teléfono. Lo que cargues se guarda cuando vuelva la señal.</div>
	{/if}
	{#if sync.frenado}
		<div class="sync-aviso rojo">{sync.frenado}</div>
	{/if}
	{#if sync.guardado === 'error' || (sync.guardado === 'pendiente' && sync.pendientes > 0)}
		<div class="sync-aviso" class:rojo={sync.guardado === 'error'}>
			{sync.guardado === 'error' ? 'No se pudo guardar en la Sheet: ' + sync.mensaje : 'Sin señal: ' + sync.pendientes + ' cambio(s) esperando para guardarse en la Sheet.'}
		</div>
	{/if}
	{#if sync.avisos.length}
		<a class="sync-aviso" href="/datos">{sync.avisos.length} fila(s) de la Sheet no se pudieron leer. Tocá para ver cuáles.</a>
	{/if}

	{@render children()}

	{#if mostrarSubir}
		<button class="subir" onclick={subirArriba} aria-label="Subir al inicio">↑</button>
	{/if}

{/if}

<style>
	/* ===== Refresh v2: fuentes self-hosted (offline, cacheadas por el SW) =====
	   Archivo (display: titulos/marca) + Chivo Mono (cifras). Solo estetica. */
	@font-face { font-family: 'Archivo'; src: url('/fonts/archivo-latin-500-normal.woff2') format('woff2'); font-weight: 500; font-style: normal; font-display: swap; }
	@font-face { font-family: 'Archivo'; src: url('/fonts/archivo-latin-600-normal.woff2') format('woff2'); font-weight: 600; font-style: normal; font-display: swap; }
	@font-face { font-family: 'Archivo'; src: url('/fonts/archivo-latin-700-normal.woff2') format('woff2'); font-weight: 700; font-style: normal; font-display: swap; }
	@font-face { font-family: 'Chivo Mono'; src: url('/fonts/chivo-mono-latin-300-normal.woff2') format('woff2'); font-weight: 300; font-style: normal; font-display: swap; }
	@font-face { font-family: 'Chivo Mono'; src: url('/fonts/chivo-mono-latin-400-normal.woff2') format('woff2'); font-weight: 400; font-style: normal; font-display: swap; }
	@font-face { font-family: 'Chivo Mono'; src: url('/fonts/chivo-mono-latin-500-normal.woff2') format('woff2'); font-weight: 500; font-style: normal; font-display: swap; }

	:global(:root) {
		--bg: #070b14;
		--surface: #172033;
		--surface-2: #1d2942;
		--surface-3: #233251;
		--border: #2a3a57;
		--text: #e4e8f0;
		--text-dim: #94a0b8;
		--accent: #5b9dff;
		--accent-hover: #7db0ff;
		--pos: #4ade80;
		--neg: #f87171;
		--warn: #fbbf24;
		--radius: 8px;
		/* Refresh v2: roles tipograficos (display para titulos, mono para cifras) */
		--font-display: 'Archivo', system-ui, sans-serif;
		--font-num: 'Chivo Mono', ui-monospace, 'Cascadia Mono', monospace;
	}

	:global(body) {
		background: var(--bg);
		color: var(--text);
		font-family: system-ui, sans-serif;
		margin: 0;
	}

	:global(h1) { color: var(--text); font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em; }
	/* Título con "?" de guía al lado; el cuadro se despliega debajo a lo ancho */
	/* Regla vertical (elemento firma del refresh v2) sobre el titulo de cada pantalla */
	:global(.titulo-guia) { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 14px 0 12px; border-left: 3px solid var(--accent); padding-left: 14px; }
	:global(.titulo-guia h1) { margin: 0; line-height: 1.15; }
	:global(h2), :global(h3) { color: var(--text); font-family: var(--font-display); font-weight: 600; }
	/* Regla firma reutilizable para encabezados de seccion */
	:global(.con-regla) { border-left: 3px solid var(--accent); padding-left: 12px; }
	:global(p) { color: var(--text); }

	/* ===== Tablas (refresh v2): sin grilla — separadores horizontales,
	   encabezado utilitario en mayusculas y cifras en mono. Solo estetica. ===== */
	:global(table) { border-collapse: collapse; }
	:global(th), :global(td) { border: none !important; border-bottom: 1px solid var(--border) !important; }
	:global(th) { color: var(--text-dim); font-weight: 600; }
	:global(thead th) { font-family: var(--font-display); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.09em; border-bottom: 1px solid var(--text-dim) !important; }
	:global(tbody tr:hover) { background: rgba(255, 255, 255, 0.025); }
	:global(tfoot td) { border-top: 2px solid var(--text-dim) !important; border-bottom: none !important; }
	/* Contenedor estandar para tablas anchas: scroll horizontal DENTRO del marco,
	   sin arrastrar el ancho del resto de la pagina. Se aplica envolviendo la tabla
	   en <div class="tabla-scroll">. */
	:global(.tabla-scroll) { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
	/* Item 4: dígitos alineados en columnas de cifras */
	:global(table), :global(.num), :global(.card strong), :global(.disp-tabla), :global(.reg-monto), :global(.ficha-monto) { font-variant-numeric: tabular-nums; }
	/* Cifras en mono (celdas numericas y montos destacados) */
	:global(td.num), :global(.card strong), :global(.reg-monto), :global(.ficha-monto) { font-family: var(--font-num); }

	:global(input), :global(select) {
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	:global(input::placeholder) { color: var(--text-dim); }

	/* ===== Accesibilidad: foco visible por teclado (a11y) =====
	   Solo aparece al navegar con Tab (no al clickear), gracias a :focus-visible. */
	:global(button:focus-visible), :global(a:focus-visible),
	:global(input:focus-visible), :global(select:focus-visible),
	:global([role="group"] button:focus-visible), :global([tabindex]:focus-visible) {
		outline: 2px solid var(--accent-hover);
		outline-offset: 2px;
		border-radius: 6px;
	}
	:global(button:focus:not(:focus-visible)) { outline: none; }

	/* Respeta "reducir movimiento": desactiva las view-transitions */
	@media (prefers-reduced-motion: reduce) {
		:global(::view-transition-old(root)), :global(::view-transition-new(root)) { animation: none !important; }
	}

	/* ===== Sistema de botones (jerarquia unica para toda la app) =====
	   Uso: class="btn btn-primary" | btn-secondary | btn-ghost | btn-danger | btn-success
	   Tamanos: (normal) | btn-sm | btn-icon. Segmentado: <div class="seg"> con .is-active */
	:global(.btn) {
		font: inherit; font-weight: 600; line-height: 1;
		display: inline-flex; align-items: center; justify-content: center; gap: 6px;
		padding: 8px 14px; font-size: 0.9rem;
		border: 1px solid transparent; border-radius: 6px;
		cursor: pointer; text-decoration: none; white-space: nowrap;
		transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease, transform 0.10s ease;
	}
	:global(.btn:disabled), :global(.btn.is-disabled) { opacity: 0.55; cursor: default; pointer-events: none; }

	/* ===== Press-state (feedback tactil, sobre todo en mobile) =====
	   Hundido sutil al presionar. Sin transform si el usuario pidio "reducir movimiento". */
	@media (prefers-reduced-motion: no-preference) {
		:global(button:active), :global(.btn:active), :global(a.btn:active) { transform: scale(0.97); }
	}
	:global(.btn:active) { filter: brightness(0.93); }
	/* Filas de lista clickeables: leve realce al presionar */
	:global(.reg:active), :global(.ficha:active), :global(.disp-linea-btn:active), :global(.disp-toggle:active) {
		background: rgba(91, 157, 255, 0.06);
	}
	:global(.btn-primary) { background: var(--accent); color: #fff; }
	:global(.btn-primary:hover) { background: var(--accent-hover); }
	:global(.btn-secondary) { background: var(--surface-2); color: var(--text); border-color: var(--border); }
	:global(.btn-secondary:hover) { border-color: var(--accent); }
	:global(.btn-ghost) { background: none; color: var(--accent); border-color: transparent; padding-left: 4px; padding-right: 4px; }
	:global(.btn-ghost:hover) { text-decoration: underline; }
	:global(.btn-danger) { background: rgba(248, 113, 113, 0.15); color: var(--neg); }
	:global(.btn-danger:hover) { background: rgba(248, 113, 113, 0.28); }
	:global(.btn-success) { background: var(--pos); color: #06281a; }
	:global(.btn-success:hover) { filter: brightness(1.06); }
	:global(.btn-danger-solid) { background: var(--neg); color: #fff; }
	:global(.btn-danger-solid:hover) { filter: brightness(1.06); }
	:global(.btn-danger-outline) { background: transparent; color: var(--neg); border-color: var(--neg); }
	:global(.btn-danger-outline:hover) { background: var(--neg); color: #fff; }
	/* Icono cuadrado, mismo alto que un .btn de texto */
	:global(.btn-icon) { padding: 0; width: 32px; height: 32px; font-size: 0.95rem; }
	/* Fila de botones de ancho parejo: columnas iguales, una sola fuente/alto */
	:global(.btn-row) { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }

	/* Botones inline / ícono estandarizados (✏ ✕ ✓ 🗑), una sola definición */
	:global(.lapiz) { background: rgba(91, 157, 255, 0.12); color: var(--accent); border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; line-height: 1; padding: 3px 9px; }
	:global(.lapiz:hover) { background: rgba(91, 157, 255, 0.22); }
	:global(.okp) { background: var(--pos); color: #06281a; border: none; border-radius: 6px; cursor: pointer; padding: 3px 9px; font-size: 0.85rem; line-height: 1; margin-left: 2px; }
	:global(.cancp) { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; padding: 3px 9px; font-size: 0.85rem; line-height: 1; margin-left: 2px; }
	:global(.del) { background: rgba(248, 113, 113, 0.15); color: var(--neg); border: none; border-radius: 6px; cursor: pointer; padding: 3px 9px; font-size: 0.85rem; line-height: 1; }
	:global(.del:hover) { background: rgba(248, 113, 113, 0.28); }
	:global(.del.off) { opacity: 0.35; cursor: not-allowed; }

	/* .vistas/.tabs/.periodos/.toggle YA vivían fusionados con .seg más abajo
	   (Brief H / A3): eran una regla duplicada con los mismos valores exactos,
	   no una variante distinta — ver el selector combinado en ":global(.seg > button)". */
	:global(.modo-btns button), :global(.medio button), :global(.acciones button) {
		font: inherit; font-weight: 600; font-size: 0.85rem; line-height: 1;
		flex: 1; padding: 8px 6px; border: 1px solid var(--border); border-radius: 6px;
		background: var(--surface-2); color: var(--text); cursor: pointer;
	}
	:global(.modo-btns button.activo), :global(.medio button.activo), :global(.acciones button.activo) { background: var(--accent); color: #fff; border-color: var(--accent); }

	/* ===== Ficha de carga estandarizada (una sola definicion para toda la app):
	   card estilo v2, alineada a la izquierda, 360px, mismo gap de campos ===== */
	:global(.form) {
		display: flex; flex-direction: column; gap: 9px;
		max-width: 360px; margin: 12px 0;
		background: var(--surface); border: 1px solid transparent; border-radius: 8px;
		padding: 14px 16px;
	}

	/* ===== Panel colapsable de alta ("+ Cargar/Agregar...", una sola definicion
	   para toda la app — antes copiada igual en 6 pantallas, ver Brief H / A3) ===== */
	:global(.form-panel) { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin: 12px 0; }
	:global(.form-panel summary) { cursor: pointer; padding: 11px 14px; font-family: var(--font-display); font-weight: 600; font-size: 0.92rem; color: var(--accent); list-style: none; }
	:global(.form-panel summary::-webkit-details-marker) { display: none; }
	:global(.form-panel[open] summary) { border-bottom: 1px solid var(--border); }
	:global(.form-panel .form) { background: none; border-color: transparent; border-radius: 0; margin: 0; padding: 12px 14px; }

	/* ===== Tarjetas KPI (una sola definicion para toda la app, valores
	   exactos de /inversiones) ===== Uso: <div class="resumen"><div class="card">
	   <span>Etiqueta</span><strong>Valor</strong></div></div>. Variantes:
	   .card.destacado (resalte de acento), .card.big (valor más grande),
	   .card.ok / .card.bad (semáforo). El hero de "primera tarjeta" de
	   /inversiones (:first-child) queda local a esa pantalla, no es global. */
	:global(.resumen) { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 12px 0; }
	:global(.card) {
		border: 1px solid transparent; background: var(--surface); border-radius: 8px;
		padding: 10px 11px; display: flex; flex-direction: column; gap: 2px; min-width: 0;
	}
	:global(.card > span) {
		font-family: var(--font-display); font-size: clamp(0.56rem, 2.4vw, 0.66rem);
		font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-dim);
	}
	:global(.card strong) { font-size: clamp(0.85rem, 3.6vw, 1.25rem); font-weight: 400; white-space: nowrap; }
	:global(.card.big strong) { font-size: clamp(1.1rem, 4.2vw, 1.6rem); }
	:global(.card.destacado) { background: rgba(91, 157, 255, 0.08); border-color: rgba(91, 157, 255, 0.3); }
	:global(.card.ok) { background: rgba(74, 222, 128, 0.10); border-color: rgba(74, 222, 128, 0.35); }
	:global(.card.bad) { background: rgba(248, 113, 113, 0.10); border-color: rgba(248, 113, 113, 0.35); }
	:global(.sk-card) { gap: 6px; }

	/* Links de navegacion / texto */
	:global(.btn-volver) { display: inline-block; background: none; border: none; cursor: pointer; padding: 0; color: var(--accent); text-decoration: none; font-size: 0.9rem; margin: 4px 0 12px; }
	:global(.btn-volver:hover) { text-decoration: underline; }
	:global(.link) { background: none; border: none; color: var(--accent); cursor: pointer; text-decoration: underline; font-size: 0.85rem; padding: 0; }

	/* Control segmentado (pill): fuente única para .seg y sus alias históricos
	   .vistas/.tabs/.periodos/.toggle (Brief H / A3 — antes era una regla
	   duplicada letra por letra en dos bloques separados de este mismo archivo,
	   no una variante visual distinta; queda igual a como se veía). */
	:global(.seg) { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
	:global(.seg > button), :global(.seg > a),
	:global(.vistas button), :global(.tabs button), :global(.periodos button), :global(.toggle button) {
		font: inherit; font-weight: 600; font-size: 0.82rem; line-height: 1;
		padding: 6px 12px; border: 1px solid var(--border); border-radius: 20px;
		background: var(--surface-2); color: var(--text); cursor: pointer; white-space: nowrap; text-decoration: none;
	}
	:global(.seg > button.is-active), :global(.seg > a.is-active),
	:global(.seg > button.activo), :global(.seg > a.activo),
	:global(.vistas button.activo), :global(.tabs button.activo), :global(.periodos button.activo), :global(.toggle button.activo) { background: var(--accent); color: #fff; border-color: var(--accent); }
	:global(.seg-block) { display: flex; }
	:global(.seg-block > button) { flex: 1; border-radius: 6px; padding: 8px 6px; }

	:global(.pos) { color: var(--pos) !important; }
	:global(.neg) { color: var(--neg) !important; }
	:global(td.ok) { color: var(--pos) !important; }
	:global(td.bad) { color: var(--neg) !important; }
	:global(td.warn) { color: var(--warn) !important; }

	/* ===== Barra superior ===== */
	.marca-menu { font-family: var(--font-display); font-size: 1.6rem; font-weight: 700; color: var(--text); padding: 0 8px 4px; border-left: 3px solid var(--accent); padding-left: 12px; }
	/* Rienda + Sheets */
	.sync-aviso { display: block; margin: 0 auto 12px; max-width: 820px; padding: 9px 12px; border-radius: 8px; font-size: 0.85rem; background: var(--surface); border-left: 3px solid var(--warn); color: var(--text); text-decoration: none; }
	.sync-aviso.rojo { border-left-color: var(--neg); }
	.bcard input.enlace { width: 100%; box-sizing: border-box; padding: 10px; margin: 6px 0 12px; font: inherit; font-size: 0.9rem; }
	.bcard code { font-size: 0.85em; }
	/* Acciones fijas arriba a la derecha: menú + campana, apiladas y centradas entre sí. */
	.topacc {
		position: fixed; top: 35px; right: 16px; z-index: 10;
		display: flex; flex-direction: column; align-items: center; gap: 8px;
	}
	.hamb {
		background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
		border-radius: 6px; font-size: 1.1rem; padding: 4px 12px; cursor: pointer; line-height: 1;
	}
	.hamb:hover { border-color: var(--accent); }
	/* Campana: debajo de la hamburguesa, más chica y liviana (menor peso visual). */
	.campana {
		position: relative;
		display: inline-flex; align-items: center; justify-content: center;
		width: 30px; height: 26px; border-radius: 6px;
		background: transparent; color: var(--text-dim); border: 1px solid transparent;
		cursor: pointer; text-decoration: none; line-height: 1;
	}
	.campana:hover { color: var(--text); border-color: var(--border); }
	.campana .badge {
		position: absolute; top: -5px; right: -5px; min-width: 15px; height: 15px; padding: 0 3px;
		border-radius: 8px; background: var(--neg); color: #fff; font-size: 0.6rem; font-weight: 700;
		display: inline-flex; align-items: center; justify-content: center; line-height: 1;
	}

	.subir {
		position: fixed;
		bottom: 20px;
		left:50%;
		transform: translateX(-50%);
		z-index: 15;
		width: 44px; height: 44px;
		background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
		border-radius: 50%; font-size: 1.2rem; cursor: pointer; line-height: 1;
		box-shadow: 0 2px 12px rgba(0,0,0,0.4);
	}
	.subir:hover { border-color: var(--accent); }
	/* ===== Menú lateral ===== */
	.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 20; }
	.panel {
		position: fixed; top: 0; right: 0; height: 100%; width: 260px; max-width: 80vw;
		background: var(--surface); border-left: 1px solid var(--border);
		z-index: 21; padding: 16px; display: flex; flex-direction: column; gap: 18px;
		box-shadow: -4px 0 20px rgba(0,0,0,0.3);
	}
	.cerrar {
		align-self: flex-end; background: none; border: none; color: var(--text-dim);
		font-size: 1.2rem; cursor: pointer; padding: 0 4px;
	}
	.cerrar:hover { color: var(--text); }
	.grupo { display: flex; flex-direction: column; gap: 4px; }
	.gtit { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); padding: 0 8px 4px; }
	.item {
		background: none; border: none; color: var(--accent); text-align: left;
		font-size: 0.95rem; font-weight: 600; padding: 9px 12px; border-radius: 6px; cursor: pointer;
	}
	.item:hover { background: rgba(91, 141, 239, 0.12); }
	.item.activo { background: var(--accent); color: #fff; }
	.item:disabled { opacity: 0.6; cursor: default; }

	/* ===== Bienvenida ===== */
	.cargando-app { max-width: 820px; margin: 40px auto; padding: 16px; }
	.bienvenida { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
	.bcard {
		background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
		padding: 28px 24px; max-width: 360px; width: 100%; display: flex; flex-direction: column; gap: 12px;
	}
	.bcard h1 { margin: 0; font-size: 1.35rem; line-height: 1.25; }
	.bdots { display: flex; gap: 6px; justify-content: center; margin-bottom: 2px; }
	.bdot { width: 7px; height: 7px; border-radius: 50%; background: var(--border); }
	.bdot.on { background: var(--accent); }
	.bq { margin: 0; font-size: 1.15rem; }
	.bin { padding: 9px; font-size: 1rem; }
	.bp { font-size: 1rem; color: var(--text); margin: 0; line-height: 1.5; }
	.bsub { font-size: 0.8rem; color: var(--text-dim); margin: 2px 0 0; }
	.bnav { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
	.bnav .crear { flex: 1; }
	.bback { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; cursor: pointer; font-size: 0.9rem; }
	.crear { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 10px; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
	.crear:disabled { opacity: 0.6; cursor: default; }
	.bmsg { font-size: 0.82rem; color: var(--neg); margin: 0; }
	.bmsg.err { display: flex; align-items: center; gap: 6px; }
	.bmsg .err-x { font-size: 1.3em; line-height: 1; }

	/* Banner global de error (unhandledrejection): fijo arriba de TODO, incluida
	   la barra superior y cualquier pantalla — misma pieza para las 100%. */
	.banner-global-err {
		position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
		display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
		background: #2a1414; border-bottom: 1px solid var(--neg);
		color: var(--text); padding: 10px 16px; font-size: 0.88rem;
	}
	.banner-fotos {
		position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 900;
		background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
		color: var(--text); padding: 8px 14px; border-radius: 8px; font-size: 0.82rem;
	}
	.banner-global-err .err-x { color: var(--neg); font-size: 1.2em; line-height: 1; }
	.banner-global-err p { margin: 0; flex: 1; min-width: 200px; }
	.banner-global-acciones { display: flex; align-items: center; gap: 8px; }
	.banner-global-cerrar {
		background: none; border: none; color: var(--text-dim); cursor: pointer;
		font-size: 1rem; line-height: 1; padding: 4px;
	}
	.banner-global-cerrar:hover { color: var(--text); }

	.separador { display: flex; align-items: center; gap: 10px; color: var(--text-dim); font-size: 0.8rem; }
	.separador::before, .separador::after { content: ''; flex: 1; height: 1px; background: var(--border); }
	.importar-b { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 9px; cursor: pointer; font-size: 0.9rem; }
	.importar-b:hover { border-color: var(--accent); }

	/* ===== Selección de modo de período (bienvenida) ===== */
	.modo-btns { display: flex; flex-direction: column; gap: 8px; }
	.modo-btns button {
		width: 100%; padding: 11px 12px; border: 1px solid var(--border); background: var(--surface-2);
		color: var(--text); border-radius: 6px; cursor: pointer; font-size: 0.9rem; text-align: left;
	}
	.modo-btns button.activo { background: var(--accent); color: #fff; border-color: var(--accent); }

	:global(::view-transition-old(root)), :global(::view-transition-new(root)) {
		animation-duration: 0.25s; animation-timing-function: ease;
	}
</style>