import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criarApi } from '../src/app/api.ts';
import { abrirBanco } from '../src/db.ts';
import { gravarPartida } from '../src/processar.ts';
import { desempenhoPorCampeao, melhoresPorRota } from '../src/relatorios/desempenho.ts';
import type { EventoTimeline } from '../src/riot/tipos.ts';
import { EU, partida, timeline, type Opcoes } from './fixtures/partidas.ts';

// Base das partidas sintéticas: você (3, mid) ganha 50 de ouro por minuto sobre o oponente (8),
// então aos 15 minutos a diferença já é +750. Visão: você 30, oponente 20 → 60%.
// KDA padrão 5/2/7 e o resto do time 2 abates cada: participação = (5+7)/(5+8) = 92,3%.

const gank: EventoTimeline = { type: 'CHAMPION_KILL', timestamp: 570_000, killerId: 8, victimId: 3, assistingParticipantIds: [7], position: { x: 7400, y: 7400 }, bounty: 300, shutdownBounty: 0 };

const PARTIDAS: Opcoes[] = [
  // Ahri: stomp e vitória.
  { matchId: 'A1', campeao: 'Ahri', vitoria: true, ajusteOuro: [{ pid: 3, deMin: 12, ouro: 1200 }] },
  // Ahri: morre num gank (1 erro), mas ainda chega aos 15 com +1.250 (stomp) e perde a partida.
  { matchId: 'A2', campeao: 'Ahri', vitoria: false, ajusteOuro: [{ pid: 8, deMin: 10, ouro: 1000 }, { pid: 3, deMin: 12, ouro: 1500 }], eventos: [gank] },
  // Zed na flex: sem stomp (+750), participa de 1 dos 2 objetivos do time.
  {
    matchId: 'Z1', campeao: 'Zed', oponente: 'Ahri', vitoria: true, fila: 440,
    eventos: [
      { type: 'ELITE_MONSTER_KILL', timestamp: 600_000, killerId: 2, killerTeamId: 100, assistingParticipantIds: [3], monsterType: 'DRAGON' },
      { type: 'BUILDING_KILL', timestamp: 900_000, killerId: 1, teamId: 200, assistingParticipantIds: [], buildingType: 'TOWER_BUILDING' },
      { type: 'ELITE_MONSTER_KILL', timestamp: 1_200_000, killerId: 7, killerTeamId: 200, assistingParticipantIds: [], monsterType: 'DRAGON' },
    ],
  },
];

function banco() {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  for (const o of PARTIDAS) gravarPartida(db, partida(o), timeline(o));
  return db;
}

describe('desempenho por campeão', () => {
  it('vitória, stomp, stomp com derrota, acertos e erros', () => {
    const [zed, ahri] = desempenhoPorCampeao(banco(), {});
    assert.equal(zed!.campeao, 'Zed', 'ordenado por % de vitória');
    assert.deepEqual(
      [ahri!.jogos, ahri!.vitoria_pct, ahri!.stomp_pct, ahri!.stomp_derrota, ahri!.erros_jogo],
      [2, 50, 100, 1, 0.5],
    );
    assert.deepEqual([zed!.jogos, zed!.vitoria_pct, zed!.stomp_pct, zed!.erros_jogo], [1, 100, 0, 0]);
    assert.equal(zed!.objetivos_pct, 50);
    assert.equal(zed!.visao_pct, 60);
    assert.equal(zed!.kp_pct, 92.3);
    assert.equal(zed!.acertos_pct, 67.4); // (92,3 + 50 + 60) / 3
    assert.equal(ahri!.objetivos_pct, null, 'sem objetivos do time, o componente fica de fora');
    assert.equal(ahri!.acertos_pct, 76.2); // (92,3 + 60) / 2
  });

  it('separa por rota, respeita o mínimo de jogos e os filtros de fila e campeão', () => {
    const db = banco();
    assert.deepEqual(desempenhoPorCampeao(db, {}, { porRota: true }).map((l) => l.posicao), ['MIDDLE', 'MIDDLE']);
    assert.deepEqual(desempenhoPorCampeao(db, {}, { minJogos: 2 }).map((l) => l.campeao), ['Ahri']);
    assert.deepEqual(desempenhoPorCampeao(db, { fila: 440 }).map((l) => l.campeao), ['Zed']);
    assert.deepEqual(desempenhoPorCampeao(db, { campeao: 'ahri' }).map((l) => l.jogos), [2]);
  });

  it('aponta o melhor campeão de cada rota em cada critério', () => {
    const [mid] = melhoresPorRota(banco(), {});
    assert.equal(mid!.posicao, 'MIDDLE');
    assert.equal(mid!.vitoria, 'Zed (100% em 1 jogo)');
    assert.equal(mid!.stomp, 'Ahri (100% em 2 jogos)');
    assert.equal(mid!.acertos, 'Ahri (76,2% em 2 jogos)');
    assert.equal(mid!.menos_erros, 'Zed (0 erro(s)/jogo em 1 jogo)');
  });
});

describe('API: desempenho e filtros', () => {
  const chamar = async (db: ReturnType<typeof banco>, url: string) => {
    const api = criarApi(db);
    const u = new URL(url, 'http://x');
    const r = await api.tratar({ metodo: 'GET', caminho: u.pathname, query: u.searchParams });
    return { status: r.status, corpo: JSON.parse(String(r.corpo)) };
  };

  it('desempenho com rótulos, ranking por rota e filtros', async () => {
    const db = banco();
    const r = await chamar(db, '/api/desempenho?porRota=1&fila=solo');
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo.linhas.map((l: { campeao: string }) => l.campeao), ['Ahri']);
    assert.equal(r.corpo.colunas.find((c: { chave: string }) => c.chave === 'erros_jogo').rotulo, 'Erros/jogo');
    assert.equal(r.corpo.melhores[0].posicao, 'MIDDLE');
    assert.equal((await chamar(db, '/api/desempenho?minJogos=0')).status, 400);
  });

  it('elo respeita o filtro de fila ranqueada', async () => {
    const db = banco();
    db.prepare(`INSERT INTO elo VALUES (?, 'RANKED_SOLO_5x5', 'GOLD', 'I', 50, 10, 5, '2026-11-20 10:00:00')`).run(EU);
    db.prepare(`INSERT INTO elo VALUES (?, 'RANKED_FLEX_SR', 'SILVER', 'II', 20, 3, 4, '2026-11-20 10:00:00')`).run(EU);
    assert.equal((await chamar(db, '/api/elo')).corpo.linhas.length, 2);
    assert.deepEqual((await chamar(db, '/api/elo?fila=flex')).corpo.linhas.map((l: { elo: string }) => l.elo), ['SILVER II']);
    assert.equal((await chamar(db, '/api/elo?fila=aram')).corpo.linhas.length, 2, 'fila sem elo mostra todas');
  });

  it('a lista de campeões do filtro pode ser a de outro jogador', async () => {
    const db = banco();
    assert.deepEqual((await chamar(db, '/api/opcoes')).corpo.campeoes, ['Ahri', 'Zed']);
    assert.deepEqual((await chamar(db, '/api/opcoes?puuid=puuid-Z1-8')).corpo.campeoes, ['Ahri']);
  });
});
