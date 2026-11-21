import type { SQLInputValue } from 'node:sqlite';

export interface Filtro {
  fila?: number;
  /** Últimos N dias. */
  dias?: number;
  campeao?: string;
  posicao?: string;
  /** Riot ID (Nome#TAG) quando há mais de uma conta. */
  conta?: string;
  incluirRemakes?: boolean;
  /** Referência de "agora" (testes). */
  agoraMs?: number;
}

export const POSICOES: Record<string, string> = {
  top: 'TOP',
  jungle: 'JUNGLE',
  selva: 'JUNGLE',
  jg: 'JUNGLE',
  mid: 'MIDDLE',
  meio: 'MIDDLE',
  adc: 'BOTTOM',
  bot: 'BOTTOM',
  sup: 'UTILITY',
  suporte: 'UTILITY',
  support: 'UTILITY',
};

/** Monta o WHERE sobre a view v_minhas_partidas (alias opcional). */
export function where(f: Filtro, alias = ''): { sql: string; params: SQLInputValue[] } {
  const a = alias ? `${alias}.` : '';
  const c: string[] = [];
  const params: SQLInputValue[] = [];
  if (!f.incluirRemakes) c.push(`${a}remake = 0`);
  if (f.fila !== undefined) {
    c.push(`${a}fila_id = ?`);
    params.push(f.fila);
  }
  if (f.dias !== undefined) {
    c.push(`${a}inicio_ms >= ?`);
    params.push((f.agoraMs ?? Date.now()) - f.dias * 86_400_000);
  }
  if (f.campeao) {
    c.push(`lower(${a}campeao) = lower(?)`);
    params.push(f.campeao.replace(/[\s'.]/g, ''));
  }
  if (f.posicao) {
    c.push(`${a}posicao = ?`);
    params.push(POSICOES[f.posicao.toLowerCase()] ?? f.posicao.toUpperCase());
  }
  if (f.conta) {
    c.push(`lower(${a}conta) = lower(?)`);
    params.push(f.conta);
  }
  return { sql: c.length ? `WHERE ${c.join(' AND ')}` : '', params };
}
