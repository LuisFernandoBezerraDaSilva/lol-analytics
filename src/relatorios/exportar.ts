import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Linha } from './consultas.ts';
import { where, type Filtro } from './filtro.ts';

export interface FormatoCsv {
  separador: string;
  decimal: string;
}

/** Excel em português abre direto: ";" entre colunas e vírgula decimal. */
export const CSV_EXCEL_BR: FormatoCsv = { separador: ';', decimal: ',' };
export const CSV_PADRAO: FormatoCsv = { separador: ',', decimal: '.' };

export function paraCsv(linhas: Linha[], fmt: FormatoCsv): string {
  if (linhas.length === 0) return '';
  const cols = Object.keys(linhas[0]!);
  const cel = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v).replace('.', fmt.decimal);
    return /["\r\n]/.test(v) || v.includes(fmt.separador) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const linhasCsv = [cols.join(fmt.separador), ...linhas.map((l) => cols.map((c) => cel(l[c])).join(fmt.separador))];
  return '﻿' + linhasCsv.join('\r\n') + '\r\n';
}

export function exportar(db: DatabaseSync, f: Filtro, pasta: string, fmt: FormatoCsv): Record<string, number> {
  mkdirSync(pasta, { recursive: true });
  const w = where(f, 'v');
  const e = w.sql ? `${w.sql} AND` : 'WHERE';

  const partidas = db.prepare(`SELECT * FROM v_minhas_partidas v ${w.sql} ORDER BY inicio_ms`).all(...w.params) as Linha[];

  const curva = db
    .prepare(
      `SELECT v.match_id, v.data, v.campeao, v.oponente, v.vitoria, fm.minuto,
         fm.ouro_total AS meu_ouro, fo.ouro_total AS ouro_oponente, fm.ouro_total - fo.ouro_total AS diferenca,
         fm.cs AS meu_cs, fo.cs AS cs_oponente, fm.xp AS meu_xp, fo.xp AS xp_oponente, fm.nivel AS meu_nivel
       FROM v_minhas_partidas v
       JOIN frames fm ON fm.match_id = v.match_id AND fm.participant_id = v.participant_id
       LEFT JOIN frames fo ON fo.match_id = v.match_id AND fo.participant_id = v.oponente_id AND fo.minuto = fm.minuto
       ${w.sql} ORDER BY v.inicio_ms, fm.minuto`,
    )
    .all(...w.params) as Linha[];

  const abates = db
    .prepare(
      `SELECT v.match_id, v.data, v.campeao,
         round(ev.tempo_ms / 60000.0, 2) AS minuto,
         CASE WHEN ev.participant_id = v.participant_id THEN 'kill'
              WHEN ev.vitima_id = v.participant_id THEN 'morte'
              ELSE 'assistencia' END AS tipo,
         ev.x, ev.y
       FROM v_minhas_partidas v
       JOIN eventos ev ON ev.match_id = v.match_id AND ev.tipo = 'CHAMPION_KILL'
       ${e} (ev.participant_id = v.participant_id OR ev.vitima_id = v.participant_id
             OR instr(',' || coalesce(ev.assistencias, '') || ',', ',' || v.participant_id || ',') > 0)
       ORDER BY v.inicio_ms, ev.tempo_ms`,
    )
    .all(...w.params) as Linha[];

  const arquivos: Record<string, Linha[]> = {
    'partidas.csv': partidas,
    'curva_ouro.csv': curva,
    'abates.csv': abates,
  };
  const contagem: Record<string, number> = {};
  for (const [nome, linhas] of Object.entries(arquivos)) {
    writeFileSync(join(pasta, nome), paraCsv(linhas, fmt), 'utf8');
    contagem[nome] = linhas.length;
  }
  return contagem;
}
