import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { abrirBanco } from '../src/db.ts';
import { duracaoEmSegundos, ehRemake, gravarPartida, oponenteDeRota, reprocessarTudo } from '../src/processar.ts';
import { EU, partida, timeline } from './fixtures/partidas.ts';

function bancoComConta() {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  return db;
}

describe('processar', () => {
  it('converte gameDuration antigo (milissegundos) em segundos', () => {
    assert.equal(duracaoEmSegundos(partida({ matchId: 'A', duracaoS: 1500, semGameEnd: true })), 1500);
    assert.equal(duracaoEmSegundos(partida({ matchId: 'B', duracaoS: 1500 })), 1500);
  });

  it('marca remake por rendição antecipada ou por menos de 5 minutos', () => {
    assert.equal(ehRemake(partida({ matchId: 'A' })), false);
    assert.equal(ehRemake(partida({ matchId: 'B', remake: true })), true);
    assert.equal(ehRemake(partida({ matchId: 'C', duracaoS: 200 })), true);
  });

  it('acha o oponente de rota pela posição no time adversário', () => {
    const p = partida({ matchId: 'A' });
    const eu = p.info.participants[2]!;
    assert.equal(oponenteDeRota(eu, p.info.participants), 8);
    const aram = partida({ matchId: 'B', fila: 450 });
    assert.equal(oponenteDeRota(aram.info.participants[2]!, aram.info.participants), null);
  });

  it('grava JSON cru, 10 participantes, frames por minuto e todos os eventos', () => {
    const db = bancoComConta();
    const o = { matchId: 'BR1_1', abates: [[4.5, 'k'], [12, 'm']] as Array<[number, 'k' | 'm']> };
    gravarPartida(db, partida(o), timeline(o));
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    assert.equal(n('SELECT count(*) n FROM participantes'), 10);
    assert.equal(n('SELECT count(*) n FROM frames WHERE participant_id = 3'), 31);
    assert.equal(n("SELECT count(*) n FROM eventos WHERE tipo = 'CHAMPION_KILL'"), 2);
    assert.equal(n("SELECT count(*) n FROM eventos WHERE tipo = 'ITEM_PURCHASED' AND participant_id = 3"), 1);
    assert.ok((db.prepare('SELECT json FROM partidas').get() as { json: string }).json.includes('"gameVersion"'));
  });

  it('v_minhas_partidas calcula métricas por minuto e diferença para o oponente', () => {
    const db = bancoComConta();
    const o = { matchId: 'BR1_1', duracaoS: 1800, ouro: 12_000, kda: [6, 3, 9] as [number, number, number], ritmoOuro: [400, 350] as [number, number] };
    gravarPartida(db, partida(o), timeline(o));
    const v = db.prepare('SELECT * FROM v_minhas_partidas').get() as Record<string, number | string>;
    assert.equal(v.campeao, 'Ahri');
    assert.equal(v.oponente, 'Zed');
    assert.equal(v.ouro_min, 400);
    assert.equal(v.kills_min, 0.2);
    assert.equal(v.cs_min, 6.67);
    assert.equal(v.kda, 5);
    assert.equal(v.ouro_10, 4500);
    assert.equal(v.dif_ouro_10, 500);
    assert.equal(v.dif_ouro_15, 750);
    assert.equal(v.dif_cs_10, 10);
    // Time 100 fez 6 + 4×2 = 14 abates; participação = (6+9)/14.
    assert.equal(v.participacao_abates, 107.1);
  });

  it('partida sem timeline entra, só sem as métricas da timeline', () => {
    const db = bancoComConta();
    gravarPartida(db, partida({ matchId: 'BR1_2' }), null);
    const v = db.prepare('SELECT ouro_min, dif_ouro_10 FROM v_minhas_partidas').get() as Record<string, number | null>;
    assert.equal(v.ouro_min, 400);
    assert.equal(v.dif_ouro_10, null);
  });

  it('regravar e reprocessar não duplica nada', () => {
    const db = bancoComConta();
    const o = { matchId: 'BR1_1', abates: [[3, 'k']] as Array<[number, 'k']> };
    gravarPartida(db, partida(o), timeline(o));
    gravarPartida(db, partida(o), timeline(o));
    assert.equal(reprocessarTudo(db), 1);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    assert.equal(n('SELECT count(*) n FROM partidas'), 1);
    assert.equal(n('SELECT count(*) n FROM participantes'), 10);
    assert.equal(n("SELECT count(*) n FROM eventos WHERE tipo = 'CHAMPION_KILL'"), 1);
  });
});
