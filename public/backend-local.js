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

  async function leerRegistro(clave) {
    const b = await conexion();
    return new Promise((resolve, reject) => {
      const tx = b.transaction(ALMACEN, 'readonly');
      const p = tx.objectStore(ALMACEN).get(clave);
      p.onsuccess = () => resolve(p.result === undefined ? null : p.result);
      p.onerror = () => reject(p.error);
    });
  }

  async function guardarRegistro(clave, valor) {
    const b = await conexion();
    return new Promise((resolve, reject) => {
      const tx = b.transaction(ALMACEN, 'readwrite');
      if (valor === null) tx.objectStore(ALMACEN).delete(clave); else tx.objectStore(ALMACEN).put(valor, clave);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Escritura cancelada'));
    });
  }

  // ── Usuario y contraseña ──
  // La contraseña nunca se guarda: de ella se deriva (PBKDF2) una llave AES-GCM que
  // cifra los datos y la clave de GitHub guardados en este navegador. Sin la
  // contraseña, lo guardado en la compu no se puede leer.

  const CLAVE_CUENTA = 'ret.cuenta';
  const ITERACIONES = 310000;
  let llave = null;
  let usuarioActual = '';

  class ErrorBloqueado extends Error { constructor() { super('Ingresá con tu usuario y contraseña.'); this.bloqueado = true; } }

  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const deB64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));

  function leerCuenta() {
    try { return JSON.parse(localStorage.getItem(CLAVE_CUENTA) || 'null'); } catch { return null; }
  }

  async function derivarLlave(contrasena, sal, iteraciones) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(contrasena), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sal, iterations: iteraciones, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function cifrar(valor, conLlave = llave) {
    if (!conLlave) throw new ErrorBloqueado();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const datos = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, conLlave, new TextEncoder().encode(JSON.stringify(valor)));
    return { cifrado: 1, iv, datos };
  }

  async function descifrar(registro, conLlave = llave) {
    if (!registro || !registro.cifrado) return registro; // dato anterior a la contraseña
    if (!conLlave) throw new ErrorBloqueado();
    const plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: registro.iv }, conLlave, registro.datos);
    return JSON.parse(new TextDecoder().decode(plano));
  }

  async function leerEstado() { return descifrar(await leerRegistro(CLAVE)); }
  async function guardarEstado(valor) { await guardarRegistro(CLAVE, await cifrar(valor)); }

  function normalizarUsuario(u) { return String(u || '').trim().toLowerCase(); }

  async function desbloquear(nuevaLlave, usuario) {
    llave = nuevaLlave;
    usuarioActual = usuario;
    // Pasa al formato cifrado lo que estuviera guardado sin cifrar (versiones anteriores).
    const registro = await leerRegistro(CLAVE);
    if (registro && !registro.cifrado) await guardarRegistro(CLAVE, await cifrar(registro));
    let nube = await descifrar(await leerRegistro('nube'));
    try {
      const vieja = JSON.parse(localStorage.getItem('ret.nube') || 'null');
      if (!nube && vieja && vieja.token) nube = vieja;
      localStorage.removeItem('ret.nube');
    } catch { /* sin almacenamiento */ }
    nubeCfg = nube && nube.token && nube.repo ? nube : null;
    if (nubeCfg) await guardarRegistro('nube', await cifrar(nubeCfg));
  }

  async function crearCuenta(usuario, contrasena, repetida) {
    if (leerCuenta()) throw new ErrorValidacion('Ya hay un usuario creado en este navegador.');
    const u = normalizarUsuario(usuario);
    if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new ErrorValidacion('El usuario debe tener entre 3 y 40 letras o números, sin espacios.');
    if (String(contrasena || '').length < 8) throw new ErrorValidacion('La contraseña debe tener al menos 8 caracteres.');
    if (contrasena !== repetida) throw new ErrorValidacion('Las dos contraseñas no coinciden.');
    const sal = crypto.getRandomValues(new Uint8Array(16));
    const nueva = await derivarLlave(contrasena, sal, ITERACIONES);
    const verif = await cifrar({ usuario: u }, nueva);
    await desbloquear(nueva, u);
    localStorage.setItem(CLAVE_CUENTA, JSON.stringify({ usuario: u, sal: b64(sal), iteraciones: ITERACIONES, verif: { iv: b64(verif.iv), datos: b64(verif.datos) } }));
    return { usuario: u };
  }

  async function ingresar(usuario, contrasena) {
    const c = leerCuenta();
    if (!c) throw new ErrorValidacion('Todavía no hay un usuario creado.');
    const incorrecto = new ErrorValidacion('Usuario o contraseña incorrectos.');
    if (normalizarUsuario(usuario) !== c.usuario) { await new Promise((r) => setTimeout(r, 600)); throw incorrecto; }
    const candidata = await derivarLlave(String(contrasena || ''), deB64(c.sal), c.iteraciones);
    try {
      await descifrar({ cifrado: 1, iv: deB64(c.verif.iv), datos: deB64(c.verif.datos) }, candidata);
    } catch {
      throw incorrecto;
    }
    await desbloquear(candidata, c.usuario);
    return { usuario: c.usuario };
  }

  async function cambiarContrasena(actual, nueva, repetida) {
    const c = leerCuenta();
    if (!c || !llave) throw new ErrorBloqueado();
    const vieja = await derivarLlave(String(actual || ''), deB64(c.sal), c.iteraciones);
    try { await descifrar({ cifrado: 1, iv: deB64(c.verif.iv), datos: deB64(c.verif.datos) }, vieja); } catch { throw new ErrorValidacion('La contraseña actual no es correcta.'); }
    if (String(nueva || '').length < 8) throw new ErrorValidacion('La contraseña nueva debe tener al menos 8 caracteres.');
    if (nueva !== repetida) throw new ErrorValidacion('Las dos contraseñas nuevas no coinciden.');
    await iniciar();
    const sal = crypto.getRandomValues(new Uint8Array(16));
    const llaveNueva = await derivarLlave(nueva, sal, ITERACIONES);
    const verif = await cifrar({ usuario: c.usuario }, llaveNueva);
    await guardarRegistro(CLAVE, await cifrar(estado, llaveNueva));
    await guardarRegistro('nube', nubeCfg ? await cifrar(nubeCfg, llaveNueva) : null);
    localStorage.setItem(CLAVE_CUENTA, JSON.stringify({ usuario: c.usuario, sal: b64(sal), iteraciones: ITERACIONES, verif: { iv: b64(verif.iv), datos: b64(verif.datos) } }));
    llave = llaveNueva;
    return { ok: true };
  }

  // Olvidé la contraseña: se borra lo guardado en este navegador (los datos de GitHub no se tocan).
  async function olvideContrasena() {
    await guardarRegistro(CLAVE, null);
    await guardarRegistro('nube', null);
    try { localStorage.removeItem(CLAVE_CUENTA); localStorage.removeItem('ret.nube'); localStorage.setItem('ret.sinEjemplos', '1'); } catch { /* sin almacenamiento */ }
    llave = null; estado = null; nubeCfg = null;
  }

  function salir() { llave = null; estado = null; nubeCfg = null; usuarioActual = ''; }

  function cuenta() {
    const c = leerCuenta();
    return { existe: Boolean(c), usuario: c ? c.usuario : '', desbloqueada: Boolean(llave) };
  }

  // ── Estado en memoria ──

  let estado = null;
  let iniciando = null;

  function estadoVacio() {
    return { version: VERSION_DATOS, sig: 1, entidades: [], colaboradores: [], empresas: [], retenciones: [], descuentos: [], ultimoRespaldo: null, modificado: null };
  }

  async function iniciar() {
    if (!llave) throw new ErrorBloqueado();
    if (estado) return;
    if (!iniciando) {
      iniciando = (async () => {
        let e = await leerEstado();
        if (!e) {
          let sinEjemplos = false;
          try { sinEjemplos = localStorage.getItem('ret.sinEjemplos') === '1'; } catch { /* sin almacenamiento */ }
          e = configNube() || sinEjemplos ? estadoVacio() : estadoConEjemplos();
          await guardarEstado(e);
        }
        estado = e;
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* opcional */ }
        sincronizarAlAbrir(); // en segundo plano: la app abre aunque GitHub tarde
      })().finally(() => { iniciando = null; });
    }
    await iniciando;
  }

  // ── Guardado en GitHub (repositorio privado) ──
  // Cada cambio se guarda primero en el navegador y enseguida se sube como un
  // archivo JSON a un repositorio privado. Cada subida queda como un "commit",
  // así que el repositorio guarda también el historial de versiones.

    const ARCHIVO_NUBE = 'datos/retenciones.json';
  let shaNube = null;
  let estadoNube = { estado: 'apagado', mensaje: '' };
  let subiendo = null;
  let temporizadorSubida = null;

  // La clave de GitHub se guarda cifrada con la contraseña (registro 'nube').
  let nubeCfg = null;
  function configNube() { return nubeCfg; }
  async function guardarConfigNube(c) {
    nubeCfg = c;
    await guardarRegistro('nube', c ? await cifrar(c) : null);
  }
  function avisarNube(nuevo) {
    estadoNube = { ...nuevo, repo: (configNube() || {}).repo || '', pendiente: Boolean(estado && estado.pendienteNube) };
    try { window.dispatchEvent(new CustomEvent('nube-estado', { detail: estadoNube })); } catch { /* sin eventos */ }
  }

  function aBase64(texto) {
    const bytes = new TextEncoder().encode(texto);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function deBase64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  class ErrorNube extends Error {
    constructor(mensaje, status = 0) { super(mensaje); this.status = status; }
  }

  async function github(config, metodo, ruta, cuerpo, accept = 'application/vnd.github+json') {
    let res;
    try {
      res = await fetch(`https://api.github.com${ruta}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${config.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new ErrorNube('No hay conexión con GitHub.');
    }
    if (res.status === 401) throw new ErrorNube('La clave de GitHub no es válida o venció.', 401);
    if (res.status === 403) throw new ErrorNube('La clave no tiene permiso sobre ese repositorio (revisá que tenga "Contents: Read and write").', 403);
    return res;
  }

  const rutaArchivo = (c) => `/repos/${c.repo}/contents/${ARCHIVO_NUBE}`;

  // Devuelve { datos, sha } del archivo en GitHub, o null si todavía no existe.
  async function leerNube(c) {
    const res = await github(c, 'GET', `${rutaArchivo(c)}?t=${Date.now()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new ErrorNube(`GitHub respondió ${res.status}.`, res.status);
    const info = await res.json();
    let texto = info.content ? deBase64(info.content) : '';
    if (!texto && info.size > 0) {
      const raw = await github(c, 'GET', `${rutaArchivo(c)}?t=${Date.now()}`, null, 'application/vnd.github.raw+json');
      texto = await raw.text();
    }
    return { datos: JSON.parse(texto), sha: info.sha };
  }

  function paraNube(e) {
    const { ultimoRespaldo, pendienteNube, ...resto } = e;
    return JSON.stringify({ sistema: 'Sistema de Retenciones', ...resto }, null, 1);
  }

  async function subirAhora() {
    const c = configNube();
    if (!c || !estado || !estado.pendienteNube) return;
    const enviado = estado;
    avisarNube({ estado: 'subiendo', mensaje: 'Guardando en GitHub…' });
    try {
      const cuerpo = (sha) => ({ message: `Datos actualizados ${enviado.modificado || ahora()}`, content: aBase64(paraNube(enviado)), ...(sha ? { sha } : {}) });
      let res = await github(c, 'PUT', rutaArchivo(c), cuerpo(shaNube));
      if (res.status === 409 || res.status === 422) {
        // Otra computadora guardó antes: tomamos su versión del archivo y subimos encima (gana el último cambio).
        const actual = await leerNube(c);
        shaNube = actual ? actual.sha : null;
        res = await github(c, 'PUT', rutaArchivo(c), cuerpo(shaNube));
      }
      if (!res.ok) throw new ErrorNube(`GitHub respondió ${res.status}.`, res.status);
      shaNube = (await res.json()).content.sha;
      if (estado === enviado || (estado && estado.modificado === enviado.modificado)) {
        await modificarSinMarca((e) => { e.pendienteNube = false; });
      }
      avisarNube({ estado: 'ok', mensaje: 'Guardado en GitHub' });
    } catch (err) {
      avisarNube({ estado: 'error', mensaje: err instanceof ErrorNube ? err.message : 'No se pudo guardar en GitHub.' });
    }
  }

  // Sube los cambios pendientes (agrupa cambios seguidos en una sola subida).
  function programarSubida(espera = 800) {
    if (!configNube()) return;
    clearTimeout(temporizadorSubida);
    temporizadorSubida = setTimeout(async () => {
      if (subiendo) await subiendo;
      subiendo = subirAhora().finally(() => { subiendo = null; });
    }, espera);
  }

  // Al abrir: si GitHub tiene una versión más nueva, se usa esa; si la de este navegador es más nueva, se sube.
  async function sincronizarAlAbrir() {
    const c = configNube();
    if (!c) { avisarNube({ estado: 'apagado', mensaje: '' }); return; }
    avisarNube({ estado: 'subiendo', mensaje: 'Revisando GitHub…' });
    try {
      const remoto = await leerNube(c);
      shaNube = remoto ? remoto.sha : null;
      const remotoMasNuevo = remoto && (!estado.modificado || (remoto.datos.modificado || '') > estado.modificado);
      if (remotoMasNuevo && !estado.pendienteNube) {
        const nuevo = validarEstado(remoto.datos);
        delete nuevo.sistema;
        nuevo.ultimoRespaldo = estado.ultimoRespaldo;
        nuevo.pendienteNube = false;
        await guardarEstado(nuevo);
        estado = nuevo;
        avisarNube({ estado: 'ok', mensaje: 'Guardado en GitHub' });
        try { window.dispatchEvent(new CustomEvent('datos-actualizados')); } catch { /* sin eventos */ }
      } else if (!remoto || estado.pendienteNube || (estado.modificado || '') > (remoto.datos.modificado || '')) {
        estado = { ...estado, pendienteNube: true };
        await guardarEstado(estado);
        programarSubida(0);
      } else {
        avisarNube({ estado: 'ok', mensaje: 'Guardado en GitHub' });
      }
    } catch (err) {
      avisarNube({ estado: 'error', mensaje: err instanceof ErrorNube ? err.message : 'No se pudo leer GitHub.' });
    }
  }

  // Conecta un repositorio. modo: 'traer' usa los datos de GitHub; 'subir' sube los de este navegador.
  async function conectarNube(repo, token, modo) {
    repo = String(repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    token = String(token || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ErrorValidacion('Escribí el repositorio como usuario/nombre, por ejemplo brunoperez1988/sistema-retenciones-datos.');
    if (!token) throw new ErrorValidacion('Pegá la clave (token) de GitHub.');
    const c = { repo, token };
    const res = await github(c, 'GET', `/repos/${repo}`).catch((e) => { throw new ErrorValidacion(e.message); });
    if (res.status === 404) throw new ErrorValidacion('No encontré ese repositorio, o la clave no tiene acceso a él.');
    if (!res.ok) throw new ErrorValidacion(`GitHub respondió ${res.status}.`);
    const info = await res.json();
    if (!info.private) throw new ErrorValidacion('Ese repositorio es PÚBLICO: cualquiera vería las cédulas y los juicios. Usá un repositorio privado.');
    if (info.permissions && info.permissions.push === false) throw new ErrorValidacion('La clave no tiene permiso para escribir en ese repositorio.');
    const remoto = await leerNube(c).catch((e) => { throw new ErrorValidacion(e.message); });
    if (remoto && modo === undefined) return { pregunta: true, empresas: (remoto.datos.empresas || []).length, retenciones: (remoto.datos.retenciones || []).length, descuentos: (remoto.datos.descuentos || []).length, modificado: remoto.datos.modificado || '' };
    await guardarConfigNube(c);
    shaNube = remoto ? remoto.sha : null;
    if (remoto && modo === 'traer') {
      const nuevo = validarEstado(remoto.datos);
      delete nuevo.sistema;
      nuevo.ultimoRespaldo = estado.ultimoRespaldo;
      nuevo.pendienteNube = false;
      await guardarEstado(nuevo);
      estado = nuevo;
      avisarNube({ estado: 'ok', mensaje: 'Guardado en GitHub' });
    } else {
      await modificarSinMarca((e) => { e.pendienteNube = true; });
      if (subiendo) await subiendo;
      await subirAhora();
      if (estadoNube.estado === 'error') {
        await guardarConfigNube(null);
        throw new ErrorValidacion(estadoNube.mensaje);
      }
    }
    return { conectado: true };
  }

  // Cambia la clave (token) de GitHub de esta computadora, sin tocar los datos. Se prueba antes de guardarla.
  async function cambiarClaveNube(token) {
    token = String(token || '').trim();
    if (!nubeCfg) throw new ErrorValidacion('Esta computadora no está conectada a GitHub.');
    if (!token) throw new ErrorValidacion('Pegá la clave nueva (token) de GitHub.');
    const c = { repo: nubeCfg.repo, token };
    const res = await github(c, 'GET', `/repos/${c.repo}`).catch((e) => { throw new ErrorValidacion(e.message); });
    if (res.status === 404) throw new ErrorValidacion('Esa clave no tiene acceso al repositorio de datos.');
    if (!res.ok) throw new ErrorValidacion(`GitHub respondió ${res.status}.`);
    const info = await res.json();
    if (info.permissions && info.permissions.push === false) throw new ErrorValidacion('La clave no tiene permiso para escribir en el repositorio.');
    await guardarConfigNube(c);
    if (estado.pendienteNube) { if (subiendo) await subiendo; await subirAhora(); }
    return { ok: true };
  }

  async function desconectarNube() {
    await guardarConfigNube(null);
    shaNube = null;
    avisarNube({ estado: 'apagado', mensaje: '' });
  }

  // Si se vuelve a la pestaña, se suben pendientes o se traen cambios de otra computadora.
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !estado || !configNube() || subiendo) return;
      if (estado.pendienteNube) programarSubida(0);
    });
  } catch { /* sin documento */ }

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
    if (configNube()) copia.pendienteNube = true;
    await guardarEstado(copia);
    estado = copia;
    programarSubida();
    return resultado;
  }

  // ── Validaciones (las mismas que la versión con servidor) ──

  function texto(valor, campo, { obligatorio = true, max = 200 } = {}) {
    const v = String(valor ?? '').trim().replace(/\s+/g, ' ');
    if (obligatorio && !v) throw new ErrorValidacion(`Falta completar: ${campo}.`);
    if (v.length > max) throw new ErrorValidacion(`${campo}: máximo ${max} caracteres.`);
    return v;
  }
  // "20% del nominal" → { porcentaje: 20, base: 'nominal' }
  function leerRegla(regla) {
    const t = String(regla || '');
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*%/);
    const base = /nominal/i.test(t) ? 'nominal' : /l[ií]quido/i.test(t) ? 'liquido' : null;
    return { porcentaje: m ? Number(m[1].replace(',', '.')) : null, base };
  }
  // Deja la regla escrita siempre igual; un porcentaje tiene que decir si es sobre el nominal o el líquido.
  function reglaCanonica(regla, { exigirBase = true } = {}) {
    const t = texto(regla, 'regla', { obligatorio: false, max: 60 });
    const { porcentaje, base } = leerRegla(t);
    if (porcentaje == null) return t;
    if (!(porcentaje > 0 && porcentaje <= 100)) throw new ErrorValidacion('El porcentaje tiene que estar entre 0 y 100.');
    if (!base) {
      if (exigirBase) throw new ErrorValidacion(`Indicá si el ${String(porcentaje).replace('.', ',')}% es sobre el sueldo nominal o sobre el líquido.`);
      return t;
    }
    return `${String(porcentaje).replace('.', ',')}% ${base === 'nominal' ? 'Nominal' : 'Líquido'}`;
  }

  const MEDIOS_COBRO = ['Depósito en cuenta bancaria', 'Mi Dinero', 'Prex', 'Abitab', 'RedPagos', 'Giro', 'Efectivo', 'Otro'];
  // Documento, medio de cobro y cuenta del beneficiario (solo judiciales; todo opcional).
  function datosBeneficiario(datos) {
    const medio = texto(datos.beneficiario_cobro, 'medio de cobro', { obligatorio: false, max: 40 });
    if (medio && !MEDIOS_COBRO.includes(medio)) throw new ErrorValidacion('Elegí un medio de cobro de la lista.');
    return {
      beneficiario_doc: texto(datos.beneficiario_doc, 'documento del beneficiario', { obligatorio: false, max: 20 }).replace(/[.\-\s]/g, ''),
      beneficiario_cobro: medio,
      beneficiario_cuenta: texto(datos.beneficiario_cuenta, 'cuenta / detalle de cobro', { obligatorio: false, max: 120 }),
    };
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
      entidades: [...estado.entidades].sort(porNombre).map((x) => ({ ...x, pasa_saldo: pasaSaldo(x) })),
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
      return { ...c, retenciones: rs.length, total: rs.reduce((a, r) => a + (r.importe_total || 0), 0), descontado: rs.reduce((a, r) => a + descontadoDe(estado, r.id), 0) };
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

  // Qué pasa con cada entidad de un mes al otro:
  // - judiciales: se pueden repetir todos los meses y el saldo pendiente pasa al mes siguiente;
  // - "Otros descuentos" (adelantos o ajustes de sueldo pagados de más): no se repite, pero lo que falta pasa al mes siguiente hasta quedar en 0;
  // - el resto de las comerciales: se cargan cada mes, sin repetir ni pasar saldo.
  const TIPOS_ENTIDAD = ['judicial', 'comercial', 'otros'];
  const sePuedeRepetir = (ent) => Boolean(ent && ent.tipo === 'judicial');
  const pasaSaldo = (ent) => Boolean(ent && (ent.tipo === 'judicial' || ent.tipo === 'otros'));

  function repiteActiva(r) {
    const t = r.mensual ? r : r.origen_id ? estado.retenciones.find((x) => x.id === r.origen_id) : null;
    if (!sePuedeRepetir(estado.entidades.find((x) => x.id === r.entidad_id))) return false;
    return Boolean(t && !t.baja && (!t.hasta || t.hasta > mesDeHoy()));
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
      // Con con_saldo, también entran las de meses anteriores que todavía tienen saldo (pasan al mes siguiente hasta quedar en 0).
      .filter((r) => !per || r.periodo === per || (f.con_saldo && r.periodo < per))
      .filter((r) => !TIPOS_ENTIDAD.includes(f.tipo) || ent.get(r.entidad_id).tipo === f.tipo)
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
          regla: reglaCanonica(r.regla, { exigirBase: false }),
          ...leerRegla(r.regla),
          // Las de porcentaje sin importe no tienen tope: se carga lo que se logró descontar en cada empresa.
          sin_tope: r.importe_total == null && leerRegla(r.regla).porcentaje != null,
          a_definir: r.importe_total == null && leerRegla(r.regla).porcentaje == null,
          pendiente: r.importe_total == null ? null : r.importe_total - real,
          completa: r.importe_total != null && real >= r.importe_total,
          arrastre: Boolean(per && r.periodo < per),
          pasa_saldo: pasaSaldo(e),
          repite: repiteActiva(r),
          _hayFiltrados: fil.length > 0,
        };
      })
      .filter((x) => !x.arrastre || (x.pasa_saldo && (x.a_definir || x.pendiente > 0)))
      .filter((x) => !filtraDescuentos || x._hayFiltrados)
      .sort((a, b) => b.periodo.localeCompare(a.periodo) || a.colaborador.localeCompare(b.colaborador, 'es') || a.entidad.localeCompare(b.entidad, 'es') || a.id - b.id);
    filas.forEach((x) => delete x._hayFiltrados);
    return filtrarTexto(filas, f.q, (x) => [x.colaborador, x.cedula, x.entidad, x.concepto, x.beneficiario, x.beneficiario_doc, x.expediente]);
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
      const tot = rets.get(d.retencion_id).importe_total;
      saldoDespues.set(d.id, tot == null ? null : tot - suma);
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
    const filas = listarRetenciones({ periodo: periodo(mes), con_saldo: true });
    // De lo que viene de meses anteriores cuenta solo el saldo con que entró a este mes.
    const antesDelMes = (x) => estado.descuentos.filter((d) => d.retencion_id === x.id && d.fecha.slice(0, 7) < mes).reduce((a, d) => a + d.importe, 0);
    const previo = new Map(filas.filter((x) => x.arrastre).map((x) => [x.id, antesDelMes(x)]));
    const saldoAnterior = filas.filter((x) => x.arrastre).reduce((a, x) => a + (x.importe_total || 0) - previo.get(x.id), 0);
    const pactado = filas.reduce((a, x) => a + (x.importe_total || 0) - (previo.get(x.id) || 0), 0);
    const retenido = filas.reduce((a, x) => a + x.descontado_real - (previo.get(x.id) || 0), 0);
    return { periodo: mes, sinTope: filas.filter((x) => x.sin_tope).length, aDefinir: filas.filter((x) => x.a_definir).length, ordenes: filas.length, arrastradas: filas.filter((x) => x.arrastre).length, saldoAnterior, completas: filas.filter((x) => x.completa).length, pactado, retenido, disponible: pactado - (retenido - filas.filter((x) => x.sin_tope).reduce((a, x) => a + x.descontado_real, 0)), retenciones: filas };
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
    if (!TIPOS_ENTIDAD.includes(tipo)) throw new ErrorValidacion('Indicá si la entidad es judicial, comercial u otros descuentos.');
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
      regla: reglaCanonica(datos.regla),
      importe_total: null,
      concepto: texto(datos.concepto, 'concepto', { obligatorio: false }),
      expediente: texto(datos.expediente, 'expediente / juzgado', { obligatorio: false }),
      beneficiario: entidad.tipo === 'judicial' ? texto(datos.beneficiario, 'beneficiario') : null,
      ...(entidad.tipo === 'judicial' ? datosBeneficiario(datos) : {}),
      cargado_por: texto(datos.cargado_por, 'quién la cargó', { max: 80 }),
      creado_en: ahora(),
      ...(sePuedeRepetir(entidad) ? datosMensual(datos) : {}),
    };
    // Si la orden es un porcentaje (p. ej. "25% Nominal"), el importe puede quedar a definir.
    if (datos.importe_total == null || datos.importe_total === '') {
      if (!fila.regla) throw new ErrorValidacion('Ingresá el importe total, o la regla (por ejemplo "25% Nominal") si todavía no se sabe el importe.');
    } else {
      fila.importe_total = importe(datos.importe_total, 'el importe total');
    }
    return modificar((e) => { const id = e.sig++; e.retenciones.push({ id, ...fila }); return { id }; });
  }

  // ── Retenciones que se repiten todos los meses ──
  // La retención original ("plantilla") lleva mensual=true; cada mes siguiente se crea una copia con origen_id.

  function datosMensual(datos) {
    if (!datos.mensual) return {};
    const hasta = datos.hasta ? periodo(datos.hasta) : null;
    if (hasta && hasta < periodo(datos.periodo)) throw new ErrorValidacion('El mes de fin no puede ser anterior al período.');
    return { mensual: true, hasta };
  }

  const mesDeHoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  function mesSiguiente(m) { const [a, x] = m.split('-').map(Number); return x === 12 ? `${a + 1}-01` : `${a}-${String(x + 1).padStart(2, '0')}`; }
  const esPorcentaje = (regla) => /%/.test(regla || '');

  // Copias mensuales que faltan crear hasta el mes actual.
  function mensualesFaltantes(e) {
    const limite = mesDeHoy();
    const hay = new Set(e.retenciones.filter((r) => r.origen_id).map((r) => `${r.origen_id}|${r.periodo}`));
    const faltan = [];
    const ent = new Map(e.entidades.map((x) => [x.id, x]));
    for (const t of e.retenciones.filter((r) => r.mensual && sePuedeRepetir(ent.get(r.entidad_id)))) {
      for (let m = mesSiguiente(t.periodo); m <= limite; m = mesSiguiente(m)) {
        if ((t.hasta && m > t.hasta) || (t.baja && m >= t.baja)) break;
        if (hay.has(`${t.id}|${m}`) || (t.omitidos || []).includes(m)) continue;
        faltan.push({
          colaborador_id: t.colaborador_id, entidad_id: t.entidad_id, periodo: m, regla: t.regla || '',
          importe_total: esPorcentaje(t.regla) ? null : t.importe_total,
          concepto: t.concepto || '', expediente: t.expediente || '', beneficiario: t.beneficiario,
          ...(t.beneficiario_doc ? { beneficiario_doc: t.beneficiario_doc } : {}),
          ...(t.beneficiario_cobro ? { beneficiario_cobro: t.beneficiario_cobro } : {}),
          ...(t.beneficiario_cuenta ? { beneficiario_cuenta: t.beneficiario_cuenta } : {}),
          cargado_por: 'Automática (se repite cada mes)', creado_en: ahora(), origen_id: t.id,
        });
      }
    }
    return faltan;
  }

  // La entidad "Otros descuentos" se cargó como comercial: pasa a su propio tipo.
  const otrosComoComercial = (e) => e.entidades.filter((x) => x.tipo === 'comercial' && normalizar(x.nombre) === 'otros descuentos');

  async function crearMensuales() {
    if (otrosComoComercial(estado).length) await modificar((e) => { otrosComoComercial(e).forEach((x) => { x.tipo = 'otros'; delete x.pasa_saldo; }); });
    if (!mensualesFaltantes(estado).length) return;
    await modificar((e) => { for (const r of mensualesFaltantes(e)) e.retenciones.push({ id: e.sig++, ...r }); });
  }

  // Deja de repetir una retención mensual desde el mes que viene (lo ya creado queda).
  function darDeBaja(id) {
    const r = estado.retenciones.find((x) => x.id === Number(id));
    if (!r) throw new ErrorValidacion('La retención no existe.', 404);
    const tId = r.mensual ? r.id : r.origen_id;
    if (!tId || !repiteActiva(r)) throw new ErrorValidacion('Esta retención no se repite todos los meses.');
    const desde = mesSiguiente(mesDeHoy());
    return modificar((e) => { e.retenciones.find((x) => x.id === tId).baja = desde; return { ok: true, desde }; });
  }

  // Cambia los datos del beneficiario de una retención judicial (y de sus copias mensuales).
  function editarBeneficiario(id, datos) {
    const n = Number(id);
    const r = estado.retenciones.find((x) => x.id === n);
    if (!r) throw new ErrorValidacion('La retención no existe.', 404);
    if (estado.entidades.find((x) => x.id === r.entidad_id).tipo !== 'judicial') throw new ErrorValidacion('Solo las retenciones judiciales tienen beneficiario.');
    const cambios = { beneficiario: texto(datos.beneficiario, 'nombre y apellido del beneficiario'), ...datosBeneficiario(datos) };
    const familia = r.mensual ? r.id : r.origen_id;
    return modificar((e) => {
      let cuantas = 0;
      for (const x of e.retenciones) {
        if (x.id === n || (familia && (x.id === familia || x.origen_id === familia))) { Object.assign(x, cambios); cuantas += 1; }
      }
      return { ok: true, retenciones: cuantas };
    });
  }

  // Define (o corrige) el importe total de una retención; nunca por debajo de lo ya descontado.
  function definirImporte(id, datos) {
    const n = Number(id);
    const ret = estado.retenciones.find((r) => r.id === n);
    if (!ret) throw new ErrorValidacion('La retención no existe.', 404);
    const total = importe(datos.importe_total, 'el importe total');
    if (total < descontadoDe(estado, n)) throw new ErrorValidacion('El importe total no puede ser menor a lo que ya se descontó.', 409);
    return modificar((e) => { e.retenciones.find((r) => r.id === n).importe_total = total; return { ok: true }; });
  }

  // Agrega retenciones desde un archivo de importación (no borra nada de lo que ya hay).
  // Crea los colaboradores y entidades que falten; no repite una retención ya cargada.
  function importarRetenciones(datos) {
    if (!datos || datos.tipo !== 'importacion-retenciones' || !Array.isArray(datos.retenciones || datos.colaboradores)
      || (datos.retenciones && !Array.isArray(datos.retenciones)) || (datos.empresas && !Array.isArray(datos.empresas)) || (datos.colaboradores && !Array.isArray(datos.colaboradores))) {
      throw new ErrorValidacion('El archivo no es una importación de retenciones.');
    }
    return modificar((e) => {
      const res = { retenciones: 0, colaboradores: 0, entidades: 0, repetidas: 0, ejemplosQuitados: Boolean(e.ejemplos) };
      // Los datos de ejemplo no se mezclan con los reales.
      if (e.ejemplos) { e.colaboradores = []; e.entidades = []; e.empresas = []; e.retenciones = []; e.descuentos = []; }
      // Empresas que falten (no repite nombres ya cargados).
      res.empresas = 0;
      for (const nom of datos.empresas || []) {
        const nombre = texto(nom, 'nombre de la empresa', { obligatorio: false });
        if (!nombre || e.empresas.some((x) => mismoNombre(x.nombre, nombre))) continue;
        e.empresas.push({ id: e.sig++, nombre });
        res.empresas += 1;
      }
      const colPorCi = new Map(e.colaboradores.map((c) => [c.cedula, c]));
      // Colaboradores sueltos (listado de funcionarios): se agregan los que falten; los ya cargados no se tocan.
      for (const x of datos.colaboradores || []) {
        const ci = String(x.cedula || '').replace(/\D/g, '');
        if (!/^\d{6,8}$/.test(ci)) throw new ErrorValidacion(`Cédula inválida en la importación: ${x.cedula}`);
        if (colPorCi.has(ci)) { res.colaboradoresYa = (res.colaboradoresYa || 0) + 1; continue; }
        const col = { id: e.sig++, cedula: ci, nombre: texto(x.nombre, 'nombre') };
        e.colaboradores.push(col); colPorCi.set(ci, col); res.colaboradores += 1;
      }
      const entPorNombre = new Map(e.entidades.map((x) => [normalizar(x.nombre), x]));
      const claveRet = (r) => [r.colaborador_id, r.entidad_id, r.periodo, r.importe_total ?? '', reglaCanonica(r.regla, { exigirBase: false }), r.concepto || ''].join('|');
      const existentes = new Map(e.retenciones.map((r) => [claveRet(r), r]));
      for (const x of datos.retenciones || []) {
        const ci = String(x.cedula || '').replace(/\D/g, '');
        if (!/^\d{6,8}$/.test(ci)) throw new ErrorValidacion(`Cédula inválida en la importación: ${x.cedula}`);
        let col = colPorCi.get(ci);
        if (!col) { col = { id: e.sig++, cedula: ci, nombre: texto(x.nombre, 'nombre') }; e.colaboradores.push(col); colPorCi.set(ci, col); res.colaboradores += 1; }
        const tipo = TIPOS_ENTIDAD.includes(x.tipo_entidad) ? x.tipo_entidad : 'comercial';
        let ent = entPorNombre.get(normalizar(x.entidad));
        if (!ent) { ent = { id: e.sig++, nombre: texto(x.entidad, 'entidad'), tipo }; e.entidades.push(ent); entPorNombre.set(normalizar(ent.nombre), ent); res.entidades += 1; }
        const r = {
          colaborador_id: col.id, entidad_id: ent.id, periodo: periodo(x.periodo),
          regla: reglaCanonica(x.regla),
          importe_total: x.importe_total == null ? null : importe(x.importe_total, 'el importe total'),
          concepto: texto(x.concepto, 'concepto', { obligatorio: false }),
          expediente: texto(x.expediente, 'expediente', { obligatorio: false }),
          beneficiario: ent.tipo === 'judicial' ? (texto(x.beneficiario, 'beneficiario', { obligatorio: false }) || 'A completar') : null,
          ...(ent.tipo === 'judicial' ? datosBeneficiario(x) : {}),
          cargado_por: texto(x.cargado_por || 'Importación', 'quién la cargó', { max: 80 }),
          creado_en: ahora(),
          ...(sePuedeRepetir(ent) ? datosMensual(x) : {}),
        };
        if (r.importe_total == null && !r.regla) throw new ErrorValidacion(`Falta el importe o la regla de ${col.nombre}.`);
        const ya = existentes.get(claveRet(r));
        if (ya) {
          res.repetidas += 1;
          // Si ya estaba cargada sin repetirse, el archivo puede marcarla como mensual.
          if (r.mensual && !ya.mensual && !ya.origen_id) { ya.mensual = true; ya.hasta = r.hasta; res.mensualesNuevas = (res.mensualesNuevas || 0) + 1; }
          // Completa el beneficiario si todavía decía "A completar".
          if (ya.beneficiario === 'A completar' && r.beneficiario && r.beneficiario !== 'A completar') {
            const datosB = { beneficiario: r.beneficiario, beneficiario_doc: r.beneficiario_doc, beneficiario_cobro: r.beneficiario_cobro, beneficiario_cuenta: r.beneficiario_cuenta };
            const familia = ya.mensual ? ya.id : ya.origen_id;
            for (const z of e.retenciones) if (z === ya || (familia && (z.id === familia || z.origen_id === familia) && z.beneficiario === 'A completar')) Object.assign(z, datosB);
            res.beneficiarios = (res.beneficiarios || 0) + 1;
          }
          continue;
        }
        const nueva = { id: e.sig++, ...r };
        existentes.set(claveRet(r), nueva);
        e.retenciones.push(nueva);
        res.retenciones += 1;
      }
      e.ejemplos = false;
      return res;
    });
  }

  // Una empresa con descuentos no se borra, para no perder el historial.
  function eliminarEmpresa(id) {
    const n = Number(id);
    if (!estado.empresas.some((x) => x.id === n)) throw new ErrorValidacion('La empresa no existe.', 404);
    const usos = estado.descuentos.filter((d) => d.empresa_id === n).length;
    if (usos) throw new ErrorValidacion(`No se puede borrar: tiene ${usos} ${usos === 1 ? 'descuento registrado' : 'descuentos registrados'}.`, 409);
    return modificar((e) => { e.empresas = e.empresas.filter((x) => x.id !== n); return { ok: true }; });
  }

  function eliminarRetencion(id) {
    const n = Number(id);
    if (!estado.retenciones.some((r) => r.id === n)) throw new ErrorValidacion('La retención no existe.', 404);
    if (estado.descuentos.some((d) => d.retencion_id === n)) throw new ErrorValidacion('No se puede eliminar una retención que ya tiene descuentos.', 409);
    return modificar((e) => {
      const r = e.retenciones.find((x) => x.id === n);
      // Si era una copia mensual, que no se vuelva a crear para ese mes.
      const t = r.origen_id && e.retenciones.find((x) => x.id === r.origen_id);
      if (t) t.omitidos = [...(t.omitidos || []), r.periodo];
      // Si era la original, sus copias pasan a ser independientes.
      if (r.mensual) e.retenciones.forEach((x) => { if (x.origen_id === n) delete x.origen_id; });
      e.retenciones = e.retenciones.filter((x) => x.id !== n);
      return { ok: true };
    });
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
      if (ret.importe_total == null) {
        if (leerRegla(ret.regla).porcentaje == null) throw new ErrorValidacion(`Primero definí el importe total de esta retención (regla: ${ret.regla || 'sin regla'}).`, 409);
        const id = e.sig++; // porcentaje sin tope
        e.descuentos.push({ id, ...fila, creado_en: ahora() });
        return { id };
      }
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
      if (!cols.has(r.colaborador_id) || !ent.has(r.entidad_id) || !(r.importe_total == null ? Boolean(r.regla) : Number.isInteger(r.importe_total) && r.importe_total > 0)) throw new ErrorValidacion('El respaldo tiene una retención con datos dañados.');
      if (ent.get(r.entidad_id).tipo === 'judicial' && !String(r.beneficiario || '').trim()) throw new ErrorValidacion('El respaldo tiene una retención judicial sin beneficiario.');
    }
    const rets = new Map(e.retenciones.map((r) => [r.id, r]));
    for (const d of e.descuentos) {
      if (!rets.has(d.retencion_id) || !emps.has(d.empresa_id) || !(Number.isInteger(d.importe) && d.importe > 0)) throw new ErrorValidacion('El respaldo tiene un descuento con datos dañados.');
    }
    for (const r of e.retenciones) {
      if (r.importe_total != null && descontadoDe(e, r.id) > r.importe_total) throw new ErrorValidacion('El respaldo tiene descuentos que superan el total de una retención.');
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
      nube: { ...estadoNube, pendiente: Boolean(estado.pendienteNube) },
    };
  }

  async function exportarRespaldo() {
    const copia = { ...structuredClone(estado), sistema: 'Sistema de Retenciones', exportado: ahora() };
    delete copia.ultimoRespaldo;
    delete copia.pendienteNube;
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
    nuevo.pendienteNube = Boolean(configNube());
    await guardarEstado(nuevo);
    estado = nuevo;
    programarSubida(0);
    return infoDatos();
  }

  async function borrarTodo() {
    const nuevo = estadoVacio();
    nuevo.modificado = ahora();
    nuevo.pendienteNube = Boolean(configNube());
    await guardarEstado(nuevo);
    estado = nuevo;
    programarSubida(0);
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

  const TIPO_TXT = { judicial: 'Judicial', comercial: 'Comercial', otros: 'Otros descuentos' };

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
    const filas = listarRetenciones({ ...f, con_saldo: true });
    const columnas = [
      { titulo: 'Período', ancho: 10 }, { titulo: 'Cédula', ancho: 12 }, { titulo: 'Colaborador', ancho: 26 }, { titulo: 'Entidad', ancho: 26 },
      { titulo: 'Tipo', ancho: 11 }, { titulo: 'Concepto', ancho: 24 }, { titulo: 'Expediente / Juzgado', ancho: 22 }, { titulo: 'Beneficiario', ancho: 24 },
      { titulo: 'Doc. beneficiario', ancho: 14 }, { titulo: 'Medio de cobro', ancho: 22 }, { titulo: 'Cuenta / detalle', ancho: 24 },
      { titulo: 'Regla', ancho: 16 }, { titulo: '% a retener', ancho: 11 }, { titulo: 'Sobre', ancho: 10 }, { titulo: 'Total', tipo: 'moneda', ancho: 14 }, { titulo: 'Descontado', tipo: 'moneda', ancho: 14 }, { titulo: 'Falta descontar', tipo: 'moneda', ancho: 15 },
      { titulo: 'Empresas donde se retuvo', ancho: 28 }, { titulo: 'Cargado por', ancho: 16 },
    ];
    const cuerpo = filas.map((x) => [x.periodo, x.cedula, x.colaborador, x.entidad, TIPO_TXT[x.tipo], x.concepto, x.expediente, x.beneficiario || '', x.beneficiario_doc || '', x.beneficiario_cobro || '', x.beneficiario_cuenta || '', x.regla || '', x.porcentaje == null ? '' : `${String(x.porcentaje).replace('.', ',')}%`, x.base === 'nominal' ? 'Nominal' : x.base === 'liquido' ? 'Líquido' : '', x.sin_tope ? 'Sin tope' : x.importe_total == null ? 'A definir' : x.importe_total, x.descontado, x.pendiente == null ? '' : x.pendiente, x.empresas, x.cargado_por]);
    const suma = (k) => filas.reduce((a, x) => a + (x[k] || 0), 0);
    cuerpo.push({ negrita: true, celdas: ['TOTAL', '', `${filas.length} retenciones`, '', '', '', '', '', '', '', '', '', '', '', suma('importe_total'), suma('descontado'), suma('pendiente'), '', ''] });
    return { columnas, filas: cuerpo, titulo: 'Planilla de retenciones', hoja: 'Planilla' };
  }

  // Por entidad acreedora: cada funcionario con lo que tenía para descontar y lo descontado.
  // Banco y número de cuenta del beneficiario. En los depósitos el banco viene al principio de la cuenta ("BROU 0012…").
  function cobroBeneficiario(x) {
    const cuenta = String(x.beneficiario_cuenta || '').trim();
    const medio = x.beneficiario_cobro || '';
    const m = /^dep[oó]sito/i.test(medio) && cuenta.match(/^([A-Za-zÁÉÍÓÚáéíóúÑñ][\wÁÉÍÓÚáéíóúÑñ.-]*)\s+(.+)$/);
    return m ? { banco: m[1], cuenta: m[2] } : { banco: medio, cuenta };
  }

  function reportePorEntidad(f) {
    const mes = f.periodo ? periodo(f.periodo) : null;
    const antes = (id) => (mes ? estado.descuentos.filter((d) => d.retencion_id === id && d.fecha.slice(0, 7) < mes).reduce((a, d) => a + d.importe, 0) : 0);
    const grupos = new Map();
    for (const x of listarRetenciones({ ...f, con_saldo: true })) {
      if (!grupos.has(x.entidad)) grupos.set(x.entidad, { entidad: x.entidad, tipo: x.tipo, filas: [], para_descontar: 0, descontado: 0, falta: 0 });
      const g = grupos.get(x.entidad);
      const previo = x.arrastre ? antes(x.id) : 0;
      const para = x.importe_total == null ? null : x.importe_total - previo;
      const desc = (f.tipo_descuento || f.empresa_id ? x.descontado : x.descontado_real) - (f.tipo_descuento || f.empresa_id ? 0 : previo);
      g.filas.push({ id: x.id, cedula: x.cedula, colaborador: x.colaborador, periodo: x.periodo, arrastre: x.arrastre, regla: x.regla, porcentaje: x.porcentaje, base: x.base,
        sin_tope: x.sin_tope, a_definir: x.a_definir, para_descontar: para, descontado: desc, falta: x.pendiente,
        beneficiario: x.beneficiario || '', beneficiario_doc: x.beneficiario_doc || '', ...(x.beneficiario ? cobroBeneficiario(x) : { banco: '', cuenta: '' }) });
      g.para_descontar += para || 0; g.descontado += desc; g.falta += x.pendiente || 0;
    }
    const lista = [...grupos.values()].sort((a, b) => a.entidad.localeCompare(b.entidad, 'es'));
    lista.forEach((g) => g.filas.sort((a, b) => a.colaborador.localeCompare(b.colaborador, 'es')));
    return { grupos: lista, para_descontar: lista.reduce((a, g) => a + g.para_descontar, 0), descontado: lista.reduce((a, g) => a + g.descontado, 0), falta: lista.reduce((a, g) => a + g.falta, 0) };
  }

  function armarPorEntidad(f) {
    const rep = reportePorEntidad(f);
    const columnas = [
      { titulo: 'Entidad acreedora', ancho: 26 }, { titulo: 'Cédula', ancho: 12 }, { titulo: 'Nombre y apellido', ancho: 30 },
      { titulo: 'Período', ancho: 10 }, { titulo: 'Para descontar', tipo: 'moneda', ancho: 15 }, { titulo: 'Regla', ancho: 16 },
      { titulo: 'Descontado', tipo: 'moneda', ancho: 14 }, { titulo: 'Falta', tipo: 'moneda', ancho: 14 },
      { titulo: 'Beneficiario', ancho: 28 }, { titulo: 'Doc. beneficiario', ancho: 14 }, { titulo: 'Banco / medio de cobro', ancho: 20 }, { titulo: 'N° de cuenta', ancho: 20 },
    ];
    const cuerpo = [];
    for (const g of rep.grupos) {
      for (const x of g.filas) {
        cuerpo.push([g.entidad, x.cedula, x.colaborador, x.periodo + (x.arrastre ? ' (saldo)' : ''),
          x.para_descontar == null ? (x.regla || 'A definir') : x.para_descontar, x.regla || '', x.descontado, x.falta == null ? '' : x.falta,
          x.beneficiario, x.beneficiario_doc, x.banco, x.cuenta]);
      }
      cuerpo.push({ negrita: true, celdas: [`Subtotal ${g.entidad}`, '', `${g.filas.length} ${g.filas.length === 1 ? 'funcionario' : 'funcionarios'}`, '', g.para_descontar, '', g.descontado, g.falta, '', '', '', ''] });
    }
    cuerpo.push({ negrita: true, celdas: ['TOTAL', '', '', '', rep.para_descontar, '', rep.descontado, rep.falta, '', '', '', ''] });
    return { columnas, filas: cuerpo, titulo: 'Retenciones por entidad acreedora', hoja: 'Por entidad' };
  }

  function armarAbonar(f) {
    const rep = reporteAbonar(f);
    const porEntidad = rep.agrupar === 'entidad';
    const columnas = [
      { titulo: porEntidad ? 'Entidad' : 'Beneficiario', ancho: 28 }, { titulo: 'Tipo', ancho: 11 }, { titulo: 'Cédula', ancho: 12 }, { titulo: 'Colaborador', ancho: 26 },
      { titulo: porEntidad ? 'Beneficiario' : 'Entidad', ancho: 26 }, { titulo: 'Concepto', ancho: 24 }, { titulo: 'Expediente / Juzgado', ancho: 22 }, { titulo: 'Período', ancho: 10 },
      { titulo: 'Doc. beneficiario', ancho: 14 }, { titulo: 'Medio de cobro', ancho: 22 }, { titulo: 'Cuenta / detalle', ancho: 24 },
      { titulo: 'A abonar', tipo: 'moneda', ancho: 15 },
    ];
    const cuerpo = [];
    for (const g of rep.grupos) {
      for (const x of g.detalle) cuerpo.push([g.grupo, TIPO_TXT[x.tipo], x.cedula, x.colaborador, porEntidad ? (x.beneficiario || '') : x.entidad, x.concepto, x.expediente, x.periodo, x.beneficiario_doc || '', x.beneficiario_cobro || '', x.beneficiario_cuenta || '', x.descontado]);
      cuerpo.push({ negrita: true, celdas: [`Subtotal ${g.grupo}`, '', '', `${g.ordenes} ${g.ordenes === 1 ? 'orden' : 'órdenes'}`, '', '', '', '', '', '', '', g.abonar] });
    }
    cuerpo.push({ negrita: true, celdas: ['TOTAL A ABONAR', '', '', '', '', '', '', '', '', '', '', rep.total] });
    return { columnas, filas: cuerpo, titulo: `A abonar por ${porEntidad ? 'entidad' : 'beneficiario'}`, hoja: 'A abonar' };
  }

  // ── Enrutador: mismas rutas que el servidor ──

  async function manejar(metodo, rutaCompleta, cuerpo) {
    await iniciar();
    await crearMensuales();
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
      if (ruta === '/api/reportes/planilla') return listarRetenciones({ ...f, con_saldo: true });
      if (ruta === '/api/reportes/abonar') return reporteAbonar(f);
      if (ruta === '/api/reportes/entidades') return reportePorEntidad(f);
      if (ruta === '/api/datos') return infoDatos();
    }
    if (metodo === 'POST') {
      if (ruta === '/api/entidades') return crearEntidad(cuerpo || {});
      if (ruta === '/api/colaboradores') return crearColaborador(cuerpo || {});
      if (ruta === '/api/empresas') return crearEmpresa(cuerpo || {});
      if (ruta === '/api/retenciones') return crearRetencion(cuerpo || {});
      if (ruta === '/api/descuentos') return crearDescuento(cuerpo || {});
      if (ruta === '/api/importar') return importarRetenciones(cuerpo || {});
      if ((m = ruta.match(/^\/api\/retenciones\/(\d+)\/importe$/))) return definirImporte(m[1], cuerpo || {});
      if ((m = ruta.match(/^\/api\/retenciones\/(\d+)\/baja$/))) return darDeBaja(m[1]);
      if ((m = ruta.match(/^\/api\/retenciones\/(\d+)\/beneficiario$/))) return editarBeneficiario(m[1], cuerpo || {});
    }
    if (metodo === 'DELETE') {
      if ((m = ruta.match(/^\/api\/retenciones\/(\d+)$/))) return eliminarRetencion(m[1]);
      if ((m = ruta.match(/^\/api\/descuentos\/(\d+)$/))) return eliminarDescuento(m[1]);
      if ((m = ruta.match(/^\/api\/empresas\/(\d+)$/))) return eliminarEmpresa(m[1]);
    }
    throw new ErrorValidacion('Ruta no encontrada.', 404);
  }

  async function descargar(rutaCompleta) {
    await iniciar();
    const url = new URL(rutaCompleta, 'http://local');
    const f = Object.fromEntries([...url.searchParams].filter(([, v]) => v));
    const rep = url.pathname.endsWith('planilla') ? armarPlanilla(f) : url.pathname.endsWith('entidades') ? armarPorEntidad(f) : armarAbonar(f);
    if (f.formato === 'csv') return csv(rep.columnas, rep.filas);
    return xlsx({ ...rep, subtitulo: `${textoFiltros(f)} · Generado el ${new Date().toLocaleString('es-UY')}` });
  }

  window.backendLocal = {
    ErrorValidacion,
    cuenta, crearCuenta, ingresar, cambiarContrasena, olvideContrasena, salir,
    manejar,
    descargar,
    exportarRespaldo: async () => { await iniciar(); return exportarRespaldo(); },
    importarRespaldo: async (t) => { await iniciar(); return importarRespaldo(t); },
    borrarTodo: async () => { await iniciar(); return borrarTodo(); },
    conectarNube: async (repo, token, modo) => { await iniciar(); return conectarNube(repo, token, modo); },
    desconectarNube,
    cambiarClaveNube: async (token) => { await iniciar(); return cambiarClaveNube(token); },
    guardarEnNubeAhora: async () => { await iniciar(); if (estado.pendienteNube) { if (subiendo) await subiendo; await subirAhora(); } else { await sincronizarAlAbrir(); } return estadoNube; },
    estadoNube: () => estadoNube,
  };
})();
