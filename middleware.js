// Ingreso con Google antes de mostrar la página (Vercel Routing Middleware).
// Solo pasan las cuentas de Google del dominio de la empresa.
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   GOOGLE_CLIENT_ID      ID de cliente OAuth de Google Cloud
//   GOOGLE_CLIENT_SECRET  Secreto del cliente OAuth
//   SESSION_SECRET        Una frase larga al azar (30 caracteres o más)
//   ALLOWED_DOMAIN        Opcional. Por defecto: aglh.com.uy
//   GITHUB_TOKEN          Opcional. Clave de GitHub del repositorio de datos: así nadie la pega en su navegador.
//   DATA_REPO             Opcional. Por defecto: brunoperez1988/sistema-retenciones-datos
//   ADMIN_EMAILS          Opcional. Correos (separados por coma) que pueden restablecer la clave de administrador sin la de GitHub.
//
// Si falta alguna variable, la página no se muestra (falla cerrada).

import { LOGO_LETRAS, LOGO_HOJA } from './ingreso-logos.js';

const COOKIE = 'ret_sesion';
const COOKIE_ESTADO = 'ret_estado';
const DURACION_SEG = 7 * 24 * 60 * 60; // 7 días
const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (t) => {
  const s = t.replace(/-/g, '+').replace(/_/g, '/');
  return atob(s + '='.repeat((4 - (s.length % 4)) % 4));
};

async function firmar(texto, secreto) {
  const llave = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', llave, enc.encode(texto)));
}

function igualSeguro(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function leerCookie(req, nombre) {
  const h = req.headers.get('cookie') || '';
  for (const parte of h.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return '';
}

const cookie = (nombre, valor, maxAge) =>
  `${nombre}=${encodeURIComponent(valor)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function sesionValida(req, secreto) {
  const v = leerCookie(req, COOKIE);
  const i = v.lastIndexOf('.');
  if (i < 1) return null;
  const datos = v.slice(0, i);
  if (!igualSeguro(await firmar(datos, secreto), v.slice(i + 1))) return null;
  try {
    const { email, exp } = JSON.parse(deB64url(datos));
    return typeof exp === 'number' && exp > Date.now() / 1000 ? email : null;
  } catch { return null; }
}

const ICONO_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
const CANDADO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

// Pantalla de ingreso: panel verde con el logo a la izquierda y el botón a la derecha.
function pagina(estado, titulo, texto, extra = {}, conBoton = true) {
  const boton = conBoton ? `<a class="gbtn" href="/auth/login"><span>${ICONO_G}</span> Continuar con Google</a>` : '';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Control de Retenciones</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;grid-template-columns:1.1fr 1fr;background:#fbfbfa;color:#232426;font-family:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif}
.izq{background:linear-gradient(140deg,#2b2c2e 0%,#4b6409 55%,#5f7d0b 80%,#9abb0d 100%);color:#fff;padding:56px;display:flex;flex-direction:column;justify-content:space-between;gap:32px;position:relative;overflow:hidden}
.izq:after{content:"";position:absolute;right:-120px;bottom:-120px;width:380px;height:380px;border-radius:50%;border:2px solid rgba(255,255,255,.12)}
.logo{position:relative;width:220px;aspect-ratio:420/184}.logo img{position:absolute;inset:0;width:100%}.logo .l{filter:invert(1) brightness(1.15)}
.izq h2{font-size:34px;line-height:1.2;margin:0 0 12px;max-width:420px}.izq p{opacity:.85;max-width:380px;line-height:1.5;margin:0}
.pie{font-size:13px;opacity:.6}
.der{display:grid;place-items:center;padding:32px 16px}.f{width:min(360px,100%)}
h1{font-size:26px;margin:0 0 8px;color:#2b2c2e}.f>p{color:#63666a;margin:0 0 28px;line-height:1.5}
.gbtn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:13px 18px;border-radius:10px;background:#2b2c2e;color:#fff;font-weight:600;font-size:15px;text-decoration:none}
.gbtn:hover{background:#46484c}.gbtn:focus-visible{outline:3px solid #9abb0d;outline-offset:2px}.gbtn span{background:#fff;border-radius:6px;padding:4px;display:grid}
.nota{font-size:13px;color:#63666a;margin-top:18px;display:flex;gap:8px;align-items:center}
@media (max-width:800px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr}.izq{padding:28px 20px}.izq h2{font-size:22px}.logo{width:170px}.izq:after{display:none}}
@media (prefers-color-scheme:dark){body{background:#17181a;color:#eef0ea}h1{color:#eef0ea}.f>p,.nota{color:#a9acb1}.gbtn{background:#9abb0d;color:#17181a}.gbtn:hover{background:#b0d11a}}
</style></head>
<body><section class="izq"><div class="logo" role="img" aria-label="AGLH · Servicios Humanos Integrales"><img class="l" src="${LOGO_LETRAS}" alt=""><img src="${LOGO_HOJA}" alt=""></div>
<div><h2>Retenciones y descuentos, en un solo lugar.</h2><p>Judiciales, cooperativas y ANDA de todos los colaboradores, siempre al día.</p></div>
<div class="pie">AGLH · Servicios Humanos Integrales</div></section>
<main class="der"><div class="f"><h1>${titulo}</h1><p>${texto}</p>${boton}<div class="nota">${CANDADO} Acceso exclusivo para personal de AGLH</div></div></main></body></html>`;
  return new Response(html, { status: estado, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

export default async function middleware(req) {
  const url = new URL(req.url);
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secretoCliente, SESSION_SECRET: secreto } = process.env;
  const dominio = (process.env.ALLOWED_DOMAIN || 'aglh.com.uy').toLowerCase();
  if (!id || !secretoCliente || !secreto || secreto.length < 16) {
    // Solo se muestran los nombres de lo que falta, nunca los valores.
    const faltan = [!id && 'GOOGLE_CLIENT_ID', !secretoCliente && 'GOOGLE_CLIENT_SECRET', !secreto && 'SESSION_SECRET'].filter(Boolean);
    const corto = secreto && secreto.length < 16 ? '<br>SESSION_SECRET es muy corto: tiene que tener 16 caracteres o más.' : '';
    return pagina(503, 'Falta configurar el ingreso', `El acceso con Google todavía no está configurado en Vercel.${faltan.length ? `<br>Falta: <strong>${faltan.join(', ')}</strong>.` : ''}${corto}`, {}, false);
  }
  const redirect = `${url.origin}/auth/callback`;

  if (url.pathname === '/auth/logout') {
    return new Response(null, { status: 302, headers: { location: '/auth/login', 'set-cookie': cookie(COOKIE, '', 0) } });
  }

  if (url.pathname === '/auth/login') {
    const estado = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.search = new URLSearchParams({
      client_id: id, redirect_uri: redirect, response_type: 'code', scope: 'openid email',
      state: estado, hd: dominio, prompt: 'select_account',
    }).toString();
    return new Response(null, { status: 302, headers: { location: google.toString(), 'set-cookie': cookie(COOKIE_ESTADO, estado, 600) } });
  }

  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    const estado = url.searchParams.get('state') || '';
    const esperado = leerCookie(req, COOKIE_ESTADO);
    if (!code || !esperado || !igualSeguro(estado, esperado)) {
      return pagina(400, 'No se pudo ingresar', 'El ingreso venció o se interrumpió. Probá de nuevo.');
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: id, client_secret: secretoCliente, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    const tok = r.ok ? await r.json() : null;
    let datos = null;
    // El id_token llega directo de Google por HTTPS (canal servidor a servidor), así que se puede leer sin verificar la firma.
    try { datos = JSON.parse(deB64url(tok.id_token.split('.')[1])); } catch { /* respuesta inválida */ }
    const email = String(datos?.email || '').toLowerCase();
    const ok = datos && datos.aud === id && datos.email_verified === true
      && email.endsWith(`@${dominio}`) && String(datos.hd || '').toLowerCase() === dominio;
    if (!ok) {
      return pagina(403, 'Acceso no permitido', `Solo pueden entrar las cuentas <strong>@${dominio}</strong>.${email ? ` Ingresaste con ${email.replace(/[<>&"]/g, '')}: probá con tu correo de la empresa.` : ''}`,
        { 'set-cookie': cookie(COOKIE_ESTADO, '', 0) });
    }
    const carga = b64url(enc.encode(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + DURACION_SEG })));
    const valor = `${carga}.${await firmar(carga, secreto)}`;
    const h = new Headers({ location: '/' });
    h.append('set-cookie', cookie(COOKIE, valor, DURACION_SEG));
    h.append('set-cookie', cookie(COOKIE_ESTADO, '', 0));
    return new Response(null, { status: 302, headers: h });
  }

  const email = await sesionValida(req, secreto);
  if (!email) {
    if (url.pathname === '/auth/yo' || url.pathname.startsWith('/gh/')) {
      return new Response('{"error":"sin sesión"}', { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return pagina(401, 'Bienvenido', `Ingresá con tu correo de la empresa (<strong>@${dominio}</strong>) para continuar.`);
  }

  const tokenGithub = process.env.GITHUB_TOKEN || '';
  const repo = process.env.DATA_REPO || 'brunoperez1988/sistema-retenciones-datos';

  if (url.pathname === '/auth/yo') {
    const admins = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    return Response.json({ email, github: Boolean(tokenGithub), admin: admins.includes(email) }, { headers: { 'cache-control': 'no-store' } });
  }

  // Pasarela a GitHub: solo el repositorio de datos, con la clave guardada en Vercel.
  if (url.pathname.startsWith('/gh/')) {
    const ruta = url.pathname.slice(3);
    const base = `/repos/${repo}`;
    if (!tokenGithub) return Response.json({ error: 'Falta GITHUB_TOKEN' }, { status: 503 });
    if (ruta.includes('..') || (ruta !== base && !ruta.startsWith(`${base}/`))) return Response.json({ error: 'Ruta no permitida' }, { status: 403 });
    if (!['GET', 'PUT'].includes(req.method)) return Response.json({ error: 'Método no permitido' }, { status: 405 });
    const h = new Headers({ Authorization: `Bearer ${tokenGithub}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sistema-retenciones' });
    for (const n of ['accept', 'content-type', 'if-none-match']) { const v = req.headers.get(n); if (v) h.set(n, v); }
    const r = await fetch(`https://api.github.com${ruta}${url.search}`, { method: req.method, headers: h, body: req.method === 'PUT' ? await req.text() : undefined });
    const out = new Headers({ 'cache-control': 'no-store' });
    for (const n of ['content-type', 'etag', 'x-github-request-id']) { const v = r.headers.get(n); if (v) out.set(n, v); }
    return new Response(r.status === 304 ? null : r.body, { status: r.status, headers: out });
  }

  return new Response(null, { headers: { 'x-middleware-next': '1' } }); // sigue a la página
}
