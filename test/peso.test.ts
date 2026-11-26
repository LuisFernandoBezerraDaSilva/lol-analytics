import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calcularPeso, pesoDaPartida } from '../src/analise/peso.ts';
import { criarApi } from '../src/app/api.ts';
import { abrirBanco } from '../src/db.ts';
import { gravarPartida } from '../src/processar.ts';
import { desempenhoPorCampeao, melhoresPorRota } from '../src/relatorios/desempenho.ts';
import type { EventoTimeline } from '../src/riot/tipos.ts';
import { EU, partida, timeline, type Opcoes } from './fixtures/partidas.ts';

// Times: 1-5 (azul, você = 3, mid) e 6-10 (vermelho, oponente de rota = 8).
// Dano: você 24.000, os outros 15.000 cada → sua parte 28,6% contra 20% do oponente.
// Abates + assistências: você 5+7, os outros 2+2 → 42,9% contra 20% do oponente.
const abate = (ms: number, killerId: number, victimId: number): EventoTimeline => ({
  type: 'CHAMPION_KILL', timestamp: ms, killerId, victimId, assistingParticipantIds: [], position: { x: 7400, y: 7400 }, bounty: 300, shutdownBounty: 0,
});

// Derrota pesada: 3 das 5 mortes do time são suas (900 de 1.500), uma delas logo antes do barão
// inimigo, e você é a única rota atrás aos 15 min (350/min contra 400/min).
const PESADA: Opcoes = {
  matchId: 'L1', vitoria: false, ritmoOuro: [350, 400],
  eventos: [
    abate(300_000, 8, 3), abate(720_000, 8, 3), abate(780_000, 9, 4), abate(840_000, 6, 1),
    abate(960_000, 3, 8), abate(1_020_000, 4, 9), abate(1_080_000, 2, 10), abate(1_100_000, 1, 6),
    abate(1_200_000, 7, 3),
    { type: 'ELITE_MONSTER_KILL', timestamp: 1_230_000, killerId: 7, killerTeamId: 200, assistingParticipantIds: [], monsterType: 'BARON_NASHOR' },
  ],
};

// Derrota inocente: você não morre, está à frente na rota e o time entrega as mortes.
const INOCENTE: Opcoes = {
  matchId: 'I1', vitoria: false, ritmoOuro: [400, 350],
  eventos: [abate(600_000, 6, 1), abate(660_000, 7, 2), abate(720_000, 9, 4), abate(800_000, 1, 6)],
};

const VITORIA: Opcoes = { matchId: 'W1', vitoria: true };

function banco(...ps: Opcoes[]) {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  for (const o of ps) gravarPartida(db, partida(o), timeline(o));
  return db;
}

const componente = (p: ReturnType<typeof calcularPeso>, chave: string) => p!.componentes.find((c) => c.chave === chave);

describe('peso na derrota', () => {
  it('derrota em que você pesou muito', () => {
    const p = calcularPeso(banco(PESADA), 'L1', 3)!;
    const ouro = componente(p, 'ouro_entregue')!;
    assert.deepEqual([ouro.suaParte, ouro.parteDoOponente, ouro.ajustado], [60, 25, 48]); // 20 × 60 ÷ 25
    assert.equal(componente(p, 'rota')!.ajustado, 100, 'a única rota atrás era a sua');
    assert.equal(componente(p, 'mortes_caras')!.ajustado, 100);
    assert.match(componente(p, 'mortes_caras')!.detalhe, /aos 20:00 \(antes do barão\)/);
    assert.equal(componente(p, 'dano')!.ajustado, 28.6);
    assert.equal(componente(p, 'abates')!.ajustado, 42.9);
    assert.equal(componente(p, 'objetivos'), undefined, 'o time não pegou objetivo nenhum');
    assert.equal(p.culpa, 82.7);
    assert.equal(p.contribuicao, 35.8);
    assert.equal(p.peso, 43.5); // 20 + (82,7 − 20) ÷ 2 − (35,75 − 20) ÷ 2
    assert.equal(p.inocencia, 0);
    assert.equal(p.veredito, 'Pesou muito');
  });

  it('derrota em que você foi inocente', () => {
    const p = calcularPeso(banco(INOCENTE), 'I1', 3)!;
    assert.equal(componente(p, 'ouro_entregue')!.ajustado, 0);
    assert.equal(componente(p, 'rota'), undefined, 'nenhuma rota do time estava atrás');
    assert.equal(p.culpa, 0);
    assert.equal(p.peso, 2.1); // 20 − 10 − 7,875
    assert.ok(Math.abs(p.inocencia! - 94.8) <= 0.1);
    assert.equal(p.veredito, 'Inocente');
  });

  it('vitória mostra a contribuição, sem peso', () => {
    const p = calcularPeso(banco(VITORIA), 'W1', 3)!;
    assert.equal(p.peso, null);
    assert.equal(p.contribuicao, 35.8);
    assert.equal(p.veredito, 'Carregou');
  });

  it('sem timeline usa o número de mortes e pula rota e objetivos', () => {
    const db = abrirBanco(':memory:');
    db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
    gravarPartida(db, partida({ matchId: 'S1', vitoria: false }), null);
    const p = calcularPeso(db, 'S1', 3)!;
    assert.deepEqual(p.componentes.map((c) => c.chave), ['ouro_entregue', 'dano', 'abates']);
    assert.match(componente(p, 'ouro_entregue')!.detalhe, /mortes do time/);
  });

  it('remake não tem peso; o resultado fica salvo e é refeito se a partida for regravada', () => {
    const db = banco(PESADA, { matchId: 'R1', remake: true, duracaoS: 200 });
    assert.equal(calcularPeso(db, 'R1', 3), null);
    pesoDaPartida(db, 'L1', 3);
    db.prepare('UPDATE participantes SET dano_campeoes = 0').run();
    assert.equal(pesoDaPartida(db, 'L1', 3)!.peso, 43.5, 'leu o resultado salvo');
    gravarPartida(db, partida(PESADA), timeline(PESADA));
    assert.equal((db.prepare('SELECT count(*) n FROM analise_peso').get() as { n: number }).n, 0);
  });
});

describe('peso nas listas', () => {
  it('desempenho e melhores por rota usam o peso médio nas derrotas', () => {
    const db = banco(PESADA, INOCENTE, VITORIA);
    const [ahri] = desempenhoPorCampeao(db, {});
    assert.equal(ahri!.peso_derrota, 22.8); // (43,5 + 2,1) ÷ 2
    assert.equal(melhoresPorRota(db, {})[0]!.menos_peso, 'Ahri (22,8% de peso nas derrotas em 3 jogos)');
  });

  it('API: partidas com peso e veredito, e o detalhe de uma partida', async () => {
    const db = banco(PESADA, VITORIA);
    const api = criarApi(db);
    const chamar = async (url: string) => {
      const u = new URL(url, 'http://x');
      const r = await api.tratar({ metodo: 'GET', caminho: u.pathname, query: u.searchParams });
      return { status: r.status, corpo: JSON.parse(String(r.corpo)) };
    };
    const rec = await chamar('/api/recentes');
    const porId = Object.fromEntries(rec.corpo.linhas.map((l: { match_id: string }) => [l.match_id, l]));
    assert.equal(porId.L1.peso, 43.5);
    assert.equal(porId.L1.veredito, 'Pesou muito');
    assert.equal(porId.W1.peso, null);
    assert.equal(porId.W1.veredito, 'Carregou');
    const d = await chamar('/api/peso?match=L1');
    assert.equal(d.corpo.componentes.length, 5);
    assert.equal((await chamar('/api/peso?match=nada')).status, 404);
    const outro = await chamar('/api/peso?match=L1&puuid=puuid-L1-8');
    assert.equal(outro.corpo.vitoria, true, 'pela visão do oponente, foi vitória');
  });
});
