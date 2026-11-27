import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { calcularPeso, pesoDaPartida, pesosDoCampeao } from '../src/analise/peso.ts';
import { criarApi } from '../src/app/api.ts';
import { atualizarClasses } from '../src/classes.ts';
import { abrirBanco } from '../src/db.ts';
import { gravarPartida } from '../src/processar.ts';
import { desempenhoPorCampeao, melhoresPorRota } from '../src/relatorios/desempenho.ts';
import type { EventoTimeline, Partida } from '../src/riot/tipos.ts';
import { EU, partida, timeline, type Opcoes } from './fixtures/partidas.ts';

// Times: 1-5 (azul) e 6-10 (vermelho), na ordem top, selva, mid, atirador, suporte. Você = 3 (mid).
// Sem classes no banco, o mid vira palpite "Mago": dano 45%, abates 25%, objetivos 15%,
// controle 10%, visão 5% (itens sem dado no time ficam de fora e os pesos se redistribuem).
// Com poucas partidas no banco, a referência é o valor inicial do mid: dano 25%, abates 22%,
// visão 15%, ouro entregue 20%.
// Dano: você 24.000 e os outros 15.000 → 28,6% → na régua 22,9.
// Abates (assistência vale metade): você 5 + 3,5 e os outros 2 + 1 → 41,5% → na régua 37,7.
// Visão: você 30 e os outros 20 → 27,3% → na régua 36,4.
// Contribuição = (0,45 × 22,9 + 0,25 × 37,7 + 0,05 × 36,4) ÷ 0,75 = 28,7.
const abate = (ms: number, killerId: number, victimId: number): EventoTimeline => ({
  type: 'CHAMPION_KILL', timestamp: ms, killerId, victimId, assistingParticipantIds: [], position: { x: 7400, y: 7400 }, bounty: 300, shutdownBounty: 0,
});

// Derrota pesada: 3 das 5 mortes do time são suas (900 de 1.500 de ouro entregue), uma delas logo
// antes do barão inimigo, e você é a única rota atrás aos 15 min.
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
const perto = (a: number | null | undefined, b: number, tolerancia = 0.15) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) <= tolerancia, `${a} ≉ ${b}`);

/** Classes como o Data Dragon informa. */
async function comClasses(db: ReturnType<typeof banco>, tags: Record<string, string[]>) {
  await atualizarClasses(db, { classes: async () => ({ versao: '16.23.1', tags }) });
}

describe('pesos por classe', () => {
  it('a classe Suporte só conta jogando de suporte; duas classes misturam 2/3 e 1/3', () => {
    assert.deepEqual(pesosDoCampeao(['Mage', 'Support'], 'MIDDLE'), { dano: 0.45, abates: 0.25, objetivos: 0.15, controle: 0.1, visao: 0.05 });
    const xerathSup = pesosDoCampeao(['Mage', 'Support'], 'UTILITY');
    perto(xerathSup.dano!, 0.3, 0.001);
    perto(xerathSup.utilidade!, 0.35 / 3, 0.001);
    const assassino = pesosDoCampeao(['Assassin'], 'MIDDLE');
    assert.ok(assassino.abates! > assassino.dano!, 'assassino pesa mais abater do que dano');
    const tanque = pesosDoCampeao(['Tank'], 'TOP');
    assert.equal(tanque.dano, undefined, 'tanque não é cobrado por dano');
    assert.ok(tanque.tanque! > 0.3);
  });
});

describe('peso na derrota', () => {
  it('derrota em que você pesou muito', () => {
    const p = calcularPeso(banco(PESADA), 'L1', 3)!;
    assert.equal(p.classes, 'Mago (palpite pela posição)');
    const ouro = componente(p, 'entregue')!;
    assert.deepEqual([ouro.suaParte, ouro.referencia, ouro.ajustado], [60, 20, 60]);
    assert.equal(ouro.origemReferencia, 'valor inicial do mid');
    assert.equal(componente(p, 'rota')!.ajustado, 100);
    assert.equal(componente(p, 'mortes_caras')!.ajustado, 100);
    assert.equal(componente(p, 'dano')!.ajustado, 22.9);
    assert.equal(componente(p, 'abates')!.ajustado, 37.7);
    assert.equal(componente(p, 'visao')!.ajustado, 36.4);
    assert.equal(componente(p, 'controle'), undefined, 'sem controle de grupo no time, o item sai da conta');
    assert.equal(componente(p, 'dano')!.pesoNaConta, 60); // 0,45 ÷ 0,75
    perto(p.contribuicao, 28.7);
    perto(p.peso, 49); // 20 + (86,7 − 20) ÷ 2 − (28,7 − 20) ÷ 2
    assert.equal(p.veredito, 'Pesou muito');
  });

  it('derrota em que você foi inocente', () => {
    const p = calcularPeso(banco(INOCENTE), 'I1', 3)!;
    assert.equal(componente(p, 'entregue')!.ajustado, 0);
    assert.equal(p.culpa, 0);
    perto(p.peso, 5.6);
    perto(p.inocencia, 86, 0.3);
    assert.equal(p.veredito, 'Inocente');
  });

  it('vitória mostra a contribuição, sem peso', () => {
    const p = calcularPeso(banco(VITORIA), 'W1', 3)!;
    assert.equal(p.peso, null);
    perto(p.contribuicao, 28.7);
    assert.equal(p.veredito, 'Carregou');
  });
});

describe('a partida do print (Xerath 23/5/5)', () => {
  /** Ranqueada de 26/11: os números do placar, na mesma ordem de posições. */
  function partidaDoPrint(): Partida {
    const p = partida({ matchId: 'BR1_PRINT', vitoria: true, duracaoS: 1608 });
    const dados: Array<[string, number, number, number, number, number]> = [
      ['Yasuo', 2, 4, 10, 14127, 31], ['Udyr', 5, 1, 1, 3005, 24], ['Xerath', 23, 5, 5, 52154, 10], ['Jhin', 8, 3, 15, 24471, 14], ['Galio', 4, 3, 23, 15041, 54],
      ['Teemo', 3, 7, 3, 11993, 13], ['Sejuani', 0, 7, 5, 9620, 12], ['Fizz', 8, 10, 0, 18962, 14], ['Twitch', 5, 10, 2, 12958, 9], ['Soraka', 0, 8, 6, 2805, 39],
    ];
    dados.forEach(([campeao, k, d, a, dano, visao], i) => {
      Object.assign(p.info.participants[i]!, { championName: campeao, kills: k, deaths: d, assists: a, totalDamageDealtToChampions: dano, visionScore: visao });
    });
    return p;
  }

  it('dá "Carregou" (antes dava "Na média do time")', async () => {
    const db = abrirBanco(':memory:');
    db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
    await comClasses(db, { Xerath: ['Mage', 'Support'], Fizz: ['Assassin', 'Fighter'] });
    gravarPartida(db, partidaDoPrint(), null);
    const p = calcularPeso(db, 'BR1_PRINT', 3)!;
    assert.equal(p.classes, 'Mago e Suporte');
    assert.equal(componente(p, 'utilidade'), undefined, 'no mid, a parte de suporte não conta');
    assert.equal(componente(p, 'dano')!.suaParte, 47.9);
    assert.equal(componente(p, 'dano')!.ajustado, 38.3); // 47,9% contra 25% do mid
    assert.equal(componente(p, 'abates')!.ajustado, 33.6); // 25,5 de 69 (assistência vale metade)
    perto(p.contribuicao, 34.8);
    assert.equal(p.veredito, 'Carregou');
  });
});

describe('suporte de cura', () => {
  it('pouco dano não derruba quem cura, dá escudo e controla', async () => {
    const db = banco();
    await comClasses(db, { Soraka: ['Support', 'Mage'] });
    const p = partida({ matchId: 'S1', vitoria: true });
    const time = p.info.participants;
    Object.assign(time[4]!, { championName: 'Soraka', totalDamageDealtToChampions: 5000, kills: 0, assists: 15, visionScore: 60, totalHealsOnTeammates: 20000, timeCCingOthers: 20 });
    for (const i of [0, 1, 2, 3]) Object.assign(time[i]!, { timeCCingOthers: 10 });
    gravarPartida(db, p, null);
    const r = calcularPeso(db, 'S1', 5)!;
    const util = componente(r, 'utilidade')!;
    assert.equal(util.suaParte, 100);
    assert.ok(util.pesoNaConta! > componente(r, 'dano')!.pesoNaConta!, 'cura pesa mais que dano para suporte');
    assert.ok(componente(r, 'dano')!.suaParte < 10);
    assert.ok(r.contribuicao! >= 25, `contribuição ${r.contribuicao}`);
  });
});

describe('referências do seu banco', () => {
  it('com jogos suficientes do campeão, a régua é a média dele naquela posição (sem as suas contas)', () => {
    const ids = Array.from({ length: 16 }, (_, i) => ({ matchId: `R${i}`, vitoria: true }) as Opcoes);
    // A Ahri (3) aqui é de outra pessoa: o banco não tem contas suas.
    const db = abrirBanco(':memory:');
    for (const o of ids) gravarPartida(db, partida(o), timeline(o));
    const p = calcularPeso(db, 'R0', 3)!;
    const dano = componente(p, 'dano')!;
    assert.equal(dano.origemReferencia, 'Ahri no mid, 16 jogos');
    assert.equal(dano.referencia, 28.6);
    assert.equal(dano.ajustado, 20, 'igual ao que a Ahri costuma fazer = 20');
  });

  it('as suas próprias partidas não entram na régua', () => {
    const ids = Array.from({ length: 20 }, (_, i) => ({ matchId: `R${i}`, vitoria: true }) as Opcoes);
    const dano = componente(calcularPeso(banco(...ids), 'R0', 3), 'dano')!;
    assert.notEqual(dano.origemReferencia, 'Ahri no mid, 16 jogos', 'a Ahri é você: cai para a média da posição');
    assert.equal(dano.origemReferencia, 'média do mid, 20 jogos');
    assert.equal(dano.referencia, 20, 'os mids do outro time');
  });
});

describe('peso salvo e banco antigo', () => {
  it('remake não tem peso; o resultado fica salvo e é refeito se a partida for regravada', () => {
    const db = banco(PESADA, { matchId: 'R1', remake: true, duracaoS: 200 });
    assert.equal(calcularPeso(db, 'R1', 3), null);
    const antes = pesoDaPartida(db, 'L1', 3)!.peso;
    db.prepare('UPDATE participantes SET dano_campeoes = 0').run();
    assert.equal(pesoDaPartida(db, 'L1', 3)!.peso, antes, 'leu o resultado salvo');
    gravarPartida(db, partida(PESADA), timeline(PESADA));
    assert.equal((db.prepare('SELECT count(*) n FROM analise_peso').get() as { n: number }).n, 0);
  });

  it('peso feito com o palpite de classe é refeito quando a classe real chega', async () => {
    const db = banco(VITORIA);
    assert.match(pesoDaPartida(db, 'W1', 3)!.classes, /palpite/);
    await comClasses(db, { Ahri: ['Mage', 'Assassin'] });
    assert.equal(pesoDaPartida(db, 'W1', 3)!.classes, 'Mago e Assassino');
  });

  it('banco antigo ganha as colunas novas, preenchidas pelo JSON já salvo', () => {
    const arquivo = join(tmpdir(), `lol-migra-${process.pid}.db`);
    try {
      let db = abrirBanco(arquivo);
      const p = partida({ matchId: 'M1' });
      Object.assign(p.info.participants[2]!, { totalHealsOnTeammates: 1234, timeCCingOthers: 17, damageSelfMitigated: 999 });
      gravarPartida(db, p, null);
      for (const c of ['mitigado', 'cura_aliados', 'escudo_aliados', 'cc_segundos']) db.exec(`ALTER TABLE participantes DROP COLUMN ${c}`);
      db.close();
      db = abrirBanco(arquivo);
      const r = db.prepare('SELECT mitigado, cura_aliados, cc_segundos FROM participantes WHERE participant_id = 3').get() as Record<string, number>;
      assert.deepEqual({ ...r }, { mitigado: 999, cura_aliados: 1234, cc_segundos: 17 });
      db.close();
    } finally {
      for (const s of ['', '-wal', '-shm']) rmSync(arquivo + s, { force: true });
    }
  });
});

describe('peso nas listas', () => {
  it('desempenho e melhores por rota usam o peso médio nas derrotas', () => {
    const db = banco(PESADA, INOCENTE, VITORIA);
    const [ahri] = desempenhoPorCampeao(db, {});
    perto(ahri!.peso_derrota, 27.3, 0.2); // (49 + 5,6) ÷ 2
    assert.match(melhoresPorRota(db, {})[0]!.menos_peso!, /^Ahri \(27,\d% de peso nas derrotas em 3 jogos\)$/);
  });

  it('API: partidas com peso e veredito, e o detalhe de uma partida', async () => {
    const db = banco(PESADA, VITORIA);
    const api = criarApi(db, { ddragon: { iconeCampeao: async () => null, iconeItem: async () => null, itens: async () => ({}), classes: async () => null } });
    const chamar = async (url: string) => {
      const u = new URL(url, 'http://x');
      const r = await api.tratar({ metodo: 'GET', caminho: u.pathname, query: u.searchParams });
      return { status: r.status, corpo: JSON.parse(String(r.corpo)) };
    };
    const rec = await chamar('/api/recentes');
    const porId = Object.fromEntries(rec.corpo.linhas.map((l: { match_id: string }) => [l.match_id, l]));
    perto(porId.L1.peso, 49);
    assert.equal(porId.L1.veredito, 'Pesou muito');
    assert.equal(porId.W1.peso, null);
    assert.equal(porId.W1.veredito, 'Carregou');
    const d = await chamar('/api/peso?match=L1');
    assert.ok(d.corpo.componentes.length >= 5);
    assert.equal((await chamar('/api/peso?match=nada')).status, 404);
    const outro = await chamar('/api/peso?match=L1&puuid=puuid-L1-8');
    assert.equal(outro.corpo.vitoria, true, 'pela visão do oponente, foi vitória');
  });
});
