import type { Linha } from './consultas.ts';

const ROTULOS: Record<string, string> = {
  grupo: '',
  jogos: 'Jogos',
  vitorias: 'V',
  vitoria_pct: '% Vit',
  kda: 'KDA',
  kills: 'K',
  deaths: 'D',
  assists: 'A',
  kills_min: 'K/min',
  deaths_min: 'D/min',
  ouro_min: 'Ouro/min',
  cs_min: 'CS/min',
  dano_min: 'Dano/min',
  visao_min: 'Visão/min',
  kp_pct: '% Part.',
  cs_10: 'CS@10',
  dif_ouro_10: 'ΔOuro@10',
  dif_ouro_15: 'ΔOuro@15',
  duracao_min: 'Min',
  data: 'Data',
  campeao: 'Campeão',
  posicao: 'Posição',
  oponente: 'Oponente',
  resultado: 'R',
  kda_linha: 'K/D/A',
  minuto: 'Min',
  meu_ouro: 'Meu ouro',
  ouro_oponente: 'Oponente',
  diferenca: 'Diferença',
  meu_cs: 'CS',
  meu_xp: 'XP',
  faixa: 'Faixa',
  kills_por_jogo: 'Kills/jogo',
  mortes_por_jogo: 'Mortes/jogo',
  assist_por_jogo: 'Assist./jogo',
  causa: 'Causa',
  viradas: 'Viradas',
  ouro: 'Ouro',
  ouro_por_virada: 'Ouro/virada',
  pct_do_ouro: '% do ouro',
  match_id: 'Partida',
  maior_perda: 'Maior perda',
  maior_ganho: 'Maior ganho',
  total_kills: 'Kills (total)',
  total_mortes: 'Mortes (total)',
};

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

export function num(v: string | number | null | undefined): string {
  return texto(v);
}

function texto(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return nf.format(v);
  return v;
}

/** Imprime uma tabela alinhada no terminal. `colunas` escolhe e ordena; omitido = todas. */
export function imprimirTabela(linhas: Linha[], colunas?: string[], rotuloGrupo = ''): string {
  if (linhas.length === 0) return 'Nenhuma partida encontrada com esses filtros.';
  const cols = colunas ?? Object.keys(linhas[0]!);
  const cab = cols.map((c) => (c === 'grupo' ? rotuloGrupo : ROTULOS[c] ?? c));
  const corpo = linhas.map((l) => cols.map((c) => texto(l[c])));
  const larg = cols.map((_, i) => Math.max(cab[i]!.length, ...corpo.map((r) => r[i]!.length)));
  const numerica = cols.map((c) => linhas.every((l) => l[c] === null || typeof l[c] === 'number'));
  const fmt = (r: string[]) => r.map((v, i) => (numerica[i] ? v.padStart(larg[i]!) : v.padEnd(larg[i]!))).join('  ');
  return [fmt(cab), larg.map((n) => '-'.repeat(n)).join('  '), ...corpo.map(fmt)].join('\n');
}
