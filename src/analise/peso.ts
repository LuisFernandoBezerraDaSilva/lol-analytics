import type { DatabaseSync } from 'node:sqlite';

/**
 * Peso na derrota (e contribuição na vitória): uma estimativa, por números, da sua parte no
 * resultado. A régua é 20%: a parte "normal" de cada um dos 5 jogadores do time.
 *
 * Parte nas coisas que deram errado (culpa):
 *   - Ouro entregue: das recompensas (bounty + shutdown) que o inimigo ganhou matando o seu
 *     time, quanto veio das suas mortes.
 *   - Rota: da desvantagem de ouro das rotas do seu time aos 15 minutos, quanto era da sua.
 *   - Mortes caras: das mortes do seu time no minuto antes de o inimigo pegar barão, dragão
 *     ancião ou um inibidor, quantas foram suas.
 * Parte nas coisas que deram certo (contribuição):
 *   - Dano em campeões, abates + assistências e participação nos objetivos do time.
 *
 * Ajuste pela posição: suporte e caçador naturalmente causam menos dano e morrem mais. Por isso
 * ouro entregue, dano, abates e objetivos são comparados com a parte do jogador da mesma posição
 * no outro time (se ele teve 10% do dano do time dele e você 10% do seu, você fica em 20%).
 *
 * Peso = 20 + (culpa − 20) ÷ 2 − (contribuição − 20) ÷ 2, entre 0 e 100.
 * Inocência = (40 − peso) ÷ 40, entre 0% e 100%: peso 20 (a média) dá 50%.
 *
 * É uma estimativa: não vê escolha de campeões, chamadas, desistência nem jogar do lado fraco.
 */

/** Suba quando mudar as regras: os pesos salvos com a versão antiga são refeitos. */
export const VERSAO_PESO = 1;
const PARTE_NORMAL = 20;
const JANELA_MORTE_CARA_MS = 60_000;

export interface ComponentePeso {
  chave: 'ouro_entregue' | 'rota' | 'mortes_caras' | 'dano' | 'abates' | 'objetivos';
  nome: string;
  tipo: 'culpa' | 'contribuicao';
  /** Sua parte bruta no time, em %. */
  suaParte: number;
  /** Parte do jogador da mesma posição no outro time (null = sem ajuste, régua de 20%). */
  parteDoOponente: number | null;
  /** Sua parte na régua de 20%, já ajustada pela posição. */
  ajustado: number;
  detalhe: string;
}

export interface PesoPartida {
  matchId: string;
  vitoria: boolean;
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
  posicao: string;
  kills: number;
  deaths: number;
  assists: number;
  dano: number;
  vitoria: boolean;
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

/** Calcula sem cache (use `pesoDaPartida`). Null se a partida não existe ou é remake. */
export function calcularPeso(db: DatabaseSync, matchId: string, participanteId: number): PesoPartida | null {
  const partida = db.prepare('SELECT remake FROM partidas WHERE match_id = ?').get(matchId) as { remake: number } | undefined;
  if (!partida || partida.remake === 1) return null;
  const jogadores = new Map<number, Jogador>();
  for (const p of db
    .prepare('SELECT participant_id, time_id, posicao, kills, deaths, assists, dano_campeoes, vitoria FROM participantes WHERE match_id = ?')
    .all(matchId) as Array<{ participant_id: number; time_id: number; posicao: string; kills: number; deaths: number; assists: number; dano_campeoes: number; vitoria: number }>) {
    jogadores.set(p.participant_id, {
      id: p.participant_id,
      time: p.time_id,
      posicao: p.posicao,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      dano: p.dano_campeoes,
      vitoria: p.vitoria === 1,
    });
  }
  const eu = jogadores.get(participanteId);
  if (!eu) return null;
  const doTime = (time: number) => [...jogadores.values()].filter((j) => j.time === time);
  const outroTime = eu.time === 100 ? 200 : 100;
  const oponenteDe = (j: Jogador) => (j.posicao ? [...jogadores.values()].find((x) => x.time !== j.time && x.posicao === j.posicao) ?? null : null);
  const op = oponenteDe(eu);

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

  /** Sua parte no time e a do oponente de posição no time dele, para um valor por jogador. */
  const partes = (valor: (j: Jogador) => number) => {
    const total = (time: number) => doTime(time).reduce((s, j) => s + valor(j), 0);
    const tEu = total(eu.time);
    const tOp = total(outroTime);
    const suaParte = tEu ? (valor(eu) / tEu) * 100 : 0;
    const parteDoOponente = op && tOp ? (valor(op) / tOp) * 100 : null;
    return { suaParte, parteDoOponente, totalTime: tEu };
  };
  /** Leva para a régua de 20%: igual ao oponente de posição = 20. */
  const ajustar = (suaParte: number, parteDoOponente: number | null) =>
    limitar(parteDoOponente === null ? suaParte : (PARTE_NORMAL * suaParte) / Math.max(parteDoOponente, 5));

  // ---- culpa: ouro entregue
  const abates = eventos.filter((e) => e.tipo === 'CHAMPION_KILL');
  const recompensa = (e: Evento) => numero(e.dados.bounty) + numero(e.dados.shutdownBounty);
  const temRecompensa = abates.some((e) => recompensa(e) > 0);
  const entregue = (j: Jogador) =>
    temTimeline && temRecompensa ? abates.filter((e) => e.vitima === j.id).reduce((s, e) => s + recompensa(e), 0) : j.deaths;
  {
    const p = partes(entregue);
    if (p.totalTime > 0) {
      const unidade = temTimeline && temRecompensa ? 'de ouro' : 'mortes';
      componentes.push({
        chave: 'ouro_entregue',
        nome: 'Ouro entregue nas mortes',
        tipo: 'culpa',
        suaParte: r1(p.suaParte),
        parteDoOponente: p.parteDoOponente === null ? null : r1(p.parteDoOponente),
        ajustado: r1(ajustar(p.suaParte, p.parteDoOponente)),
        detalhe: `Suas mortes entregaram ${fmt.format(entregue(eu))} de ${fmt.format(p.totalTime)} ${unidade} do time (${fmt.format(p.suaParte)}%).`,
      });
    }
  }

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
    const total = doTime(eu.time).reduce((s, j) => s + deficit(j), 0);
    const meu = ouro.get(eu.id)! - ouro.get(op.id)!;
    if (total > 0) {
      const suaParte = (deficit(eu) / total) * 100;
      componentes.push({
        chave: 'rota',
        nome: `Desvantagem nas rotas aos ${minuto} min`,
        tipo: 'culpa',
        suaParte: r1(suaParte),
        parteDoOponente: null,
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
        suaParte: r1(suaParte),
        parteDoOponente: null,
        ajustado: r1(suaParte),
        detalhe: minhas.length
          ? `Você morreu ${minhas.map((m) => `aos ${relogio(m.tempo)} (antes do ${m.objetivo})`).join(', ')}; o time teve ${total} morte(s) assim.`
          : `O time teve ${total} morte(s) no minuto antes de um objetivo grande do inimigo, nenhuma sua.`,
      });
    }
  }

  // ---- contribuição
  {
    const p = partes((j) => j.dano);
    if (p.totalTime > 0) {
      componentes.push({
        chave: 'dano',
        nome: 'Dano em campeões',
        tipo: 'contribuicao',
        suaParte: r1(p.suaParte),
        parteDoOponente: p.parteDoOponente === null ? null : r1(p.parteDoOponente),
        ajustado: r1(ajustar(p.suaParte, p.parteDoOponente)),
        detalhe: `Você causou ${fmt.format(p.suaParte)}% do dano do time${p.parteDoOponente !== null ? `; o oponente de posição, ${fmt.format(p.parteDoOponente)}% do time dele` : ''}.`,
      });
    }
  }
  {
    const p = partes((j) => j.kills + j.assists);
    if (p.totalTime > 0) {
      componentes.push({
        chave: 'abates',
        nome: 'Abates e assistências',
        tipo: 'contribuicao',
        suaParte: r1(p.suaParte),
        parteDoOponente: p.parteDoOponente === null ? null : r1(p.parteDoOponente),
        ajustado: r1(ajustar(p.suaParte, p.parteDoOponente)),
        detalhe: `Você teve ${fmt.format(p.suaParte)}% dos abates e assistências do time.`,
      });
    }
  }
  if (temTimeline) {
    const objetivoDo = (time: number) => (e: Evento) =>
      (e.tipo === 'ELITE_MONSTER_KILL' && numero(e.dados.killerTeamId) === time) ||
      (e.tipo === 'BUILDING_KILL' && numero(e.dados.teamId) === (time === 100 ? 200 : 100));
    const participou = (j: Jogador) =>
      eventos.filter((e) => objetivoDo(j.time)(e) && (e.autor === j.id || e.assistencias.includes(j.id))).length;
    const p = partes(participou);
    if (p.totalTime > 0) {
      componentes.push({
        chave: 'objetivos',
        nome: 'Participação em objetivos',
        tipo: 'contribuicao',
        suaParte: r1(p.suaParte),
        parteDoOponente: p.parteDoOponente === null ? null : r1(p.parteDoOponente),
        ajustado: r1(ajustar(p.suaParte, p.parteDoOponente)),
        detalhe: `Você participou de ${participou(eu)} objetivo(s) do time (${fmt.format(p.suaParte)}% das participações).`,
      });
    }
  }

  const culpa = media(componentes.filter((c) => c.tipo === 'culpa').map((c) => c.ajustado));
  const contribuicao = media(componentes.filter((c) => c.tipo === 'contribuicao').map((c) => c.ajustado));
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
  if (salvo) return JSON.parse(salvo.json) as PesoPartida;
  const p = calcularPeso(db, matchId, participanteId);
  if (!p) return null;
  db.prepare(
    `INSERT OR REPLACE INTO analise_peso (match_id, participant_id, versao, json, calculado_em) VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(matchId, participanteId, VERSAO_PESO, JSON.stringify(p));
  return p;
}
