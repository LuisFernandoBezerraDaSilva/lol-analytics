import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { criarApi } from '../src/app/api.ts';
import { abrirBanco } from '../src/db.ts';
import { DataDragon } from '../src/ddragon.ts';
import { atualizarRegistrados, consultarJogador, limparConsultasAvulsas, listarJogadores, registrarJogador } from '../src/jogadores.ts';
import { gravarPartida } from '../src/processar.ts';
import { placar } from '../src/relatorios/placar.ts';
import { resumo } from '../src/relatorios/consultas.ts';
import type { FiltroIds } from '../src/riot/cliente.ts';
import type { Partida } from '../src/riot/tipos.ts';
import { EU, partida, timeline } from './fixtures/partidas.ts';

const pasta = mkdtempSync(join(tmpdir(), 'lol-jog-'));
after(() => rmSync(pasta, { recursive: true, force: true }));

/** Partida sintética em que o participante 8 é `puuid` e você (3) não jogou. */
function partidaDe(matchId: string, puuid: string): Partida {
  const p = partida({ matchId });
  p.info.participants[7]!.puuid = puuid;
  p.info.participants[7]!.riotIdGameName = puuid;
  p.info.participants[2]!.puuid = `alguem-${matchId}`;
  return p;
}

/** Riot falsa: cada jogador tem as próprias partidas. */
function riotFalsa() {
  const historicos: Record<string, string[]> = {
    'puuid-a': ['A_3', 'A_2', 'A_1'],
    'puuid-b': ['B_2', 'B_1'],
  };
  const dono = (id: string) => (id.startsWith('A_') ? 'puuid-a' : 'puuid-b');
  const pedidos = { partidas: 0 };
  return {
    pedidos,
    contaPorRiotId: async (nome: string, tag: string) => {
      const puuid = nome === 'Eu' ? EU : nome === 'Alfa' ? 'puuid-a' : 'puuid-b';
      return { puuid, gameName: nome, tagLine: tag };
    },
    idsDePartidas: async (puuid: string, f: FiltroIds) => (historicos[puuid] ?? []).slice(0, f.count ?? 100),
    partida: async (id: string) => {
      pedidos.partidas++;
      return partidaDe(id, dono(id));
    },
    timeline: async (id: string) => timeline({ matchId: id }),
    ranqueadas: async () => [{ queueType: 'RANKED_SOLO_5x5', tier: 'PLATINUM', rank: 'IV', leaguePoints: 10, wins: 30, losses: 25 }],
  };
}

function banco() {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  const minha = { matchId: 'MINHA_1' };
  gravarPartida(db, partida(minha), timeline(minha));
  return db;
}

const contar = (db: ReturnType<typeof banco>, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('consulta de outros jogadores', () => {
  it('consulta eventual: baixa as partidas e não mistura com as suas', async () => {
    const db = banco();
    const r = await consultarJogador(db, riotFalsa(), 'Alfa#BR1', { n: 20 });
    assert.equal(r.novas, 3);
    assert.deepEqual(listarJogadores(db).map((j) => [j.riotId, j.registrado, j.partidas]), [['Alfa#BR1', false, 3]]);
    assert.equal(resumo(db, { puuid: 'puuid-a' })!.jogos, 3);
    assert.equal(resumo(db, {})!.jogos, 1, 'os seus relatórios continuam só com as suas partidas');
    assert.equal(contar(db, "SELECT count(*) n FROM elo WHERE puuid = 'puuid-a'"), 1);
  });

  it('a próxima consulta descarta a anterior, mas nunca as suas partidas', async () => {
    const db = banco();
    const riot = riotFalsa();
    await consultarJogador(db, riot, 'Alfa#BR1', { n: 20 });
    await consultarJogador(db, riot, 'Beta#BR1', { n: 20 });
    assert.deepEqual(listarJogadores(db).map((j) => j.riotId), ['Beta#BR1']);
    assert.equal(contar(db, "SELECT count(*) n FROM partidas WHERE match_id LIKE 'A_%'"), 0);
    assert.equal(contar(db, "SELECT count(*) n FROM partidas WHERE match_id = 'MINHA_1'"), 1);
    assert.equal(contar(db, "SELECT count(*) n FROM elo WHERE puuid = 'puuid-a'"), 0);
  });

  it('registrar em memória guarda o jogador e o histórico dele', async () => {
    const db = banco();
    const riot = riotFalsa();
    await consultarJogador(db, riot, 'Alfa#BR1', { n: 20 });
    registrarJogador(db, 'puuid-a', true);
    await consultarJogador(db, riot, 'Beta#BR1', { n: 20 });
    assert.deepEqual(listarJogadores(db).map((j) => [j.riotId, j.registrado]), [['Alfa#BR1', true], ['Beta#BR1', false]]);
    assert.equal(resumo(db, { puuid: 'puuid-a' })!.jogos, 3);
    registrarJogador(db, 'puuid-a', false);
    assert.equal(limparConsultasAvulsas(db), 5, 'tirar da memória libera a limpeza');
  });

  it('atualizar os registrados não descarta a consulta eventual aberta', async () => {
    const db = banco();
    const riot = riotFalsa();
    await consultarJogador(db, riot, 'Alfa#BR1', { n: 20 });
    registrarJogador(db, 'puuid-a', true);
    await consultarJogador(db, riot, 'Beta#BR1', { n: 20 });
    riot.pedidos.partidas = 0;
    await atualizarRegistrados(db, riot, 20);
    assert.equal(riot.pedidos.partidas, 0, 'nada novo para baixar');
    assert.equal(resumo(db, { puuid: 'puuid-b' })!.jogos, 2);
  });

  it('não consulta a sua própria conta como se fosse outro jogador', async () => {
    await assert.rejects(consultarJogador(banco(), riotFalsa(), 'Eu#BR1', { n: 5 }), /uma das suas contas/);
  });
});

describe('placar da partida', () => {
  it('dois times, ordenados por posição, com itens e marcações', () => {
    const db = banco();
    const p = partida({ matchId: 'P_1' });
    Object.assign(p.info.participants[2]!, { item0: 3089, item1: 3020, item6: 3340 });
    gravarPartida(db, p, null);
    const pl = placar(db, 'P_1', 'puuid-P_1-8')!;
    assert.equal(pl.times.length, 2);
    assert.deepEqual(pl.times[0]!.jogadores.map((j) => j.posicao), ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
    const eu = pl.times[0]!.jogadores[2]!;
    assert.equal(eu.eu, true);
    assert.deepEqual(eu.itens, [3089, 3020, 0, 0, 0, 0, 3340]);
    assert.equal(pl.times[1]!.jogadores[2]!.foco, true);
    assert.equal(pl.times[0]!.vitoria, true);
    assert.equal(pl.times[0]!.kills, 5 + 4 * 2);
    assert.equal(pl.duracao, '30:00');
    assert.equal(pl.temTimeline, false);
    assert.equal(placar(db, 'NAO_EXISTE'), null);
  });
});

describe('Data Dragon', () => {
  it('baixa uma vez, guarda no disco e depois funciona offline', async () => {
    const dir = join(pasta, 'dd');
    let chamadas = 0;
    const online = (async (url: string) => {
      chamadas++;
      if (url.endsWith('versions.json')) return Response.json(['16.23.1', '16.22.1']);
      if (url.endsWith('/item/3089.png')) return new Response(new Uint8Array([1, 2, 3]));
      if (url.endsWith('item.json')) return Response.json({ data: { '3089': { name: 'Capuz da Morte de Rabadon' } } });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const dd = new DataDragon(dir, online);
    assert.deepEqual([...(await dd.iconeItem('3089'))!], [1, 2, 3]);
    assert.ok(existsSync(join(dir, '16.23.1', 'item', '3089.png')));
    assert.equal((await dd.itens())['3089'], 'Capuz da Morte de Rabadon');
    assert.equal(await dd.iconeItem('../x'), null, 'nome inválido nem chega à internet');
    assert.equal(await dd.iconeCampeao('Ahri; rm'), null);

    const offline = (async () => {
      throw new Error('sem internet');
    }) as unknown as typeof fetch;
    const dd2 = new DataDragon(dir, offline);
    assert.deepEqual([...(await dd2.iconeItem('3089'))!], [1, 2, 3], 'usa a versão e o arquivo guardados');
    assert.equal(await dd2.iconeItem('1001'), null);
    assert.ok(chamadas > 0);
  });
});

describe('API: jogadores e placar', () => {
  it('consulta em segundo plano, abre o jogador, registra e mostra o placar', async () => {
    const db = banco();
    const riot = riotFalsa();
    const ddragon = { iconeCampeao: async () => null, iconeItem: async (id: string) => (id === '3089' ? Buffer.from([9]) : null), itens: async () => ({}), classes: async () => null };
    const api = criarApi(db, { criarRiot: () => ({ riot, riotIds: [{ gameName: 'Eu', tagLine: 'BR1' }] }), ddragon });
    const chamar = async (metodo: string, url: string, corpo?: unknown) => {
      const u = new URL(url, 'http://x');
      const r = await api.tratar({ metodo, caminho: u.pathname, query: u.searchParams, corpo });
      return { status: r.status, corpo: r.tipo.startsWith('application/json') ? JSON.parse(String(r.corpo)) : r.corpo, r };
    };

    assert.equal((await chamar('POST', '/api/jogadores/consultar', {})).status, 400);
    assert.equal((await chamar('POST', '/api/jogadores/consultar', { riotId: 'Alfa#BR1', n: 20 })).status, 202);
    while (api.sync.rodando) await new Promise((ok) => setTimeout(ok, 5));
    assert.equal(api.sync.erro, null);
    assert.deepEqual(api.sync.resultado, { puuid: 'puuid-a', riotId: 'Alfa#BR1' });

    const j = await chamar('GET', '/api/jogador?puuid=puuid-a');
    assert.equal(j.corpo.registrado, false);
    assert.equal(j.corpo.elo[0].elo, 'PLATINUM IV');
    assert.equal((await chamar('GET', '/api/resumo?puuid=puuid-a')).corpo.jogos, 3);
    assert.equal((await chamar('GET', '/api/recentes?puuid=puuid-a&n=1')).corpo.linhas[0].match_id, 'A_3');

    const reg = await chamar('POST', '/api/jogadores/registrar', { puuid: 'puuid-a', registrar: true });
    assert.equal(reg.corpo.registrado, true);
    assert.equal((await chamar('POST', '/api/jogadores/registrar', { puuid: 'xpto', registrar: true })).status, 404);

    const pl = await chamar('GET', '/api/partida?match=A_3&puuid=puuid-a');
    assert.equal(pl.corpo.times[1].jogadores[2].foco, true);
    assert.equal((await chamar('GET', '/api/partida?match=nada')).status, 404);

    const ouro = await chamar('GET', '/api/ouro?match=A_3&puuid=puuid-a');
    assert.equal(ouro.status, 200);
    assert.equal(ouro.corpo.partida.campeao, 'Zed');

    const icone = await chamar('GET', '/api/ddragon/item/3089');
    assert.equal(icone.r.tipo, 'image/png');
    assert.equal(icone.r.cache, true);
    assert.equal((await chamar('GET', '/api/ddragon/item/1')).status, 404);
  });
});
