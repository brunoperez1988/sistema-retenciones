'use strict';

/*
 * Motor local para la versión de archivo único (sin servidor ni instalación).
 * Atiende las mismas rutas /api/... que el servidor y guarda los datos en el
 * navegador (IndexedDB). Las reglas que en la versión con servidor controla
 * SQLite se controlan acá, antes de guardar cada cambio:
 *   - nunca se descuenta más que el importe total de la retención;
 *   - beneficiario obligatorio en judiciales; cédula única y válida; etc.
 * Los importes se guardan en centésimos (enteros).
 */
(function () {
  const TIPOS_DESCUENTO = ['1Q', '2Q', 'Egresos', 'Ajustes', 'Licencias'];
  const NOMBRE_BD = 'sistema-retenciones';
  const ALMACEN = 'datos';
  const CLAVE = 'estado';
  const VERSION_DATOS = 1;

  class ErrorValidacion extends Error {
    constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
  }

  // ── Persistencia (IndexedDB) ──

  function abrirBD() {
    return new Promise((resolve, reject) => {
      let pedido;
      try { pedido = indexedDB.open(NOMBRE_BD, 1); } catch (e) { reject(e); return; }
      pedido.onupgradeneeded = () => pedido.result.createObjectStore(ALMACEN);
      pedido.onsuccess = () => resolve(pedido.result);
      pedido.onerror = () => reject(pedido.error);
      pedido.onblocked = () => reject(new Error('Base bloqueada'));
    });
  }

  let bd = null;
  async function conexion() {
    if (!bd) {
      bd = await abrirBD();
      bd.onclose = () => { bd = null; };
      bd.onversionchange = () => { bd.close(); bd = null; };
    }
    return bd;
  }

  async function leerEstado() {
    const b = await conexion();
    return new Promise((resolve, reject) => {
      const tx = b.transaction(ALMACEN, 'readonly');
      const p = tx.objectStore(ALMACEN).get(CLAVE);
      p.onsuccess = () => resolve(p.result || null);
      p.onerror = () => reject(p.error);
    });
  }

  async function guardarEstado(valor) {
    const b = await conexion();
    return new Promise((resolve, reject) => {
      const tx = b.transaction(ALMACEN, 'readwrite');
      tx.objectStore(ALMACEN).put(valor, CLAVE);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Escritura cancelada'));
    });
  }

  // ── Estado en memoria ──

  let estado = null;
  let iniciando = null;

  function estadoVacio() {
    return { version: VERSION_DATOS, sig: 1, entidades: [], colaboradores: [], empresas: [], retenciones: [], descuentos: [], ultimoRespaldo: null, modificado: null };
  }

  async function iniciar() {
    if (estado) return;
    if (!iniciando) {
      iniciando = (async () => {
        let e = await leerEstado();
        if (!e) {
          e = estadoConEjemplos();
          await guardarEstado(e);
        }
        estado = e;
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* opcional */ }
      })().finally(() => { iniciando = null; });
    }
    await iniciando;
  }

  const ahora = () => {
    const d = new Date();
    const dos = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
  };

  // Aplica un cambio sobre una copia; solo si se guarda bien reemplaza el estado.
  async function modificar(fn) {
    const copia = structuredClone(estado);
    const resultado = fn(copia);
    copia.modificado = ahora();
    await guardarEstado(copia);
    estado = copia;
    return resultado;
  }

  // ── Validaciones (las mismas que la versión con servidor) ──

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
  function importe(valor, campo = 'el importe') {
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) throw new ErrorValidacion(`Ingresá ${campo} mayor a cero.`);
    if (n > 10000000000) throw new ErrorValidacion('El importe es demasiado alto.');
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
  function cedula(valor) {
    const v = String(valor ?? '').replace(/[.\-\s]/g, '');
    if (!/^\d{6,8}$/.test(v)) throw new ErrorValidacion('La cédula debe tener entre 6 y 8 dígitos (con dígito verificador).');
    const cuerpo = v.slice(0, -1).padStart(7, '0');
    const pesos = [2, 9, 8, 7, 6, 3, 4];
    const suma = pesos.reduce((acc, p, i) => acc + p * Number(cuerpo[i]), 0);
    if ((10 - (suma % 10)) % 10 !== Number(v.at(-1))) throw new ErrorValidacion('La cédula no es válida: revisá el dígito verificador.');
    return v;
  }
  const mismoNombre = (a, b) => a.localeCompare(b, 'es', { sensitivity: 'accent' }) === 0;
  const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, 'es');

  // ── Consultas ──

  const descontadoDe = (e, retId) => e.descuentos.reduce((a, d) => a + (d.retencion_id === retId ? d.importe : 0), 0);

  function catalogos() {
    return {
      entidades: [...estado.entidades].sort(porNombre),
      colaboradores: [...estado.colaboradores].sort(porNombre),
      empresas: [...estado.empresas].sort(porNombre),
      tiposDescuento: TIPOS_DESCUENTO,
    };
  }

  function listarEntidades() {
    return catalogos().entidades.map((x) => ({ ...x, retenciones: estado.retenciones.filter((r) => r.entidad_id === x.id).length }));
  }
  function listarColaboradores() {
    return catalogos().colaboradores.map((c) => {
      const rs = estado.retenciones.filter((r) => r.colaborador_id === c.id);
      return { ...c, retenciones: rs.length, total: rs.reduce((a, r) => a + r.importe_total, 0), descontado: rs.reduce((a, r) => a + descontadoDe(estado, r.id), 0) };
    });
  }
  function listarEmpresas() {
    return catalogos().empresas.map((em) => {
      const ds = estado.descuentos.filter((d) => d.empresa_id === em.id);
      return { ...em, descuentos: ds.length, retenido: ds.reduce((a, d) => a + d.importe, 0) };
    });
  }

  function normalizar(s) { return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
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

  function listarRetenciones(f = {}) {
    const ent = new Map(estado.entidades.map((x) => [x.id, x]));
    const col = new Map(estado.colaboradores.map((x) => [x.id, x]));
    const emp = new Map(estado.empresas.map((x) => [x.id, x]));
    const per = f.periodo ? periodo(f.periodo) : null;
    const tdesc = TIPOS_DESCUENTO.includes(f.tipo_descuento) ? f.tipo_descuento : null;
    const empresaId = f.empresa_id ? Number(f.empresa_id) : null;
    const filtraDescuentos = Boolean(tdesc || empresaId);

    let filas = estado.retenciones
      .filter((r) => !per || r.periodo === per)
      .filter((r) => !(f.tipo === 'judicial' || f.tipo === 'comercial') || ent.get(r.entidad_id).tipo === f.tipo)
      .filter((r) => !f.colaborador_id || r.colaborador_id === Number(f.colaborador_id))
      .map((r) => {
        const c = col.get(r.colaborador_id);
        const e = ent.get(r.entidad_id);
        const todos = estado.descuentos.filter((d) => d.retencion_id === r.id);
        const fil = todos.filter((d) => (!tdesc || d.tipo === tdesc) && (!empresaId || d.empresa_id === empresaId));
        const real = todos.reduce((a, d) => a + d.importe, 0);
        const filtrado = fil.reduce((a, d) => a + d.importe, 0);
        return {
          ...r,
          colaborador_id: c.id, cedula: c.cedula, colaborador: c.nombre,
          entidad_id: e.id, entidad: e.nombre, tipo: e.tipo,
          descontado_real: real, cantidad_descuentos: todos.length, descontado_filtrado: filtrado,
          empresas: [...new Set(fil.map((d) => emp.get(d.empresa_id).nombre))].join(', '),
          descontado: filtraDescuentos ? filtrado : real,
          pendiente: r.importe_total - real,
          completa: real >= r.importe_total,
          _hayFiltrados: fil.length > 0,
        };
      })
      .filter((x) => !filtraDescuentos || x._hayFiltrados)
      .sort((a, b) => b.periodo.localeCompare(a.periodo) || a.colaborador.localeCompare(b.colaborador, 'es') || a.entidad.localeCompare(b.entidad, 'es') || a.id - b.id);
    filas.forEach((x) => delete x._hayFiltrados);
    return filtrarTexto(filas, f.q, (x) => [x.colaborador, x.cedula, x.entidad, x.concepto, x.beneficiario, x.expediente]);
  }

  function listarDescuentos(f = {}) {
    const rets = new Map(listarRetenciones().map((r) => [r.id, r]));
    const emp = new Map(estado.empresas.map((x) => [x.id, x]));
    const mes = f.mes ? periodo(f.mes) : null;
    // Saldo luego de cada descuento (orden por fecha e id).
    const acumulado = new Map();
    const saldoDespues = new Map();
    [...estado.descuentos].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id).forEach((d) => {
      const suma = (acumulado.get(d.retencion_id) || 0) + d.importe;
      acumulado.set(d.retencion_id, suma);
      saldoDespues.set(d.id, rets.get(d.retencion_id).importe_total - suma);
    });
    const filas = estado.descuentos
      .filter((d) => !mes || d.fecha.slice(0, 7) === mes)
      .filter((d) => !TIPOS_DESCUENTO.includes(f.tipo_descuento) || d.tipo === f.tipo_descuento)
      .filter((d) => !f.empresa_id || d.empresa_id === Number(f.empresa_id))
      .filter((d) => !f.retencion_id || d.retencion_id === Number(f.retencion_id))
      .map((d) => {
        const r = rets.get(d.retencion_id);
        return {
          ...d, empresa: emp.get(d.empresa_id).nombre,
          periodo: r.periodo, importe_total: r.importe_total, concepto: r.concepto, beneficiario: r.beneficiario,
          cedula: r.cedula, colaborador: r.colaborador, entidad: r.entidad, tipo_entidad: r.tipo,
          saldo_despues: saldoDespues.get(d.id), saldo_actual: r.pendiente,
        };
      })
      .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id - a.id);
    return filtrarTexto(filas, f.q, (x) => [x.colaborador, x.cedula, x.entidad, x.concepto, x.beneficiario, x.empresa]);
  }

  function panel(mes) {
    const filas = listarRetenciones({ periodo: periodo(mes) });
    const pactado = filas.reduce((a, x) => a + x.importe_total, 0);
    const retenido = filas.reduce((a, x) => a + x.descontado_real, 0);
    return { periodo: mes, ordenes: filas.length, completas: filas.filter((x) => x.completa).length, pactado, retenido, disponible: pactado - retenido, retenciones: filas };
  }

  function reporteAbonar(f) {
    const agrupar = f.agrupar === 'entidad' ? 'entidad' : 'beneficiario';
    const grupos = new Map();
    for (const x of listarRetenciones(f).filter((r) => r.descontado > 0)) {
      const clave = agrupar === 'entidad' ? x.entidad : (x.beneficiario || x.entidad);
      if (!grupos.has(clave)) grupos.set(clave, { grupo: clave, tipos: new Set(), ordenes: 0, abonar: 0, pendiente: 0, detalle: [] });
      const g = grupos.get(clave);
      g.tipos.add(x.tipo); g.ordenes += 1; g.abonar += x.descontado; g.pendiente += x.pendiente; g.detalle.push(x);
    }
    const lista = [...grupos.values()].map(({ tipos, ...g }) => ({ ...g, tipo: [...tipos].join(' / ') })).sort((a, b) => a.grupo.localeCompare(b.grupo, 'es'));
    return { agrupar, grupos: lista, total: lista.reduce((a, g) => a + g.abonar, 0) };
  }

  // ── Altas, bajas y la regla del tope ──

  function crearEntidad(datos) {
    const nombre = texto(datos.nombre, 'nombre de la entidad');
    const tipo = String(datos.tipo || '');
    if (!['judicial', 'comercial'].includes(tipo)) throw new ErrorValidacion('Indicá si la entidad es judicial o comercial.');
    if (estado.entidades.some((x) => mismoNombre(x.nombre, nombre))) throw new ErrorValidacion('Ya existe una entidad con ese nombre.', 409);
    return modificar((e) => { const id = e.sig++; e.entidades.push({ id, nombre, tipo }); return { id }; });
  }

  function crearColaborador(datos) {
    const ci = cedula(datos.cedula);
    const nombre = texto(datos.nombre, 'nombre del colaborador');
    if (estado.colaboradores.some((x) => x.cedula === ci)) throw new ErrorValidacion('Ya existe un colaborador con esa cédula.', 409);
    return modificar((e) => { const id = e.sig++; e.colaboradores.push({ id, cedula: ci, nombre }); return { id }; });
  }

  function crearEmpresa(datos) {
    const nombre = texto(datos.nombre, 'nombre de la empresa');
    if (estado.empresas.some((x) => mismoNombre(x.nombre, nombre))) throw new ErrorValidacion('Ya existe una empresa con ese nombre.', 409);
    return modificar((e) => { const id = e.sig++; e.empresas.push({ id, nombre }); return { id }; });
  }

  function crearRetencion(datos) {
    const colaborador_id = entero(datos.colaborador_id, 'el colaborador');
    const entidad_id = entero(datos.entidad_id, 'la entidad');
    if (!estado.colaboradores.some((c) => c.id === colaborador_id)) throw new ErrorValidacion('El colaborador elegido no existe.');
    const entidad = estado.entidades.find((x) => x.id === entidad_id);
    if (!entidad) throw new ErrorValidacion('La entidad elegida no existe.');
    const fila = {
      colaborador_id, entidad_id,
      periodo: periodo(datos.periodo),
      importe_total: importe(datos.importe_total, 'el importe total'),
      concepto: texto(datos.concepto, 'concepto', { obligatorio: false }),
      expediente: texto(datos.expediente, 'expediente / juzgado', { obligatorio: false }),
      beneficiario: entidad.tipo === 'judicial' ? texto(datos.beneficiario, 'beneficiario') : null,
      cargado_por: texto(datos.cargado_por, 'quién la cargó', { max: 80 }),
      creado_en: ahora(),
    };
    return modificar((e) => { const id = e.sig++; e.retenciones.push({ id, ...fila }); return { id }; });
  }

  function eliminarRetencion(id) {
    const n = Number(id);
    if (!estado.retenciones.some((r) => r.id === n)) throw new ErrorValidacion('La retención no existe.', 404);
    if (estado.descuentos.some((d) => d.retencion_id === n)) throw new ErrorValidacion('No se puede eliminar una retención que ya tiene descuentos.', 409);
    return modificar((e) => { e.retenciones = e.retenciones.filter((r) => r.id !== n); return { ok: true }; });
  }

  function crearDescuento(datos) {
    const fila = {
      retencion_id: entero(datos.retencion_id, 'la retención'),
      importe: importe(datos.importe),
      tipo: String(datos.tipo || ''),
      empresa_id: entero(datos.empresa_id, 'la empresa donde se retuvo'),
      descontado_por: texto(datos.descontado_por, 'quién hizo el descuento', { max: 80 }),
      fecha: fecha(datos.fecha),
    };
    if (!TIPOS_DESCUENTO.includes(fila.tipo)) throw new ErrorValidacion('Elegí el tipo de descuento.');
    if (!estado.empresas.some((x) => x.id === fila.empresa_id)) throw new ErrorValidacion('La empresa elegida no existe.');
    return modificar((e) => {
      // Regla de oro, verificada sobre los datos que se van a guardar.
      const ret = e.retenciones.find((r) => r.id === fila.retencion_id);
      if (!ret) throw new ErrorValidacion('La retención elegida no existe.');
      const pendiente = ret.importe_total - descontadoDe(e, ret.id);
      if (fila.importe > pendiente) {
        throw new ErrorValidacion(pendiente <= 0
          ? 'Esta retención ya está completa: no queda nada por descontar.'
          : 'El importe supera lo que falta descontar de esta retención. Nunca se puede descontar más que el importe total.', 409);
      }
      const id = e.sig++;
      e.descuentos.push({ id, ...fila, creado_en: ahora() });
      return { id };
    });
  }

  function eliminarDescuento(id) {
    const n = Number(id);
    if (!estado.descuentos.some((d) => d.id === n)) throw new ErrorValidacion('El descuento no existe.', 404);
    return modificar((e) => { e.descuentos = e.descuentos.filter((d) => d.id !== n); return { ok: true }; });
  }

  // Revisa un respaldo completo antes de aceptarlo (todas las reglas, incluido el tope).
  function validarEstado(e) {
    if (!e || typeof e !== 'object' || !Array.isArray(e.retenciones) || !Array.isArray(e.descuentos)
      || !Array.isArray(e.entidades) || !Array.isArray(e.colaboradores) || !Array.isArray(e.empresas)) {
      throw new ErrorValidacion('El archivo no es un respaldo del Sistema de Retenciones.');
    }
    const ids = new Set();
    for (const lista of [e.entidades, e.colaboradores, e.empresas, e.retenciones, e.descuentos]) {
      for (const x of lista) {
        if (!Number.isInteger(x.id) || ids.has(x.id)) throw new ErrorValidacion('El respaldo tiene datos dañados (identificadores).');
        ids.add(x.id);
      }
    }
    const ent = new Map(e.entidades.map((x) => [x.id, x]));
    const cols = new Set(e.colaboradores.map((x) => x.id));
    const emps = new Set(e.empresas.map((x) => x.id));
    for (const r of e.retenciones) {
      if (!cols.has(r.colaborador_id) || !ent.has(r.entidad_id) || !(Number.isInteger(r.importe_total) && r.importe_total > 0)) throw new ErrorValidacion('El respaldo tiene una retención con datos dañados.');
      if (ent.get(r.entidad_id).tipo === 'judicial' && !String(r.beneficiario || '').trim()) throw new ErrorValidacion('El respaldo tiene una retención judicial sin beneficiario.');
    }
    const rets = new Map(e.retenciones.map((r) => [r.id, r]));
    for (const d of e.descuentos) {
      if (!rets.has(d.retencion_id) || !emps.has(d.empresa_id) || !(Number.isInteger(d.importe) && d.importe > 0)) throw new ErrorValidacion('El respaldo tiene un descuento con datos dañados.');
    }
    for (const r of e.retenciones) {
      if (descontadoDe(e, r.id) > r.importe_total) throw new ErrorValidacion('El respaldo tiene descuentos que superan el total de una retención.');
    }
    const maxId = Math.max(0, ...ids);
    return { ...estadoVacio(), ...e, version: VERSION_DATOS, sig: Math.max(Number(e.sig) || 0, maxId + 1) };
  }

  // ── Respaldo ──

  function infoDatos() {
    return {
      local: true,
      modificado: estado.modificado,
      ultimoRespaldo: estado.ultimoRespaldo,
      cantidades: {
        retenciones: estado.retenciones.length, descuentos: estado.descuentos.length,
        colaboradores: estado.colaboradores.length, entidades: estado.entidades.length, empresas: estado.empresas.length,
      },
      ejemplos: Boolean(estado.ejemplos),
    };
  }

  async function exportarRespaldo() {
    const copia = { ...structuredClone(estado), sistema: 'Sistema de Retenciones', exportado: ahora() };
    delete copia.ultimoRespaldo;
    const blob = new Blob([JSON.stringify(copia, null, 1)], { type: 'application/json' });
    await modificarSinMarca((e) => { e.ultimoRespaldo = ahora(); });
    return blob;
  }

  async function modificarSinMarca(fn) {
    const copia = structuredClone(estado);
    fn(copia);
    await guardarEstado(copia);
    estado = copia;
  }

  async function importarRespaldo(textoArchivo) {
    let datos;
    try { datos = JSON.parse(textoArchivo); } catch { throw new ErrorValidacion('El archivo no es un respaldo válido.'); }
    const nuevo = validarEstado(datos);
    delete nuevo.sistema; delete nuevo.exportado;
    nuevo.ultimoRespaldo = ahora();
    nuevo.modificado = ahora();
    await guardarEstado(nuevo);
    estado = nuevo;
    return infoDatos();
  }

  async function borrarTodo() {
    const nuevo = estadoVacio();
    nuevo.modificado = ahora();
    await guardarEstado(nuevo);
    estado = nuevo;
    return infoDatos();
  }

  // ── Datos de ejemplo ──

  function estadoConEjemplos() {
    const e = estadoVacio();
    e.ejemplos = true;
    const mes = (desp) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + desp); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
    const actual = mes(0); const anterior = mes(-1);
    const nuevoId = () => e.sig++;
    const ent = (nombre, tipo) => { const id = nuevoId(); e.entidades.push({ id, nombre, tipo }); return id; };
    const col = (ci, nombre) => { const id = nuevoId(); e.colaboradores.push({ id, cedula: ci, nombre }); return id; };
    const emp = (nombre) => { const id = nuevoId(); e.empresas.push({ id, nombre }); return id; };
    const juzgado = ent('Juzgado de Familia N° 2', 'judicial');
    const electro = ent('Electrohogar SA', 'comercial');
    const anda = ent('ANDA', 'comercial');
    const juan = col('11111111', 'Juan Pérez');
    const ana = col('22222222', 'Ana Gómez');
    const central = emp('Operativa Central'); const norte = emp('Sucursal Norte'); emp('Sucursal Este');
    const ret = (c, en, p, total, concepto, expediente, beneficiario) => {
      const id = nuevoId();
      e.retenciones.push({ id, colaborador_id: c, entidad_id: en, periodo: p, importe_total: total, concepto, expediente, beneficiario, cargado_por: 'Administración', creado_en: ahora() });
      return id;
    };
    const desc = (r, imp, tipo, empresa, f) => e.descuentos.push({ id: nuevoId(), retencion_id: r, importe: imp, tipo, empresa_id: empresa, descontado_por: 'Liquidación', fecha: f, creado_en: ahora() });
    const r1 = ret(juan, anda, actual, 200000, 'Préstamo ANDA', '', null);
    const r2 = ret(ana, juzgado, actual, 850000, 'Pensión alimenticia', 'IUE 2-12345/2025', 'María Gómez');
    const r3 = ret(juan, electro, actual, 450000, 'Cuota crédito', '', null);
    const r4 = ret(ana, anda, anterior, 150000, 'Préstamo ANDA', '', null);
    const r5 = ret(juan, juzgado, anterior, 600000, 'Pensión alimenticia', 'IUE 2-9876/2024', 'Lucía Pérez');
    desc(r1, 2000, '1Q', central, `${actual}-15`);
    desc(r2, 425000, '1Q', central, `${actual}-15`);
    desc(r3, 150000, '1Q', norte, `${actual}-15`);
    desc(r4, 75000, '1Q', central, `${anterior}-15`);
    desc(r4, 75000, '2Q', central, `${anterior}-28`);
    desc(r5, 300000, '1Q', central, `${anterior}-15`);
    desc(r5, 300000, '2Q', norte, `${anterior}-28`);
    e.modificado = ahora();
    return e;
  }

  // ── Exportación (Excel sin compresión + CSV) ──

  const TIPO_TXT = { judicial: 'Judicial', comercial: 'Comercial' };

  function csv(columnas, filas) {
    const celda = (v, col) => {
      if (v == null) return '';
      if (col.tipo === 'moneda' && typeof v === 'number') return (v / 100).toFixed(2).replace('.', ',');
      const s = String(v);
      return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lineas = [columnas.map((c) => celda(c.titulo, {})).join(';')];
    for (const f of filas) {
      const valores = Array.isArray(f) ? f : f.celdas;
      lineas.push(columnas.map((c, i) => celda(valores[i], c)).join(';'));
    }
    return new Blob(['﻿' + lineas.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  }

  const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  function zip(archivos) {
    const enc = new TextEncoder();
    const partes = []; const centrales = []; let offset = 0;
    for (const { nombre, texto: contenido } of archivos) {
      const n = enc.encode(nombre); const datos = enc.encode(contenido); const crc = crc32(datos);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(12, 0x21, true); local.setUint32(14, crc, true); local.setUint32(18, datos.length, true); local.setUint32(22, datos.length, true); local.setUint16(26, n.length, true);
      partes.push(local.buffer, n, datos);
      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x0800, true);
      central.setUint16(14, 0x21, true); central.setUint32(16, crc, true); central.setUint32(20, datos.length, true); central.setUint32(24, datos.length, true);
      central.setUint16(28, n.length, true); central.setUint32(42, offset, true);
      centrales.push(central.buffer, n);
      offset += 30 + n.length + datos.length;
    }
    const tamDir = centrales.reduce((a, b) => a + b.byteLength, 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
    fin.setUint32(12, tamDir, true); fin.setUint32(16, offset, true);
    return new Blob([...partes, ...centrales, fin.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const xml = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const columna = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

  const ESTILOS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot; #,##0.00"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF1F6F68"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F8F86"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFDF1D8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function xlsx({ hoja, titulo, subtitulo, columnas, filas }) {
    const filasXml = []; let nFila = 0;
    const fila = (celdas) => { nFila += 1; filasXml.push(`<row r="${nFila}">${celdas.join('')}</row>`); };
    const cT = (ref, v, s = 0) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    const cN = (ref, v, s = 0) => `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
    fila([cT('A1', titulo, 5)]); fila([cT('A2', subtitulo)]); fila([]);
    const enc = nFila + 1;
    fila(columnas.map((c, i) => cT(`${columna(i)}${enc}`, c.titulo, 1)));
    for (const f of filas) {
      const valores = Array.isArray(f) ? f : f.celdas; const negrita = !Array.isArray(f) && f.negrita; const r = nFila + 1;
      fila(columnas.map((c, i) => {
        const v = valores[i]; const ref = `${columna(i)}${r}`;
        if (v == null || v === '') return negrita ? cT(ref, '', 3) : '';
        if (c.tipo === 'moneda' && typeof v === 'number') return cN(ref, (v / 100).toFixed(2), negrita ? 4 : 2);
        return cT(ref, v, negrita ? 3 : 0);
      }).filter(Boolean));
    }
    const ult = columna(columnas.length - 1);
    const nombreHoja = xml(hoja);
    const hojaXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${enc}" topLeftCell="A${enc + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columnas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho || 16}" customWidth="1"/>`).join('')}</cols><sheetData>${filasXml.join('')}</sheetData><autoFilter ref="A${enc}:${ult}${Math.max(nFila, enc)}"/></worksheet>`;
    return zip([
      { nombre: '[Content_Types].xml', texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { nombre: '_rels/.rels', texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { nombre: 'xl/workbook.xml', texto: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${nombreHoja}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${nombreHoja}'!$A$${enc}:$${ult}$${Math.max(nFila, enc)}</definedName></definedNames></workbook>` },
      { nombre: 'xl/_rels/workbook.xml.rels', texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { nombre: 'xl/styles.xml', texto: ESTILOS },
      { nombre: 'xl/worksheets/sheet1.xml', texto: hojaXml },
    ]);
  }

  function textoFiltros(f) {
    const p = [];
    if (f.periodo) p.push(`Período ${f.periodo}`);
    if (f.tipo) p.push(TIPO_TXT[f.tipo] || f.tipo);
    if (f.tipo_descuento) p.push(`Tipo de descuento ${f.tipo_descuento}`);
    if (f.empresa_id) p.push(`Retenido en ${(estado.empresas.find((e) => e.id === Number(f.empresa_id)) || {}).nombre || ''}`);
    if (f.q) p.push(`Búsqueda "${f.q}"`);
    return p.length ? `Filtros: ${p.join(' · ')}` : 'Sin filtros';
  }

  function armarPlanilla(f) {
    const filas = listarRetenciones(f);
    const columnas = [
      { titulo: 'Período', ancho: 10 }, { titulo: 'Cédula', ancho: 12 }, { titulo: 'Colaborador', ancho: 26 }, { titulo: 'Entidad', ancho: 26 },
      { titulo: 'Tipo', ancho: 11 }, { titulo: 'Concepto', ancho: 24 }, { titulo: 'Expediente / Juzgado', ancho: 22 }, { titulo: 'Beneficiario', ancho: 24 },
      { titulo: 'Total', tipo: 'moneda', ancho: 14 }, { titulo: 'Descontado', tipo: 'moneda', ancho: 14 }, { titulo: 'Falta descontar', tipo: 'moneda', ancho: 15 },
      { titulo: 'Empresas donde se retuvo', ancho: 28 }, { titulo: 'Cargado por', ancho: 16 },
    ];
    const cuerpo = filas.map((x) => [x.periodo, x.cedula, x.colaborador, x.entidad, TIPO_TXT[x.tipo], x.concepto, x.expediente, x.beneficiario || '', x.importe_total, x.descontado, x.pendiente, x.empresas, x.cargado_por]);
    const suma = (k) => filas.reduce((a, x) => a + x[k], 0);
    cuerpo.push({ negrita: true, celdas: ['TOTAL', '', `${filas.length} retenciones`, '', '', '', '', '', suma('importe_total'), suma('descontado'), suma('pendiente'), '', ''] });
    return { columnas, filas: cuerpo, titulo: 'Planilla de retenciones', hoja: 'Planilla' };
  }

  function armarAbonar(f) {
    const rep = reporteAbonar(f);
    const porEntidad = rep.agrupar === 'entidad';
    const columnas = [
      { titulo: porEntidad ? 'Entidad' : 'Beneficiario', ancho: 28 }, { titulo: 'Tipo', ancho: 11 }, { titulo: 'Cédula', ancho: 12 }, { titulo: 'Colaborador', ancho: 26 },
      { titulo: porEntidad ? 'Beneficiario' : 'Entidad', ancho: 26 }, { titulo: 'Concepto', ancho: 24 }, { titulo: 'Expediente / Juzgado', ancho: 22 }, { titulo: 'Período', ancho: 10 },
      { titulo: 'A abonar', tipo: 'moneda', ancho: 15 },
    ];
    const cuerpo = [];
    for (const g of rep.grupos) {
      for (const x of g.detalle) cuerpo.push([g.grupo, TIPO_TXT[x.tipo], x.cedula, x.colaborador, porEntidad ? (x.beneficiario || '') : x.entidad, x.concepto, x.expediente, x.periodo, x.descontado]);
      cuerpo.push({ negrita: true, celdas: [`Subtotal ${g.grupo}`, '', '', `${g.ordenes} ${g.ordenes === 1 ? 'orden' : 'órdenes'}`, '', '', '', '', g.abonar] });
    }
    cuerpo.push({ negrita: true, celdas: ['TOTAL A ABONAR', '', '', '', '', '', '', '', rep.total] });
    return { columnas, filas: cuerpo, titulo: `A abonar por ${porEntidad ? 'entidad' : 'beneficiario'}`, hoja: 'A abonar' };
  }

  // ── Enrutador: mismas rutas que el servidor ──

  async function manejar(metodo, rutaCompleta, cuerpo) {
    await iniciar();
    const url = new URL(rutaCompleta, 'http://local');
    const ruta = url.pathname.replace(/\/+$/, '');
    const f = Object.fromEntries([...url.searchParams].filter(([, v]) => v));
    let m;
    if (metodo === 'GET') {
      if (ruta === '/api/catalogos') return catalogos();
      if (ruta === '/api/entidades') return listarEntidades();
      if (ruta === '/api/colaboradores') return listarColaboradores();
      if (ruta === '/api/empresas') return listarEmpresas();
      if (ruta === '/api/retenciones') return listarRetenciones(f);
      if (ruta === '/api/descuentos') return listarDescuentos(f);
      if (ruta === '/api/panel') return panel(f.periodo || new Date().toISOString().slice(0, 7));
      if (ruta === '/api/reportes/planilla') return listarRetenciones(f);
      if (ruta === '/api/reportes/abonar') return reporteAbonar(f);
      if (ruta === '/api/datos') return infoDatos();
    }
    if (metodo === 'POST') {
      if (ruta === '/api/entidades') return crearEntidad(cuerpo || {});
      if (ruta === '/api/colaboradores') return crearColaborador(cuerpo || {});
      if (ruta === '/api/empresas') return crearEmpresa(cuerpo || {});
      if (ruta === '/api/retenciones') return crearRetencion(cuerpo || {});
      if (ruta === '/api/descuentos') return crearDescuento(cuerpo || {});
    }
    if (metodo === 'DELETE') {
      if ((m = ruta.match(/^\/api\/retenciones\/(\d+)$/))) return eliminarRetencion(m[1]);
      if ((m = ruta.match(/^\/api\/descuentos\/(\d+)$/))) return eliminarDescuento(m[1]);
    }
    throw new ErrorValidacion('Ruta no encontrada.', 404);
  }

  async function descargar(rutaCompleta) {
    await iniciar();
    const url = new URL(rutaCompleta, 'http://local');
    const f = Object.fromEntries([...url.searchParams].filter(([, v]) => v));
    const esPlanilla = url.pathname.endsWith('planilla');
    const rep = esPlanilla ? armarPlanilla(f) : armarAbonar(f);
    if (f.formato === 'csv') return csv(rep.columnas, rep.filas);
    return xlsx({ ...rep, subtitulo: `${textoFiltros(f)} · Generado el ${new Date().toLocaleString('es-UY')}` });
  }

  window.backendLocal = {
    ErrorValidacion,
    manejar,
    descargar,
    exportarRespaldo: async () => { await iniciar(); return exportarRespaldo(); },
    importarRespaldo: async (t) => { await iniciar(); return importarRespaldo(t); },
    borrarTodo: async () => { await iniciar(); return borrarTodo(); },
  };
})();
