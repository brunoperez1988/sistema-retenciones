// Respaldo automático semanal (Vercel Cron, ver vercel.json → "crons").
// Cada lunes de madrugada guarda en el repositorio de datos una copia de los datos de cada empresa:
//   SHI  → respaldos/AAAA-MM-DD.json
//   AGLH → empresas/aglh/respaldos/AAAA-MM-DD.json
// La fecha es la del lunes de esa semana (hora de Uruguay). Si la copia de la semana ya existe no se repite,
// así que llamarla de más no hace nada malo. Las copias se descargan o recuperan desde la solapa Respaldo.
//
// Usa GITHUB_TOKEN y DATA_REPO, las mismas variables de la pasarela (middleware.js).
// Si en Vercel está CRON_SECRET, solo responde a quien la mande (Vercel la manda sola en el cron).

const EMPRESAS = [
  { clave: 'shi', nombre: 'SHI', origen: 'datos/retenciones.json', destino: 'respaldos/' },
  { clave: 'aglh', nombre: 'AGLH', origen: 'empresas/aglh/datos/retenciones.json', destino: 'empresas/aglh/respaldos/' },
];

const cabeceras = (token) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sistema-retenciones', Accept: 'application/vnd.github+json' });

// Lunes de la semana actual, en hora de Uruguay (UTC−3, sin horario de verano).
export function lunesDeLaSemana(ahora = new Date()) {
  const uy = new Date(ahora.getTime() - 3 * 3600 * 1000);
  const dia = (uy.getUTCDay() + 6) % 7; // 0 = lunes
  uy.setUTCDate(uy.getUTCDate() - dia);
  return uy.toISOString().slice(0, 10);
}

function aBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function respaldarEmpresa(empresa, { token, repo, fecha, fetch: f = fetch }) {
  const base = `https://api.github.com/repos/${repo}/contents/`;
  const destino = `${empresa.destino}${fecha}.json`;
  const ya = await f(base + destino, { method: 'GET', headers: cabeceras(token) });
  if (ya.ok) return { empresa: empresa.nombre, estado: 'ya estaba', archivo: destino };
  if (ya.status !== 404) throw new Error(`${empresa.nombre}: GitHub respondió ${ya.status} al revisar la copia.`);

  const r = await f(base + empresa.origen, { method: 'GET', headers: { ...cabeceras(token), Accept: 'application/vnd.github.raw+json' } });
  if (r.status === 404) return { empresa: empresa.nombre, estado: 'sin datos todavía' };
  if (!r.ok) throw new Error(`${empresa.nombre}: GitHub respondió ${r.status} al leer los datos.`);
  const datos = JSON.parse(await r.text());
  // Se marca de qué empresa es, así no se puede recuperar por error en la otra.
  const copia = { ...datos, sistema: 'Sistema de Retenciones', empresa_sistema: empresa.clave, exportado: new Date().toISOString().slice(0, 19).replace('T', ' '), respaldo_automatico: fecha };

  const p = await f(base + destino, {
    method: 'PUT', headers: { ...cabeceras(token), 'content-type': 'application/json' },
    body: JSON.stringify({ message: `Respaldo automático ${empresa.nombre} semana del ${fecha}`, content: aBase64(JSON.stringify(copia, null, 1)) }),
  });
  if (p.status === 422) return { empresa: empresa.nombre, estado: 'ya estaba', archivo: destino }; // otra llamada la creó recién
  if (!p.ok) throw new Error(`${empresa.nombre}: GitHub respondió ${p.status} al guardar la copia.`);
  return { empresa: empresa.nombre, estado: 'guardado', archivo: destino };
}

export async function GET(req) {
  const secreto = process.env.CRON_SECRET;
  if (secreto && req.headers.get('authorization') !== `Bearer ${secreto}`) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) return Response.json({ error: 'Falta GITHUB_TOKEN en Vercel.' }, { status: 503 });
  const repo = process.env.DATA_REPO || 'brunoperez1988/sistema-retenciones-datos';
  const fecha = lunesDeLaSemana();
  const resultados = [];
  let fallo = false;
  for (const empresa of EMPRESAS) {
    try { resultados.push(await respaldarEmpresa(empresa, { token, repo, fecha })); }
    catch (e) { fallo = true; resultados.push({ empresa: empresa.nombre, estado: 'error', mensaje: e.message }); }
  }
  return Response.json({ fecha, resultados }, { status: fallo ? 500 : 200, headers: { 'cache-control': 'no-store' } });
}
