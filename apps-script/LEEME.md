# Conectar Rienda con tu Google Sheet

Rienda guarda tus datos en tu Sheet "Finanzas". Este script es el puente: se
instala una sola vez, dentro de la Sheet, desde la compu. Son unos 10 minutos.

## 1. Pegar el script

1. Abrí la Sheet **Finanzas** → menú **Extensiones → Apps Script**.
2. En el archivo `Código.gs`, borrá lo que haya y pegá todo el contenido de
   [`Code.gs`](./Code.gs).
3. Revisá los ajustes de arriba de todo (`NOMBRE_PERFIL`, `APP_URL`).
4. Guardá (ícono del disquete).

## 2. Implementarlo como App web

1. Arriba a la derecha: **Implementar → Nueva implementación**.
2. En el engranaje de "Seleccionar tipo", elegí **Aplicación web**.
3. Completá:
   - Descripción: `Rienda`
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
4. **Implementar** → **Autorizar acceso** → elegí tu cuenta.
   Google avisa "Google no verificó esta app": es normal porque el script es
   tuyo. Tocá **Configuración avanzada → Ir a Rienda (no seguro) → Permitir**.

"Cualquier usuario" hace falta para que la app pueda llamarlo desde el teléfono.
Igual nadie puede leer nada sin la clave del enlace de conexión.

## 3. Generar el enlace de conexión

1. En el editor, en el desplegable de funciones (al lado de ▶ Ejecutar),
   elegí **configurar** y tocá **▶ Ejecutar**.
2. Abajo, en el **Registro de ejecución**, aparecen:
   - el **enlace de conexión** (`https://script.google.com/macros/s/…/exec?k=…`), y
   - un link para abrir directo en el iPhone.

No compartas ese enlace: con él se pueden leer y escribir tus finanzas.

`configurar` también deja como texto las columnas de fechas y meses (para que
Sheets no las convierta solas) y crea la pestaña oculta `_perfil`.

## 4. En el iPhone

1. Mandate el link "para el iPhone" (por WhatsApp a vos mismo, Notas, etc.) y
   abrilo en **Safari**: la app se conecta sola.
2. **Compartir → Agregar a inicio**.
3. Si la app instalada te pide el enlace, pegá el enlace de conexión.

## Qué cambia en la Sheet

- **Gastos** e **Ingresos** quedan igual, con una columna **id** al final. No
  la toques: es cómo la app sabe qué fila es cuál. Si agregás filas a mano,
  dejá el id vacío y la app le pone uno.
- Lo que Rienda guarda aparte va en pestañas **ocultas** que empiezan con `_`
  (categorías, diccionario, tarjetas, recurrentes, presupuestos, ajustes).
- La app nunca borra más de unas pocas filas de una vez: si algo raro intenta
  borrar muchas, se frena y te avisa.

## Si actualizo el script

**Implementar → Gestionar implementaciones → ✏ (editar) → Versión: Nueva →
Implementar.** Así la URL no cambia y no hay que reconectar el teléfono.
