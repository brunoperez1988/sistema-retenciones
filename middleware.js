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

function pagina(estado, titulo, texto, extra = {}) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titulo}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f4f2;color:#222;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{background:#fff;border-radius:12px;padding:32px;max-width:420px;box-shadow:0 2px 12px #0001;text-align:center}
a.b{display:inline-block;margin-top:16px;background:#2f8f86;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#18191a;color:#eee}main{background:#242526}}</style></head>
<body><main><h1 style="font-size:1.3rem">${titulo}</h1><p>${texto}</p></main></body></html>`;
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
    return pagina(503, 'Falta configurar el ingreso', `El acceso con Google todavía no está configurado en Vercel.${faltan.length ? `<br>Falta: <strong>${faltan.join(', ')}</strong>.` : ''}${corto}`);
  }
  const redirect = `${url.origin}/auth/callback`;
  const entrar = `<a class="b" href="/auth/login">Ingresar con Google</a>`;

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
      return pagina(400, 'No se pudo ingresar', `El ingreso venció o se interrumpió. Probá de nuevo.<br>${entrar}`);
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
      return pagina(403, 'Acceso no permitido', `Solo pueden entrar las cuentas @${dominio}.${email ? ` Ingresaste con ${email.replace(/[<>&"]/g, '')}.` : ''}<br>${entrar}`,
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
    return pagina(401, 'Control de Retenciones', `Ingresá con tu cuenta de Google @${dominio}.<br>${entrar}`);
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
