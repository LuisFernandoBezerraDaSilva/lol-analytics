import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analiseDaPartida, calcularAnalisesNovas, resumirCausas } from '../src/analise/ouro.ts';
import { abrirBanco } from '../src/db.ts';
import { gravarPartida } from '../src/processar.ts';
import type { ClienteRiot, FiltroIds } from '../src/riot/cliente.ts';
import { sincronizar } from '../src/sync.ts';
import { EU, partida, timeline, type Opcoes } from './fixtures/partidas.ts';

// Partida com um gank aos 9:30: o oponente (8) abre 950 de ouro.
const gank = (matchId: string): Opcoes => ({
  matchId,
  ajusteOuro: [{ pid: 8, deMin: 10, ouro: 1000 }],
  eventos: [{ type: 'CHAMPION_KILL', timestamp: 570_000, killerId: 8, victimId: 3, assistingParticipantIds: [7], position: { x: 7400, y: 7400 }, bounty: 300, shutdownBounty: 0 }],
});

function banco(...ids: string[]) {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  for (const id of ids) gravarPartida(db, partida(gank(id)), timeline(gank(id)));
  return db;
}

const contar = (db: ReturnType<typeof banco>, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('análise salva', () => {
  it('calcula uma vez e depois só lê do banco', () => {
    const db = banco('M1');
    const a = analiseDaPartida(db, 'M1', 3)!;
    assert.equal(a.calculou, true);
    assert.equal(a.analise.episodios[0]!.variacao, -950);

    // Prova de que não recalcula: mesmo zerando o ouro na timeline, a leitura devolve o que foi salvo.
    db.prepare('UPDATE frames SET ouro_total = 0').run();
    const b = analiseDaPartida(db, 'M1', 3)!;
    assert.equal(b.calculou, false);
    assert.deepEqual(b.analise, a.analise);
  });

  it('regravar a partida (reprocessar) refaz a análise dela', () => {
    const db = banco('M1');
    analiseDaPartida(db, 'M1', 3);
    gravarPartida(db, partida(gank('M1')), timeline(gank('M1')));
    assert.equal(contar(db, 'SELECT count(*) n FROM analise_viradas'), 0);
    assert.equal(analiseDaPartida(db, 'M1', 3)!.calculou, true);
  });

  it('outro limiar ou janela gera outra análise, sem apagar a primeira', () => {
    const db = banco('M1');
    analiseDaPartida(db, 'M1', 3);
    analiseDaPartida(db, 'M1', 3, { limiar: 300, janela: 1 });
    assert.equal(contar(db, 'SELECT count(*) n FROM analise_viradas'), 2);
    assert.equal(analiseDaPartida(db, 'M1', 3)!.calculou, false);
  });

  it('calcula só as análises que faltam e descarta as de versão antiga do algoritmo', () => {
    const db = banco('M1', 'M2');
    db.prepare("INSERT INTO analise_viradas VALUES ('M1', 3, 500, 2, 0, '{}', '')").run();
    assert.equal(calcularAnalisesNovas(db), 2);
    assert.equal(contar(db, 'SELECT count(*) n FROM analise_viradas WHERE versao = 0'), 0);
    assert.equal(calcularAnalisesNovas(db), 0, 'na segunda vez não há nada novo');
    gravarPartida(db, partida(gank('M3')), timeline(gank('M3')));
    assert.equal(calcularAnalisesNovas(db), 1, 'só a partida nova');
    assert.equal(contar(db, 'SELECT count(*) n FROM analise_viradas'), 3);
  });

  it('o resumo das causas usa e guarda as análises', () => {
    const db = banco('M1', 'M2');
    const r = resumirCausas(db, {});
    assert.equal(r.perdas[0]!.viradas, 2);
    assert.equal(contar(db, 'SELECT count(*) n FROM analise_viradas'), 2);
  });
});

describe('atualização incremental', () => {
  it('busca só as partidas novas e não esquece nem recalcula as antigas', async () => {
    const db = banco('BR1_1', 'BR1_2');
    assert.equal(calcularAnalisesNovas(db), 2);
    const antes = db.prepare('SELECT match_id, calculado_em FROM analise_viradas ORDER BY match_id').all();

    const pedidas: string[] = [];
    const riot = {
      contaPorRiotId: async () => ({ puuid: EU, gameName: 'Eu', tagLine: 'BR1' }),
      idsDePartidas: async (_p: string, f: FiltroIds) => ['BR1_3', 'BR1_2', 'BR1_1'].slice(f.start ?? 0),
      partida: async (id: string) => {
        pedidas.push(id);
        return partida(gank(id));
      },
      timeline: async (id: string) => timeline(gank(id)),
    };
    const [r] = await sincronizar(db, riot as unknown as ClienteRiot, [{ gameName: 'Eu', tagLine: 'BR1' }], { max: 200 });

    assert.deepEqual(pedidas, ['BR1_3'], 'só a nova foi baixada');
    assert.equal(r!.novas, 1);
    assert.equal(contar(db, 'SELECT count(*) n FROM partidas'), 3, 'as antigas continuam no banco');
    assert.equal(calcularAnalisesNovas(db), 1, 'só a nova foi analisada');
    const depois = db.prepare("SELECT match_id, calculado_em FROM analise_viradas WHERE match_id <> 'BR1_3' ORDER BY match_id").all();
    assert.deepEqual(depois, antes, 'as análises antigas ficaram intactas');
  });
});
