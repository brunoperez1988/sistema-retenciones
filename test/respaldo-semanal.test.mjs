// Pruebas del respaldo automático semanal (api/respaldo-semanal.js), con un GitHub de mentira.
import test from 'node:test';
import assert from 'node:assert';
import { lunesDeLaSemana, respaldarEmpresa } from '../api/respaldo-semanal.js';

const SHI = { clave: 'shi', nombre: 'SHI', origen: 'datos/retenciones.json', destino: 'respaldos/' };

function githubFalso(archivos) {
  const pedidos = [];
  const f = async (url, op) => {
    const ruta = url.split('/contents/')[1];
    pedidos.push([op.method, ruta]);
    if (op.method === 'GET') return archivos[ruta] ? new Response(archivos[ruta]) : new Response('{}', { status: 404 });
    const cuerpo = JSON.parse(op.body);
    archivos[ruta] = Buffer.from(cuerpo.content, 'base64').toString('utf8');
    return new Response('{}', { status: 201 });
  };
  return { f, pedidos, archivos };
}

test('la copia lleva la fecha del lunes, en hora de Uruguay', () => {
  assert.equal(lunesDeLaSemana(new Date('2026-11-30T06:00:00Z')), '2026-11-30'); // lunes 3 AM en Uruguay
  assert.equal(lunesDeLaSemana(new Date('2026-11-25T19:00:00Z')), '2026-11-23'); // miércoles
  assert.equal(lunesDeLaSemana(new Date('2026-11-30T02:00:00Z')), '2026-11-23'); // domingo 23 h en Uruguay
});

test('guarda la copia marcada con su empresa, y no la repite en la misma semana', async () => {
  const g = githubFalso({ 'datos/retenciones.json': JSON.stringify({ sistema: 'Sistema de Retenciones', retenciones: [{ id: 1 }] }) });
  const r1 = await respaldarEmpresa(SHI, { token: 'x', repo: 'a/b', fecha: '2026-11-30', fetch: g.f });
  assert.equal(r1.estado, 'guardado');
  const copia = JSON.parse(g.archivos['respaldos/2026-11-30.json']);
  assert.equal(copia.empresa_sistema, 'shi');
  assert.deepEqual(copia.retenciones, [{ id: 1 }]);
  const r2 = await respaldarEmpresa(SHI, { token: 'x', repo: 'a/b', fecha: '2026-11-30', fetch: g.f });
  assert.equal(r2.estado, 'ya estaba');
  assert.equal(g.pedidos.filter(([m]) => m === 'PUT').length, 1);
});

test('una empresa sin datos todavía no falla', async () => {
  const g = githubFalso({});
  const r = await respaldarEmpresa({ ...SHI, nombre: 'AGLH' }, { token: 'x', repo: 'a/b', fecha: '2026-11-30', fetch: g.f });
  assert.equal(r.estado, 'sin datos todavía');
});
