import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRiotId } from '../src/config.ts';
import { abrirBanco } from '../src/db.ts';
import { idDaFila } from '../src/filas.ts';
import { ClienteRiot, ErroRiot } from '../src/riot/cliente.ts';
import { Limitador } from '../src/riot/limitador.ts';
import type { FiltroIds } from '../src/riot/cliente.ts';
import { sincronizar } from '../src/sync.ts';
import { EU, partida, timeline } from './fixtures/partidas.ts';

/** Relógio falso: dormir só avança o tempo. */
function relogio() {
  let t = 0;
  const esperas: number[] = [];
  return {
    agora: () => t,
    dormir: async (ms: number) => {
      esperas.push(ms);
      t += ms;
    },
    esperas,
  };
}

describe('limitador', () => {
  it('segura a requisição que estouraria a janela', async () => {
    const r = relogio();
    const l = new Limitador([{ limite: 3, ms: 1_000 }], r.agora, r.dormir);
    for (let i = 0; i < 3; i++) await l.aguardarVez();
    assert.equal(r.esperas.length, 0);
    await l.aguardarVez();
    assert.ok(r.agora() >= 1_000, 'a quarta só sai depois de 1s');
  });

  it('respeita a janela longa (100 por 2 min) além da curta', async () => {
    const r = relogio();
    const l = new Limitador([{ limite: 20, ms: 1_000 }, { limite: 100, ms: 120_000 }], r.agora, r.dormir);
    for (let i = 0; i < 101; i++) await l.aguardarVez();
    assert.ok(r.agora() >= 120_000);
  });

  it('pausar (Retry-After) segura todo mundo', async () => {
    const r = relogio();
    const l = new Limitador([{ limite: 100, ms: 1_000 }], r.agora, r.dormir);
    l.pausar(5_000);
    await l.aguardarVez();
    assert.ok(r.agora() >= 5_000);
  });
});

describe('cliente da Riot', () => {
  function cliente(respostas: Array<() => Response>, chamadas: Array<{ url: string; chave: string | null }>) {
    const r = relogio();
    return new ClienteRiot({
      apiKey: 'RGAPI-teste',
      platform: 'br1',
      region: 'americas',
      limitePorSegundo: 20,
      limitePor2Minutos: 100,
      limitador: new Limitador([{ limite: 20, ms: 1_000 }], r.agora, r.dormir),
      dormir: r.dormir,
      fetch: (async (url: string, init?: RequestInit) => {
        chamadas.push({ url, chave: new Headers(init?.headers).get('X-Riot-Token') });
        return respostas.shift()!();
      }) as typeof fetch,
    });
  }

  it('manda a chave no header, nunca na URL, e usa a região certa', async () => {
    const chamadas: Array<{ url: string; chave: string | null }> = [];
    const c = cliente([() => Response.json({ puuid: 'p', gameName: 'Eu', tagLine: 'BR1' })], chamadas);
    await c.contaPorRiotId('Meu Nome', 'BR1');
    assert.equal(chamadas[0]!.chave, 'RGAPI-teste');
    assert.ok(!chamadas[0]!.url.includes('RGAPI'));
    assert.equal(chamadas[0]!.url, 'https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Meu%20Nome/BR1');
  });

  it('espera o Retry-After no 429 e tenta de novo', async () => {
    const chamadas: Array<{ url: string; chave: string | null }> = [];
    const c = cliente(
      [() => new Response(null, { status: 429, headers: { 'Retry-After': '2' } }), () => Response.json(['BR1_1'])],
      chamadas,
    );
    assert.deepEqual(await c.idsDePartidas('p', { queue: 420 }), ['BR1_1']);
    assert.equal(chamadas.length, 2);
    assert.match(chamadas[1]!.url, /ids\?start=0&count=100&queue=420$/);
  });

  it('chave expirada vira erro claro; partida inexistente vira null', async () => {
    const c = cliente([() => new Response(null, { status: 403 }), () => new Response(null, { status: 404 })], []);
    await assert.rejects(c.partida('X'), (e: unknown) => e instanceof ErroRiot && e.status === 403 && /24h/.test(e.message));
    assert.equal(await c.partida('Y'), null);
  });

  it('elo usa o servidor (br1), não a região', async () => {
    const chamadas: Array<{ url: string; chave: string | null }> = [];
    const c = cliente([() => Response.json([])], chamadas);
    await c.ranqueadas('p');
    assert.equal(chamadas[0]!.url, 'https://br1.api.riotgames.com/lol/league/v4/entries/by-puuid/p');
  });
});

describe('sync', () => {
  /** Riot falsa com um histórico de N partidas (BR1_N é a mais nova). */
  function riotFalsa(total: number, sumidas: string[] = []) {
    const historico = Array.from({ length: total }, (_, i) => `BR1_${total - i}`);
    const pedidos = { ids: 0, partidas: 0 };
    const riot = {
      contaPorRiotId: async () => ({ puuid: EU, gameName: 'Eu', tagLine: 'BR1' }),
      idsDePartidas: async (_p: string, f: FiltroIds) => {
        pedidos.ids++;
        return historico.slice(f.start ?? 0, (f.start ?? 0) + (f.count ?? 100));
      },
      partida: async (id: string) => {
        pedidos.partidas++;
        return sumidas.includes(id) ? null : partida({ matchId: id });
      },
      timeline: async (id: string) => timeline({ matchId: id }),
      historico,
      pedidos,
    };
    return riot;
  }
  const conta = [{ gameName: 'Eu', tagLine: 'BR1' }];
  const n = (db: ReturnType<typeof abrirBanco>) => (db.prepare('SELECT count(*) n FROM partidas').get() as { n: number }).n;

  it('baixa em lotes até completar o histórico e depois só o que é novo', async () => {
    const db = abrirBanco(':memory:');
    const riot = riotFalsa(250);
    const sync = (max: number) => sincronizar(db, riot as unknown as ClienteRiot, conta, { max });

    await sync(120);
    assert.equal(n(db), 120);
    await sync(120);
    assert.equal(n(db), 240, 'o segundo lote pega as antigas que faltaram');
    await sync(120);
    assert.equal(n(db), 250);
    assert.equal((db.prepare('SELECT historico_completo h FROM contas').get() as { h: number }).h, 1);

    riot.historico.unshift('BR1_251', 'BR1_252');
    riot.pedidos.ids = 0;
    const [r] = await sync(120);
    assert.equal(r!.novas, 2);
    assert.equal(riot.pedidos.ids, 1, 'histórico completo: para na primeira página já salva');
  });

  it('partida que a Riot não entrega mais não é pedida de novo', async () => {
    const db = abrirBanco(':memory:');
    const riot = riotFalsa(3, ['BR1_2']);
    const [r] = await sincronizar(db, riot as unknown as ClienteRiot, conta, { max: 10 });
    assert.equal(r!.indisponiveis, 1);
    riot.pedidos.partidas = 0;
    await sincronizar(db, riot as unknown as ClienteRiot, conta, { max: 10 });
    assert.equal(riot.pedidos.partidas, 0);
  });
});

describe('entradas', () => {
  it('Riot ID aceita espaço e # no nome', () => {
    assert.deepEqual(parseRiotId(' Meu Nome#BR1 '), { gameName: 'Meu Nome', tagLine: 'BR1' });
    assert.throws(() => parseRiotId('semtag'));
  });

  it('fila por apelido ou número', () => {
    assert.equal(idDaFila('solo'), 420);
    assert.equal(idDaFila('ARAM'), 450);
    assert.equal(idDaFila('1700'), 1700);
    assert.throws(() => idDaFila('xpto'));
  });
});

describe('limites da chave', () => {
  it('lê o header X-App-Rate-Limit', async () => {
    const { lerLimites } = await import('../src/riot/cliente.ts');
    assert.deepEqual(lerLimites('20:1,100:120'), [{ limite: 20, ms: 1_000 }, { limite: 100, ms: 120_000 }]);
    assert.deepEqual(lerLimites(null), []);
    assert.deepEqual(lerLimites('lixo'), []);
  });

  it('o cliente passa a usar os limites que a Riot informou', async () => {
    const r = relogio();
    const limitador = new Limitador([{ limite: 20, ms: 1_000 }], r.agora, r.dormir);
    const c = new ClienteRiot({
      apiKey: 'k', platform: 'br1', region: 'americas', limitePorSegundo: 20, limitePor2Minutos: 100, limitador, dormir: r.dormir,
      fetch: (async () => Response.json([], { headers: { 'X-App-Rate-Limit': '500:10,30000:600' } })) as unknown as typeof fetch,
    });
    await c.idsDePartidas('p');
    assert.deepEqual(limitador.limites, [{ limite: 500, ms: 10_000 }, { limite: 30_000, ms: 600_000 }]);
  });
});
