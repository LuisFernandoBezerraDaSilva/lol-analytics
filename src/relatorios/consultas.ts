import type { DatabaseSync } from 'node:sqlite';
import { where, type Filtro } from './filtro.ts';

export type Linha = Record<string, string | number | null>;

/** Métricas somadas e divididas pelo tempo total (mais justo que média de razões). */
const METRICAS = `
  count(*) AS jogos,
  sum(vitoria) AS vitorias,
  round(avg(vitoria) * 100, 1) AS vitoria_pct,
  round(sum(kills + assists) * 1.0 / max(sum(deaths), 1), 2) AS kda,
  round(avg(kills), 1) AS kills,
  round(avg(deaths), 1) AS deaths,
  round(avg(assists), 1) AS assists,
  round(sum(kills) * 60.0 / sum(duracao_s), 3) AS kills_min,
  round(sum(deaths) * 60.0 / sum(duracao_s), 3) AS deaths_min,
  round(sum(ouro) * 60.0 / sum(duracao_s), 1) AS ouro_min,
  round(sum(cs) * 60.0 / sum(duracao_s), 2) AS cs_min,
  round(sum(dano_campeoes) * 60.0 / sum(duracao_s), 1) AS dano_min,
  round(sum(visao) * 60.0 / sum(duracao_s), 2) AS visao_min,
  round(avg(participacao_abates), 1) AS kp_pct,
  round(avg(cs_10), 1) AS cs_10,
  round(avg(dif_ouro_10)) AS dif_ouro_10,
  round(avg(dif_ouro_15)) AS dif_ouro_15,
  round(avg(duracao_min), 1) AS duracao_min
`;

export const AGRUPAMENTOS: Record<string, string> = {
  campeao: 'campeao',
  posicao: 'posicao',
  oponente: 'oponente',
  fila: 'fila_id',
  mes: "strftime('%Y-%m', data)",
  semana: "strftime('%Y-S%W', data)",
  duracao: `CASE
    WHEN duracao_s < 1200 THEN '< 20 min'
    WHEN duracao_s < 1500 THEN '20-25 min'
    WHEN duracao_s < 1800 THEN '25-30 min'
    WHEN duracao_s < 2100 THEN '30-35 min'
    ELSE '35+ min' END`,
};

export function agrupar(db: DatabaseSync, por: string, f: Filtro, minJogos = 1): Linha[] {
  const expr = AGRUPAMENTOS[por];
  if (!expr) throw new Error(`Agrupamento desconhecido: ${por}. Use ${Object.keys(AGRUPAMENTOS).join(', ')}.`);
  const w = where(f);
  const ordem = por === 'mes' || por === 'semana' || por === 'duracao' ? 'grupo' : 'jogos DESC, grupo';
  return db
    .prepare(
      `SELECT ${expr} AS grupo, ${METRICAS} FROM v_minhas_partidas ${w.sql}
       GROUP BY grupo HAVING count(*) >= ? ORDER BY ${ordem}`,
    )
    .all(...w.params, minJogos) as Linha[];
}

export function resumo(db: DatabaseSync, f: Filtro): Linha | undefined {
  const w = where(f);
  return db.prepare(`SELECT ${METRICAS} FROM v_minhas_partidas ${w.sql}`).get(...w.params) as Linha | undefined;
}

export function recentes(db: DatabaseSync, f: Filtro, n = 20): Linha[] {
  const w = where(f);
  return db
    .prepare(
      `SELECT match_id, data, campeao, posicao, oponente,
         CASE WHEN vitoria = 1 THEN 'V' ELSE 'D' END AS resultado,
         kills || '/' || deaths || '/' || assists AS kda_linha,
         duracao_min, ouro_min, cs_min, dano_min, kp_pct, dif_ouro_10
       FROM (SELECT *, participacao_abates AS kp_pct FROM v_minhas_partidas) ${w.sql}
       ORDER BY inicio_ms DESC LIMIT ?`,
    )
    .all(...w.params, n) as Linha[];
}

/** Ouro médio por minuto de jogo: o seu, o do oponente de rota e a diferença. */
export function curvaDeOuro(db: DatabaseSync, f: Filtro, ateMinuto = 30): Linha[] {
  const w = where(f, 'v');
  return db
    .prepare(
      `SELECT fm.minuto,
         count(*) AS jogos,
         round(avg(fm.ouro_total)) AS meu_ouro,
         round(avg(fo.ouro_total)) AS ouro_oponente,
         round(avg(fm.ouro_total - fo.ouro_total)) AS diferenca,
         round(avg(fm.cs), 1) AS meu_cs,
         round(avg(fm.xp)) AS meu_xp
       FROM v_minhas_partidas v
       JOIN frames fm ON fm.match_id = v.match_id AND fm.participant_id = v.participant_id
       LEFT JOIN frames fo ON fo.match_id = v.match_id AND fo.participant_id = v.oponente_id AND fo.minuto = fm.minuto
       ${w.sql ? `${w.sql} AND` : 'WHERE'} fm.minuto <= ?
       GROUP BY fm.minuto ORDER BY fm.minuto`,
    )
    .all(...w.params, ateMinuto) as Linha[];
}

/** Abates, mortes e assistências por faixa de 5 minutos, por partida (vem da timeline). */
export function abatesPorTempo(db: DatabaseSync, f: Filtro): Linha[] {
  const w = where(f, 'v');
  const jogos = (
    db
      .prepare(
        `SELECT count(*) AS n FROM v_minhas_partidas v ${w.sql} ${w.sql ? 'AND' : 'WHERE'}
         EXISTS (SELECT 1 FROM timelines t WHERE t.match_id = v.match_id)`,
      )
      .get(...w.params) as { n: number }
  ).n;
  const linhas = db
    .prepare(
      `SELECT (e.tempo_ms / 300000) * 5 AS de_min,
         sum(e.participant_id = v.participant_id) AS kills,
         sum(e.vitima_id = v.participant_id) AS mortes,
         sum(instr(',' || coalesce(e.assistencias, '') || ',', ',' || v.participant_id || ',') > 0) AS assistencias
       FROM v_minhas_partidas v
       JOIN eventos e ON e.match_id = v.match_id AND e.tipo = 'CHAMPION_KILL'
       ${w.sql}
       GROUP BY de_min ORDER BY de_min`,
    )
    .all(...w.params) as Array<{ de_min: number; kills: number; mortes: number; assistencias: number }>;
  const por = (x: number) => (jogos ? Math.round((x / jogos) * 100) / 100 : 0);
  return linhas.map((l) => ({
    faixa: `${l.de_min}-${l.de_min + 5} min`,
    kills_por_jogo: por(l.kills),
    mortes_por_jogo: por(l.mortes),
    assist_por_jogo: por(l.assistencias),
    total_kills: l.kills,
    total_mortes: l.mortes,
  }));
}
