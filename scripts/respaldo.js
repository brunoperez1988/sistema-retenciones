'use strict';

// Copia de respaldo de la base: npm run respaldo  (o doble clic en "Respaldo.bat")
// Usa VACUUM INTO, así que funciona aunque el sistema esté abierto.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const raiz = path.join(__dirname, '..');
const ruta = process.env.DB_PATH || path.join(raiz, 'data', 'retenciones.db');
if (!fs.existsSync(ruta)) {
  console.log('Todavía no hay datos para respaldar.');
  process.exit(0);
}
const carpeta = path.join(raiz, 'respaldos');
fs.mkdirSync(carpeta, { recursive: true });
const d = new Date();
const dos = (n) => String(n).padStart(2, '0');
const sello = `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}_${dos(d.getHours())}-${dos(d.getMinutes())}-${dos(d.getSeconds())}`;
const destino = path.join(carpeta, `retenciones-${sello}.db`);
const db = new DatabaseSync(ruta);
db.prepare('VACUUM INTO ?').run(destino);
db.close();
console.log('Respaldo guardado en:');
console.log('  ' + destino);
