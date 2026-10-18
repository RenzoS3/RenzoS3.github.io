# Rienda + Sheets

Fork de Rienda que guarda los datos en una **Google Sheet** en vez del
almacenamiento del navegador, para que funcione en iPhone sin perder datos.

## Qué cambia

- **La base corre en memoria** (`src/lib/db/worker.ts`). Al abrir, la app baja la
  Sheet y la carga; después de cada escritura compara la base con el último
  estado conocido y sube las diferencias fila por fila (por `id`).
- **Todo el código de Rienda queda igual**: pantallas, consultas, cálculos.
  Lo nuevo está en `src/lib/sheets/`:
  - `tablas.ts` — qué tabla va en qué pestaña y cómo se convierte.
  - `sync.svelte.ts` — arranque, cola de cambios, copia sin señal, seguridad.
  - `conexion.ts` — enlace de conexión y llamadas al Apps Script.
  - `inversiones.ts` — fase 2: Activos, Renta y amortización, Caja y las
    ocultas `_activos`, `_cuentas`, `_precios`, `_fotos` en la Sheet "Inversiones".
  - `mercado.ts` / `cacheMercado.ts` — al abrir: precios, histórico de data912
    (copia en el teléfono, se vuelve a bajar si falta) y reconstrucción de las
    fotos diarias desde el primer movimiento (una vez; después viven en `_fotos`).
- **Puente**: `apps-script/Code.gs`, un Apps Script dentro de la Sheet
  (instalación en `apps-script/LEEME.md`).
- **Sin señal**: la cola de cambios y una copia de los datos quedan en el
  teléfono; se suben solas cuando vuelve la conexión.
- **Seguridad**: nunca se sube una base vacía (si el worker se reinicia, la app
  recarga desde la Sheet) y los borrados masivos se frenan en la app y en el
  script.
- **Se apagó**: copias de seguridad locales e importar/borrar todo desde la app
  (la Sheet ya es el respaldo).
- **Inversiones (fase 2)**: igual que Rienda, con los datos en la Sheet
  "Inversiones" (la abre el mismo Apps Script por su ID). Agregado propio:
  splits o cambios de ratio por activo (`src/lib/db/splits.ts`), porque el
  histórico de data912 viene sin ajustar.

## Desarrollo local

```sh
node tools/sheets-falso.mjs /tmp/estado.json 8787   # Sheet de prueba (corre el mismo Code.gs)
npm run build && npx vite preview
# abrir http://localhost:4173/#conectar=http%3A%2F%2Flocalhost%3A8787%2Fexec%3Fk%3D<clave>
```

## Publicación

`.github/workflows/pages.yml` publica en GitHub Pages en cada push a `main`.
