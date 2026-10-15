'use strict';

// Acceso a datos. Usa el SQLite que trae Node (node:sqlite), sin dependencias externas.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TIPOS_DESCUENTO = ['1Q', '2Q', 'Egresos', 'Ajustes', 'Licencias'];

class ErrorValidacion extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

let db = null;
let rutaBase = null;

function conectar(ruta) {
  rutaBase = ruta;
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const nueva = new DatabaseSync(ruta);
  nueva.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  nueva.exec(fs.readFileSync(path.join(__dirname, 'esquema.sql'), 'utf8'));
  db = nueva;
  return db;
}

// Si la conexión se perdió (o nunca se abrió), intenta abrirla de nuevo en cada pedido.
function base() {
  if (!db) conectar(rutaBase);
  return db;
}

function cerrar() {
  if (db) { try { db.close(); } catch { /* ya cerrada */ } }
  db = null;
}

// Traduce errores de SQLite a mensajes para la persona usuaria.
// Devuelve null si el error no es de validación (o sea, es una falla de la base).
function traducirError(err) {
  const m = String(err && err.message || '');
  if (m.includes('TOPE_EXCEDIDO')) return new ErrorValidacion('El descuento supera lo que falta descontar de la retención. Nunca se puede descontar más que el importe total.', 409);
  if (m.includes('TOTAL_MENOR_A_DESCONTADO')) return new ErrorValidacion('El importe total no puede ser menor a lo que ya se descontó.', 409);
  if (m.includes('BENEFICIARIO_OBLIGATORIO')) return new ErrorValidacion('El beneficiario es obligatorio en las retenciones judiciales.');
  if (m.includes('UNIQUE') && m.includes('colaboradores.cedula')) return new ErrorValidacion('Ya existe un colaborador con esa cédula.', 409);
  if (m.includes('UNIQUE') && m.includes('empresas.nombre')) return new ErrorValidacion('Ya existe una empresa con ese nombre.', 409);
  if (m.includes('UNIQUE') && m.includes('entidades.nombre')) return new ErrorValidacion('Ya existe una entidad con ese nombre.', 409);
  if (m.includes('FOREIGN KEY')) return new ErrorValidacion('No se puede completar: hay registros relacionados o falta un dato de referencia.', 409);
  if (m.includes('CHECK constraint')) return new ErrorValidacion('Algún dato no tiene el formato correcto.');
  return null;
}

// ── Validaciones comunes ──

function texto(valor, campo, { obligatorio = true, max = 200 } = {}) {
  const v = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (obligatorio && !v) throw new ErrorValidacion(`Falta completar: ${campo}.`);
  if (v.length > max) throw new ErrorValidacion(`${campo}: máximo ${max} caracteres.`);
  return v;
}

function entero(valor, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ErrorValidacion(`Elegí ${campo}.`);
  return n;
}

// Recibe centésimos (entero) desde la pantalla.
function importe(valor, campo = 'el importe') {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ErrorValidacion(`Ingresá ${campo} mayor a cero.`);
  if (n > 100_000_000_00) throw new ErrorValidacion(`${campo[0].toUpperCase() + campo.slice(1)} es demasiado alto.`);
  return n;
}

function periodo(valor) {
  const v = String(valor ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw new ErrorValidacion('Elegí un período (mes) válido.');
  return v;
}

function fecha(valor) {
  const v = String(valor ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00'))) throw new ErrorValidacion('Ingresá una fecha válida.');
  return v;
}

// Cédula uruguaya: 7 u 8 dígitos (con dígito verificador).
function cedula(valor) {
  const v = String(valor ?? '').replace(/[.\-\s]/g, '');
  if (!/^\d{6,8}$/.test(v)) throw new ErrorValidacion('La cédula debe tener entre 6 y 8 dígitos (con dígito verificador).');
  const cuerpo = v.slice(0, -1).padStart(7, '0');
  const pesos = [2, 9, 8, 7, 6, 3, 4];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(cuerpo[i]), 0);
  const dv = (10 - (suma % 10)) % 10;
  if (dv !== Number(v.at(-1))) throw new ErrorValidacion('La cédula no es válida: revisá el dígito verificador.');
  return v;
}

// ── Catálogos ──

function catalogos() {
  const d = base();
  return {
    entidades: d.prepare('SELECT id, nombre, tipo FROM entidades ORDER BY nombre').all(),
    colaboradores: d.prepare('SELECT id, cedula, nombre FROM colaboradores ORDER BY nombre').all(),
    empresas: d.prepare('SELECT id, nombre FROM empresas ORDER BY nombre').all(),
    tiposDescuento: TIPOS_DESCUENTO,
  };
}

function listarEntidades() {
  return base().prepare(`
    SELECT e.id, e.nombre, e.tipo, COUNT(r.id) AS retenciones
    FROM entidades e LEFT JOIN retenciones r ON r.entidad_id = e.id
    GROUP BY e.id ORDER BY e.nombre`).all();
}

function crearEntidad(datos) {
  const nombre = texto(datos.nombre, 'nombre de la entidad');
  const tipo = String(datos.tipo || '');
  if (!['judicial', 'comercial'].includes(tipo)) throw new ErrorValidacion('Indicá si la entidad es judicial o comercial.');
  const r = base().prepare('INSERT INTO entidades (nombre, tipo) VALUES (?, ?)').run(nombre, tipo);
  return { id: Number(r.lastInsertRowid) };
}

function listarColaboradores() {
  return base().prepare(`
    SELECT c.id, c.cedula, c.nombre,
           COUNT(r.id) AS retenciones,
           COALESCE(SUM(r.importe_total), 0) AS total,
           COALESCE(SUM((SELECT SUM(importe) FROM descuentos d WHERE d.retencion_id = r.id)), 0) AS descontado
    FROM colaboradores c LEFT JOIN retenciones r ON r.colaborador_id = c.id
    GROUP BY c.id ORDER BY c.nombre`).all();
}

function crearColaborador(datos) {
  const ci = cedula(datos.cedula);
  const nombre = texto(datos.nombre, 'nombre del colaborador');
  const r = base().prepare('INSERT INTO colaboradores (cedula, nombre) VALUES (?, ?)').run(ci, nombre);
  return { id: Number(r.lastInsertRowid) };
}

function listarEmpresas() {
  return base().prepare(`
    SELECT em.id, em.nombre, COUNT(d.id) AS descuentos, COALESCE(SUM(d.importe), 0) AS retenido
    FROM empresas em LEFT JOIN descuentos d ON d.empresa_id = em.id
    GROUP BY em.id ORDER BY em.nombre`).all();
}

function crearEmpresa(datos) {
  const nombre = texto(datos.nombre, 'nombre de la empresa');
  const r = base().prepare('INSERT INTO empresas (nombre) VALUES (?)').run(nombre);
  return { id: Number(r.lastInsertRowid) };
}

// ── Retenciones ──

// Filtros: periodo, tipo (judicial|comercial), colaborador_id, tipo_descuento, empresa_id.
// Si hay filtro de descuento (tipo o empresa), "descontado" suma solo esos descuentos
// y se excluyen las retenciones sin descuentos que coincidan.
function listarRetenciones(f = {}) {
  const cond = [];
  const params = {};
  const condDesc = [];
  if (f.periodo) { cond.push('r.periodo = $periodo'); params.periodo = periodo(f.periodo); }
  if (f.tipo === 'judicial' || f.tipo === 'comercial') { cond.push('e.tipo = $tipo'); params.tipo = f.tipo; }
  if (f.colaborador_id) { cond.push('r.colaborador_id = $colab'); params.colab = Number(f.colaborador_id); }
  if (f.tipo_descuento && TIPOS_DESCUENTO.includes(f.tipo_descuento)) { condDesc.push('ds.tipo = $tdesc'); params.tdesc = f.tipo_descuento; }
  if (f.empresa_id) { condDesc.push('ds.empresa_id = $empresa'); params.empresa = Number(f.empresa_id); }
  const filtraDescuentos = condDesc.length > 0;
  if (filtraDescuentos) cond.push('fil.retencion_id IS NOT NULL');

  const sql = `
    SELECT r.id, r.periodo, r.importe_total, r.concepto, r.expediente, r.beneficiario,
           r.cargado_por, r.creado_en,
           c.id AS colaborador_id, c.cedula, c.nombre AS colaborador,
           e.id AS entidad_id, e.nombre AS entidad, e.tipo,
           COALESCE(tot.descontado, 0) AS descontado_real,
           COALESCE(tot.cantidad, 0) AS cantidad_descuentos,
           COALESCE(fil.descontado, 0) AS descontado_filtrado,
           fil.empresas
    FROM retenciones r
    JOIN colaboradores c ON c.id = r.colaborador_id
    JOIN entidades e ON e.id = r.entidad_id
    LEFT JOIN (SELECT retencion_id, SUM(importe) AS descontado, COUNT(*) AS cantidad
               FROM descuentos GROUP BY retencion_id) tot ON tot.retencion_id = r.id
    LEFT JOIN (SELECT ds.retencion_id, SUM(ds.importe) AS descontado,
                      GROUP_CONCAT(DISTINCT em.nombre) AS empresas
               FROM descuentos ds JOIN empresas em ON em.id = ds.empresa_id
               ${condDesc.length ? 'WHERE ' + condDesc.join(' AND ') : ''}
               GROUP BY ds.retencion_id) fil ON fil.retencion_id = r.id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY r.periodo DESC, c.nombre, e.nombre, r.id`;

  let filas = base().prepare(sql).all(params).map((x) => ({
    ...x,
    empresas: x.empresas ? x.empresas.split(',').join(', ') : '',
    descontado: filtraDescuentos ? x.descontado_filtrado : x.descontado_real,
    pendiente: x.importe_total - x.descontado_real,
    completa: x.descontado_real >= x.importe_total,
  }));
  return filtrarTexto(filas, f.q, (x) => [x.colaborador, x.cedula, x.entidad, x.concepto, x.beneficiario, x.expediente]);
}

function crearRetencion(datos) {
  const d = base();
  const colaborador_id = entero(datos.colaborador_id, 'el colaborador');
  const entidad_id = entero(datos.entidad_id, 'la entidad');
  const entidad = d.prepare('SELECT tipo FROM entidades WHERE id = ?').get(entidad_id);
  if (!entidad) throw new ErrorValidacion('La entidad elegida no existe.');
  const fila = {
    colaborador_id,
    entidad_id,
    periodo: periodo(datos.periodo),
    importe_total: importe(datos.importe_total, 'el importe total'),
    concepto: texto(datos.concepto, 'concepto', { obligatorio: false }),
    expediente: texto(datos.expediente, 'expediente / juzgado', { obligatorio: false }),
    beneficiario: entidad.tipo === 'judicial' ? texto(datos.beneficiario, 'beneficiario') : null,
    cargado_por: texto(datos.cargado_por, 'quién la cargó', { max: 80 }),
  };
  const r = d.prepare(`
    INSERT INTO retenciones (colaborador_id, entidad_id, periodo, importe_total, concepto, expediente, beneficiario, cargado_por)
    VALUES ($colaborador_id, $entidad_id, $periodo, $importe_total, $concepto, $expediente, $beneficiario, $cargado_por)`).run(fila);
  return { id: Number(r.lastInsertRowid) };
}

function eliminarRetencion(id) {
  const d = base();
  const n = d.prepare('SELECT COUNT(*) AS n FROM descuentos WHERE retencion_id = ?').get(Number(id)).n;
  if (n > 0) throw new ErrorValidacion('No se puede eliminar una retención que ya tiene descuentos.', 409);
  const r = d.prepare('DELETE FROM retenciones WHERE id = ?').run(Number(id));
  if (!r.changes) throw new ErrorValidacion('La retención no existe.', 404);
  return { ok: true };
}

// ── Descuentos ──

// Filtros: mes (de la fecha del descuento), tipo_descuento, empresa_id, q.
function listarDescuentos(f = {}) {
  const cond = [];
  const params = {};
  if (f.mes) { cond.push("substr(d.fecha, 1, 7) = $mes"); params.mes = periodo(f.mes); }
  if (f.tipo_descuento && TIPOS_DESCUENTO.includes(f.tipo_descuento)) { cond.push('d.tipo = $tdesc'); params.tdesc = f.tipo_descuento; }
  if (f.empresa_id) { cond.push('d.empresa_id = $empresa'); params.empresa = Number(f.empresa_id); }
  if (f.retencion_id) { cond.push('d.retencion_id = $ret'); params.ret = Number(f.retencion_id); }

  // saldo_despues: lo que faltaba descontar inmediatamente después de cada descuento.
  const sql = `
    SELECT * FROM (
      SELECT d.id, d.fecha, d.importe, d.tipo, d.descontado_por, d.creado_en, d.retencion_id, d.empresa_id,
             em.nombre AS empresa,
             r.periodo, r.importe_total, r.concepto, r.beneficiario,
             c.cedula, c.nombre AS colaborador, e.nombre AS entidad, e.tipo AS tipo_entidad,
             r.importe_total - SUM(d.importe) OVER (PARTITION BY d.retencion_id ORDER BY d.fecha, d.id) AS saldo_despues,
             r.importe_total - SUM(d.importe) OVER (PARTITION BY d.retencion_id) AS saldo_actual
      FROM descuentos d
      JOIN retenciones r ON r.id = d.retencion_id
      JOIN colaboradores c ON c.id = r.colaborador_id
      JOIN entidades e ON e.id = r.entidad_id
      JOIN empresas em ON em.id = d.empresa_id
    ) d
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY d.fecha DESC, d.id DESC`;
  const filas = base().prepare(sql).all(params);
  return filtrarTexto(filas, f.q, (x) => [x.colaborador, x.cedula, x.entidad, x.concepto, x.beneficiario, x.empresa]);
}

function crearDescuento(datos) {
  const d = base();
  const fila = {
    retencion_id: entero(datos.retencion_id, 'la retención'),
    importe: importe(datos.importe),
    tipo: String(datos.tipo || ''),
    empresa_id: entero(datos.empresa_id, 'la empresa donde se retuvo'),
    descontado_por: texto(datos.descontado_por, 'quién hizo el descuento', { max: 80 }),
    fecha: fecha(datos.fecha),
  };
  if (!TIPOS_DESCUENTO.includes(fila.tipo)) throw new ErrorValidacion('Elegí el tipo de descuento.');
  const ret = d.prepare(`
    SELECT r.importe_total - COALESCE((SELECT SUM(importe) FROM descuentos WHERE retencion_id = r.id), 0) AS pendiente
    FROM retenciones r WHERE r.id = ?`).get(fila.retencion_id);
  if (!ret) throw new ErrorValidacion('La retención elegida no existe.');
  // Control previo con mensaje claro; el trigger de la base es la garantía final.
  if (fila.importe > ret.pendiente) {
    throw new ErrorValidacion(ret.pendiente <= 0
      ? 'Esta retención ya está completa: no queda nada por descontar.'
      : 'El importe supera lo que falta descontar de esta retención.', 409);
  }
  const r = d.prepare(`
    INSERT INTO descuentos (retencion_id, importe, tipo, empresa_id, descontado_por, fecha)
    VALUES ($retencion_id, $importe, $tipo, $empresa_id, $descontado_por, $fecha)`).run(fila);
  return { id: Number(r.lastInsertRowid) };
}

function eliminarDescuento(id) {
  const r = base().prepare('DELETE FROM descuentos WHERE id = ?').run(Number(id));
  if (!r.changes) throw new ErrorValidacion('El descuento no existe.', 404);
  return { ok: true };
}

// ── Panel ──

function panel(mes) {
  const filas = listarRetenciones({ periodo: periodo(mes) });
  const pactado = filas.reduce((a, x) => a + x.importe_total, 0);
  const retenido = filas.reduce((a, x) => a + x.descontado_real, 0);
  return {
    periodo: mes,
    ordenes: filas.length,
    completas: filas.filter((x) => x.completa).length,
    pactado,
    retenido,
    disponible: pactado - retenido,
    retenciones: filas,
  };
}

// ── Reportes ──

function reportePlanilla(f) {
  return listarRetenciones(f);
}

// Agrupa lo retenido (a abonar) por beneficiario o por entidad.
// En retenciones comerciales sin beneficiario se usa el nombre de la entidad.
function reporteAbonar(f) {
  const agrupar = f.agrupar === 'entidad' ? 'entidad' : 'beneficiario';
  const filas = listarRetenciones(f).filter((x) => x.descontado > 0);
  const grupos = new Map();
  for (const x of filas) {
    const clave = agrupar === 'entidad' ? x.entidad : (x.beneficiario || x.entidad);
    if (!grupos.has(clave)) grupos.set(clave, { grupo: clave, tipos: new Set(), ordenes: 0, abonar: 0, pendiente: 0, detalle: [] });
    const g = grupos.get(clave);
    g.tipos.add(x.tipo);
    g.ordenes += 1;
    g.abonar += x.descontado;
    g.pendiente += x.pendiente;
    g.detalle.push(x);
  }
  const lista = [...grupos.values()]
    .map((g) => ({ ...g, tipo: [...g.tipos].join(' / ') }))
    .sort((a, b) => a.grupo.localeCompare(b.grupo, 'es'));
  lista.forEach((g) => delete g.tipos);
  return { agrupar, grupos: lista, total: lista.reduce((a, g) => a + g.abonar, 0) };
}

// ── Utilidades ──

function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function filtrarTexto(filas, q, campos) {
  const termino = normalizar(q).trim();
  if (!termino) return filas;
  const partes = termino.split(/\s+/);
  const termCi = termino.replace(/[.\-\s]/g, '');
  return filas.filter((x) => {
    const heno = normalizar(campos(x).join(' | '));
    return partes.every((p) => heno.includes(p)) || (termCi && /^\d+$/.test(termCi) && heno.includes(termCi));
  });
}

module.exports = {
  conectar, cerrar, traducirError, ErrorValidacion, TIPOS_DESCUENTO,
  catalogos, listarEntidades, crearEntidad, listarColaboradores, crearColaborador,
  listarEmpresas, crearEmpresa, listarRetenciones, crearRetencion, eliminarRetencion,
  listarDescuentos, crearDescuento, eliminarDescuento, panel, reportePlanilla, reporteAbonar,
};
