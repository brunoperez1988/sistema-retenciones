'use strict';

// Sistema de Control de Retenciones de Sueldos
// Servidor web sin dependencias: node server.js  →  http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const datos = require('./src/db');
const { csv, xlsx } = require('./src/exportar');
const { cargarEjemplos } = require('./scripts/ejemplos');

const PUERTO = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // solo esta computadora: no hay inicio de sesión todavía
const RUTA_BASE = process.env.DB_PATH || path.join(__dirname, 'data', 'retenciones.db');
const PUBLICO = path.join(__dirname, 'public');

// ── Arranque de la base ──
try {
  const db = datos.conectar(RUTA_BASE);
  const vacia = db.prepare('SELECT (SELECT COUNT(*) FROM entidades) + (SELECT COUNT(*) FROM colaboradores) AS n').get().n === 0;
  if (vacia && !process.argv.includes('--sin-ejemplos')) {
    cargarEjemplos(db);
    console.log('Base nueva: se cargaron los datos de ejemplo.');
  }
} catch (err) {
  // No frenamos el servidor: las pantallas mostrarán el aviso con "Reintentar".
  console.error('No se pudo abrir la base de datos:', err.message);
  datos.cerrar();
}

// ── Utilidades HTTP ──

function json(res, status, cuerpo) {
  const b = Buffer.from(JSON.stringify(cuerpo));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > 1_000_000) { reject(new datos.ErrorValidacion('Pedido demasiado grande.', 413)); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      try { resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); }
      catch { reject(new datos.ErrorValidacion('El pedido no tiene un formato válido.')); }
    });
    req.on('error', reject);
  });
}

function descargar(res, nombre, tipo, buffer) {
  res.writeHead(200, {
    'Content-Type': tipo,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${nombre}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

const TIPOS_ESTATICOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function servirEstatico(req, res, ruta) {
  const relativa = ruta === '/' ? '/index.html' : decodeURIComponent(ruta);
  const archivo = path.normalize(path.join(PUBLICO, relativa));
  if (!archivo.startsWith(PUBLICO + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(archivo, (err, contenido) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TIPOS_ESTATICOS[path.extname(archivo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(contenido);
  });
}

// ── Reportes exportables ──

const TIPO_TXT = { judicial: 'Judicial', comercial: 'Comercial' };

function textoFiltros(f) {
  const partes = [];
  if (f.periodo) partes.push(`Período ${f.periodo}`);
  if (f.tipo) partes.push(TIPO_TXT[f.tipo] || f.tipo);
  if (f.tipo_descuento) partes.push(`Tipo de descuento ${f.tipo_descuento}`);
  if (f.empresa_nombre) partes.push(`Retenido en ${f.empresa_nombre}`);
  if (f.q) partes.push(`Búsqueda "${f.q}"`);
  return partes.length ? `Filtros: ${partes.join(' · ')}` : 'Sin filtros';
}

function exportarPlanilla(f) {
  const filas = datos.reportePlanilla(f);
  const columnas = [
    { titulo: 'Período', ancho: 10 }, { titulo: 'Cédula', ancho: 12 }, { titulo: 'Colaborador', ancho: 26 },
    { titulo: 'Entidad', ancho: 26 }, { titulo: 'Tipo', ancho: 11 }, { titulo: 'Concepto', ancho: 24 },
    { titulo: 'Expediente / Juzgado', ancho: 22 }, { titulo: 'Beneficiario', ancho: 24 },
    { titulo: 'Total', tipo: 'moneda', ancho: 14 }, { titulo: 'Descontado', tipo: 'moneda', ancho: 14 },
    { titulo: 'Falta descontar', tipo: 'moneda', ancho: 15 }, { titulo: 'Empresas donde se retuvo', ancho: 28 },
    { titulo: 'Cargado por', ancho: 16 },
  ];
  const cuerpo = filas.map((x) => [x.periodo, x.cedula, x.colaborador, x.entidad, TIPO_TXT[x.tipo], x.concepto, x.expediente,
    x.beneficiario || '', x.importe_total, x.descontado, x.pendiente, x.empresas, x.cargado_por]);
  const suma = (k) => filas.reduce((a, x) => a + x[k], 0);
  cuerpo.push({ negrita: true, celdas: ['TOTAL', '', `${filas.length} retenciones`, '', '', '', '', '', suma('importe_total'), suma('descontado'), suma('pendiente'), '', ''] });
  return { columnas, filas: cuerpo, titulo: 'Planilla de retenciones', hoja: 'Planilla' };
}

function exportarAbonar(f) {
  const rep = datos.reporteAbonar(f);
  const porEntidad = rep.agrupar === 'entidad';
  const columnas = [
    { titulo: porEntidad ? 'Entidad' : 'Beneficiario', ancho: 28 }, { titulo: 'Tipo', ancho: 11 },
    { titulo: 'Cédula', ancho: 12 }, { titulo: 'Colaborador', ancho: 26 },
    { titulo: porEntidad ? 'Beneficiario' : 'Entidad', ancho: 26 }, { titulo: 'Concepto', ancho: 24 },
    { titulo: 'Expediente / Juzgado', ancho: 22 }, { titulo: 'Período', ancho: 10 },
    { titulo: 'A abonar', tipo: 'moneda', ancho: 15 },
  ];
  const cuerpo = [];
  for (const g of rep.grupos) {
    for (const x of g.detalle) {
      cuerpo.push([g.grupo, TIPO_TXT[x.tipo], x.cedula, x.colaborador, porEntidad ? (x.beneficiario || '') : x.entidad,
        x.concepto, x.expediente, x.periodo, x.descontado]);
    }
    cuerpo.push({ negrita: true, celdas: [`Subtotal ${g.grupo}`, '', '', `${g.ordenes} ${g.ordenes === 1 ? 'orden' : 'órdenes'}`, '', '', '', '', g.abonar] });
  }
  cuerpo.push({ negrita: true, celdas: ['TOTAL A ABONAR', '', '', '', '', '', '', '', rep.total] });
  return { columnas, filas: cuerpo, titulo: `A abonar por ${porEntidad ? 'entidad' : 'beneficiario'}`, hoja: 'A abonar' };
}

function filtrosDesde(url) {
  const p = url.searchParams;
  const f = {};
  for (const k of ['periodo', 'tipo', 'tipo_descuento', 'empresa_id', 'q', 'agrupar', 'mes', 'colaborador_id', 'retencion_id']) {
    const v = p.get(k);
    if (v) f[k] = v;
  }
  return f;
}

// ── Rutas de la API ──

async function api(req, res, url) {
  const ruta = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  const f = filtrosDesde(url);
  let id;

  if (m === 'GET' && ruta === '/api/estado') { datos.catalogos(); return json(res, 200, { ok: true }); }
  if (m === 'GET' && ruta === '/api/catalogos') return json(res, 200, datos.catalogos());

  if (m === 'GET' && ruta === '/api/entidades') return json(res, 200, datos.listarEntidades());
  if (m === 'POST' && ruta === '/api/entidades') return json(res, 201, datos.crearEntidad(await leerCuerpo(req)));
  if (m === 'GET' && ruta === '/api/colaboradores') return json(res, 200, datos.listarColaboradores());
  if (m === 'POST' && ruta === '/api/colaboradores') return json(res, 201, datos.crearColaborador(await leerCuerpo(req)));
  if (m === 'GET' && ruta === '/api/empresas') return json(res, 200, datos.listarEmpresas());
  if (m === 'POST' && ruta === '/api/empresas') return json(res, 201, datos.crearEmpresa(await leerCuerpo(req)));

  if (m === 'GET' && ruta === '/api/retenciones') return json(res, 200, datos.listarRetenciones(f));
  if (m === 'POST' && ruta === '/api/retenciones') return json(res, 201, datos.crearRetencion(await leerCuerpo(req)));
  if (m === 'DELETE' && (id = ruta.match(/^\/api\/retenciones\/(\d+)$/))) return json(res, 200, datos.eliminarRetencion(id[1]));

  if (m === 'GET' && ruta === '/api/descuentos') return json(res, 200, datos.listarDescuentos(f));
  if (m === 'POST' && ruta === '/api/descuentos') return json(res, 201, datos.crearDescuento(await leerCuerpo(req)));
  if (m === 'DELETE' && (id = ruta.match(/^\/api\/descuentos\/(\d+)$/))) return json(res, 200, datos.eliminarDescuento(id[1]));

  if (m === 'GET' && ruta === '/api/panel') return json(res, 200, datos.panel(f.periodo || new Date().toISOString().slice(0, 7)));

  if (m === 'GET' && (ruta === '/api/reportes/planilla' || ruta === '/api/reportes/abonar')) {
    const esPlanilla = ruta.endsWith('planilla');
    const formato = url.searchParams.get('formato');
    if (!formato) return json(res, 200, esPlanilla ? datos.reportePlanilla(f) : datos.reporteAbonar(f));
    if (f.empresa_id) f.empresa_nombre = (datos.catalogos().empresas.find((e) => e.id === Number(f.empresa_id)) || {}).nombre;
    const rep = esPlanilla ? exportarPlanilla(f) : exportarAbonar(f);
    const base = `${esPlanilla ? 'planilla-retenciones' : 'a-abonar'}${f.periodo ? '-' + f.periodo : ''}`;
    if (formato === 'csv') return descargar(res, `${base}.csv`, 'text/csv; charset=utf-8', csv(rep.columnas, rep.filas));
    const subtitulo = `${textoFiltros(f)} · Generado el ${new Date().toLocaleString('es-UY')}`;
    return descargar(res, `${base}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx({ ...rep, subtitulo }));
  }

  return json(res, 404, { error: 'Ruta no encontrada.' });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    return servirEstatico(req, res, url.pathname);
  }
  try {
    await api(req, res, url);
  } catch (err) {
    const validacion = err instanceof datos.ErrorValidacion ? err : datos.traducirError(err);
    if (validacion) return json(res, validacion.status, { error: validacion.message });
    // Falla de la base u otra falla interna: la pantalla muestra "Tus datos están a salvo" + Reintentar.
    console.error(new Date().toISOString(), req.method, url.pathname, err);
    datos.cerrar(); // se vuelve a abrir en el próximo pedido
    json(res, 503, { error: 'No pudimos cargar la información. Tus datos están a salvo.', conexion: true });
  }
});

servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`El Sistema de Retenciones ya está abierto en http://localhost:${PUERTO} (o el puerto ${PUERTO} está ocupado).`);
    process.exit(0);
  }
  throw err;
});

servidor.listen(PUERTO, HOST, () => {
  console.log(`Sistema de Retenciones listo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PUERTO}`);
  console.log(`Base de datos: ${RUTA_BASE}`);
  console.log('Dejá esta ventana abierta mientras uses el sistema. Para cerrarlo, cerrá esta ventana.');
});
