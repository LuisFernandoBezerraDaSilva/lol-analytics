import type { DatabaseSync } from 'node:sqlite';
import { classesDe, classesSalvas, NOME_CLASSE, type Classe } from '../classes.ts';

/**
 * Peso na derrota (e contribuição na vitória): uma estimativa, por números, da sua parte no
 * resultado. A régua é 20%: a parte "normal" de cada um dos 5 jogadores do time.
 *
 * 1. A sua parte no time em cada item (dano, abates, cura/escudo em aliados, dano recebido e
 *    mitigado, controle de grupo, visão, objetivos, ouro entregue nas mortes).
 * 2. A referência de cada item: quanto aquele campeão, naquela posição, costuma ter, pela média
 *    dos 10 jogadores de todas as partidas do seu banco. Com poucos jogos do campeão, usa a
 *    média da classe na posição, depois a média da posição e, por último, valores iniciais.
 *    Na régua: sua parte ÷ referência × 20. Igual ao que o campeão costuma fazer = 20.
 * 3. Contribuição = média ponderada dos itens, com pesos pela classe do campeão (Data Dragon):
 *    assassino pesa abates, tanque pesa aguentar dano e controlar, suporte pesa cura, escudo e
 *    visão, mago e atirador pesam dano, lutador mistura dano e aguentar. Campeão com duas classes
 *    mistura os pesos (2/3 e 1/3); a classe Suporte só conta jogando de suporte.
 * 4. Culpa = média de: ouro entregue nas mortes (na régua), sua parte na desvantagem das rotas
 *    aos 15 minutos e nas mortes do time no minuto antes de barão, ancião ou inibidor inimigo.
 * 5. Peso = 20 + (culpa − 20) ÷ 2 − (contribuição − 20) ÷ 2, entre 0 e 100.
 *    Inocência = (40 − peso) ÷ 40: peso 20 (a média) dá 50%.
 *
 * É uma estimativa: não vê escolha de campeões, chamadas, desistência nem jogar do lado fraco.
 */

/** Suba quando mudar as regras: os pesos salvos com a versão antiga são refeitos. */
export const VERSAO_PESO = 2;
const PARTE_NORMAL = 20;
const JANELA_MORTE_CARA_MS = 60_000;
/** Mínimo de participações do time em objetivos para o item contar (poucas = acaso). */
const MIN_OBJETIVOS = 5;
/** Mínimo de jogos para usar cada referência. */
const MINIMO = { campeao: 15, classe: 30, posicao: 20 };

export type Metrica = 'dano' | 'abates' | 'tanque' | 'utilidade' | 'controle' | 'visao' | 'objetivos' | 'entregue';
type MetricaContribuicao = Exclude<Metrica, 'entregue'>;

export const NOME_METRICA: Record<Metrica, string> = {
  dano: 'Dano em campeões',
  abates: 'Abates (assistência vale metade)',
  tanque: 'Dano recebido e mitigado',
  utilidade: 'Cura e escudo em aliados',
  controle: 'Controle de grupo',
  visao: 'Placar de visão',
  objetivos: 'Participação em objetivos',
  entregue: 'Ouro entregue nas mortes',
};

/** Peso de cada item na contribuição, por classe (cada linha soma 1). */
export const PESOS_CLASSE: Record<Classe, Partial<Record<MetricaContribuicao, number>>> = {
  Assassin: { abates: 0.45, dano: 0.3, objetivos: 0.15, visao: 0.1 },
  Mage: { dano: 0.45, abates: 0.25, objetivos: 0.15, controle: 0.1, visao: 0.05 },
  Marksman: { dano: 0.45, abates: 0.25, objetivos: 0.2, visao: 0.1 },
  Fighter: { dano: 0.3, abates: 0.25, tanque: 0.2, objetivos: 0.2, controle: 0.05 },
  Tank: { tanque: 0.35, controle: 0.25, abates: 0.15, objetivos: 0.15, visao: 0.1 },
  Support: { utilidade: 0.35, visao: 0.25, abates: 0.15, controle: 0.15, objetivos: 0.1 },
};

/** Referências iniciais por posição (sua parte "normal" no time, em %), até o banco ter jogos. */
const VALORES_INICIAIS: Record<Metrica, Record<string, number>> = {
  dano: { TOP: 22, JUNGLE: 17, MIDDLE: 25, BOTTOM: 27, UTILITY: 9 },
  abates: { TOP: 19, JUNGLE: 23, MIDDLE: 22, BOTTOM: 22, UTILITY: 14 },
  tanque: { TOP: 26, JUNGLE: 24, MIDDLE: 16, BOTTOM: 14, UTILITY: 20 },
  utilidade: { TOP: 10, JUNGLE: 10, MIDDLE: 10, BOTTOM: 5, UTILITY: 65 },
  controle: { TOP: 22, JUNGLE: 24, MIDDLE: 18, BOTTOM: 10, UTILITY: 26 },
  visao: { TOP: 15, JUNGLE: 20, MIDDLE: 15, BOTTOM: 15, UTILITY: 35 },
  objetivos: { TOP: 17, JUNGLE: 27, MIDDLE: 19, BOTTOM: 19, UTILITY: 18 },
  entregue: { TOP: 20, JUNGLE: 20, MIDDLE: 20, BOTTOM: 21, UTILITY: 19 },
};

const NOME_POSICAO: Record<string, string> = { TOP: 'top', JUNGLE: 'selva', MIDDLE: 'mid', BOTTOM: 'atirador', UTILITY: 'suporte' };

export interface ComponentePeso {
  chave: Metrica | 'rota' | 'mortes_caras';
  nome: string;
  tipo: 'culpa' | 'contribuicao';
  /** Quanto o item pesa na contribuição (0 a 100%); null nos itens de culpa. */
  pesoNaConta: number | null;
  /** Sua parte no time, em %. */
  suaParte: number;
  /** O que o campeão costuma ter nesse item (null = régua fixa de 20%). */
  referencia: number | null;
  /** De onde veio a referência (ex.: "Xerath no mid, 87 jogos"). */
  origemReferencia: string | null;
  /** Na régua de 20: sua parte ÷ referência × 20. */
  ajustado: number;
  detalhe: string;
}

export interface PesoPartida {
  matchId: string;
  vitoria: boolean;
  campeao: string;
  /** Ex.: "Mago" ou "Mago e Suporte"; "(palpite pela posição)" sem o Data Dragon. */
  classes: string;
  /** Só nas derrotas. */
  peso: number | null;
  inocencia: number | null;
  culpa: number | null;
  contribuicao: number | null;
  veredito: string;
  componentes: ComponentePeso[];
}

interface Jogador {
  id: number;
  time: number;
  campeao: string;
  posicao: string;
  kills: number;
  deaths: number;
  assists: number;
  vitoria: boolean;
  valores: Record<'dano' | 'abates' | 'tanque' | 'utilidade' | 'controle' | 'visao', number>;
}

interface Evento {
  tipo: string;
  tempo: number;
  autor: number | null;
  vitima: number | null;
  assistencias: number[];
  dados: Record<string, unknown>;
}

const numero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const limitar = (x: number, min = 0, max = 100) => Math.min(max, Math.max(min, x));
const fmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const media = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const relogio = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

function vereditoDerrota(peso: number): string {
  if (peso < 10) return 'Inocente';
  if (peso < 16) return 'Pouco peso';
  if (peso <= 24) return 'Na média do time';
  if (peso <= 32) return 'Pesou';
  return 'Pesou muito';
}

function vereditoVitoria(contribuicao: number): string {
  if (contribuicao >= 28) return 'Carregou';
  if (contribuicao >= 22) return 'Acima da média';
  if (contribuicao >= 16) return 'Na média do time';
  return 'Foi carregado';
}

/** Pesos da contribuição para o campeão: classe principal 2/3, segunda classe 1/3. */
export function pesosDoCampeao(classes: Classe[], posicao: string): Partial<Record<MetricaContribuicao, number>> {
  // A classe Suporte só conta jogando de suporte (o Xerath é "Mago/Suporte", mas no mid não cura ninguém).
  let validas = classes.filter((c) => c !== 'Support' || posicao === 'UTILITY' || classes.length === 1);
  if (validas.length === 0) validas = classes;
  if (validas.length === 0) return { dano: 0.4, abates: 0.4, objetivos: 0.2 };
  const fatias = validas.length === 1 ? [1] : [2 / 3, 1 / 3];
  const pesos: Partial<Record<MetricaContribuicao, number>> = {};
  validas.slice(0, 2).forEach((c, i) => {
    for (const [m, p] of Object.entries(PESOS_CLASSE[c]) as Array<[MetricaContribuicao, number]>) pesos[m] = (pesos[m] ?? 0) + p * fatias[i]!;
  });
  return pesos;
}

// ---------------------------------------------------------------- referências (médias do banco)

interface Acumulado {
  soma: number;
  n: number;
}
type Referencias = Map<string, Acumulado>;
const cacheReferencias = new WeakMap<DatabaseSync, { assinatura: string; refs: Referencias }>();

function acumular(refs: Referencias, chave: string, valor: number) {
  const a = refs.get(chave) ?? { soma: 0, n: 0 };
  a.soma += valor;
  a.n++;
  refs.set(chave, a);
}

/**
 * Médias de cada item por campeão+posição, classe+posição e posição, com os jogadores de todas as
 * partidas do banco, MENOS as suas contas: você está em todas as partidas, e comparar você com a
 * sua própria média tornaria mais difícil "carregar" justamente nos campeões em que você é bom.
 * Recalcula só quando entram partidas, contas ou classes novas.
 */
function referencias(db: DatabaseSync): Referencias {
  const assinatura = JSON.stringify(
    db
      .prepare(
        `SELECT (SELECT count(*) FROM partidas) p, (SELECT count(*) FROM timelines) t, (SELECT count(*) FROM campeoes_classes) c,
           (SELECT count(*) FROM contas) contas`,
      )
      .get(),
  );
  const cache = cacheReferencias.get(db);
  if (cache?.assinatura === assinatura) return cache.refs;

  const salvas = classesSalvas(db);
  const refs: Referencias = new Map();
  const registrar = (metrica: Metrica, campeao: string, posicao: string, parte: number) => {
    acumular(refs, `${metrica}|c|${campeao}|${posicao}`, parte);
    const principal = classesDe(campeao, posicao, salvas).classes[0];
    if (principal) acumular(refs, `${metrica}|k|${principal}|${posicao}`, parte);
    acumular(refs, `${metrica}|p|${posicao}`, parte);
  };

  // Itens que vêm direto dos participantes (parte do jogador no total do time).
  const linhas = db
    .prepare(
      `SELECT campeao, posicao, dano, abates, tanque, utilidade, controle, visao FROM (
         SELECT p.puuid, p.campeao, p.posicao,
           p.dano_campeoes * 100.0 / NULLIF(sum(p.dano_campeoes) OVER w, 0) AS dano,
           (p.kills + 0.5 * p.assists) * 100.0 / NULLIF(sum(p.kills + 0.5 * p.assists) OVER w, 0) AS abates,
           (p.dano_recebido + p.mitigado) * 100.0 / NULLIF(sum(p.dano_recebido + p.mitigado) OVER w, 0) AS tanque,
           (p.cura_aliados + p.escudo_aliados) * 100.0 / NULLIF(sum(p.cura_aliados + p.escudo_aliados) OVER w, 0) AS utilidade,
           p.cc_segundos * 100.0 / NULLIF(sum(p.cc_segundos) OVER w, 0) AS controle,
           p.visao * 100.0 / NULLIF(sum(p.visao) OVER w, 0) AS visao
         FROM participantes p JOIN partidas m ON m.match_id = p.match_id AND m.remake = 0
         WINDOW w AS (PARTITION BY p.match_id, p.time_id)
       ) WHERE posicao <> '' AND puuid NOT IN (SELECT puuid FROM contas)`,
    )
    .all() as Array<Record<string, number | string | null>>;
  for (const l of linhas) {
    for (const m of ['dano', 'abates', 'tanque', 'utilidade', 'controle', 'visao'] as const) {
      if (l[m] !== null) registrar(m, String(l.campeao), String(l.posicao), Number(l[m]));
    }
  }

  // Ouro entregue e objetivos vêm da timeline.
  const minhas = new Set((db.prepare('SELECT puuid FROM contas').all() as Array<{ puuid: string }>).map((c) => c.puuid));
  const porTime = (sql: string, metrica: Metrica, minimoDoTime: number) => {
    const rs = db.prepare(sql).all() as Array<{ match_id: string; time_id: number; puuid: string; campeao: string; posicao: string; valor: number }>;
    const totais = new Map<string, number>();
    for (const r of rs) totais.set(`${r.match_id}|${r.time_id}`, (totais.get(`${r.match_id}|${r.time_id}`) ?? 0) + r.valor);
    for (const r of rs) {
      const total = totais.get(`${r.match_id}|${r.time_id}`)!;
      if (r.posicao && !minhas.has(r.puuid) && total > 0 && total >= minimoDoTime) registrar(metrica, r.campeao, r.posicao, (r.valor * 100) / total);
    }
  };
  porTime(
    `SELECT p.match_id, p.time_id, p.puuid, p.campeao, p.posicao,
       coalesce(sum(coalesce(json_extract(e.json, '$.bounty'), 0) + coalesce(json_extract(e.json, '$.shutdownBounty'), 0)), 0) AS valor
     FROM participantes p
     JOIN partidas m ON m.match_id = p.match_id AND m.remake = 0
     JOIN timelines t ON t.match_id = p.match_id
     LEFT JOIN eventos e ON e.match_id = p.match_id AND e.tipo = 'CHAMPION_KILL' AND e.vitima_id = p.participant_id
     GROUP BY p.match_id, p.participant_id`,
    'entregue',
    1,
  );
  porTime(
    `SELECT p.match_id, p.time_id, p.puuid, p.campeao, p.posicao, count(e.seq) AS valor
     FROM participantes p
     JOIN partidas m ON m.match_id = p.match_id AND m.remake = 0
     JOIN timelines t ON t.match_id = p.match_id
     LEFT JOIN eventos e ON e.match_id = p.match_id AND e.tipo IN ('ELITE_MONSTER_KILL', 'BUILDING_KILL')
       AND (CASE WHEN e.tipo = 'ELITE_MONSTER_KILL' THEN json_extract(e.json, '$.killerTeamId')
                 ELSE 300 - json_extract(e.json, '$.teamId') END) = p.time_id
       AND (e.participant_id = p.participant_id
            OR instr(',' || coalesce(e.assistencias, '') || ',', ',' || p.participant_id || ',') > 0)
     GROUP BY p.match_id, p.participant_id`,
    'objetivos',
    MIN_OBJETIVOS,
  );

  cacheReferencias.set(db, { assinatura, refs });
  return refs;
}

/** A referência mais específica que tem jogos suficientes. */
function referenciaDe(refs: Referencias, metrica: Metrica, campeao: string, classe: Classe | undefined, posicao: string): { valor: number; origem: string } | null {
  if (!posicao) return null;
  const pos = NOME_POSICAO[posicao] ?? posicao.toLowerCase();
  const tentar = (chave: string, minimo: number, origem: (n: number) => string) => {
    const a = refs.get(chave);
    return a && a.n >= minimo ? { valor: a.soma / a.n, origem: origem(a.n) } : null;
  };
  return (
    tentar(`${metrica}|c|${campeao}|${posicao}`, MINIMO.campeao, (n) => `${campeao} no ${pos}, ${n} jogos`) ??
    (classe ? tentar(`${metrica}|k|${classe}|${posicao}`, MINIMO.classe, (n) => `${NOME_CLASSE[classe].toLowerCase()}s no ${pos}, ${n} jogos`) : null) ??
    tentar(`${metrica}|p|${posicao}`, MINIMO.posicao, (n) => `média do ${pos}, ${n} jogos`) ??
    (VALORES_INICIAIS[metrica][posicao] !== undefined ? { valor: VALORES_INICIAIS[metrica][posicao]!, origem: `valor inicial do ${pos}` } : null)
  );
}

// ---------------------------------------------------------------- cálculo de uma partida

/** Calcula sem cache (use `pesoDaPartida`). Null se a partida não existe ou é remake. */
export function calcularPeso(db: DatabaseSync, matchId: string, participanteId: number): PesoPartida | null {
  const partida = db.prepare('SELECT remake FROM partidas WHERE match_id = ?').get(matchId) as { remake: number } | undefined;
  if (!partida || partida.remake === 1) return null;
  const jogadores = new Map<number, Jogador>();
  for (const p of db
    .prepare(
      `SELECT participant_id, time_id, campeao, posicao, kills, deaths, assists, vitoria, dano_campeoes, dano_recebido,
         mitigado, cura_aliados, escudo_aliados, cc_segundos, visao
       FROM participantes WHERE match_id = ?`,
    )
    .all(matchId) as Array<Record<string, number | string>>) {
    const n = (c: string) => Number(p[c]);
    jogadores.set(n('participant_id'), {
      id: n('participant_id'),
      time: n('time_id'),
      campeao: String(p.campeao),
      posicao: String(p.posicao),
      kills: n('kills'),
      deaths: n('deaths'),
      assists: n('assists'),
      vitoria: n('vitoria') === 1,
      valores: {
        dano: n('dano_campeoes'),
        abates: n('kills') + 0.5 * n('assists'),
        tanque: n('dano_recebido') + n('mitigado'),
        utilidade: n('cura_aliados') + n('escudo_aliados'),
        controle: n('cc_segundos'),
        visao: n('visao'),
      },
    });
  }
  const eu = jogadores.get(participanteId);
  if (!eu) return null;
  const meuTime = [...jogadores.values()].filter((j) => j.time === eu.time);
  const outroTime = eu.time === 100 ? 200 : 100;
  const oponenteDe = (j: Jogador) => (j.posicao ? [...jogadores.values()].find((x) => x.time !== j.time && x.posicao === j.posicao) ?? null : null);
  const op = oponenteDe(eu);

  const salvas = classesSalvas(db);
  const { classes, doDataDragon } = classesDe(eu.campeao, eu.posicao, salvas);
  const refs = referencias(db);
  const pesos = pesosDoCampeao(classes, eu.posicao);
  const nomeClasses = classes.length ? classes.map((c) => NOME_CLASSE[c]).join(' e ') : 'sem classe';

  const eventos = (
    db
      .prepare(
        `SELECT tipo, tempo_ms, participant_id, vitima_id, assistencias, json FROM eventos
         WHERE match_id = ? AND tipo IN ('CHAMPION_KILL', 'ELITE_MONSTER_KILL', 'BUILDING_KILL') ORDER BY seq`,
      )
      .all(matchId) as Array<{ tipo: string; tempo_ms: number; participant_id: number | null; vitima_id: number | null; assistencias: string | null; json: string }>
  ).map(
    (e): Evento => ({
      tipo: e.tipo,
      tempo: e.tempo_ms,
      autor: e.participant_id,
      vitima: e.vitima_id,
      assistencias: e.assistencias ? e.assistencias.split(',').map(Number) : [],
      dados: JSON.parse(e.json) as Record<string, unknown>,
    }),
  );
  const temTimeline = eventos.length > 0;
  const componentes: ComponentePeso[] = [];

  /** Monta um item comparado com a referência do campeão. */
  const item = (metrica: Metrica, valorDe: (j: Jogador) => number, tipo: 'culpa' | 'contribuicao', minimoDoTime = 1, detalhe?: (sua: number, total: number) => string) => {
    const total = meuTime.reduce((s, j) => s + valorDe(j), 0);
    if (total <= 0 || total < minimoDoTime) return;
    const suaParte = (valorDe(eu) / total) * 100;
    const ref = referenciaDe(refs, metrica, eu.campeao, classes[0], eu.posicao);
    const ajustado = ref ? limitar((PARTE_NORMAL * suaParte) / Math.max(ref.valor, 2)) : limitar(suaParte);
    componentes.push({
      chave: metrica,
      nome: NOME_METRICA[metrica],
      tipo,
      pesoNaConta: null,
      suaParte: r1(suaParte),
      referencia: ref ? r1(ref.valor) : null,
      origemReferencia: ref?.origem ?? null,
      ajustado: r1(ajustado),
      detalhe:
        (detalhe ? detalhe(valorDe(eu), total) : `Você teve ${fmt.format(suaParte)}% do time em "${NOME_METRICA[metrica].toLowerCase()}"`) +
        (ref ? `; o normal é ${fmt.format(ref.valor)}% (${ref.origem}).` : '.'),
    });
  };

  // ---- culpa: ouro entregue
  const abates = eventos.filter((e) => e.tipo === 'CHAMPION_KILL');
  const recompensa = (e: Evento) => numero(e.dados.bounty) + numero(e.dados.shutdownBounty);
  const temRecompensa = temTimeline && abates.some((e) => recompensa(e) > 0);
  item(
    'entregue',
    (j) => (temRecompensa ? abates.filter((e) => e.vitima === j.id).reduce((s, e) => s + recompensa(e), 0) : j.deaths),
    'culpa',
    1,
    (sua, total) => `Suas mortes entregaram ${fmt.format(sua)} de ${fmt.format(total)} ${temRecompensa ? 'de ouro' : 'mortes'} do time`,
  );

  // ---- culpa: rota aos 15 minutos
  const frames = db
    .prepare(
      `SELECT participant_id, ouro_total, minuto FROM frames
       WHERE match_id = ? AND minuto = (SELECT min(15, max(minuto)) FROM frames WHERE match_id = ?)`,
    )
    .all(matchId, matchId) as Array<{ participant_id: number; ouro_total: number; minuto: number }>;
  if (frames.length && op) {
    const ouro = new Map(frames.map((f) => [f.participant_id, f.ouro_total]));
    const minuto = frames[0]!.minuto;
    const deficit = (j: Jogador) => {
      const o = oponenteDe(j);
      if (!o || !ouro.has(j.id) || !ouro.has(o.id)) return 0;
      return Math.max(0, ouro.get(o.id)! - ouro.get(j.id)!);
    };
    const total = meuTime.reduce((s, j) => s + deficit(j), 0);
    const meu = ouro.get(eu.id)! - ouro.get(op.id)!;
    if (total > 0) {
      const suaParte = (deficit(eu) / total) * 100;
      componentes.push({
        chave: 'rota',
        nome: `Desvantagem nas rotas aos ${minuto} min`,
        tipo: 'culpa',
        pesoNaConta: null,
        suaParte: r1(suaParte),
        referencia: null,
        origemReferencia: null,
        ajustado: r1(suaParte),
        detalhe: `Você estava ${fmt.format(Math.abs(meu))} de ouro ${meu < 0 ? 'atrás do' : 'à frente do'} seu oponente; as rotas do time somavam ${fmt.format(total)} de desvantagem.`,
      });
    }
  }

  // ---- culpa: mortes antes de objetivo grande do inimigo
  const grandes = eventos.filter(
    (e) =>
      (e.tipo === 'ELITE_MONSTER_KILL' &&
        numero(e.dados.killerTeamId) === outroTime &&
        (e.dados.monsterType === 'BARON_NASHOR' || e.dados.monsterSubType === 'ELDER_DRAGON')) ||
      (e.tipo === 'BUILDING_KILL' && numero(e.dados.teamId) === eu.time && e.dados.buildingType === 'INHIBITOR_BUILDING'),
  );
  if (grandes.length) {
    const caras = new Map<number, Array<{ tempo: number; objetivo: string }>>();
    for (const g of grandes) {
      const nome = g.tipo === 'BUILDING_KILL' ? 'inibidor' : g.dados.monsterType === 'BARON_NASHOR' ? 'barão' : 'dragão ancião';
      for (const m of abates) {
        const vitima = m.vitima !== null ? jogadores.get(m.vitima) : undefined;
        if (vitima && vitima.time === eu.time && m.tempo <= g.tempo && m.tempo > g.tempo - JANELA_MORTE_CARA_MS) {
          caras.set(vitima.id, [...(caras.get(vitima.id) ?? []), { tempo: m.tempo, objetivo: nome }]);
        }
      }
    }
    const total = [...caras.values()].reduce((s, l) => s + l.length, 0);
    if (total > 0) {
      const minhas = caras.get(eu.id) ?? [];
      const suaParte = (minhas.length / total) * 100;
      componentes.push({
        chave: 'mortes_caras',
        nome: 'Mortes antes de objetivo grande',
        tipo: 'culpa',
        pesoNaConta: null,
        suaParte: r1(suaParte),
        referencia: null,
        origemReferencia: null,
        ajustado: r1(suaParte),
        detalhe: minhas.length
          ? `Você morreu ${minhas.map((m) => `aos ${relogio(m.tempo)} (antes do ${m.objetivo})`).join(', ')}; o time teve ${total} morte(s) assim.`
          : `O time teve ${total} morte(s) no minuto antes de um objetivo grande do inimigo, nenhuma sua.`,
      });
    }
  }

  // ---- contribuição: os itens que pesam para a classe do campeão
  const objetivosDe = (j: Jogador) =>
    eventos.filter(
      (e) =>
        ((e.tipo === 'ELITE_MONSTER_KILL' && numero(e.dados.killerTeamId) === j.time) ||
          (e.tipo === 'BUILDING_KILL' && numero(e.dados.teamId) === (j.time === 100 ? 200 : 100))) &&
        (e.autor === j.id || e.assistencias.includes(j.id)),
    ).length;
  const detalhes: Partial<Record<MetricaContribuicao, (sua: number, total: number) => string>> = {
    dano: (s, t) => `Você causou ${fmt.format((s / t) * 100)}% do dano do time`,
    abates: () => `Você fez ${eu.kills} abate(s) e ${eu.assists} assistência(s), ${fmt.format(((eu.valores.abates) / meuTime.reduce((x, j) => x + j.valores.abates, 0)) * 100)}% do time`,
    tanque: (s, t) => `Você recebeu e mitigou ${fmt.format((s / t) * 100)}% do dano que o time aguentou`,
    utilidade: (s, t) => `Você fez ${fmt.format((s / t) * 100)}% da cura e do escudo em aliados do time`,
    controle: (s, t) => `Você fez ${fmt.format((s / t) * 100)}% do tempo de controle de grupo do time`,
    visao: (s, t) => `Você teve ${fmt.format((s / t) * 100)}% do placar de visão do time`,
    objetivos: (s) => `Você participou de ${s} objetivo(s) do time`,
  };
  for (const [metrica, peso] of Object.entries(pesos) as Array<[MetricaContribuicao, number]>) {
    if (!peso) continue;
    if (metrica === 'objetivos') {
      if (temTimeline) item('objetivos', objetivosDe, 'contribuicao', MIN_OBJETIVOS, detalhes.objetivos);
    } else {
      item(metrica, (j) => j.valores[metrica], 'contribuicao', 1, detalhes[metrica]);
    }
  }
  const contrib = componentes.filter((c) => c.tipo === 'contribuicao');
  const somaPesos = contrib.reduce((s, c) => s + (pesos[c.chave as MetricaContribuicao] ?? 0), 0);
  for (const c of contrib) c.pesoNaConta = somaPesos ? r1(((pesos[c.chave as MetricaContribuicao] ?? 0) / somaPesos) * 100) : null;
  const contribuicao = somaPesos ? contrib.reduce((s, c) => s + c.ajustado * (pesos[c.chave as MetricaContribuicao] ?? 0), 0) / somaPesos : null;
  const culpa = media(componentes.filter((c) => c.tipo === 'culpa').map((c) => c.ajustado));

  let peso: number | null = null;
  let inocencia: number | null = null;
  let veredito: string;
  if (eu.vitoria) {
    veredito = contribuicao === null ? 'Sem dados' : vereditoVitoria(contribuicao);
  } else {
    peso = r1(limitar(PARTE_NORMAL + ((culpa ?? PARTE_NORMAL) - PARTE_NORMAL) / 2 - ((contribuicao ?? PARTE_NORMAL) - PARTE_NORMAL) / 2));
    inocencia = r1(limitar(((2 * PARTE_NORMAL - peso) / (2 * PARTE_NORMAL)) * 100));
    veredito = vereditoDerrota(peso);
  }
  return {
    matchId,
    vitoria: eu.vitoria,
    campeao: eu.campeao,
    classes: doDataDragon ? nomeClasses : `${nomeClasses} (palpite pela posição)`,
    peso,
    inocencia,
    culpa: culpa === null ? null : r1(culpa),
    contribuicao: contribuicao === null ? null : r1(contribuicao),
    veredito,
    componentes,
  };
}

/** O peso da partida para esse jogador: lido do banco se já foi calculado, senão calculado e guardado. */
export function pesoDaPartida(db: DatabaseSync, matchId: string, participanteId: number): PesoPartida | null {
  const salvo = db
    .prepare('SELECT json FROM analise_peso WHERE match_id = ? AND participant_id = ? AND versao = ?')
    .get(matchId, participanteId, VERSAO_PESO) as { json: string } | undefined;
  if (salvo) {
    const antigo = JSON.parse(salvo.json) as PesoPartida;
    // Calculado antes de o app ter as classes do Data Dragon: refaz quando elas chegarem.
    const eraPalpite = antigo.classes.includes('(palpite') && classesSalvas(db).has(antigo.campeao.toLowerCase());
    if (!eraPalpite) return antigo;
  }
  const p = calcularPeso(db, matchId, participanteId);
  if (!p) return null;
  db.prepare(
    `INSERT OR REPLACE INTO analise_peso (match_id, participant_id, versao, json, calculado_em) VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(matchId, participanteId, VERSAO_PESO, JSON.stringify(p));
  return p;
}
