<script lang="ts">
	// Rienda + Sheets: "Tus datos" muestra la conexión con la Google Sheet.
	// Ya no hay copias de seguridad ni importación/borrado local: la Sheet es la
	// fuente de verdad y el respaldo a la vez.
	import { sync, recargarDesdeSheet } from '$lib/sheets/sync.svelte';
	import { borrarConexion } from '$lib/sheets/conexion';
	import { descargarBlob, exportarFinanzasXLSX, exportarInversionesXLSX } from '$lib/db/precarga';
	import { hoyISO, fechaHoraCorta } from '$lib/format';
	import Guia from '$lib/Guia.svelte';
	import InstalarApp from '$lib/InstalarApp.svelte';

	let recargando = $state(false);
	let msg = $state('');

	async function onRecargar() {
		recargando = true;
		msg = '';
		const ok = await recargarDesdeSheet();
		if (!ok) {
			msg = 'Hay cambios que todavía no se pudieron guardar en la Sheet. Probá de nuevo cuando tengas señal.';
			recargando = false;
		}
	}

	async function onExcel() {
		try {
			descargarBlob(`rienda-finanzas-${hoyISO()}.xlsx`, await exportarFinanzasXLSX());
		} catch (e) {
			console.error(e);
			alert('No se pudo generar el Excel.');
		}
	}

	async function onExcelInv() {
		try {
			descargarBlob(`rienda-inversiones-${hoyISO()}.xlsx`, await exportarInversionesXLSX());
		} catch (e) {
			console.error(e);
			alert('No se pudo generar el Excel.');
		}
	}

	function onDesconectar() {
		if (sync.pendientes > 0) {
			alert('Hay cambios sin guardar en la Sheet. Esperá a tener señal antes de desconectar.');
			return;
		}
		if (!confirm('¿Desconectar este teléfono de la Sheet? Tus datos siguen en la Sheet; vas a tener que pegar el enlace de nuevo.')) return;
		borrarConexion();
		location.href = '/';
	}

	const estadoTexto = $derived(
		sync.guardado === 'guardando' ? 'Guardando…'
		: sync.guardado === 'error' ? 'Error al guardar'
		: sync.pendientes > 0 ? `${sync.pendientes} cambio(s) sin guardar`
		: 'Todo guardado'
	);
</script>

<div class="titulo-guia">
	<h1>Tus datos</h1>
	<Guia
		clave="datos-sheets"
		para="Ver dónde están tus datos y si está todo guardado."
		uso="Tus datos viven en tu Google Sheet. La app la baja al abrir y guarda cada cambio ahí. Si estás sin señal, los cambios esperan en el teléfono y se suben solos."
	/>
</div>

<div class="estado" class:vieja={sync.guardado === 'error' || sync.offline}>
	<span class="est-main">{estadoTexto}</span>
	<span class="est-sub">
		{#if sync.hoja}Sheet: <a href={sync.hoja.url} target="_blank" rel="noopener">{sync.hoja.nombre}</a>{#if sync.hojaInv} y <a href={sync.hojaInv.url} target="_blank" rel="noopener">{sync.hojaInv.nombre}</a>{/if} · {/if}
		Bajada {fechaHoraCorta(sync.ultimaCarga, '—')}{#if sync.ultimoGuardado} · último guardado {fechaHoraCorta(sync.ultimoGuardado)}{/if}
	</span>
	{#if sync.offline}<span class="est-sub">Sin conexión: estás viendo la copia de este teléfono.</span>{/if}
	{#if sync.guardado === 'error' && sync.mensaje}<span class="est-sub">{sync.mensaje}</span>{/if}
</div>

<div class="acc">
	<button class="btn btn-primary" disabled={recargando} onclick={onRecargar}>{recargando ? 'Recargando…' : 'Recargar desde la Sheet'}</button>
	<button class="btn btn-secondary" onclick={onExcel}>Descargar Excel (formato RIENDA)</button>
	{#if sync.invEstado === 'ok'}<button class="btn btn-secondary" onclick={onExcelInv}>Descargar Excel de inversiones</button>{/if}
</div>

{#if sync.invEstado !== 'ok'}
	<details class="sec" open>
		<summary>Conectar la Sheet "Inversiones"</summary>
		<div class="sec-body">
			{#if sync.invEstado === 'error'}<p class="nota aviso">{sync.invMensaje}</p>{/if}
			<p class="nota">Desde la compu, en la Sheet <b>Finanzas</b> → Extensiones → Apps Script:</p>
			<ol class="pasos">
				<li>Reemplazá todo el código por la versión nueva de <code>apps-script/Code.gs</code> del repo.</li>
				<li>Arriba de todo, pegá entre las comillas de <code>ID_INVERSIONES</code> el ID de tu Sheet Inversiones (lo que va entre <code>/d/</code> y <code>/edit</code> en su dirección). Guardá.</li>
				<li>Implementar → Gestionar implementaciones → ✏ → Versión: <b>Nueva</b> → Implementar. La dirección no cambia: el teléfono no hay que reconectarlo.</li>
				<li>Volvé acá y tocá <b>Recargar desde la Sheet</b>.</li>
			</ol>
		</div>
	</details>
{/if}
{#if msg}<p class="nota aviso">{msg}</p>{/if}

{#if sync.avisos.length}
	<details class="sec" open>
		<summary>Filas de la Sheet que no se pudieron leer ({sync.avisos.length})</summary>
		<div class="sec-body">
			<p class="nota">No aparecen en la app hasta que se corrijan en la Sheet. No se borró nada.</p>
			<ul class="avisos">{#each sync.avisos as a (a)}<li>{a}</li>{/each}</ul>
		</div>
	</details>
{/if}

<details class="sec">
	<summary>Instalar en el teléfono</summary>
	<div class="sec-body"><InstalarApp mostrarInstalada dismissible={false} /></div>
</details>

<details class="sec peligro">
	<summary>Desconectar este teléfono</summary>
	<div class="sec-body">
		<p class="nota">Saca el enlace de conexión de este teléfono. No borra nada de la Sheet.</p>
		<div class="acc"><button class="btn btn-secondary" onclick={onDesconectar}>Desconectar</button></div>
	</div>
</details>

<style>
	:global(body) { max-width: 820px; margin: 0 auto; padding: 16px; }
	.estado { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 10px 14px; margin: 10px 0 14px; display: flex; flex-direction: column; gap: 3px; }
	.estado.vieja { border-color: var(--warn); background: rgba(251, 191, 36, 0.08); }
	.est-main { font-weight: 600; font-size: 0.92rem; }
	.est-sub { font-size: 0.8rem; color: var(--text-dim); }
	.est-sub a { color: var(--accent); }
	.sec { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; margin: 14px 0 10px; }
	.sec > summary { cursor: pointer; padding: 12px 14px; font-weight: 600; font-size: 0.95rem; list-style: none; display: flex; align-items: center; justify-content: space-between; }
	.sec > summary::after { content: '▸'; color: var(--text-dim); }
	.sec[open] > summary::after { content: '▾'; }
	.sec > summary::-webkit-details-marker { display: none; }
	.sec-body { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 10px; }
	.sec.peligro { border-color: var(--neg); margin-top: 22px; }
	.sec.peligro > summary { color: var(--neg); }
	.acc { display: flex; flex-direction: column; gap: 8px; }
	.acc :global(.btn) { width: 100%; box-sizing: border-box; text-align: center; }
	.nota { font-size: 0.82rem; color: var(--text-dim); margin: 0; line-height: 1.5; }
	.aviso { margin-top: 10px; color: var(--warn); }
	ul.avisos { margin: 0; padding-left: 18px; font-size: 0.82rem; color: var(--text-dim); }
	ol.pasos { margin: 0; padding-left: 20px; font-size: 0.85rem; line-height: 1.55; display: flex; flex-direction: column; gap: 4px; }
</style>
