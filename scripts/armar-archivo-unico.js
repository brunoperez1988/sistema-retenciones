'use strict';

// Arma la versión de archivo único: un solo .html que se abre con doble clic,
// sin servidor ni instalación. Los datos quedan guardados en el navegador.
// Uso: npm run archivo-unico   →   dist/Sistema-Retenciones.html

const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const leer = (n) => fs.readFileSync(path.join(pub, n), 'utf8');
const seguro = (js) => js.replace(/<\/script/gi, '<\\/script');

let html = leer('index.html');
html = html.replace('<link rel="stylesheet" href="/styles.css">', () => `<style>\n${leer('styles.css')}\n</style>`);
html = html.replace('<script src="/app.js"></script>', () =>
  `<script>\n${seguro(leer('backend-local.js'))}\n</script>\n  <script>\n${seguro(leer('app.js'))}\n</script>`);
html = html.replace(/src="\/(logo[\w-]*\.png)"/g, (_, n) => `src="data:image/png;base64,${fs.readFileSync(path.join(pub, n)).toString('base64')}"`);
if (html.includes('href="/styles.css"') || html.includes('src="/app.js"')) throw new Error('No se pudo armar el archivo único');

const destino = path.join(__dirname, '..', 'dist', 'Sistema-Retenciones.html');
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, html);
console.log('Listo:', destino);
