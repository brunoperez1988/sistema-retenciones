'use strict';

// Datos de ejemplo. Se cargan solos la primera vez que se abre una base vacía.
// Para volver a empezar con estos datos: npm run reiniciar

const path = require('node:path');

function mesRelativo(desplazamiento) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + desplazamiento);
  return d.toISOString().slice(0, 7);
}

function cargarEjemplos(db) {
  const actual = mesRelativo(0);
  const anterior = mesRelativo(-1);
  const id = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  db.exec('BEGIN');
  try {
    const juzgado = id('INSERT INTO entidades (nombre, tipo) VALUES (?, ?)', 'Juzgado de Familia N° 2', 'judicial');
    const electro = id('INSERT INTO entidades (nombre, tipo) VALUES (?, ?)', 'Electrohogar SA', 'comercial');
    const anda = id('INSERT INTO entidades (nombre, tipo) VALUES (?, ?)', 'ANDA', 'comercial');

    const juan = id('INSERT INTO colaboradores (cedula, nombre) VALUES (?, ?)', '11111111', 'Juan Pérez');
    const ana = id('INSERT INTO colaboradores (cedula, nombre) VALUES (?, ?)', '22222222', 'Ana Gómez');

    const central = id('INSERT INTO empresas (nombre) VALUES (?)', 'Operativa Central');
    const norte = id('INSERT INTO empresas (nombre) VALUES (?)', 'Sucursal Norte');
    id('INSERT INTO empresas (nombre) VALUES (?)', 'Sucursal Este');

    const ret = (colab, ent, periodo, total, concepto, expediente, beneficiario) => id(
      `INSERT INTO retenciones (colaborador_id, entidad_id, periodo, importe_total, concepto, expediente, beneficiario, cargado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, colab, ent, periodo, total, concepto, expediente, beneficiario, 'Administración');
    const desc = (r, importe, tipo, empresa, fecha) => id(
      `INSERT INTO descuentos (retencion_id, importe, tipo, empresa_id, descontado_por, fecha)
       VALUES (?, ?, ?, ?, ?, ?)`, r, importe, tipo, empresa, 'Liquidación', fecha);

    // Importes en centésimos: 200000 = $ 2.000,00
    const r1 = ret(juan, anda, actual, 200000, 'Préstamo ANDA', '', null);
    const r2 = ret(ana, juzgado, actual, 850000, 'Pensión alimenticia', 'IUE 2-12345/2025', 'María Gómez');
    const r3 = ret(juan, electro, actual, 450000, 'Cuota crédito', '', null);
    const r4 = ret(ana, anda, anterior, 150000, 'Préstamo ANDA', '', null);
    const r5 = ret(juan, juzgado, anterior, 600000, 'Pensión alimenticia', 'IUE 2-9876/2024', 'Lucía Pérez');

    desc(r1, 2000, '1Q', central, `${actual}-15`);
    desc(r2, 425000, '1Q', central, `${actual}-15`);
    desc(r3, 150000, '1Q', norte, `${actual}-15`);
    desc(r4, 75000, '1Q', central, `${anterior}-15`);
    desc(r4, 75000, '2Q', central, `${anterior}-28`); // completa
    desc(r5, 300000, '1Q', central, `${anterior}-15`);
    desc(r5, 300000, '2Q', norte, `${anterior}-28`); // completa
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { cargarEjemplos };

// Uso directo: node scripts/ejemplos.js --reiniciar  (borra la base y la vuelve a crear con los ejemplos)
if (require.main === module) {
  const fs = require('node:fs');
  const datos = require('../src/db');
  const ruta = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'retenciones.db');
  if (!process.argv.includes('--reiniciar')) {
    console.log('Esto borra TODOS los datos y deja solo los de ejemplo. Para confirmar: npm run reiniciar');
    process.exit(1);
  }
  for (const sufijo of ['', '-wal', '-shm']) fs.rmSync(ruta + sufijo, { force: true });
  cargarEjemplos(datos.conectar(ruta));
  datos.cerrar();
  console.log('Base reiniciada con los datos de ejemplo:', ruta);
}
