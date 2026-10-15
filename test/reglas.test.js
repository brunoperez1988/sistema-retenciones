'use strict';

// Pruebas de las reglas de negocio contra una base temporal: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const datos = require('../src/db');
const { cargarEjemplos } = require('../scripts/ejemplos');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retenciones-'));
const db = datos.conectar(path.join(dir, 'prueba.db'));
cargarEjemplos(db);
test.after(() => { datos.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); });

const anda = () => datos.listarRetenciones({ q: 'juan anda' })[0];

test('la base rechaza descontar más que el total, aunque se saltee la pantalla', () => {
  const r = anda();
  assert.throws(
    () => db.prepare("INSERT INTO descuentos (retencion_id, importe, tipo, empresa_id, descontado_por, fecha) VALUES (?, ?, '1Q', 1, 'x', '2026-10-01')").run(r.id, r.pendiente + 1),
    /TOPE_EXCEDIDO/,
  );
});

test('se puede descontar exactamente el saldo y la orden queda completa', () => {
  const r = anda();
  datos.crearDescuento({ retencion_id: r.id, importe: r.pendiente, tipo: '2Q', empresa_id: 1, descontado_por: 'x', fecha: '2026-10-30' });
  const despues = anda();
  assert.strictEqual(despues.pendiente, 0);
  assert.strictEqual(despues.completa, true);
  assert.throws(() => datos.crearDescuento({ retencion_id: r.id, importe: 1, tipo: '2Q', empresa_id: 1, descontado_por: 'x', fecha: '2026-10-30' }), /completa/);
});

test('la base rechaza subir un descuento existente por encima del tope', () => {
  const r = anda();
  const d = db.prepare('SELECT id FROM descuentos WHERE retencion_id = ? LIMIT 1').get(r.id);
  assert.throws(() => db.prepare('UPDATE descuentos SET importe = importe + 1 WHERE id = ?').run(d.id), /TOPE_EXCEDIDO/);
});

test('la base rechaza bajar el total por debajo de lo descontado', () => {
  const r = anda();
  assert.throws(() => db.prepare('UPDATE retenciones SET importe_total = 1 WHERE id = ?').run(r.id), /TOTAL_MENOR_A_DESCONTADO/);
});

test('beneficiario obligatorio en judiciales, también en la base', () => {
  const juzgado = datos.catalogos().entidades.find((e) => e.tipo === 'judicial');
  assert.throws(() => datos.crearRetencion({ colaborador_id: 1, entidad_id: juzgado.id, periodo: '2026-10', importe_total: 1000, cargado_por: 'x' }), /beneficiario/);
  assert.throws(
    () => db.prepare("INSERT INTO retenciones (colaborador_id, entidad_id, periodo, importe_total, cargado_por) VALUES (1, ?, '2026-10', 1000, 'x')").run(juzgado.id),
    /BENEFICIARIO_OBLIGATORIO/,
  );
});

test('la cédula es única y se valida el dígito verificador', () => {
  assert.throws(() => datos.crearColaborador({ cedula: '1.111.111-1', nombre: 'Otro' }), (e) => /UNIQUE/.test(e.message));
  assert.throws(() => datos.crearColaborador({ cedula: '1.111.111-2', nombre: 'Otro' }), /verificador/);
  assert.ok(datos.crearColaborador({ cedula: '3.333.333-3', nombre: 'Carla Silva' }).id);
});

test('reporte a abonar agrupa por beneficiario y por entidad', () => {
  const porBenef = datos.reporteAbonar({ agrupar: 'beneficiario' });
  assert.ok(porBenef.grupos.some((g) => g.grupo === 'María Gómez'));
  const porEntidad = datos.reporteAbonar({ agrupar: 'entidad' });
  assert.strictEqual(porEntidad.total, porBenef.total);
});
