'use strict';

/* Sistema de Control de Retenciones · pantallas (sin frameworks) */

const $app = document.getElementById('app');
const MENSAJE_FALLA = 'No pudimos cargar la información. Tus datos están a salvo.';

// ── Formatos es-UY ──

const fmtMoneda = new Intl.NumberFormat('es-UY', { style: 'currency', currency: 'UYU' });
const moneda = (centesimos) => fmtMoneda.format((centesimos || 0) / 100);
const fmtNumero = new Intl.NumberFormat('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numeroPlano = (centesimos) => fmtNumero.format((centesimos || 0) / 100);

function nombreMes(periodo) {
  if (!periodo) return '';
  const [a, m] = periodo.split('-').map(Number);
  const txt = new Date(a, m - 1, 1).toLocaleDateString('es-UY', { month: 'long', year: 'numeric' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}
const mesCorto = (periodo) => {
  const [a, m] = periodo.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('es-UY', { month: 'short', year: 'numeric' }).replace('.', '');
};
const fecha = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const cedula = (ci) => {
  const s = String(ci || '');
  if (s.length < 2) return s;
  const cuerpo = s.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cuerpo}-${s.slice(-1)}`;
};
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mesActual = () => hoy().slice(0, 7);

// Acepta "2.000", "2000", "2.000,50", "2000,5", "2000.50". Devuelve centésimos o NaN.
function leerImporte(texto) {
  let s = String(texto || '').trim().replace(/\$|\s|UYU/gi, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tipoTxt = { judicial: 'Judicial', comercial: 'Comercial' };
const etiquetaTipo = (tipo) => `<span class="etiqueta-tipo ${esc(tipo)}">${tipoTxt[tipo] || esc(tipo)}</span>`;

// Recordar quién carga (solo comodidad local; si el navegador no deja, no pasa nada).
const recordar = {
  leer(clave) { try { return localStorage.getItem('ret.' + clave) || ''; } catch { return ''; } },
  guardar(clave, valor) { try { localStorage.setItem('ret.' + clave, valor); } catch { /* sin almacenamiento */ } },
};

// ── Comunicación con el servidor ──

class ErrorConexion extends Error { constructor() { super(MENSAJE_FALLA); } }

// En la versión de archivo único no hay servidor: las mismas rutas las atiende el motor local.
const LOCAL = Boolean(window.backendLocal);

async function apiLocal(ruta, metodo, cuerpo) {
  try {
    return await window.backendLocal.manejar(metodo, ruta, cuerpo ? JSON.parse(JSON.stringify(cuerpo)) : undefined);
  } catch (err) {
    if (err instanceof window.backendLocal.ErrorValidacion) {
      const e = new Error(err.message);
      e.validacion = true;
      throw e;
    }
    console.error(err);
    throw new ErrorConexion();
  }
}

async function api(ruta, { metodo = 'GET', cuerpo } = {}) {
  if (LOCAL) return apiLocal(ruta, metodo, cuerpo);
  let res;
  try {
    res = await fetch(ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ErrorConexion();
  }
  let datos = null;
  try { datos = await res.json(); } catch { /* respuesta no JSON */ }
  if (res.status >= 500 || datos === null) throw new ErrorConexion();
  if (!res.ok) {
    const e = new Error(datos.error || 'No se pudo completar la operación.');
    e.validacion = true;
    throw e;
  }
  return datos;
}

async function descargarArchivo(url, nombre) {
  let blob;
  if (LOCAL) {
    try { blob = await window.backendLocal.descargar(url); } catch (e) { console.error(e); throw new ErrorConexion(); }
  } else {
    let res;
    try { res = await fetch(url, { cache: 'no-store' }); } catch { throw new ErrorConexion(); }
    if (!res.ok) throw new ErrorConexion();
    blob = await res.blob();
  }
  guardarBlob(blob, nombre);
}

function guardarBlob(blob, nombre) {
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(blob);
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  setTimeout(() => { URL.revokeObjectURL(enlace.href); enlace.remove(); }, 1000);
}

// ── Avisos y fallas ──

let temporizadorAviso;
function aviso(texto) {
  const el = document.getElementById('aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { el.hidden = true; }, 3500);
}

function fallaPagina(reintentar) {
  $app.innerHTML = `
    <div class="falla" role="alert">
      <div class="icono" aria-hidden="true">!</div>
      <p>${MENSAJE_FALLA}</p>
      <button class="boton" type="button" id="reintentar">Reintentar</button>
    </div>`;
  document.getElementById('reintentar').addEventListener('click', reintentar);
}

function fallaEnLinea(contenedor, reintentar) {
  contenedor.innerHTML = `
    <div class="falla-en-linea" role="alert">
      <span>${MENSAJE_FALLA}</span>
      <button class="boton chico ambar" type="button">Reintentar</button>
    </div>`;
  contenedor.querySelector('button').addEventListener('click', reintentar);
}

// Ejecuta una carga parcial (p. ej. una tabla) y, si falla, muestra el aviso con Reintentar en su lugar.
async function cargarEn(contenedor, fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ErrorConexion || !e.validacion) fallaEnLinea(contenedor, () => cargarEn(contenedor, fn));
    else contenedor.innerHTML = `<div class="mensaje error">${esc(e.message)}</div>`;
  }
}

// Envío de formularios: valida, muestra errores claros y nunca pierde lo escrito.
function manejarEnvio(form, { enviar, alTerminar }) {
  const zona = form.querySelector('.zona-mensaje');
  const boton = form.querySelector('button[type="submit"]');
  const ejecutar = async () => {
    zona.innerHTML = '';
    boton.disabled = true;
    try {
      await enviar();
      await alTerminar();
    } catch (e) {
      if (e.validacion || e.local) zona.innerHTML = `<div class="mensaje error" role="alert">${esc(e.message)}</div>`;
      else fallaEnLinea(zona, ejecutar);
    } finally {
      boton.disabled = false;
    }
  };
  form.addEventListener('submit', (ev) => { ev.preventDefault(); ejecutar(); });
}

function errorLocal(mensaje) { const e = new Error(mensaje); e.local = true; return e; }

// ── Navegación ──

const estado = { mes: mesActual() };

const vistas = {
  panel: vistaPanel,
  retenciones: vistaRetenciones,
  descuentos: vistaDescuentos,
  reportes: vistaReportes,
  empresas: vistaEmpresas,
  colaboradores: vistaColaboradores,
  entidades: vistaEntidades,
  ...(LOCAL ? { respaldo: vistaRespaldo } : {}),
};

if (LOCAL) {
  const pastilla = document.createElement('a');
  pastilla.id = 'estado-nube';
  pastilla.className = 'estado-nube';
  pastilla.href = '#/respaldo';
  pastilla.hidden = true;
  document.querySelector('.barra-interior').appendChild(pastilla);
  const pintarNube = (n) => {
    pastilla.hidden = !n || n.estado === 'apagado';
    if (pastilla.hidden) return;
    pastilla.dataset.estado = n.estado;
    pastilla.textContent = n.estado === 'ok' ? '✓ En GitHub' : n.estado === 'subiendo' ? '↻ Guardando' : '⚠ Sin guardar';
    pastilla.title = n.mensaje || '';
  };
  window.addEventListener('nube-estado', (ev) => pintarNube(ev.detail));
  window.addEventListener('datos-actualizados', () => { aviso('Se cargaron los datos más nuevos desde GitHub.'); navegar(); });
  pintarNube(window.backendLocal.estadoNube());

  const salir = document.createElement('button');
  salir.type = 'button';
  salir.id = 'boton-salir';
  salir.className = 'boton-salir';
  salir.textContent = 'Salir';
  salir.addEventListener('click', cerrarSesion);
  document.querySelector('.barra-interior').appendChild(salir);

  // Se cierra sola la sesión después de 20 minutos sin usar el sistema.
  let ultimoUso = Date.now();
  ['click', 'keydown', 'mousemove', 'touchstart'].forEach((t) => window.addEventListener(t, () => { ultimoUso = Date.now(); }, { passive: true }));
  setInterval(() => {
    if (window.backendLocal.cuenta().desbloqueada && Date.now() - ultimoUso > 20 * 60 * 1000) cerrarSesion();
  }, 30 * 1000);

  const enlace = document.createElement('a');
  enlace.href = '#/respaldo';
  enlace.dataset.seccion = 'respaldo';
  enlace.textContent = 'Respaldo';
  document.getElementById('menu').appendChild(enlace);
}

let navegacionActual = 0;
async function navegar() {
  if (LOCAL) {
    const c = window.backendLocal.cuenta();
    document.body.classList.toggle('bloqueado', !c.desbloqueada);
    if (!c.desbloqueada) { pantallaAcceso(c); return; }
    document.getElementById('boton-salir').title = `Cerrar la sesión de ${c.usuario}`;
  }
  const [ruta, consulta = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const seccion = vistas[ruta] ? ruta : 'panel';
  document.querySelectorAll('.menu a').forEach((a) => a.classList.toggle('activo', a.dataset.seccion === seccion));
  document.getElementById('menu').classList.remove('abierto');
  const id = ++navegacionActual;
  $app.innerHTML = '<p class="cargando">Cargando…</p>';
  try {
    await vistas[seccion](new URLSearchParams(consulta), () => id === navegacionActual);
  } catch (e) {
    if (id === navegacionActual) fallaPagina(navegar);
    if (!(e instanceof ErrorConexion)) console.error(e);
  }
}

window.addEventListener('hashchange', navegar);
document.querySelector('.menu-boton').addEventListener('click', (ev) => {
  const menu = document.getElementById('menu');
  const abierto = menu.classList.toggle('abierto');
  ev.currentTarget.setAttribute('aria-expanded', String(abierto));
});

// ── Panel ──

async function vistaPanel(_params, vigente) {
  const d = await api(`/api/panel?periodo=${estado.mes}`);
  if (!vigente()) return;
  const avance = d.pactado ? Math.round((d.retenido / d.pactado) * 100) : 0;
  $app.innerHTML = `
    <section class="panel-cabecera">
      <div>
        <h1>Panel de retenciones</h1>
        <p>${esc(nombreMes(d.periodo))} · ${d.ordenes} ${d.ordenes === 1 ? 'orden' : 'órdenes'}, ${d.completas} ${d.completas === 1 ? 'completa' : 'completas'}</p>
      </div>
      <div class="campo">
        <label for="panel-mes">Mes</label>
        <input type="month" id="panel-mes" value="${esc(d.periodo)}" required>
      </div>
    </section>

    ${await avisoRespaldo()}
    <section class="indicadores" aria-label="Resumen del mes">
      <div class="indicador ordenes"><div class="titulo">Órdenes</div><div class="valor">${d.ordenes}</div><div class="detalle">${d.completas} ${d.completas === 1 ? 'completa' : 'completas'}${d.sinTope ? ` · ${d.sinTope} por porcentaje` : ''}${d.aDefinir ? ` · ${d.aDefinir} a definir` : ''}</div></div>
      <div class="indicador pactado"><div class="titulo">Total pactado</div><div class="valor">${moneda(d.pactado)}</div><div class="detalle">${d.arrastradas ? `Incluye ${moneda(d.saldoAnterior)} que vienen de meses anteriores` : 'Suma de las retenciones del mes'}</div></div>
      <div class="indicador retenido"><div class="titulo">Total retenido</div><div class="valor">${moneda(d.retenido)}</div>
        <div class="avance-general" title="${avance}% retenido"><span style="width:${Math.min(avance, 100)}%"></span></div></div>
      <div class="indicador disponible"><div class="titulo">Disponible</div><div class="valor">${moneda(d.disponible)}</div><div class="detalle">Falta descontar${d.sinTope ? ' (sin contar las de porcentaje)' : ''}</div></div>
    </section>

    <div class="encabezado"><h2>Órdenes de ${esc(nombreMes(d.periodo).toLowerCase())}</h2>
      <a class="boton secundario" href="#/retenciones">+ Cargar retención</a></div>
    ${d.retenciones.length ? `<div class="ordenes">${d.retenciones.map(tarjetaOrden).join('')}</div>`
      : `<div class="tarjeta vacio">No hay retenciones cargadas para este mes.</div>`}`;

  conectarDefinirImporte($app, navegar);
  document.getElementById('panel-mes').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    estado.mes = ev.target.value;
    navegar();
  });
}

function tarjetaOrden(r) {
  if (r.sin_tope) return tarjetaPorcentaje(r);
  if (r.a_definir) return tarjetaADefinir(r);
  const pct = Math.min(100, Math.round((r.descontado_real / r.importe_total) * 100));
  return `
    <article class="orden ${esc(r.tipo)} ${r.completa ? 'es-completa' : ''}">
      <div class="orden-cabecera">
        <div class="orden-persona">${esc(r.colaborador)}
          <span class="sec">CI ${esc(cedula(r.cedula))} · ${esc(r.entidad)}</span>
          ${r.concepto ? `<span class="sec">${esc(r.concepto)}</span>` : ''}
          ${r.beneficiario ? `<span class="sec">Beneficiario: ${esc(r.beneficiario)}</span>` : ''}
          ${r.regla && !r.a_definir ? `<span class="sec">Retener ${etiquetaRegla(r)}</span>` : ''}
        </div>
        <div class="orden-etiquetas">${etiquetaTipo(r.tipo)}${r.repite ? '<span class="etiqueta-tipo mensual">Mensual</span>' : ''}${r.arrastre ? `<span class="etiqueta-tipo arrastre">Viene de ${esc(mesCorto(r.periodo))}</span>` : ''}${r.completa ? '<span class="etiqueta-tipo completa">Completa</span>' : ''}</div>
      </div>
      <div class="barra-avance" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Avance ${pct}%"><span style="width:${pct}%"></span></div>
      <div class="orden-cifras">
        <span>Retenido <strong>${moneda(r.descontado_real)}</strong> de <strong>${moneda(r.importe_total)}</strong> (${pct}%)</span>
        ${r.completa ? '' : `<span class="falta">Falta <strong>${moneda(r.pendiente)}</strong></span>`}
      </div>
      ${r.completa ? '' : `<div><a class="boton chico secundario" href="#/descuentos?retencion=${r.id}">Registrar descuento</a></div>`}
    </article>`;
}

// Retenciones a las que se les puede cargar un descuento: con saldo, o por porcentaje del mes actual o el anterior.
function abierta(r) {
  if (r.sin_tope) return r.periodo >= mesAnterior();
  return r.pendiente > 0;
}
function mesAnterior() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function textoPct(r) {
  return `${String(r.porcentaje).replace('.', ',')}% del ${r.base === 'liquido' ? 'líquido' : r.base === 'nominal' ? 'nominal' : '?'}`;
}

// "20% del NOMINAL", bien visible; otras reglas (BPC) como texto.
function etiquetaRegla(r) {
  if (r.porcentaje != null) {
    const pct = String(r.porcentaje).replace('.', ',');
    if (!r.base) return `<span class="etiqueta-pct">${esc(pct)}% · ¿nominal o líquido?</span>`;
    return `<span class="etiqueta-pct ${r.base}">${esc(pct)}% del ${r.base === 'nominal' ? 'NOMINAL' : 'LÍQUIDO'}</span>`;
  }
  return r.regla ? `<span class="etiqueta-regla">${esc(r.regla)}</span>` : '';
}

// Orden por porcentaje: no tiene tope; se carga lo que se logró descontar en cada empresa.
function tarjetaPorcentaje(r) {
  return `
    <article class="orden ${esc(r.tipo)}">
      <div class="orden-cabecera">
        <div class="orden-persona">${esc(r.colaborador)}
          <span class="sec">CI ${esc(cedula(r.cedula))} · ${esc(r.entidad)}</span>
          ${r.concepto ? `<span class="sec">${esc(r.concepto)}</span>` : ''}
          ${r.beneficiario ? `<span class="sec">Beneficiario: ${esc(r.beneficiario)}</span>` : ''}
        </div>
        <div class="orden-etiquetas">${etiquetaTipo(r.tipo)}${r.repite ? '<span class="etiqueta-tipo mensual">Mensual</span>' : ''}</div>
      </div>
      <div class="orden-cifras"><span>Retener ${etiquetaRegla(r)}</span></div>
      <div class="orden-cifras"><span>Descontado <strong>${moneda(r.descontado_real)}</strong>${r.cantidad_descuentos ? ` en ${r.cantidad_descuentos} ${r.cantidad_descuentos === 1 ? 'descuento' : 'descuentos'}${r.empresas ? ` (${esc(r.empresas)})` : ''}` : ''}</span></div>
      <div><a class="boton chico secundario" href="#/descuentos?retencion=${r.id}">Registrar descuento</a></div>
    </article>`;
}

// Orden con otra regla (BPC, etc.) a la que todavía le falta el importe.
function tarjetaADefinir(r) {
  return `
    <article class="orden ${esc(r.tipo)}">
      <div class="orden-cabecera">
        <div class="orden-persona">${esc(r.colaborador)}
          <span class="sec">CI ${esc(cedula(r.cedula))} · ${esc(r.entidad)}</span>
          ${r.concepto ? `<span class="sec">${esc(r.concepto)}</span>` : ''}
          ${r.beneficiario ? `<span class="sec">Beneficiario: ${esc(r.beneficiario)}</span>` : ''}
          ${r.regla && !r.a_definir ? `<span class="sec">Retener ${etiquetaRegla(r)}</span>` : ''}
        </div>
        <div class="orden-etiquetas">${etiquetaTipo(r.tipo)}${r.repite ? '<span class="etiqueta-tipo mensual">Mensual</span>' : ''}${r.arrastre ? `<span class="etiqueta-tipo arrastre">Viene de ${esc(mesCorto(r.periodo))}</span>` : ''}<span class="etiqueta-tipo a-definir">A definir</span></div>
      </div>
      <div class="orden-cifras"><span>Retener ${etiquetaRegla(r)}</span><span class="sec">Importe a definir</span></div>
      <div><button class="boton chico ambar" type="button" ${atributosDefinir(r)}>Definir importe</button></div>
    </article>`;
}

function atributosDefinir(r) {
  return `data-definir="${r.id}" data-regla="${esc(r.regla)}" data-pct="${r.porcentaje ?? ''}" data-base="${r.base || ''}" data-persona="${esc(r.colaborador)}"`;
}

// Pide el importe de una retención "a definir" (si es porcentaje, lo calcula desde el sueldo) y lo guarda.
function conectarDefinirImporte(raiz, alTerminar) {
  raiz.querySelectorAll('[data-definir]').forEach((b) => b.addEventListener('click', () => {
    const pct = b.dataset.pct ? Number(b.dataset.pct) : null;
    const base = b.dataset.base;
    const dlg = document.createElement('dialog');
    dlg.className = 'dialogo';
    dlg.innerHTML = `<form method="dialog" class="formulario" novalidate>
      <h2>Definir importe</h2>
      <p>${esc(b.dataset.persona)}<br>Retener ${pct != null ? `<span class="etiqueta-pct ${esc(base)}">${esc(String(pct).replace('.', ','))}% del ${base === 'liquido' ? 'LÍQUIDO' : base === 'nominal' ? 'NOMINAL' : '¿nominal o líquido?'}</span>` : `<strong>${esc(b.dataset.regla)}</strong>`}</p>
      ${pct != null ? `<div class="campo"><label for="dl-sueldo">Sueldo ${base === 'liquido' ? 'líquido' : 'nominal'} del mes</label><input id="dl-sueldo" inputmode="decimal" autocomplete="off" placeholder="Ej.: 45.000"><span class="ayuda">Opcional: si lo ponés, calculo el importe.</span></div>` : ''}
      <div class="campo"><label for="dl-importe">Importe a retener</label><input id="dl-importe" inputmode="decimal" autocomplete="off" placeholder="Ej.: 4.500,50"></div>
      <div class="zona-mensaje"></div>
      <div class="acciones"><button class="boton" value="ok" id="dl-guardar">Guardar</button><button class="boton secundario" value="cancelar" formnovalidate>Cancelar</button></div>
    </form>`;
    document.body.appendChild(dlg);
    const inSueldo = dlg.querySelector('#dl-sueldo');
    const inImp = dlg.querySelector('#dl-importe');
    if (inSueldo) inSueldo.addEventListener('input', () => {
      const v = leerImporte(inSueldo.value);
      inImp.value = v > 0 ? numeroPlano(Math.round((v * pct) / 100)) : '';
    });
    dlg.querySelector('#dl-guardar').addEventListener('click', async (ev) => {
      ev.preventDefault();
      const importe = leerImporte(inImp.value);
      const zona = dlg.querySelector('.zona-mensaje');
      if (!(importe > 0)) { zona.innerHTML = '<div class="mensaje error">Importe no válido. Ej.: 4.500 o 4.500,50</div>'; return; }
      try {
        await api(`/api/retenciones/${b.dataset.definir}/importe`, { metodo: 'POST', cuerpo: { importe_total: importe } });
        dlg.close(); aviso('Importe guardado.'); alTerminar();
      } catch (e) { zona.innerHTML = `<div class="mensaje error">${esc(e.validacion ? e.message : MENSAJE_FALLA)}</div>`; }
    });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    (inSueldo || inImp).focus();
  }));
}

// ── Retenciones recibidas ──

const filtrosRet = { periodo: '', tipo: '', q: '' };

async function vistaRetenciones(_params, vigente) {
  const cat = await api('/api/catalogos');
  if (!vigente()) return;
  $app.innerHTML = `
    <div class="encabezado"><div><h1>Retenciones recibidas</h1><p>Órdenes judiciales y comerciales que llegan para descontar a los colaboradores.</p></div></div>
    <div class="columnas">
      <section class="tarjeta">
        <h2>Cargar retención</h2>
        ${!cat.colaboradores.length || !cat.entidades.length
          ? `<p class="mensaje error">Primero cargá ${!cat.colaboradores.length ? '<a href="#/colaboradores">colaboradores</a>' : ''}${!cat.colaboradores.length && !cat.entidades.length ? ' y ' : ''}${!cat.entidades.length ? '<a href="#/entidades">entidades</a>' : ''}.</p>` : ''}
        <form class="formulario" id="form-ret" novalidate>
          <div class="campo"><label for="r-colab">Colaborador <span class="obligatorio">*</span></label>
            <select id="r-colab" required><option value="">Elegí…</option>
              ${cat.colaboradores.map((c) => `<option value="${c.id}">${esc(c.nombre)} · CI ${esc(cedula(c.cedula))}</option>`).join('')}
            </select></div>
          <div class="campo"><label for="r-ent">Entidad acreedora <span class="obligatorio">*</span></label>
            <select id="r-ent" required><option value="">Elegí…</option>
              ${cat.entidades.map((e) => `<option value="${e.id}" data-tipo="${e.tipo}">${esc(e.nombre)} (${tipoTxt[e.tipo]})</option>`).join('')}
            </select></div>
          <div class="fila">
            <div class="campo"><label for="r-periodo">Período <span class="obligatorio">*</span></label>
              <input type="month" id="r-periodo" value="${mesActual()}" required></div>
            <div class="campo"><label for="r-calculo">Cómo se calcula <span class="obligatorio">*</span></label>
              <select id="r-calculo"><option value="fijo">Importe fijo</option><option value="porcentaje">Porcentaje del sueldo</option><option value="otra">Otra regla (BPC, etc.)</option></select></div>
          </div>
          <div class="fila" id="campos-pct" hidden>
            <div class="campo"><label for="r-pct">Porcentaje a retener <span class="obligatorio">*</span></label>
              <input id="r-pct" inputmode="decimal" placeholder="20" autocomplete="off"></div>
            <div class="campo"><label for="r-base">Sobre el sueldo <span class="obligatorio">*</span></label>
              <select id="r-base"><option value="">Elegí…</option><option value="Nominal">Nominal</option><option value="Líquido">Líquido</option></select></div>
          </div>
          <div class="campo" id="campo-regla" hidden><label for="r-regla">Regla <span class="obligatorio">*</span></label>
            <input id="r-regla" maxlength="60" placeholder="Ej.: 1,5 BPC"></div>
          <div class="campo"><label for="r-importe">Importe total <span class="obligatorio" id="importe-obligatorio">*</span></label>
            <input id="r-importe" inputmode="decimal" placeholder="2.000,00" autocomplete="off">
            <span class="ayuda" id="importe-ayuda" hidden>Si todavía no sabés el importe, dejalo vacío: la retención queda “a definir”.</span></div>
          <div class="fila">
            <div class="campo"><label class="check"><input type="checkbox" id="r-mensual"> Se repite todos los meses</label>
              <span class="ayuda">Se crea sola cada mes hasta que le des de baja. Si es por porcentaje, se crea cada mes con el mismo porcentaje.</span></div>
            <div class="campo" id="campo-hasta" hidden><label for="r-hasta">Hasta (opcional)</label><input type="month" id="r-hasta"></div>
          </div>
          <div class="campo"><label for="r-concepto">Concepto</label><input id="r-concepto" maxlength="200" placeholder="Ej.: Pensión alimenticia, cuota crédito"></div>
          <div class="campo"><label for="r-exp">N° de expediente / Juzgado</label><input id="r-exp" maxlength="200"></div>
          <div class="campo" id="campo-benef" hidden><label for="r-benef">Beneficiario <span class="obligatorio">*</span></label>
            <input id="r-benef" maxlength="200" placeholder="A quién se le abona"><span class="ayuda">Obligatorio en retenciones judiciales.</span></div>
          <div class="campo"><label for="r-cargo">Cargada por <span class="obligatorio">*</span></label>
            <input id="r-cargo" maxlength="80" value="${esc(recordar.leer('cargo') || usuarioSesion())}" required></div>
          <div class="zona-mensaje"></div>
          <div class="acciones"><button class="boton" type="submit">Guardar retención</button></div>
        </form>
      </section>

      <section class="tarjeta">
        <h2>Listado</h2>
        <div class="filtros">
          <div class="campo"><label for="f-periodo">Período</label><input type="month" id="f-periodo" value="${esc(filtrosRet.periodo)}"></div>
          <div class="campo"><label for="f-tipo">Tipo</label><select id="f-tipo">
            <option value="">Todas</option><option value="judicial">Judicial</option><option value="comercial">Comercial</option></select></div>
          <div class="campo ancho"><label for="f-q">Buscar</label><input id="f-q" type="search" placeholder="Nombre, CI, entidad, concepto, beneficiario" value="${esc(filtrosRet.q)}"></div>
        </div>
        <div id="lista-ret"><p class="cargando">Cargando…</p></div>
      </section>
    </div>`;

  document.getElementById('f-tipo').value = filtrosRet.tipo;
  const selEnt = document.getElementById('r-ent');
  const campoBenef = document.getElementById('campo-benef');
  const esJudicial = () => selEnt.selectedOptions[0]?.dataset.tipo === 'judicial';
  selEnt.addEventListener('change', () => { campoBenef.hidden = !esJudicial(); });
  const selCalculo = document.getElementById('r-calculo');
  const mostrarCalculo = () => {
    const c = selCalculo.value;
    document.getElementById('campos-pct').hidden = c !== 'porcentaje';
    document.getElementById('campo-regla').hidden = c !== 'otra';
    document.getElementById('importe-obligatorio').hidden = c !== 'fijo';
    document.getElementById('importe-ayuda').hidden = c === 'fijo';
  };
  selCalculo.addEventListener('change', mostrarCalculo);
  const chkMensual = document.getElementById('r-mensual');
  chkMensual.addEventListener('change', () => { document.getElementById('campo-hasta').hidden = !chkMensual.checked; });

  const lista = document.getElementById('lista-ret');
  const recargar = () => cargarEn(lista, async () => {
    const qs = new URLSearchParams(Object.entries(filtrosRet).filter(([, v]) => v));
    const filas = await api(`/api/retenciones?${qs}`);
    lista.innerHTML = tablaRetenciones(filas);
    conectarDefinirImporte(lista, recargar);
    lista.querySelectorAll('[data-baja]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Dejar de repetir esta retención? Desde el mes que viene no se crea más. Lo ya cargado queda igual.')) return;
      try { await api(`/api/retenciones/${b.dataset.baja}/baja`, { metodo: 'POST', cuerpo: {} }); aviso('Listo: no se repite más desde el mes que viene.'); recargar(); }
      catch (e) { if (e.validacion) aviso(e.message); else fallaEnLinea(lista, recargar); }
    }));
    lista.querySelectorAll('[data-eliminar]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta retención? No tiene descuentos aplicados.')) return;
      try { await api(`/api/retenciones/${b.dataset.eliminar}`, { metodo: 'DELETE' }); aviso('Retención eliminada.'); recargar(); }
      catch (e) { if (e.validacion) aviso(e.message); else fallaEnLinea(lista, recargar); }
    }));
  });
  conectarFiltros({ periodo: 'f-periodo', tipo: 'f-tipo', q: 'f-q' }, filtrosRet, recargar);
  recargar();

  const form = document.getElementById('form-ret');
  manejarEnvio(form, {
    enviar: async () => {
      const textoImporte = form.querySelector('#r-importe').value.trim();
      const importe = textoImporte ? leerImporte(textoImporte) : null;
      const calculo = selCalculo.value;
      const pct = Number(form.querySelector('#r-pct').value.trim().replace(',', '.'));
      const base = form.querySelector('#r-base').value;
      if (calculo === 'porcentaje' && !(pct > 0 && pct <= 100)) throw errorLocal('Ingresá el porcentaje a retener, por ejemplo 20.');
      if (calculo === 'porcentaje' && !base) throw errorLocal('Indicá si el porcentaje es sobre el sueldo nominal o el líquido.');
      const regla = calculo === 'porcentaje' ? `${String(pct).replace('.', ',')}% ${base}` : calculo === 'otra' ? form.querySelector('#r-regla').value.trim() : '';
      if (calculo === 'otra' && !regla) throw errorLocal('Escribí la regla, por ejemplo "1,5 BPC".');
      if (!form.querySelector('#r-colab').value) throw errorLocal('Elegí el colaborador.');
      if (!selEnt.value) throw errorLocal('Elegí la entidad acreedora.');
      if (!form.querySelector('#r-periodo').value) throw errorLocal('Elegí el período.');
      if (importe == null && !regla) throw errorLocal('Ingresá el importe total.');
      if (importe != null && !(importe > 0)) throw errorLocal('Ingresá un importe total válido, por ejemplo 2.000 o 2.000,50.');
      if (esJudicial() && !form.querySelector('#r-benef').value.trim()) throw errorLocal('El beneficiario es obligatorio en las retenciones judiciales.');
      if (!form.querySelector('#r-cargo').value.trim()) throw errorLocal('Indicá quién carga la retención.');
      await api('/api/retenciones', { metodo: 'POST', cuerpo: {
        colaborador_id: Number(form.querySelector('#r-colab').value),
        entidad_id: Number(selEnt.value),
        periodo: form.querySelector('#r-periodo').value,
        importe_total: importe,
        regla,
        mensual: chkMensual.checked,
        hasta: chkMensual.checked ? form.querySelector('#r-hasta').value : '',
        concepto: form.querySelector('#r-concepto').value,
        expediente: form.querySelector('#r-exp').value,
        beneficiario: esJudicial() ? form.querySelector('#r-benef').value : null,
        cargado_por: form.querySelector('#r-cargo').value,
      } });
      recordar.guardar('cargo', form.querySelector('#r-cargo').value.trim());
    },
    alTerminar: async () => {
      aviso('Retención guardada.');
      ['#r-importe', '#r-regla', '#r-pct', '#r-base', '#r-concepto', '#r-exp', '#r-benef', '#r-hasta'].forEach((s) => { form.querySelector(s).value = ''; });
      selCalculo.value = 'fijo'; mostrarCalculo();
      chkMensual.checked = false; document.getElementById('campo-hasta').hidden = true;
      form.querySelector('#r-colab').focus();
      recargar();
    },
  });
}

function tablaRetenciones(filas) {
  if (!filas.length) return '<div class="tabla-contenedor"><p class="vacio">No hay retenciones con estos filtros.</p></div>';
  const suma = (k) => filas.reduce((a, x) => a + (x[k] || 0), 0);
  return `<div class="tabla-contenedor"><table>
    <thead><tr><th>Período</th><th>Colaborador</th><th>Entidad</th><th>Concepto / Expediente</th><th>Beneficiario</th>
      <th class="num">Total</th><th class="num">Descontado</th><th class="num">Falta descontar</th><th>Cargó</th><th></th></tr></thead>
    <tbody>${filas.map((r) => `<tr>
      <td>${esc(mesCorto(r.periodo))}</td>
      <td>${esc(r.colaborador)}<span class="sec">CI ${esc(cedula(r.cedula))}</span></td>
      <td>${esc(r.entidad)}<span class="sec">${etiquetaTipo(r.tipo)}${r.repite ? ' <span class="etiqueta-tipo mensual">Mensual</span>' : ''}</span></td>
      <td>${esc(r.concepto) || '—'}${r.expediente ? `<span class="sec">${esc(r.expediente)}</span>` : ''}</td>
      <td>${r.tipo === 'judicial' ? esc(r.beneficiario) : '<span class="sec">—</span>'}</td>
      <td class="num">${celdaTotal(r)}</td>
      <td class="num">${moneda(r.descontado)}</td>
      <td class="num">${celdaFalta(r)}</td>
      <td>${esc(r.cargado_por)}<span class="sec">${fecha(r.creado_en)}</span></td>
      <td>${r.cantidad_descuentos === 0 ? `<button class="boton chico peligro" type="button" data-eliminar="${r.id}">Eliminar</button>`
        : (r.completa || r.a_definir ? '' : `<a class="boton chico secundario" href="#/descuentos?retencion=${r.id}">Descontar</a>`)}
        ${r.a_definir ? `<button class="boton chico ambar" type="button" ${atributosDefinir(r)}>Definir importe</button>` : ''}
        ${r.repite ? `<button class="boton chico secundario" type="button" data-baja="${r.id}" title="Dejar de repetir cada mes">Dar de baja</button>` : ''}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="5">Total (${filas.length})</td><td class="num">${moneda(suma('importe_total'))}</td>
      <td class="num">${moneda(suma('descontado'))}</td><td class="num">${moneda(suma('pendiente'))}</td><td colspan="2"></td></tr></tfoot>
  </table></div>`;
}

function celdaTotal(r) {
  if (r.sin_tope) return `${etiquetaRegla(r)}<span class="sec">sin tope</span>`;
  if (r.a_definir) return `<span class="etiqueta-tipo a-definir">A definir</span><span class="sec">${etiquetaRegla(r)}</span>`;
  return `${moneda(r.importe_total)}${r.regla ? `<span class="sec">${etiquetaRegla(r)}</span>` : ''}`;
}
function celdaFalta(r) {
  if (r.a_definir || r.sin_tope) return '<span class="sec">—</span>';
  return r.completa ? '<span class="etiqueta-tipo completa">Completa</span>' : moneda(r.pendiente);
}

// Vincula inputs de filtro a un objeto de estado y recarga con una pequeña espera al escribir.
function conectarFiltros(mapa, destino, recargar) {
  let espera;
  for (const [clave, id] of Object.entries(mapa)) {
    const el = document.getElementById(id);
    const actualizar = () => { destino[clave] = el.value.trim(); clearTimeout(espera); espera = setTimeout(recargar, el.type === 'search' ? 250 : 0); };
    el.addEventListener(el.type === 'search' ? 'input' : 'change', actualizar);
  }
}

// ── Descuentos ──

const filtrosDesc = { mes: '', tipo_descuento: '', empresa_id: '', q: '' };

async function vistaDescuentos(params, vigente) {
  const [cat, rets] = await Promise.all([api('/api/catalogos'), api('/api/retenciones')]);
  if (!vigente()) return;
  let retenciones = rets;
  const preRet = retenciones.find((r) => String(r.id) === params.get('retencion'));

  $app.innerHTML = `
    <div class="encabezado"><div><h1>Descuentos</h1><p>Lo que efectivamente se le descontó a cada colaborador. Nunca puede superar el total de la retención.</p></div></div>
    <div class="columnas">
      <section class="tarjeta">
        <h2>Registrar descuento</h2>
        <form class="formulario" id="form-desc" novalidate>
          <div class="campo"><label for="d-colab">Persona <span class="obligatorio">*</span></label>
            <select id="d-colab" required><option value="">Elegí…</option></select></div>
          <div class="campo"><label for="d-ret">Retención <span class="obligatorio">*</span></label>
            <select id="d-ret" required disabled><option value="">Elegí primero la persona</option></select>
            <span class="ayuda" id="d-ret-ayuda"></span></div>
          <div class="fila">
            <div class="campo"><label for="d-importe">Importe <span class="obligatorio">*</span></label>
              <input id="d-importe" inputmode="decimal" placeholder="0,00" autocomplete="off" required>
              <span class="error-campo" id="d-importe-error" hidden></span></div>
            <div class="campo"><label for="d-tipo">Tipo <span class="obligatorio">*</span></label>
              <select id="d-tipo" required><option value="">Elegí…</option>${cat.tiposDescuento.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
          </div>
          <div class="campo"><label for="d-empresa">Empresa donde se retuvo <span class="obligatorio">*</span></label>
            <select id="d-empresa" required><option value="">Elegí…</option>
              ${cat.empresas.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}</select></div>
          <div class="fila">
            <div class="campo"><label for="d-quien">Descontado por <span class="obligatorio">*</span></label>
              <input id="d-quien" maxlength="80" value="${esc(recordar.leer('quien') || usuarioSesion())}" required></div>
            <div class="campo"><label for="d-fecha">Fecha <span class="obligatorio">*</span></label>
              <input type="date" id="d-fecha" value="${hoy()}" required></div>
          </div>
          <div class="zona-mensaje"></div>
          <div class="acciones"><button class="boton" type="submit">Registrar descuento</button></div>
        </form>
      </section>

      <section class="tarjeta">
        <h2>Histórico de descuentos</h2>
        <div class="filtros">
          <div class="campo"><label for="h-mes">Mes del descuento</label><input type="month" id="h-mes" value="${esc(filtrosDesc.mes)}"></div>
          <div class="campo"><label for="h-tipo">Tipo</label><select id="h-tipo"><option value="">Todos</option>${cat.tiposDescuento.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
          <div class="campo"><label for="h-empresa">Empresa</label><select id="h-empresa"><option value="">Todas</option>${cat.empresas.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}</select></div>
          <div class="campo ancho"><label for="h-q">Buscar</label><input id="h-q" type="search" placeholder="Nombre, CI, entidad, concepto" value="${esc(filtrosDesc.q)}"></div>
        </div>
        <div id="lista-desc"><p class="cargando">Cargando…</p></div>
      </section>
    </div>`;

  document.getElementById('h-tipo').value = filtrosDesc.tipo_descuento;
  document.getElementById('h-empresa').value = filtrosDesc.empresa_id;

  const form = document.getElementById('form-desc');
  const selColab = form.querySelector('#d-colab');
  const selRet = form.querySelector('#d-ret');
  const ayudaRet = form.querySelector('#d-ret-ayuda');
  const inImporte = form.querySelector('#d-importe');
  const errImporte = form.querySelector('#d-importe-error');
  const botonGuardar = form.querySelector('button[type="submit"]');

  const retElegida = () => retenciones.find((r) => String(r.id) === selRet.value);

  function llenarPersonas() {
    const actual = selColab.value;
    const conPendientes = new Set(retenciones.filter(abierta).map((r) => r.colaborador_id));
    const personas = cat.colaboradores.filter((c) => conPendientes.has(c.id));
    selColab.innerHTML = `<option value="">${personas.length ? 'Elegí…' : 'No hay retenciones pendientes'}</option>` +
      personas.map((c) => `<option value="${c.id}">${esc(c.nombre)} · CI ${esc(cedula(c.cedula))}</option>`).join('');
    if (personas.some((c) => String(c.id) === actual)) selColab.value = actual;
  }

  function llenarRetenciones(preferida) {
    const propias = retenciones.filter((r) => String(r.colaborador_id) === selColab.value && abierta(r));
    selRet.disabled = !propias.length;
    selRet.innerHTML = propias.length
      ? (propias.length > 1 ? '<option value="">Elegí…</option>' : '') + propias.map((r) =>
        `<option value="${r.id}">${esc(r.entidad)} · ${esc(mesCorto(r.periodo))}${r.concepto ? ' · ' + esc(r.concepto) : ''} — ${r.sin_tope ? `${esc(textoPct(r))}, sin tope` : `falta ${moneda(r.pendiente)}`}</option>`).join('')
      : `<option value="">${selColab.value ? 'Sin retenciones pendientes' : 'Elegí primero la persona'}</option>`;
    if (preferida && propias.some((r) => r.id === preferida)) selRet.value = String(preferida);
    actualizarAyuda();
  }

  function actualizarAyuda() {
    const r = retElegida();
    ayudaRet.innerHTML = r && r.sin_tope
      ? `Retener ${etiquetaRegla(r)} · Ingresá lo que se logró descontar en esta empresa. Ya descontado: <strong>${moneda(r.descontado_real)}</strong>${r.empresas ? ` (${esc(r.empresas)})` : ''}.`
      : r
      ? `Total ${moneda(r.importe_total)} · descontado ${moneda(r.descontado_real)} · <strong>máximo a descontar ${moneda(r.pendiente)}</strong>
         <button type="button" class="boton chico secundario" id="usar-saldo" style="margin-left:6px">Usar saldo</button>`
      : '';
    const usar = document.getElementById('usar-saldo');
    if (usar) usar.addEventListener('click', () => { inImporte.value = numeroPlano(r.pendiente); validarImporte(); });
    validarImporte();
  }

  // Control en pantalla de la regla de tope (la base también lo controla).
  function validarImporte() {
    const r = retElegida();
    const texto = inImporte.value.trim();
    const valor = leerImporte(texto);
    let msg = '';
    if (texto && !(valor > 0)) msg = 'Importe no válido. Ej.: 1.500 o 1.500,50';
    else if (r && !r.sin_tope && valor > r.pendiente) msg = `Supera lo que falta descontar (${moneda(r.pendiente)}).`;
    errImporte.textContent = msg;
    errImporte.hidden = !msg;
    inImporte.setAttribute('aria-invalid', msg ? 'true' : 'false');
    botonGuardar.disabled = Boolean(msg);
    return !msg;
  }

  selColab.addEventListener('change', () => llenarRetenciones());
  selRet.addEventListener('change', actualizarAyuda);
  inImporte.addEventListener('input', validarImporte);

  llenarPersonas();
  if (preRet && abierta(preRet)) {
    selColab.value = String(preRet.colaborador_id);
    llenarRetenciones(preRet.id);
    inImporte.focus();
  } else llenarRetenciones();

  const lista = document.getElementById('lista-desc');
  const recargarLista = () => cargarEn(lista, async () => {
    const qs = new URLSearchParams(Object.entries(filtrosDesc).filter(([, v]) => v));
    const filas = await api(`/api/descuentos?${qs}`);
    lista.innerHTML = tablaDescuentos(filas);
    lista.querySelectorAll('[data-eliminar]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este descuento? El importe vuelve a quedar pendiente en la retención.')) return;
      try {
        await api(`/api/descuentos/${b.dataset.eliminar}`, { metodo: 'DELETE' });
        aviso('Descuento eliminado.');
        await refrescarRetenciones();
        recargarLista();
      } catch (e) { if (e.validacion) aviso(e.message); else fallaEnLinea(lista, recargarLista); }
    }));
  });

  async function refrescarRetenciones() {
    retenciones = await api('/api/retenciones');
    const elegida = selRet.value ? Number(selRet.value) : null;
    llenarPersonas();
    llenarRetenciones(elegida);
  }

  conectarFiltros({ mes: 'h-mes', tipo_descuento: 'h-tipo', empresa_id: 'h-empresa', q: 'h-q' }, filtrosDesc, recargarLista);
  recargarLista();

  manejarEnvio(form, {
    enviar: async () => {
      const r = retElegida();
      const importe = leerImporte(inImporte.value);
      if (!r) throw errorLocal('Elegí la persona y la retención.');
      if (!(importe > 0)) throw errorLocal('Ingresá un importe válido mayor a cero.');
      if (!r.sin_tope && importe > r.pendiente) throw errorLocal(`No se puede descontar más de lo que falta (${moneda(r.pendiente)}).`);
      if (!form.querySelector('#d-tipo').value) throw errorLocal('Elegí el tipo de descuento.');
      if (!form.querySelector('#d-empresa').value) throw errorLocal('Elegí la empresa donde se retuvo.');
      if (!form.querySelector('#d-quien').value.trim()) throw errorLocal('Indicá quién hizo el descuento.');
      if (!form.querySelector('#d-fecha').value) throw errorLocal('Indicá la fecha.');
      await api('/api/descuentos', { metodo: 'POST', cuerpo: {
        retencion_id: r.id,
        importe,
        tipo: form.querySelector('#d-tipo').value,
        empresa_id: Number(form.querySelector('#d-empresa').value),
        descontado_por: form.querySelector('#d-quien').value,
        fecha: form.querySelector('#d-fecha').value,
      } });
      recordar.guardar('quien', form.querySelector('#d-quien').value.trim());
    },
    alTerminar: async () => {
      aviso('Descuento registrado.');
      inImporte.value = '';
      await refrescarRetenciones().catch(() => {});
      recargarLista();
    },
  });
}

function tablaDescuentos(filas) {
  if (!filas.length) return '<div class="tabla-contenedor"><p class="vacio">No hay descuentos con estos filtros.</p></div>';
  const total = filas.reduce((a, x) => a + x.importe, 0);
  return `<div class="tabla-contenedor"><table>
    <thead><tr><th>Fecha</th><th>Colaborador</th><th>Retención</th><th>Tipo</th><th>Empresa</th>
      <th class="num">Importe</th><th class="num">Saldo luego</th><th class="num">Saldo pendiente</th><th>Descontó</th><th></th></tr></thead>
    <tbody>${filas.map((d) => `<tr>
      <td>${fecha(d.fecha)}</td>
      <td>${esc(d.colaborador)}<span class="sec">CI ${esc(cedula(d.cedula))}</span></td>
      <td>${esc(d.entidad)} · ${esc(mesCorto(d.periodo))}<span class="sec">${esc(d.concepto)}${d.beneficiario ? ' · ' + esc(d.beneficiario) : ''}</span></td>
      <td>${esc(d.tipo)}</td>
      <td>${esc(d.empresa)}</td>
      <td class="num">${moneda(d.importe)}</td>
      <td class="num">${d.saldo_despues == null ? '<span class="sec">sin tope</span>' : moneda(d.saldo_despues)}</td>
      <td class="num">${d.saldo_actual == null ? '<span class="sec">—</span>' : d.saldo_actual <= 0 ? '<span class="etiqueta-tipo completa">Completa</span>' : moneda(d.saldo_actual)}</td>
      <td>${esc(d.descontado_por)}</td>
      <td><button class="boton chico peligro" type="button" data-eliminar="${d.id}" title="Eliminar descuento">Eliminar</button></td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="5">Total descontado (${filas.length})</td><td class="num">${moneda(total)}</td><td colspan="4"></td></tr></tfoot>
  </table></div>`;
}

// ── Reportes ──

const filtrosRep = { periodo: '', q: '', tipo: '', tipo_descuento: '', empresa_id: '', agrupar: 'beneficiario', pestana: 'planilla' };

async function vistaReportes(_params, vigente) {
  const cat = await api('/api/catalogos');
  if (!vigente()) return;
  $app.innerHTML = `
    <div class="encabezado"><div><h1>Reportes</h1><p>Filtrá, revisá en pantalla y descargá en Excel o CSV.</p></div></div>
    <section class="tarjeta">
      <h2>Filtros</h2>
      <div class="filtros">
        <div class="campo"><label for="rp-periodo">Mes</label><input type="month" id="rp-periodo" value="${esc(filtrosRep.periodo)}"></div>
        <div class="campo ancho"><label for="rp-q">Buscar</label><input type="search" id="rp-q" placeholder="Nombre, CI, entidad, concepto, beneficiario" value="${esc(filtrosRep.q)}"></div>
        <div class="campo"><label for="rp-tipo">Judicial / Comercial</label><select id="rp-tipo"><option value="">Todas</option><option value="judicial">Judicial</option><option value="comercial">Comercial</option></select></div>
        <div class="campo"><label for="rp-tdesc">Tipo de descuento</label><select id="rp-tdesc"><option value="">Todos</option>${cat.tiposDescuento.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
        <div class="campo"><label for="rp-empresa">Empresa donde se retuvo</label><select id="rp-empresa"><option value="">Todas</option>${cat.empresas.map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}</select></div>
      </div>
      <p class="nota">Si filtrás por tipo de descuento o empresa, “Descontado” y “A abonar” suman solo los descuentos que cumplen ese filtro.</p>
    </section>

    <div class="pestanas" role="tablist">
      <button type="button" role="tab" data-pestana="planilla">Planilla de personas con retenciones</button>
      <button type="button" role="tab" data-pestana="abonar">A abonar</button>
    </div>

    <section class="tarjeta">
      <div class="encabezado" style="margin-bottom:12px">
        <div id="rp-opciones"></div>
        <div class="acciones">
          <button class="boton ambar" type="button" id="rp-xlsx">Descargar Excel</button>
          <button class="boton secundario" type="button" id="rp-csv">Descargar CSV</button>
        </div>
      </div>
      <div id="rp-descarga"></div>
      <div id="rp-resultado"><p class="cargando">Cargando…</p></div>
    </section>`;

  document.getElementById('rp-tipo').value = filtrosRep.tipo;
  document.getElementById('rp-tdesc').value = filtrosRep.tipo_descuento;
  document.getElementById('rp-empresa').value = filtrosRep.empresa_id;

  const resultado = document.getElementById('rp-resultado');
  const opciones = document.getElementById('rp-opciones');
  const consulta = () => new URLSearchParams(Object.entries({
    periodo: filtrosRep.periodo, q: filtrosRep.q, tipo: filtrosRep.tipo, tipo_descuento: filtrosRep.tipo_descuento,
    empresa_id: filtrosRep.empresa_id, ...(filtrosRep.pestana === 'abonar' ? { agrupar: filtrosRep.agrupar } : {}),
  }).filter(([, v]) => v));

  const recargar = () => cargarEn(resultado, async () => {
    document.querySelectorAll('.pestanas button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pestana === filtrosRep.pestana)));
    if (filtrosRep.pestana === 'planilla') {
      opciones.innerHTML = '<h2>Planilla de personas con retenciones</h2>';
      const filas = await api(`/api/reportes/planilla?${consulta()}`);
      resultado.innerHTML = tablaPlanilla(filas);
    } else {
      opciones.innerHTML = `<div class="campo"><span class="etiqueta">Agrupar por</span><div class="radio-grupo">
        <label><input type="radio" name="agrupar" value="beneficiario" ${filtrosRep.agrupar === 'beneficiario' ? 'checked' : ''}> Beneficiario</label>
        <label><input type="radio" name="agrupar" value="entidad" ${filtrosRep.agrupar === 'entidad' ? 'checked' : ''}> Entidad</label></div></div>`;
      opciones.querySelectorAll('input[name="agrupar"]').forEach((i) => i.addEventListener('change', () => { filtrosRep.agrupar = i.value; recargar(); }));
      const rep = await api(`/api/reportes/abonar?${consulta()}`);
      resultado.innerHTML = tablaAbonar(rep);
    }
  });

  document.querySelectorAll('.pestanas button').forEach((b) => b.addEventListener('click', () => { filtrosRep.pestana = b.dataset.pestana; recargar(); }));
  conectarFiltros({ periodo: 'rp-periodo', q: 'rp-q', tipo: 'rp-tipo', tipo_descuento: 'rp-tdesc', empresa_id: 'rp-empresa' }, filtrosRep, recargar);

  const zonaDescarga = document.getElementById('rp-descarga');
  const bajar = async (formato) => {
    zonaDescarga.innerHTML = '';
    const ruta = filtrosRep.pestana === 'planilla' ? 'planilla' : 'abonar';
    const qs = consulta();
    qs.set('formato', formato);
    const nombre = `${ruta === 'planilla' ? 'planilla-retenciones' : 'a-abonar'}${filtrosRep.periodo ? '-' + filtrosRep.periodo : ''}.${formato}`;
    try { await descargarArchivo(`/api/reportes/${ruta}?${qs}`, nombre); }
    catch { fallaEnLinea(zonaDescarga, () => bajar(formato)); }
  };
  document.getElementById('rp-xlsx').addEventListener('click', () => bajar('xlsx'));
  document.getElementById('rp-csv').addEventListener('click', () => bajar('csv'));
  recargar();
}

function tablaPlanilla(filas) {
  if (!filas.length) return '<div class="tabla-contenedor"><p class="vacio">No hay retenciones con estos filtros.</p></div>';
  const suma = (k) => filas.reduce((a, x) => a + (x[k] || 0), 0);
  return `<div class="tabla-contenedor"><table>
    <thead><tr><th>Período</th><th>CI</th><th>Colaborador</th><th>Entidad</th><th>Concepto</th><th>Expediente</th><th>Beneficiario</th>
      <th class="num">Total</th><th class="num">Descontado</th><th class="num">Falta descontar</th><th>Retenido en</th></tr></thead>
    <tbody>${filas.map((r) => `<tr>
      <td>${esc(mesCorto(r.periodo))}${r.arrastre ? '<span class="sec">saldo que pasa</span>' : ''}</td><td>${esc(cedula(r.cedula))}</td><td>${esc(r.colaborador)}</td>
      <td>${esc(r.entidad)}<span class="sec">${etiquetaTipo(r.tipo)}</span></td>
      <td>${esc(r.concepto)}</td><td>${esc(r.expediente)}</td><td>${esc(r.beneficiario || '')}</td>
      <td class="num">${celdaTotal(r)}</td><td class="num">${moneda(r.descontado)}</td>
      <td class="num">${celdaFalta(r)}</td>
      <td>${esc(r.empresas) || '<span class="sec">—</span>'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="7">Total (${filas.length} retenciones)</td><td class="num">${moneda(suma('importe_total'))}</td>
      <td class="num">${moneda(suma('descontado'))}</td><td class="num">${moneda(suma('pendiente'))}</td><td></td></tr></tfoot>
  </table></div>`;
}

function tablaAbonar(rep) {
  if (!rep.grupos.length) return '<div class="tabla-contenedor"><p class="vacio">No hay importes retenidos para abonar con estos filtros.</p></div>';
  const porEntidad = rep.agrupar === 'entidad';
  return `<div class="tabla-contenedor"><table>
    <thead><tr><th>Colaborador</th><th>${porEntidad ? 'Beneficiario' : 'Entidad'}</th><th>Concepto</th><th>Expediente</th><th>Período</th><th class="num">A abonar</th></tr></thead>
    <tbody>${rep.grupos.map((g) => `
      <tr class="grupo"><td colspan="6">${esc(g.grupo)} · ${esc(g.tipo.split(' / ').map((t) => tipoTxt[t] || t).join(' / '))}</td></tr>
      ${g.detalle.map((x) => `<tr>
        <td>${esc(x.colaborador)}<span class="sec">CI ${esc(cedula(x.cedula))}</span></td>
        <td>${esc(porEntidad ? (x.beneficiario || '—') : x.entidad)}</td>
        <td>${esc(x.concepto)}</td><td>${esc(x.expediente)}</td><td>${esc(mesCorto(x.periodo))}</td>
        <td class="num">${moneda(x.descontado)}</td></tr>`).join('')}
      <tr class="subtotal"><td colspan="5">Subtotal ${esc(g.grupo)} (${g.ordenes} ${g.ordenes === 1 ? 'orden' : 'órdenes'})</td><td class="num">${moneda(g.abonar)}</td></tr>`).join('')}
    </tbody>
    <tfoot><tr><td colspan="5">Total a abonar</td><td class="num">${moneda(rep.total)}</td></tr></tfoot>
  </table></div>`;
}

// ── Altas simples: empresas, colaboradores y entidades ──

async function vistaAlta({ titulo, descripcion, ruta, campos, columnas, vacio, exito }, vigente) {
  const filas = await api(ruta);
  if (!vigente()) return;
  $app.innerHTML = `
    <div class="encabezado"><div><h1>${titulo}</h1><p>${descripcion}</p></div></div>
    <div class="columnas">
      <section class="tarjeta">
        <h2>Nuevo registro</h2>
        <form class="formulario" id="form-alta" novalidate>
          ${campos.map((c) => c.html).join('')}
          <div class="zona-mensaje"></div>
          <div class="acciones"><button class="boton" type="submit">Guardar</button></div>
        </form>
      </section>
      <section class="tarjeta"><h2>Listado</h2><div id="lista-alta"></div></section>
    </div>`;

  const lista = document.getElementById('lista-alta');
  const pintar = (datos) => {
    lista.innerHTML = datos.length
      ? `<div class="tabla-contenedor"><table><thead><tr>${columnas.map((c) => `<th class="${c.num ? 'num' : ''}">${c.titulo}</th>`).join('')}</tr></thead>
         <tbody>${datos.map((f) => `<tr>${columnas.map((c) => `<td class="${c.num ? 'num' : ''}">${c.valor(f)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<div class="tabla-contenedor"><p class="vacio">${vacio}</p></div>`;
  };
  pintar(filas);

  const form = document.getElementById('form-alta');
  manejarEnvio(form, {
    enviar: async () => {
      const cuerpo = {};
      for (const c of campos) {
        const v = c.leer(form);
        if (!v) throw errorLocal(`Falta completar: ${c.nombre}.`);
        cuerpo[c.clave] = v;
      }
      await api(ruta, { metodo: 'POST', cuerpo });
    },
    alTerminar: async () => {
      aviso(exito);
      form.reset();
      form.querySelector('input, select').focus();
      await cargarEn(lista, async () => pintar(await api(ruta)));
    },
  });
}

function vistaEmpresas(_p, vigente) {
  return vistaAlta({
  titulo: 'Empresas',
  descripcion: 'Empresas del grupo donde se retiene a los colaboradores.',
  ruta: '/api/empresas',
  campos: [{ clave: 'nombre', nombre: 'nombre', html: '<div class="campo"><label for="a-nombre">Nombre <span class="obligatorio">*</span></label><input id="a-nombre" maxlength="200" placeholder="Ej.: Sucursal Oeste"></div>', leer: (f) => f.querySelector('#a-nombre').value.trim() }],
  columnas: [
    { titulo: 'Empresa', valor: (f) => esc(f.nombre) },
    { titulo: 'Descuentos', num: true, valor: (f) => f.descuentos },
    { titulo: 'Total retenido', num: true, valor: (f) => moneda(f.retenido) },
  ],
  vacio: 'Todavía no hay empresas.',
  exito: 'Empresa guardada.',
}, vigente);
}

function vistaColaboradores(_p, vigente) {
  return vistaAlta({
  titulo: 'Colaboradores',
  descripcion: 'Personas a las que se les aplican retenciones. La cédula no se puede repetir.',
  ruta: '/api/colaboradores',
  campos: [
    { clave: 'cedula', nombre: 'cédula', html: '<div class="campo"><label for="a-ci">Cédula <span class="obligatorio">*</span></label><input id="a-ci" inputmode="numeric" maxlength="12" placeholder="1.234.567-2"><span class="ayuda">Con dígito verificador. Puntos y guion son opcionales.</span></div>', leer: (f) => f.querySelector('#a-ci').value.trim() },
    { clave: 'nombre', nombre: 'nombre', html: '<div class="campo"><label for="a-nombre">Nombre completo <span class="obligatorio">*</span></label><input id="a-nombre" maxlength="200"></div>', leer: (f) => f.querySelector('#a-nombre').value.trim() },
  ],
  columnas: [
    { titulo: 'Cédula', valor: (f) => esc(cedula(f.cedula)) },
    { titulo: 'Nombre', valor: (f) => esc(f.nombre) },
    { titulo: 'Retenciones', num: true, valor: (f) => f.retenciones },
    { titulo: 'Total', num: true, valor: (f) => moneda(f.total) },
    { titulo: 'Falta descontar', num: true, valor: (f) => moneda(f.total - f.descontado) },
  ],
  vacio: 'Todavía no hay colaboradores.',
  exito: 'Colaborador guardado.',
}, vigente);
}

function vistaEntidades(_p, vigente) {
  return vistaAlta({
  titulo: 'Entidades acreedoras',
  descripcion: 'Quienes envían las retenciones: juzgados, cooperativas, comercios, etc.',
  ruta: '/api/entidades',
  campos: [
    { clave: 'nombre', nombre: 'nombre', html: '<div class="campo"><label for="a-nombre">Nombre <span class="obligatorio">*</span></label><input id="a-nombre" maxlength="200"></div>', leer: (f) => f.querySelector('#a-nombre').value.trim() },
    { clave: 'tipo', nombre: 'tipo', html: '<div class="campo"><label for="a-tipo">Tipo <span class="obligatorio">*</span></label><select id="a-tipo"><option value="">Elegí…</option><option value="judicial">Judicial</option><option value="comercial">Comercial</option></select></div>', leer: (f) => f.querySelector('#a-tipo').value },
  ],
  columnas: [
    { titulo: 'Entidad', valor: (f) => esc(f.nombre) },
    { titulo: 'Tipo', valor: (f) => etiquetaTipo(f.tipo) },
    { titulo: 'Retenciones', num: true, valor: (f) => f.retenciones },
  ],
  vacio: 'Todavía no hay entidades.',
  exito: 'Entidad guardada.',
}, vigente);
}

// ── Respaldo (solo en la versión de archivo único) ──

function diasDesde(fechaHora) {
  if (!fechaHora) return null;
  const t = Date.parse(fechaHora.replace(' ', 'T'));
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

async function avisoRespaldo() {
  if (!LOCAL) return '';
  let info;
  try { info = await api('/api/datos'); } catch { return ''; }
  if (info.nube && info.nube.estado !== 'apagado') return ''; // ya se guarda solo en GitHub
  const hayCambios = info.modificado && (!info.ultimoRespaldo || info.modificado > info.ultimoRespaldo);
  const dias = diasDesde(info.ultimoRespaldo);
  if (info.ejemplos && !info.ultimoRespaldo) {
    return `<div class="falla-en-linea" style="margin-bottom:18px"><span>Estás viendo datos de ejemplo. Cuando quieras cargar los reales, entrá a <strong>Respaldo</strong> y tocá “Empezar de cero”.</span>
      <a class="boton chico ambar" href="#/respaldo">Ir a Respaldo</a></div>`;
  }
  if (!hayCambios || (dias !== null && dias < 7)) return '';
  return `<div class="falla-en-linea" style="margin-bottom:18px"><span>${dias === null ? 'Todavía no descargaste ningún respaldo.' : `Hace ${dias} días que no descargás un respaldo.`} Los datos viven solo en este navegador.</span>
    <a class="boton chico ambar" href="#/respaldo">Descargar respaldo</a></div>`;
}

async function vistaRespaldo(_params, vigente) {
  const info = await api('/api/datos');
  if (!vigente()) return;
  const c = info.cantidades;
  const dias = diasDesde(info.ultimoRespaldo);
  $app.innerHTML = `
    <div class="encabezado"><div><h1>Respaldo de los datos</h1>
      <p>Todo lo que cargás se guarda automáticamente en este navegador${info.nube.estado !== 'apagado' ? ' y en tu repositorio privado de GitHub' : ', en esta computadora'}.</p></div></div>
    ${seccionGithub(info.nube)}
    ${seccionContrasena()}
    <div class="columnas">
      <section class="tarjeta">
        <h2>Descargar respaldo</h2>
        <p>Guarda un archivo con <strong>todos</strong> los datos. Hacelo seguido (por ejemplo, al terminar cada quincena) y guardá el archivo en un pendrive, en la nube o en tu correo.</p>
        <p class="nota">Último respaldo: <strong>${info.ultimoRespaldo ? `${fecha(info.ultimoRespaldo)}${dias ? ` (hace ${dias} ${dias === 1 ? 'día' : 'días'})` : ' (hoy)'}` : 'nunca'}</strong></p>
        <div class="acciones" style="margin-top:12px"><button class="boton ambar" type="button" id="bajar-respaldo">Descargar respaldo</button></div>
        <div id="zona-respaldo" style="margin-top:12px"></div>
      </section>
      <section class="tarjeta">
        <h2>Lo que hay guardado</h2>
        <div class="tabla-contenedor"><table><tbody>
          <tr><td>Retenciones</td><td class="num">${c.retenciones}</td></tr>
          <tr><td>Descuentos</td><td class="num">${c.descuentos}</td></tr>
          <tr><td>Colaboradores</td><td class="num">${c.colaboradores}</td></tr>
          <tr><td>Entidades</td><td class="num">${c.entidades}</td></tr>
          <tr><td>Empresas</td><td class="num">${c.empresas}</td></tr>
        </tbody></table></div>
        <p class="nota">Importante: si borrás los datos de navegación (“cookies y datos de sitios”) o usás otra computadora u otro navegador, no vas a ver estos datos. Para eso está el respaldo.</p>
      </section>
    </div>
    <div class="columnas" style="margin-top:20px">
      <section class="tarjeta">
        <h2>Recuperar un respaldo</h2>
        <p>Elegí un archivo de respaldo descargado antes. <strong>Reemplaza</strong> todos los datos actuales por los del archivo. También sirve para pasar los datos a otra computadora.</p>
        <div class="campo"><label for="archivo-respaldo">Archivo de respaldo (.json)</label><input type="file" id="archivo-respaldo" accept=".json,application/json"></div>
        <div id="zona-recuperar" style="margin-top:12px"></div>
      </section>
      <section class="tarjeta">
        <h2>Importar retenciones</h2>
        <p>Agrega las retenciones de un archivo de importación (.json) preparado a partir de tu planilla. <strong>No borra nada</strong>: crea los colaboradores y entidades que falten, y si una retención ya estaba cargada no la repite.</p>
        <div class="campo"><label for="archivo-importar">Archivo de importación (.json)</label><input type="file" id="archivo-importar" accept=".json,application/json"></div>
        <div id="zona-importar" style="margin-top:12px"></div>
      </section>
    </div>
    <div class="columnas" style="margin-top:20px">
      <section class="tarjeta">
        <h2>Empezar de cero</h2>
        <p>Borra <strong>todos</strong> los datos (incluidos los de ejemplo) para empezar a cargar los reales. ${info.ejemplos ? 'Ahora mismo estás viendo datos de ejemplo.' : 'Antes conviene descargar un respaldo.'}</p>
        <div class="acciones"><button class="boton peligro" type="button" id="borrar-todo">Borrar todo y empezar de cero</button></div>
      </section>
    </div>`;

  conectarSeccionGithub(info.nube);
  conectarSeccionContrasena();

  const zona = document.getElementById('zona-respaldo');
  const bajar = async () => {
    zona.innerHTML = '';
    try {
      const blob = await window.backendLocal.exportarRespaldo();
      const d = new Date();
      const dos = (n) => String(n).padStart(2, '0');
      guardarBlob(blob, `respaldo-retenciones-${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}_${dos(d.getHours())}-${dos(d.getMinutes())}.json`);
      aviso('Respaldo descargado. Buscalo en la carpeta Descargas.');
      setTimeout(navegar, 800);
    } catch (e) { console.error(e); fallaEnLinea(zona, bajar); }
  };
  document.getElementById('bajar-respaldo').addEventListener('click', bajar);

  const zonaRec = document.getElementById('zona-recuperar');
  document.getElementById('archivo-respaldo').addEventListener('change', async (ev) => {
    const archivo = ev.target.files[0];
    if (!archivo) return;
    zonaRec.innerHTML = '';
    if (!confirm(`¿Reemplazar todos los datos actuales por los del archivo “${archivo.name}”?`)) { ev.target.value = ''; return; }
    try {
      const info2 = await window.backendLocal.importarRespaldo(await archivo.text());
      aviso(`Respaldo recuperado: ${info2.cantidades.retenciones} retenciones y ${info2.cantidades.descuentos} descuentos.`);
      navegar();
    } catch (e) {
      ev.target.value = '';
      if (e instanceof window.backendLocal.ErrorValidacion) zonaRec.innerHTML = `<div class="mensaje error">${esc(e.message)} No se cambió nada.</div>`;
      else { console.error(e); zonaRec.innerHTML = `<div class="mensaje error">${MENSAJE_FALLA}</div>`; }
    }
  });

  const zonaImp = document.getElementById('zona-importar');
  document.getElementById('archivo-importar').addEventListener('change', async (ev) => {
    const archivo = ev.target.files[0];
    if (!archivo) return;
    if (info.ejemplos && !confirm('Ahora hay datos de ejemplo. Al importar se quitan y quedan solo los datos reales del archivo. ¿Continuar?')) { ev.target.value = ''; return; }
    zonaImp.innerHTML = '<p class="nota">Importando…</p>';
    try {
      let datos;
      try { datos = JSON.parse(await archivo.text()); } catch { throw new window.backendLocal.ErrorValidacion('El archivo no es una importación de retenciones.'); }
      const r = await api('/api/importar', { metodo: 'POST', cuerpo: datos });
      aviso(`Importación lista: ${r.retenciones} retenciones nuevas${r.repetidas ? ` (${r.repetidas} ya estaban cargadas)` : ''}${r.mensualesNuevas ? `; ${r.mensualesNuevas} quedaron como mensuales` : ''}.`);
      navegar();
    } catch (e) {
      ev.target.value = '';
      const msg = e instanceof window.backendLocal.ErrorValidacion || e.validacion ? e.message : MENSAJE_FALLA;
      zonaImp.innerHTML = `<div class="mensaje error">${esc(msg)} No se cambió nada.</div>`;
    }
  });

  document.getElementById('borrar-todo').addEventListener('click', async () => {
    if (!confirm('¿Borrar TODOS los datos? Esto no se puede deshacer (salvo que tengas un respaldo).')) return;
    if (!info.ejemplos && !confirm('Confirmá de nuevo: se borran todas las retenciones, descuentos, colaboradores, entidades y empresas.')) return;
    try { await window.backendLocal.borrarTodo(); aviso('Listo: el sistema quedó vacío.'); location.hash = '#/panel'; }
    catch (e) { console.error(e); aviso(MENSAJE_FALLA); }
  });
}

function seccionGithub(n) {
  if (n.estado !== 'apagado') {
    const txt = n.estado === 'ok' ? 'Todo guardado en GitHub.' : n.estado === 'subiendo' ? 'Guardando en GitHub…' : `No se pudo guardar en GitHub: ${esc(n.mensaje)} Tus datos están a salvo en este navegador y se suben solos cuando vuelva la conexión.`;
    return `<section class="tarjeta">
      <h2>Guardado en GitHub</h2>
      <p>Cada cambio se guarda solo en el repositorio privado <a href="https://github.com/${esc(n.repo)}" target="_blank" rel="noopener"><strong>${esc(n.repo)}</strong></a>, con su historial de versiones. Desde otra computadora, conectá el mismo repositorio y vas a ver los mismos datos.</p>
      <div class="${n.estado === 'error' ? 'mensaje error' : 'mensaje ok'}" style="margin:12px 0">${txt}</div>
      <div class="acciones"><button class="boton" type="button" id="nube-ahora">Guardar ahora</button>
        <button class="boton peligro" type="button" id="nube-desconectar">Desconectar de esta computadora</button></div>
    </section>`;
  }
  return `<section class="tarjeta">
    <h2>Guardar en GitHub (recomendado)</h2>
    <p>Así los datos quedan guardados en un repositorio <strong>privado</strong> de tu cuenta, con historial, y los podés abrir desde cualquier computadora. Se hace una sola vez:</p>
    <ol class="pasos">
      <li>Creá un repositorio <strong>privado</strong>: entrá a <a href="https://github.com/new" target="_blank" rel="noopener">github.com/new</a>, nombre <strong>sistema-retenciones-datos</strong>, marcá <strong>Private</strong> y tocá <strong>Create repository</strong>.</li>
      <li>Creá la clave: entrá a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">esta página de GitHub</a>. Poné un nombre (por ejemplo “Retenciones”) y en <strong>Expiration</strong> elegí el plazo más largo. En <strong>Repository access</strong> elegí <strong>Only select repositories</strong> → <em>sistema-retenciones-datos</em>. En <strong>Permissions</strong> → <strong>Repository permissions</strong> → <strong>Contents</strong> elegí <strong>Read and write</strong>. Tocá <strong>Generate token</strong> y copiá la clave (empieza con <code>github_pat_</code>).</li>
      <li>Pegala acá abajo y tocá <strong>Conectar</strong>.</li>
    </ol>
    <form class="formulario" id="form-nube" novalidate>
      <div class="fila">
        <div class="campo"><label for="nube-repo">Repositorio privado</label><input id="nube-repo" value="brunoperez1988/sistema-retenciones-datos" autocomplete="off"></div>
        <div class="campo"><label for="nube-token">Clave de GitHub (token)</label><input id="nube-token" type="password" autocomplete="off" placeholder="github_pat_…"></div>
      </div>
      <p class="nota">La clave queda guardada solo en este navegador. Tratala como una contraseña: no la compartas.</p>
      <div class="zona-mensaje"></div>
      <div class="acciones"><button class="boton" type="submit">Conectar</button></div>
    </form>
  </section>`;
}

function conectarSeccionGithub(n) {
  if (n.estado !== 'apagado') {
    document.getElementById('nube-ahora').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      const r = await window.backendLocal.guardarEnNubeAhora().catch(() => null);
      aviso(r && r.estado === 'ok' ? 'Guardado en GitHub.' : 'No se pudo guardar en GitHub. Tus datos están a salvo en este navegador.');
      navegar();
    });
    document.getElementById('nube-desconectar').addEventListener('click', () => {
      if (!confirm('¿Desconectar GitHub en esta computadora? Los datos que ya están en GitHub no se borran.')) return;
      window.backendLocal.desconectarNube();
      navegar();
    });
    return;
  }
  const form = document.getElementById('form-nube');
  const zona = form.querySelector('.zona-mensaje');
  const conectar = async (modo) => {
    zona.innerHTML = '<p class="nota">Conectando con GitHub…</p>';
    try {
      const r = await window.backendLocal.conectarNube(form.querySelector('#nube-repo').value, form.querySelector('#nube-token').value, modo);
      if (r.pregunta) {
        zona.innerHTML = `<div class="falla-en-linea" style="display:block">
          <p style="margin:0 0 10px">En ese repositorio ya hay datos guardados (${r.retenciones} retenciones y ${r.descuentos} descuentos${r.modificado ? `, último cambio ${fecha(r.modificado)}` : ''}). ¿Cuáles querés usar?</p>
          <div class="acciones"><button class="boton" type="button" data-modo="traer">Usar los de GitHub</button>
            <button class="boton secundario" type="button" data-modo="subir">Reemplazarlos por los de este navegador</button></div></div>`;
        zona.querySelectorAll('[data-modo]').forEach((b) => b.addEventListener('click', () => conectar(b.dataset.modo)));
        return;
      }
      aviso('Listo: los datos se guardan en GitHub.');
      navegar();
    } catch (e) {
      zona.innerHTML = `<div class="mensaje error">${esc(e.message || 'No se pudo conectar con GitHub.')}</div>`;
    }
  };
  form.addEventListener('submit', (ev) => { ev.preventDefault(); conectar(); });
}

// ── Usuario y contraseña (versión de archivo único) ──

function usuarioSesion() { return LOCAL ? window.backendLocal.cuenta().usuario : ''; }

function cerrarSesion() {
  window.backendLocal.salir();
  location.hash = '#/panel';
  location.reload();
}

function pantallaAcceso(c) {
  const crear = !c.existe;
  $app.innerHTML = `
    <section class="acceso tarjeta">
      <h1>${crear ? 'Creá tu usuario' : 'Ingresar'}</h1>
      <p>${crear
        ? 'Elegí un usuario y una contraseña. Con la contraseña se cifran los datos guardados en esta computadora: sin ella nadie los puede leer. <strong>Anotala en un lugar seguro.</strong>'
        : 'Ingresá con tu usuario y contraseña para ver las retenciones.'}</p>
      <form class="formulario" id="form-acceso" novalidate>
        <div class="campo"><label for="ac-usuario">Usuario</label><input id="ac-usuario" autocomplete="username" value="${esc(c.usuario)}" autocapitalize="off" spellcheck="false"></div>
        <div class="campo"><label for="ac-clave">Contraseña</label><input id="ac-clave" type="password" autocomplete="${crear ? 'new-password' : 'current-password'}"></div>
        ${crear ? '<div class="campo"><label for="ac-clave2">Repetí la contraseña</label><input id="ac-clave2" type="password" autocomplete="new-password"><span class="ayuda">Mínimo 8 caracteres.</span></div>' : ''}
        <div class="zona-mensaje"></div>
        <div class="acciones"><button class="boton" type="submit">${crear ? 'Crear usuario y entrar' : 'Ingresar'}</button></div>
      </form>
      ${crear ? '' : '<p class="nota" style="margin-top:16px"><button type="button" class="enlace" id="olvide">Olvidé mi contraseña</button></p>'}
    </section>`;
  const form = document.getElementById('form-acceso');
  (c.usuario ? form.querySelector('#ac-clave') : form.querySelector('#ac-usuario')).focus();
  const zona = form.querySelector('.zona-mensaje');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const boton = form.querySelector('button[type="submit"]');
    boton.disabled = true;
    zona.innerHTML = '<p class="nota">Verificando…</p>';
    try {
      const u = form.querySelector('#ac-usuario').value;
      const k = form.querySelector('#ac-clave').value;
      if (crear) await window.backendLocal.crearCuenta(u, k, form.querySelector('#ac-clave2').value);
      else await window.backendLocal.ingresar(u, k);
      navegar();
    } catch (e) {
      zona.innerHTML = `<div class="mensaje error" role="alert">${esc(e instanceof window.backendLocal.ErrorValidacion ? e.message : MENSAJE_FALLA)}</div>`;
      form.querySelector('#ac-clave').value = '';
      boton.disabled = false;
    }
  });
  const olvide = document.getElementById('olvide');
  if (olvide) olvide.addEventListener('click', async () => {
    if (!confirm('Si olvidaste la contraseña, se borran los datos guardados en ESTE navegador y creás un usuario nuevo.\n\nSi los datos están guardados en GitHub, los recuperás desde Respaldo → Guardar en GitHub (vas a necesitar la clave de GitHub; si no la tenés, en GitHub podés tocar "Regenerate token").\n\n¿Continuar?')) return;
    try { await window.backendLocal.olvideContrasena(); } catch (e) { console.error(e); }
    location.reload();
  });
}

function seccionContrasena() {
  return `<section class="tarjeta">
    <h2>Cambiar contraseña</h2>
    <form class="formulario" id="form-contrasena" novalidate>
      <div class="fila">
        <div class="campo"><label for="cc-actual">Contraseña actual</label><input id="cc-actual" type="password" autocomplete="current-password"></div>
        <div class="campo"><label for="cc-nueva">Contraseña nueva</label><input id="cc-nueva" type="password" autocomplete="new-password"></div>
      </div>
      <div class="campo"><label for="cc-nueva2">Repetí la contraseña nueva</label><input id="cc-nueva2" type="password" autocomplete="new-password"></div>
      <div class="zona-mensaje"></div>
      <div class="acciones"><button class="boton secundario" type="submit">Cambiar contraseña</button></div>
    </form>
  </section>`;
}

function conectarSeccionContrasena() {
  const form = document.getElementById('form-contrasena');
  const zona = form.querySelector('.zona-mensaje');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    zona.innerHTML = '<p class="nota">Cambiando…</p>';
    try {
      await window.backendLocal.cambiarContrasena(form.querySelector('#cc-actual').value, form.querySelector('#cc-nueva').value, form.querySelector('#cc-nueva2').value);
      form.reset();
      zona.innerHTML = '<div class="mensaje ok">Listo: la contraseña quedó cambiada.</div>';
    } catch (e) {
      zona.innerHTML = `<div class="mensaje error">${esc(e instanceof window.backendLocal.ErrorValidacion ? e.message : MENSAJE_FALLA)}</div>`;
    }
  });
}

navegar();
