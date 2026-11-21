import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { criarApi, type Requisicao } from '../src/app/api.ts';
import { validar } from '../src/configurar.ts';
import { abrirBanco } from '../src/db.ts';
import { gravarPartida } from '../src/processar.ts';
import type { FiltroIds } from '../src/riot/cliente.ts';
import { EU, partida, timeline, type Opcoes } from './fixtures/partidas.ts';

const pasta = mkdtempSync(join(tmpdir(), 'lol-api-'));
after(() => rmSync(pasta, { recursive: true, force: true }));

const GANK: Opcoes = {
  matchId: 'BR1_10',
  inicioMs: Date.UTC(2026, 10, 19),
  ajusteOuro: [{ pid: 8, deMin: 10, ouro: 1000 }],
  eventos: [{ type: 'CHAMPION_KILL', timestamp: 570_000, killerId: 8, victimId: 3, assistingParticipantIds: [7], position: { x: 7400, y: 7400 }, bounty: 300, shutdownBounty: 0 }],
};

function montar() {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  gravarPartida(db, partida(GANK), timeline(GANK));
  const o2: Opcoes = { matchId: 'BR1_11', campeao: 'Zed', inicioMs: Date.UTC(2026, 10, 20), fila: 440 };
  gravarPartida(db, partida(o2), timeline(o2));
  const historico = ['BR1_12'];
  const riot = {
    contaPorRiotId: async () => ({ puuid: EU, gameName: 'Eu', tagLine: 'BR1' }),
    idsDePartidas: async (_p: string, f: FiltroIds) => historico.slice(f.start ?? 0),
    partida: async (id: string) => partida({ matchId: id }),
    timeline: async (id: string) => timeline({ matchId: id }),
    ranqueadas: async () => [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 10, losses: 8 }],
  };
  const arquivoEnv = join(pasta, `.env-${Math.random()}`);
  const api = criarApi(db, { criarRiot: () => ({ riot, riotIds: [{ gameName: 'Eu', tagLine: 'BR1' }] }), arquivoEnv });
  const chamar = async (metodo: string, url: string, corpo?: unknown) => {
    const u = new URL(url, 'http://x');
    const r = await api.tratar({ metodo, caminho: u.pathname, query: u.searchParams, corpo } as Requisicao);
    return { status: r.status, corpo: r.tipo.startsWith('application/json') ? JSON.parse(r.corpo) : r.corpo, r };
  };
  return { db, api, chamar, arquivoEnv };
}

describe('API do app', () => {
  it('estado mostra o banco e nunca devolve a chave inteira', async () => {
    const { chamar } = montar();
    process.env.RIOT_API_KEY = 'RGAPI-00000000-1111-2222-3333-444455556666';
    const { corpo } = await chamar('GET', '/api/estado');
    assert.equal(corpo.banco.partidas, 2);
    assert.deepEqual(corpo.banco.contas, ['Eu#BR1']);
    assert.equal(corpo.config.finalDaChave, '6666');
    assert.ok(!JSON.stringify(corpo).includes('RGAPI-0000'));
  });

  it('relatórios respondem com colunas rotuladas e respeitam os filtros', async () => {
    const { chamar } = montar();
    const g = await chamar('GET', '/api/grupo/campeao');
    assert.deepEqual(g.corpo.linhas.map((l: { grupo: string }) => l.grupo).sort(), ['Ahri', 'Zed']);
    assert.equal(g.corpo.colunas.find((c: { chave: string }) => c.chave === 'vitoria_pct').rotulo, '% Vit');
    assert.equal((await chamar('GET', '/api/resumo?fila=flex')).corpo.jogos, 1);
    assert.equal((await chamar('GET', '/api/recentes?n=1')).corpo.linhas[0].match_id, 'BR1_11');
    assert.equal((await chamar('GET', '/api/grupo/xpto')).status, 404);
    assert.equal((await chamar('GET', '/api/resumo?fila=xpto')).status, 400);
    assert.equal((await chamar('GET', '/api/resumo?dias=-1')).status, 400);
  });

  it('viradas e detalhe de ouro da partida', async () => {
    const { chamar } = montar();
    const v = await chamar('GET', '/api/viradas');
    const gank = v.corpo.find((p: { matchId: string }) => p.matchId === 'BR1_10');
    assert.equal(gank.maiorPerda.causa, 'Gank do caçador inimigo');
    const d = await chamar('GET', '/api/ouro?match=BR1_10');
    assert.equal(d.corpo.partida.oponente, 'Zed');
    assert.equal(d.corpo.episodios[0].variacao, -950);
    assert.ok(d.corpo.episodios[0].dicas[0].includes('sentinela'));
    assert.equal((await chamar('GET', '/api/ouro?match=NAO_EXISTE')).status, 404);
    const c = await chamar('GET', '/api/causas');
    assert.equal(c.corpo.ganksSemSentinela, 1);
  });

  it('exporta CSV para download, só arquivos conhecidos', async () => {
    const { chamar } = montar();
    const r = await chamar('GET', '/api/exportar/partidas.csv?campeao=Zed');
    assert.equal(r.r.arquivo, 'partidas.csv');
    assert.equal(r.corpo.trim().split('\r\n').length, 2);
    assert.equal((await chamar('GET', '/api/exportar/..%2F.env')).status, 404);
  });

  it('sincroniza em segundo plano e mostra o andamento', async () => {
    const { chamar, api } = montar();
    const r = await chamar('POST', '/api/sync', { max: 10 });
    assert.equal(r.status, 202);
    assert.equal((await chamar('POST', '/api/sync', {})).status, 409, 'não deixa rodar dois ao mesmo tempo');
    while (api.sync.rodando) await new Promise((ok) => setTimeout(ok, 5));
    const s = await chamar('GET', '/api/sync');
    assert.equal(s.corpo.erro, null);
    assert.ok(s.corpo.log.some((l: string) => l.includes('1 partida(s) salva(s)')));
    assert.equal((await chamar('GET', '/api/estado')).corpo.banco.partidas, 3);
    const elo = await chamar('GET', '/api/elo');
    assert.equal(elo.corpo.linhas[0].elo, 'GOLD II');
  });

  it('configuração grava no .env sem apagar o resto e valida tudo', async () => {
    const { chamar, arquivoEnv } = montar();
    writeFileSync(arquivoEnv, '# comentario\nDB_PATH=data/lol.db\nRIOT_API_KEY=RGAPI-antiga-0000-0000-0000-000000000000\n');
    const ok = await chamar('POST', '/api/config', { riotId: 'Meu Nome#BR1', servidor: 'euw1', apiKey: 'RGAPI-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    assert.equal(ok.status, 200);
    const env = readFileSync(arquivoEnv, 'utf8');
    assert.match(env, /^# comentario$/m);
    assert.match(env, /^DB_PATH=data\/lol\.db$/m);
    assert.match(env, /^RIOT_API_KEY=RGAPI-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee$/m);
    assert.match(env, /^RIOT_ID="Meu Nome#BR1"$/m);
    // O mesmo leitor que o Node usa no process.loadEnvFile precisa devolver o Riot ID inteiro.
    const lido = parseEnv(env);
    assert.equal(lido.RIOT_ID, 'Meu Nome#BR1');
    assert.equal(lido.RIOT_API_KEY, 'RGAPI-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.match(env, /^RIOT_REGION=europe$/m);
    assert.equal((await chamar('POST', '/api/config', { apiKey: 'nao-e-chave' })).status, 400);
    assert.equal((await chamar('POST', '/api/config', { riotId: 'sem tag' })).status, 400);
  });

  it('validação barra quebra de linha e servidor desconhecido', () => {
    assert.throws(() => validar({ riotId: 'Nome#BR1\nRIOT_API_KEY=x' }));
    assert.throws(() => validar({ servidor: 'xx9' }));
    assert.deepEqual(validar({ servidor: 'KR' }), { RIOT_PLATFORM: 'kr', RIOT_REGION: 'asia' });
  });
});
