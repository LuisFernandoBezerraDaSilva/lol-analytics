import type { DatabaseSync } from 'node:sqlite';
import { analiseDaPartida, PADRAO_ANALISE, type Causa } from '../analise/ouro.ts';
import { pesoDaPartida } from '../analise/peso.ts';
import { fonte, where, type Filtro } from './filtro.ts';

/**
 * Desempenho por campeão (ou por campeão e rota), para achar os seus campeões mais fortes.
 *
 * - Vitória: % de partidas ganhas.
 * - Stomp: % de partidas em que você chegou aos 15 minutos com 1.000 de ouro ou mais sobre o
 *   oponente de rota, ganhando ou perdendo a partida. "Stomp e derrota" conta as que, mesmo
 *   assim, terminaram em derrota.
 * - Acertos (macro): média de três participações, em %:
 *     participação nos abates do time, participação nos objetivos do time (dragões, arautos,
 *     vastilarvas, barão e torres) e visão em relação ao oponente de rota
 *     (seu placar de visão ÷ a soma dos dois; 50% = igual a ele).
 * - Erros por jogo: viradas de ouro contra você em que você morreu (gank, 1x1 ou luta),
 *   pela análise das viradas. Aqui menor é melhor.
 */

export const LIMIAR_STOMP = 1000;
const CAUSAS_DE_ERRO: Causa[] = ['gank_sofrido', 'morte_1x1', 'morte_em_luta'];

export interface LinhaDesempenho {
  campeao: string;
  posicao: string | null;
  jogos: number;
  vitorias: number;
  vitoria_pct: number;
  stomp_pct: number | null;
  stomp_derrota: number;
  acertos_pct: number | null;
  kp_pct: number | null;
  objetivos_pct: number | null;
  visao_pct: number | null;
  erros_jogo: number | null;
  /** Média do peso nas derrotas (src/analise/peso.ts); 20 = a parte normal de um jogador. */
  peso_derrota: number | null;
  kda: number;
}

export interface MelhorPorRota {
  posicao: string;
  vitoria: string | null;
  stomp: string | null;
  acertos: string | null;
  menos_erros: string | null;
  menos_peso: string | null;
}

interface PartidaBruta {
  match_id: string;
  participant_id: number;
  campeao: string;
  posicao: string;
  vitoria: number;
  kills: number;
  deaths: number;
  assists: number;
  dif_ouro_15: number | null;
  kp: number | null;
  visao: number;
  visao_oponente: number | null;
  oponente_id: number | null;
  obj_time: number | null;
  obj_meus: number | null;
  tem_timeline: number;
}

const media = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const pct = (parte: number, total: number) => (total ? Math.round((parte / total) * 1000) / 10 : 0);

function partidas(db: DatabaseSync, f: Filtro): PartidaBruta[] {
  const w = where(f, 'v');
  // Objetivo do time: monstro épico que o time matou (killerTeamId) ou torre/inibidor do outro
  // time derrubada (teamId do evento é o dono da construção). "Meus": eu matei ou ajudei.
  const objetivoDoTime = `(e.tipo = 'ELITE_MONSTER_KILL' AND json_extract(e.json, '$.killerTeamId') = p.time_id)
      OR (e.tipo = 'BUILDING_KILL' AND 300 - json_extract(e.json, '$.teamId') = p.time_id)`;
  const participei = `(e.participant_id = v.participant_id
      OR instr(',' || coalesce(e.assistencias, '') || ',', ',' || v.participant_id || ',') > 0)`;
  return db
    .prepare(
      `SELECT v.match_id, v.participant_id, v.campeao, v.posicao, v.vitoria, v.kills, v.deaths, v.assists,
         v.dif_ouro_15, v.participacao_abates AS kp, v.visao, op.visao AS visao_oponente, v.oponente_id,
         EXISTS (SELECT 1 FROM timelines t WHERE t.match_id = v.match_id) AS tem_timeline,
         (SELECT count(*) FROM eventos e WHERE e.match_id = v.match_id AND (${objetivoDoTime})) AS obj_time,
         (SELECT count(*) FROM eventos e WHERE e.match_id = v.match_id AND (${objetivoDoTime}) AND ${participei}) AS obj_meus
       FROM ${fonte(f)} v
       JOIN participantes p ON p.match_id = v.match_id AND p.participant_id = v.participant_id
       LEFT JOIN participantes op ON op.match_id = v.match_id AND op.participant_id = v.oponente_id
       ${w.sql}`,
    )
    .all(...w.params) as unknown as PartidaBruta[];
}

/** Erros da partida (viradas contra você com morte sua), pela análise salva. Null sem análise. */
function errosDaPartida(db: DatabaseSync, p: PartidaBruta): number | null {
  if (!p.tem_timeline || p.oponente_id === null) return null;
  const a = analiseDaPartida(db, p.match_id, p.participant_id, PADRAO_ANALISE)?.analise;
  if (!a) return null;
  return a.episodios.filter((e) => e.variacao < 0 && e.causas.some((c) => CAUSAS_DE_ERRO.includes(c))).length;
}

export function desempenhoPorCampeao(db: DatabaseSync, f: Filtro, o: { porRota?: boolean; minJogos?: number } = {}): LinhaDesempenho[] {
  const grupos = new Map<string, PartidaBruta[]>();
  for (const p of partidas(db, f)) {
    const chave = o.porRota ? `${p.campeao}|${p.posicao}` : p.campeao;
    grupos.set(chave, [...(grupos.get(chave) ?? []), p]);
  }
  const linhas: LinhaDesempenho[] = [];
  for (const lista of grupos.values()) {
    if (lista.length < (o.minJogos ?? 1)) continue;
    const vitorias = lista.filter((p) => p.vitoria === 1).length;
    const comRota = lista.filter((p) => p.dif_ouro_15 !== null);
    const stomps = comRota.filter((p) => p.dif_ouro_15! >= LIMIAR_STOMP);
    const kps: number[] = [];
    const objs: number[] = [];
    const visoes: number[] = [];
    const acertos: number[] = [];
    const erros: number[] = [];
    const pesos: number[] = [];
    for (const p of lista) {
      if (p.vitoria === 0) {
        const peso = pesoDaPartida(db, p.match_id, p.participant_id)?.peso;
        if (peso !== null && peso !== undefined) pesos.push(peso);
      }
      const partes: number[] = [];
      if (p.kp !== null) {
        const kp = Math.min(p.kp, 100);
        kps.push(kp);
        partes.push(kp);
      }
      if (p.tem_timeline && p.obj_time) {
        const ob = (p.obj_meus! / p.obj_time) * 100;
        objs.push(ob);
        partes.push(ob);
      }
      if (p.visao_oponente !== null && p.visao + p.visao_oponente > 0) {
        const vi = (p.visao / (p.visao + p.visao_oponente)) * 100;
        visoes.push(vi);
        partes.push(vi);
      }
      const m = media(partes);
      if (m !== null) acertos.push(m);
      const e = errosDaPartida(db, p);
      if (e !== null) erros.push(e);
    }
    const k = lista.reduce((s, p) => s + p.kills + p.assists, 0);
    const d = lista.reduce((s, p) => s + p.deaths, 0);
    linhas.push({
      campeao: lista[0]!.campeao,
      posicao: o.porRota ? lista[0]!.posicao || null : null,
      jogos: lista.length,
      vitorias,
      vitoria_pct: pct(vitorias, lista.length),
      stomp_pct: comRota.length ? pct(stomps.length, comRota.length) : null,
      stomp_derrota: stomps.filter((p) => p.vitoria === 0).length,
      acertos_pct: r1(media(acertos)),
      kp_pct: r1(media(kps)),
      objetivos_pct: r1(media(objs)),
      visao_pct: r1(media(visoes)),
      erros_jogo: erros.length ? Math.round((erros.reduce((s, x) => s + x, 0) / erros.length) * 100) / 100 : null,
      peso_derrota: r1(media(pesos)),
      kda: Math.round((k / Math.max(d, 1)) * 100) / 100,
    });
  }
  return linhas.sort((a, b) => b.vitoria_pct - a.vitoria_pct || b.jogos - a.jogos || a.campeao.localeCompare(b.campeao));
}

/** O melhor campeão de cada rota em cada critério (empate: quem jogou mais). */
export function melhoresPorRota(db: DatabaseSync, f: Filtro, minJogos = 1): MelhorPorRota[] {
  const linhas = desempenhoPorCampeao(db, f, { porRota: true, minJogos }).filter((l) => l.posicao);
  const rotas = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].filter((r) => linhas.some((l) => l.posicao === r));
  const melhor = (lista: LinhaDesempenho[], valor: (l: LinhaDesempenho) => number | null, menor = false, unidade = '%') => {
    const validos = lista.filter((l) => valor(l) !== null);
    if (!validos.length) return null;
    validos.sort((a, b) => (menor ? valor(a)! - valor(b)! : valor(b)! - valor(a)!) || b.jogos - a.jogos);
    const l = validos[0]!;
    // "Mais stomps" com 0% não é destaque de ninguém.
    if (!menor && valor(l) === 0) return null;
    const v = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(valor(l)!);
    return `${l.campeao} (${v}${unidade} em ${l.jogos} jogo${l.jogos > 1 ? 's' : ''})`;
  };
  return rotas.map((posicao) => {
    const daRota = linhas.filter((l) => l.posicao === posicao);
    return {
      posicao,
      vitoria: melhor(daRota, (l) => l.vitoria_pct),
      stomp: melhor(daRota, (l) => l.stomp_pct),
      acertos: melhor(daRota, (l) => l.acertos_pct),
      menos_erros: melhor(daRota, (l) => l.erros_jogo, true, ' erro(s)/jogo'),
      menos_peso: melhor(daRota, (l) => l.peso_derrota, true, '% de peso nas derrotas'),
    };
  });
}
