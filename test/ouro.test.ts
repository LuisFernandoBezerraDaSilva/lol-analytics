import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analisarPartida, detectarViradas, PADRAO_ANALISE, resumirCausas, zona } from '../src/analise/ouro.ts';
import { abrirBanco } from '../src/db.ts';
import { gravarPartida } from '../src/processar.ts';
import type { EventoTimeline } from '../src/riot/tipos.ts';
import { EU, partida, timeline, type Opcoes } from './fixtures/partidas.ts';

// Nas partidas sintéticas: você = 3 (mid, time 100), seu caçador = 2,
// oponente de rota = 8 (mid, time 200), caçador inimigo = 7, atirador inimigo = 9.
// Ritmo base: você +400/min, oponente +350/min, então você ganha 50 de ouro por minuto.

const MID = { x: 7400, y: 7400 };
const BOT = { x: 13000, y: 1500 };

function abate(ms: number, killerId: number, victimId: number, assists: number[] = [], pos = MID, bounty = 300): EventoTimeline {
  return { type: 'CHAMPION_KILL', timestamp: ms, killerId, victimId, assistingParticipantIds: assists, position: pos, bounty, shutdownBounty: 0 };
}

function banco(...partidas: Opcoes[]) {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  for (const o of partidas) gravarPartida(db, partida(o), timeline(o));
  return db;
}

const GANK: Opcoes = {
  matchId: 'GANK',
  ajusteOuro: [{ pid: 8, deMin: 10, ouro: 1000 }],
  eventos: [abate(570_000, 8, 3, [7])],
};

describe('mapa', () => {
  it('classifica as zonas do Summoner’s Rift', () => {
    assert.equal(zona(7400, 7400), 'mid');
    assert.equal(zona(13000, 1500), 'bot');
    assert.equal(zona(1500, 13000), 'top');
    assert.equal(zona(500, 500), 'base');
    assert.equal(zona(14000, 14000), 'base');
    assert.equal(zona(5000, 9800), 'rio');
    assert.equal(zona(4000, 7000), 'selva');
  });
});

describe('detecção de viradas', () => {
  it('acha a queda brusca e ignora o ganho lento de farm', () => {
    const d = [0, 50, 100, 150, 200, -750, -700, -650, -600, -550, -500];
    assert.deepEqual(detectarViradas(d, PADRAO_ANALISE), [{ inicio: 4, fim: 5, variacao: -950 }]);
  });

  it('um trecho longo no mesmo sentido vira uma virada só', () => {
    const d = [0, 0, -400, -800, -1200, -1250];
    assert.deepEqual(detectarViradas(d, PADRAO_ANALISE), [{ inicio: 1, fim: 4, variacao: -1200 }]);
  });

  it('o limiar e a janela são configuráveis', () => {
    const d = [0, 50, 100, 150, 200, -750];
    assert.equal(detectarViradas(d, { limiar: 1000, janela: 2 }).length, 0);
    assert.equal(detectarViradas(d, { limiar: 900, janela: 1 }).length, 1);
  });
});

describe('explicação de uma virada', () => {
  it('gank sem sentinela: aponta o caçador e sugere sentinela', () => {
    const an = analisarPartida(banco(GANK), 'GANK', 3)!;
    assert.equal(an.episodios.length, 1);
    const ep = an.episodios[0]!;
    assert.deepEqual([ep.inicio, ep.fim, ep.variacao], [9, 10, -950]);
    assert.equal(ep.causaPrincipal, 'gank_sofrido');
    assert.equal(ep.gankSemSentinela, true);
    assert.equal(ep.oponente.ouroAbates, 300);
    assert.equal(ep.oponente.ouroOutros, 1050);
    assert.ok(ep.leitura.some((l) => l.includes('Você morreu aos 9:30 para Zed com ajuda de Campeao7 (caçador) no mid')));
    assert.ok(ep.dicas.some((d) => d.includes('não colocou nenhuma sentinela')));
  });

  it('gank com sentinela colocada: a dica muda', () => {
    const o: Opcoes = {
      ...GANK,
      matchId: 'GANK2',
      eventos: [...GANK.eventos!, { type: 'WARD_PLACED', timestamp: 480_000, creatorId: 3, wardType: 'YELLOW_TRINKET' }],
    };
    const ep = analisarPartida(banco(o), 'GANK2', 3)!.episodios[0]!;
    assert.equal(ep.gankSemSentinela, false);
    assert.ok(ep.dicas.some((d) => d.includes('tinha colocado 1 sentinela')));
  });

  it('triple kill do oponente fora da rota: roam', () => {
    const o: Opcoes = {
      matchId: 'ROAM',
      ajusteOuro: [{ pid: 8, deMin: 16, ouro: 950 }],
      eventos: [
        abate(910_000, 8, 4, [], BOT),
        abate(920_000, 8, 5, [], BOT),
        abate(930_000, 8, 1, [], BOT),
        { type: 'CHAMPION_SPECIAL_KILL', timestamp: 930_000, killerId: 8, killType: 'KILL_MULTI', multiKillLength: 3 },
      ],
    };
    const ep = analisarPartida(banco(o), 'ROAM', 3)!.episodios[0]!;
    assert.equal(ep.causaPrincipal, 'roam_do_oponente');
    assert.equal(ep.oponente.kills, 3);
    assert.equal(ep.oponente.maiorMultikill, 3);
    assert.ok(ep.leitura.some((l) => l === 'Zed fez um triple kill no trecho.'));
    assert.ok(ep.leitura.some((l) => l.includes('fora da rota dele')));
    assert.ok(ep.dicas.some((d) => d.includes('sumir da rota')));
  });

  it('farm: ele fez mais CS sem você morrer', () => {
    const o: Opcoes = {
      matchId: 'FARM',
      ajusteOuro: [{ pid: 8, deMin: 20, ouro: 650 }],
      ajusteCs: [{ pid: 8, deMin: 20, cs: 10 }],
    };
    const ep = analisarPartida(banco(o), 'FARM', 3)!.episodios[0]!;
    assert.equal(ep.causaPrincipal, 'farm');
    assert.ok(ep.leitura.some((l) => l.includes('Zed fez 9 CS a mais')));
    assert.ok(ep.dicas.some((d) => d.includes('último golpe')));
  });

  it('placas: o oponente transformou a vantagem em objetivo', () => {
    const placa = (ms: number): EventoTimeline => ({ type: 'TURRET_PLATE_DESTROYED', timestamp: ms, killerId: 8, laneType: 'MID_LANE', teamId: 100 });
    const o: Opcoes = { matchId: 'PLACAS', ajusteOuro: [{ pid: 8, deMin: 13, ouro: 750 }], eventos: [placa(740_000), placa(750_000), placa(760_000)] };
    const ep = analisarPartida(banco(o), 'PLACAS', 3)!.episodios[0]!;
    assert.equal(ep.causaPrincipal, 'objetivos');
    assert.equal(ep.oponente.placas, 3);
    assert.ok(ep.leitura.some((l) => l === 'Zed pegou 3 placa(s).'));
  });

  it('virada a seu favor: abate 1x1 no oponente', () => {
    const o: Opcoes = { matchId: 'SOLO', ajusteOuro: [{ pid: 3, deMin: 6, ouro: 700 }], eventos: [abate(330_000, 3, 8)] };
    const ep = analisarPartida(banco(o), 'SOLO', 3)!.episodios[0]!;
    assert.ok(ep.variacao > 0);
    assert.equal(ep.causaPrincipal, 'abate_1x1');
    assert.equal(ep.dicas.length, 0);
  });

  it('ARAM não tem oponente de rota: sem análise', () => {
    assert.equal(analisarPartida(banco({ matchId: 'ARAM', fila: 450 }), 'ARAM', 3), null);
  });
});

describe('resumo das causas', () => {
  it('soma o ouro perdido por causa principal e conta ganks sem sentinela', () => {
    const roam: Opcoes = {
      matchId: 'ROAM',
      ajusteOuro: [{ pid: 8, deMin: 16, ouro: 950 }],
      eventos: [abate(910_000, 8, 4, [], BOT)],
    };
    const r = resumirCausas(banco(GANK, roam, { matchId: 'NADA' }), {});
    assert.equal(r.partidas, 3);
    assert.deepEqual(
      r.perdas.map((l) => [l.causa, l.viradas, l.ouro]),
      [['Gank do caçador inimigo', 1, 950], ['Oponente saiu da rota e abateu', 1, 900]],
    );
    assert.equal(r.ganks, 1);
    assert.equal(r.ganksSemSentinela, 1);
    assert.equal(r.ganhos.length, 0);
  });
});
