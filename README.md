# Sistema de Control de Retenciones de Sueldos

**Usarlo online:** <https://brunoperez1988.github.io/sistema-retenciones/> (los datos se guardan solo en el navegador de cada persona; no se suben a internet).

Aplicación web (es-UY, pesos uruguayos) para registrar las retenciones judiciales y comerciales que llegan a la empresa, los descuentos que se aplican a cada colaborador y cuánto falta descontar.

## Forma más simple: un solo archivo, sin instalar nada

Si la computadora no deja instalar programas ni abrir archivos `.bat`, usá **Sistema-Retenciones.html**:

1. Guardá el archivo en un lugar fijo (por ejemplo, *Documentos*).
2. Hacé doble clic: se abre en el navegador. Funciona en **Chrome** o **Edge**. Si se abre con otro navegador, hacé clic derecho → **Abrir con** → Chrome o Edge.
3. Usalo normalmente. Todo se guarda solo, en ese navegador y en esa computadora. Al cerrar y volver a abrir el archivo, los datos siguen ahí.
4. En el menú **Respaldo**:
   - **Descargar respaldo**: baja un archivo con todos los datos. Hacelo seguido y guardalo en un pendrive, en la nube o en tu correo.
   - **Recuperar un respaldo**: vuelve a cargar los datos desde ese archivo (también sirve para pasarlos a otra computadora).
   - **Empezar de cero**: borra los datos de ejemplo para cargar los reales.
   - **Guardar en GitHub** (recomendado): conecta un repositorio **privado** de tu cuenta (por ejemplo `sistema-retenciones-datos`) con una clave de acceso de GitHub (*fine-grained token* con permiso *Contents: Read and write* solo sobre ese repositorio). Desde ahí cada cambio se sube solo al archivo `datos/retenciones.json`, cada subida queda como una versión en el historial, y desde otra computadora se conecta el mismo repositorio para ver los mismos datos. La app no deja usar un repositorio público.

Ojo: si se borran los datos de navegación del navegador (“cookies y datos de sitios”), se borran también los datos del sistema. Por eso es importante el respaldo.

Este archivo se arma desde el código con `npm run archivo-unico` (queda en `dist/`). Tiene las mismas pantallas y reglas; el control de “nunca descontar más que el total” lo hace el propio programa antes de guardar, porque en esta versión no hay base de datos SQLite.

## Versión con servidor: abrirla en Windows (doble clic)

1. Hacé clic derecho en **sistema-retenciones.zip** → **Extraer todo…** → **Extraer**. Guardá la carpeta en un lugar fijo, por ejemplo *Documentos*. No la abras desde adentro del .zip.
2. Entrá a la carpeta **retenciones** y hacé doble clic en **Iniciar.bat**.
   - La primera vez, si falta, instala solo un programa gratuito llamado Node.js. Si Windows pregunta si permitís cambios, respondé **Sí**. Cuando termine, volvé a hacer doble clic en **Iniciar.bat**.
   - Si Windows muestra “Windows protegió su PC”, tocá **Más información** → **Ejecutar de todas formas**.
3. Se abre el navegador con el sistema (dirección <http://localhost:3000>). **Dejá abierta la ventana negra** mientras lo usás; para cerrar el sistema, cerrá esa ventana.

## Dónde se guardan los datos

Todo lo que cargás queda guardado en el archivo **data\retenciones.db**, dentro de la misma carpeta. Se guarda al instante: podés cerrar y volver a abrir el sistema y el histórico sigue ahí.

**Copia de respaldo:** doble clic en **Respaldo.bat**. Crea una copia con fecha y hora en la carpeta **respaldos** (funciona aunque el sistema esté abierto). Copiá esa carpeta a un pendrive o a la nube cada tanto.

**Recuperar un respaldo:** cerrá el sistema, borrá `data\retenciones.db` (y, si existen, `retenciones.db-wal` y `retenciones.db-shm`), copiá el respaldo dentro de `data` y renombralo a `retenciones.db`.

**Pasar a otra computadora:** copiá la carpeta entera, incluida `data`.

## Para quien sepa usar la terminal (cualquier sistema)

Con Node.js 22.5 o superior instalado, en esta carpeta:

| Comando | Para qué sirve |
|---|---|
| `npm start` | Levanta la aplicación en <http://localhost:3000> |
| `npm run respaldo` | Copia de respaldo en `respaldos/` |
| `npm test` | Prueba las reglas (tope de descuento, beneficiario, cédula, reportes) sobre una base temporal |
| `npm run reiniciar` | **Borra todos los datos** y deja solo los de ejemplo |

La primera vez se crea la base con los datos de ejemplo. Para empezar con la base vacía: `node server.js --sin-ejemplos`.
Variables opcionales: `PORT` (puerto), `DB_PATH` (ruta de la base), `HOST` (por defecto `127.0.0.1`: solo se abre desde la misma computadora).

## Qué hace

- **Panel:** elegís el mes y ves la cantidad de órdenes, el total pactado, el total retenido y lo disponible (lo que falta descontar). Cada orden tiene barra de avance, etiqueta Judicial/Comercial y la marca “Completa” al llegar al tope.
- **Retenciones recibidas:** carga (colaborador, entidad, período, importe, concepto, expediente/juzgado, beneficiario y quién la cargó) y listado con total, descontado y falta descontar. El beneficiario aparece y es obligatorio solo en las judiciales.
- **Descuentos:** elegís la persona y una de sus retenciones pendientes; la pantalla muestra el máximo que se puede descontar y no deja guardar si se pasa. Histórico con el saldo que quedó luego de cada descuento y el saldo pendiente actual.
- **Reportes:** filtros por mes, búsqueda (nombre, CI, entidad, concepto, beneficiario), judicial/comercial, tipo de descuento y empresa donde se retuvo.
  - *Planilla* de todas las personas con retenciones.
  - *A abonar*, agrupado por beneficiario o por entidad, con subtotales.
  - Ambos se descargan en Excel (.xlsx) o CSV (separado por “;”, listo para Excel en español).
- **Empresas, Colaboradores y Entidades:** altas y listados. La cédula es única y se valida el dígito verificador.

## Reglas que controla la base de datos

Además de los controles en pantalla, la base (`src/esquema.sql`) tiene triggers que impiden, aunque alguien la modifique por fuera de la aplicación:

- descontar más que el importe total de una retención (al crear o al modificar un descuento);
- bajar el total de una retención por debajo de lo ya descontado;
- guardar una retención judicial sin beneficiario.

Los importes se guardan en centésimos (números enteros) para evitar errores de redondeo.

## Si se corta la conexión

Si el servidor o la base no responden, la pantalla muestra “No pudimos cargar la información. Tus datos están a salvo.” con un botón **Reintentar**, y los formularios conservan lo que ya escribiste.

## Datos de ejemplo

- Entidades: Juzgado de Familia N° 2 (judicial), Electrohogar SA (comercial), ANDA (comercial).
- Colaboradores: Juan Pérez (CI 1.111.111-1) y Ana Gómez (CI 2.222.222-2, cédula de ejemplo).
- Empresas: Operativa Central, Sucursal Norte, Sucursal Este.
- Retenciones del mes actual y del anterior, con algunos descuentos (por ejemplo, $ 20 a Juan Pérez por ANDA en la Operativa Central).

## Pendiente

- **Inicio de sesión** antes de compartirla con otras personas: son datos sensibles. Mientras tanto la app solo escucha en la propia computadora (`127.0.0.1`).

## Estructura

```
server.js            servidor web y API
src/esquema.sql      tablas, restricciones y triggers
src/db.js            consultas y validaciones
src/exportar.js      Excel (.xlsx) y CSV
scripts/ejemplos.js  datos de ejemplo / reinicio
scripts/respaldo.js  copia de respaldo
scripts/armar-archivo-unico.js  arma dist/Sistema-Retenciones.html
public/backend-local.js  motor de la versión de archivo único
Iniciar.bat          abrir con doble clic (Windows)
Respaldo.bat         respaldo con doble clic (Windows)
public/              pantallas (HTML, CSS, JS)
test/                pruebas de las reglas
```
