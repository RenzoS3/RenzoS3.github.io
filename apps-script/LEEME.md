# Conectar Rienda con una Google Sheet

Cada persona usa la misma app (https://renzos3.github.io) con **su propia**
Google Sheet, en **su propia** cuenta de Google. Este script es el puente
entre la app y la Sheet. Se instala una sola vez, desde una compu, y lleva
unos 10 minutos.

Si lo instalás para otra persona en tu compu, abrí una **ventana de invitado**
(o de incógnito) y que esa persona inicie sesión con su cuenta de Google. Al
terminar, cerrá esa ventana.

## 1. Crear la Sheet y pegar el script

1. Entrá a **sheets.new** (crea una Sheet en blanco) y ponele de nombre
   **Finanzas**. Si ya tenés una Sheet con gastos en formato RIENDA, usá esa.
2. Menú **Extensiones → Apps Script**.
3. En el archivo `Código.gs`, borrá lo que haya y pegá todo el contenido de
   [`Code.gs`](./Code.gs). Guardá (ícono del disquete).

## 2. Implementarlo como App web

1. Arriba a la derecha: **Implementar → Nueva implementación**.
2. En el engranaje de "Seleccionar tipo", elegí **Aplicación web**.
3. Completá:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario** (exactamente esa opción)
4. **Implementar** → **Autorizar acceso** → elegí la cuenta.
   Google avisa "Google no verificó esta app": es normal porque el script es
   de la propia cuenta. Tocá **Configuración avanzada → Ir a … (no seguro) → Permitir**.
5. Al final aparece la **URL de la aplicación web** (termina en `/exec`).
   Tocá **Copiar**.

## 3. Generar el link para el iPhone

1. Arriba de todo en `Código.gs`, pegá esa URL entre las comillas de
   `URL_WEBAPP`, por ejemplo:
   `const URL_WEBAPP = 'https://script.google.com/macros/s/AKfy…/exec';`
   Si también usás Inversiones, pegá en `ID_INVERSIONES` el ID de esa Sheet
   (lo que va entre `/d/` y `/edit` en su dirección). Guardá.
2. En el desplegable de funciones (al lado de ▶ Ejecutar) elegí
   **configurar** y tocá **▶ Ejecutar**.
3. Abajo, en el **Registro de ejecución**, aparece **"LISTO. Abrí este link
   en el iPhone"** con un link largo. Copialo.

No compartas ese link: con él se pueden leer y escribir esas finanzas.

## 4. En el iPhone

1. Mandá el link al iPhone (WhatsApp a uno mismo, Notas, mail) y abrilo en
   **Safari**.
2. La primera vez, la app pregunta el nombre y cómo arranca el mes (del 1 al
   30, o el día de cobro del sueldo). Después crea las categorías de arranque,
   que se editan en Configuración.
3. **Compartir → Agregar a inicio**. Si la app instalada pide el enlace de
   conexión, pegá el segundo link del registro (el que termina en `/exec?k=…`).

## Qué queda en la Sheet

- **Gastos** e **Ingresos** en formato RIENDA, con una columna **id** al final.
  No la toques: es cómo la app sabe qué fila es cuál. Si agregás filas a mano,
  dejá el id vacío y la app le pone uno.
- Lo que Rienda guarda aparte va en pestañas **ocultas** que empiezan con `_`
  (categorías, diccionario, tarjetas, recurrentes, presupuestos, ajustes, perfil).
- La app nunca borra más de unas pocas filas de una vez: si algo intenta borrar
  muchas, se frena y avisa.

## Sheet "Inversiones"

El mismo script abre también la Sheet Inversiones (por su `ID_INVERSIONES`):

- **Activos**, **Renta y amortización** y **Caja** quedan con el formato de la
  planilla de Rienda, más una columna **id** al final (no la toques).
- En Activos, `moneda` y `monto_total` son lo que pagaste o cobraste. Si un
  CEDEAR que cotiza en pesos lo pagaste en dólares, `valor_dolar` convierte.
- Columnas propias como `monto_ars` no se pisan, y las filas nuevas copian la
  fórmula de la fila de arriba. Posicion y Pendientes no se tocan.
- Caja: `Ingreso` (positivo), `Retiro` (negativo; también acepta "Egreso" o el
  monto sin signo) y `Convertir` (dos filas con el mismo `grupo`: sale una
  moneda, entra la otra).
- Pestañas ocultas: `_activos` (catálogo: exposición, símbolo de cotización y
  **splits**), `_cuentas`, `_precios` (precios corregidos a mano) y `_fotos`
  (valor diario de la cartera, para Evolución de cartera).
- **Splits o cambios de ratio**: en `_activos`, columna `splits`, con el formato
  `AAAA-MM-DD:factor` (varios separados por `;`), por ejemplo SPY `2026-06-01:3`.
  El histórico de data912 viene sin ajustar; con esto los precios anteriores se
  dividen por el factor (el día exacto la app lo busca en la serie).

## Si actualizo el script

**Implementar → Gestionar implementaciones → ✏ (editar) → Versión: Nueva →
Implementar.** Así la URL no cambia y no hay que reconectar el teléfono.
