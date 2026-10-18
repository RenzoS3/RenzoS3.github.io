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
   Guardá.
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

## Si actualizo el script

**Implementar → Gestionar implementaciones → ✏ (editar) → Versión: Nueva →
Implementar.** Así la URL no cambia y no hay que reconectar el teléfono.
