import type { DatabaseSync } from 'node:sqlite';
import { where, type Filtro } from '../relatorios/filtro.ts';

/**
 * Explica as viradas de ouro entre você e o oponente de rota.
 *
 * 1. Monta a diferença de ouro minuto a minuto (seu ouro total − o do oponente).
 * 2. Acha os trechos em que ela muda bruscamente (padrão: 500 de ouro em até 2 minutos).
 * 3. Em cada trecho, separa de onde veio o ouro de cada um, com o que a timeline da Riot informa:
 *    abates (bounty + shutdown), torres e monstros (bounty), e o resto (farm, assistências,
 *    ouro passivo, placas), que é a diferença entre o ouro total e o que foi identificado.
 * 4. Classifica as mortes (gank, 1x1, luta), o roam do oponente, o farm e os objetivos,
 *    e escreve a leitura e as dicas.
 *
 * Tudo é pós-jogo e só usa o que a API oficial entrega.
 */

export interface OpcoesAnalise {
  /** Variação mínima de ouro para contar como virada. */
  limiar: number;
  /** Janela em minutos para essa variação acontecer. */
  janela: number;
}

export const PADRAO_ANALISE: OpcoesAnalise = { limiar: 500, janela: 2 };

interface Evento {
  tempo: number;
  tipo: string;
  autor: number | null;
  vitima: number | null;
  assistencias: number[];
  x: number | null;
  y: number | null;
  dados: Record<string, unknown>;
}

interface Jogador {
  id: number;
  campeao: string;
  time: number;
  posicao: string;
}

export interface Contexto {
  matchId: string;
  data: string;
  vitoria: boolean;
  eu: Jogador;
  op: Jogador;
  jogadores: Map<number, Jogador>;
  ouro: Map<number, number[]>;
  cs: Map<number, number[]>;
  nivel: Map<number, number[]>;
  eventos: Evento[];
}

export interface Fontes {
  ouro: number;
  cs: number;
  ouroAbates: number;
  ouroTorres: number;
  ouroMonstros: number;
  /** Farm, assistências, ouro passivo e placas: o que sobra do ouro total. */
  ouroOutros: number;
  kills: number;
  mortes: number;
  assistencias: number;
  maiorMultikill: number;
  placas: number;
  torres: number;
  monstros: string[];
  sentinelas: number;
}

export type Causa =
  | 'gank_sofrido'
  | 'morte_1x1'
  | 'morte_em_luta'
  | 'roam_do_oponente'
  | 'farm'
  | 'objetivos'
  | 'abate_1x1'
  | 'gank_aliado'
  | 'abate_em_luta'
  | 'seu_roam'
  | 'indefinida';

export const NOME_CAUSA: Record<Causa, string> = {
  gank_sofrido: 'Gank do caçador inimigo',
  morte_1x1: 'Morte 1x1 para o oponente',
  morte_em_luta: 'Morte em luta (2+ inimigos)',
  roam_do_oponente: 'Oponente saiu da rota e abateu',
  farm: 'Diferença de farm',
  objetivos: 'Placas, torres e monstros',
  abate_1x1: 'Você abateu o oponente 1x1',
  gank_aliado: 'Gank do seu caçador',
  abate_em_luta: 'Abates em luta',
  seu_roam: 'Você saiu da rota e abateu',
  indefinida: 'Sem causa clara (assistências, ouro passivo)',
};

export interface Episodio {
  inicio: number;
  fim: number;
  /** Variação da diferença de ouro no trecho: negativa = você perdeu para o oponente. */
  variacao: number;
  eu: Fontes;
  oponente: Fontes;
  causas: Causa[];
  causaPrincipal: Causa;
  leitura: string[];
  dicas: string[];
  /** Morreu para gank sem ter colocado sentinela nos 3 minutos antes. */
  gankSemSentinela: boolean;
}

export interface AnalisePartida {
  ctx: Contexto;
  diferenca: number[];
  episodios: Episodio[];
}

// ---------------------------------------------------------------- mapa

export type Zona = 'top' | 'mid' | 'bot' | 'rio' | 'selva' | 'base';

/** Zona aproximada do Summoner's Rift (coordenadas de 0 a ~15000; base azul embaixo à esquerda). */
export function zona(x: number, y: number): Zona {
  if ((x < 3600 && y < 3600) || (x > 11200 && y > 11200)) return 'base';
  if (x < 2400 || y > 12500) return 'top';
  if (y < 2400 || x > 12500) return 'bot';
  if (Math.abs(x - y) < 1500) return 'mid';
  if (Math.abs(x + y - 14800) < 1500) return 'rio';
  return 'selva';
}

const ZONA_DA_POSICAO: Record<string, Zona> = { TOP: 'top', MIDDLE: 'mid', BOTTOM: 'bot', UTILITY: 'bot' };

const NOME_ZONA: Record<Zona, string> = {
  top: 'no top',
  mid: 'no mid',
  bot: 'no bot',
  rio: 'no rio',
  selva: 'na selva',
  base: 'na base',
};

// ---------------------------------------------------------------- carga

export function carregarContexto(db: DatabaseSync, matchId: string, participanteId: number): Contexto | null {
  const v = db
    .prepare('SELECT data, vitoria, participant_id, oponente_id FROM v_minhas_partidas WHERE match_id = ? AND participant_id = ?')
    .get(matchId, participanteId) as { data: string; vitoria: number; participant_id: number; oponente_id: number | null } | undefined;
  if (!v || v.oponente_id === null) return null;

  const jogadores = new Map<number, Jogador>();
  for (const p of db
    .prepare('SELECT participant_id, campeao, time_id, posicao FROM participantes WHERE match_id = ?')
    .all(matchId) as Array<{ participant_id: number; campeao: string; time_id: number; posicao: string }>) {
    jogadores.set(p.participant_id, { id: p.participant_id, campeao: p.campeao, time: p.time_id, posicao: p.posicao });
  }

  const ouro = new Map<number, number[]>();
  const cs = new Map<number, number[]>();
  const nivel = new Map<number, number[]>();
  const frames = db
    .prepare('SELECT participant_id, minuto, ouro_total, cs, nivel FROM frames WHERE match_id = ? ORDER BY minuto')
    .all(matchId) as Array<{ participant_id: number; minuto: number; ouro_total: number; cs: number; nivel: number }>;
  if (frames.length === 0) return null;
  for (const f of frames) {
    for (const [mapa, valor] of [[ouro, f.ouro_total], [cs, f.cs], [nivel, f.nivel]] as const) {
      const serie = mapa.get(f.participant_id) ?? [];
      serie[f.minuto] = valor;
      mapa.set(f.participant_id, serie);
    }
  }

  const eventos = (
    db
      .prepare('SELECT tempo_ms, tipo, participant_id, vitima_id, assistencias, x, y, json FROM eventos WHERE match_id = ? ORDER BY seq')
      .all(matchId) as Array<{
      tempo_ms: number;
      tipo: string;
      participant_id: number | null;
      vitima_id: number | null;
      assistencias: string | null;
      x: number | null;
      y: number | null;
      json: string;
    }>
  ).map((e) => ({
    tempo: e.tempo_ms,
    tipo: e.tipo,
    autor: e.participant_id,
    vitima: e.vitima_id,
    assistencias: e.assistencias ? e.assistencias.split(',').map(Number) : [],
    x: e.x,
    y: e.y,
    dados: JSON.parse(e.json) as Record<string, unknown>,
  }));

  const eu = jogadores.get(v.participant_id);
  const op = jogadores.get(v.oponente_id);
  if (!eu || !op) return null;
  return { matchId, data: v.data, vitoria: v.vitoria === 1, eu, op, jogadores, ouro, cs, nivel, eventos };
}

// ---------------------------------------------------------------- detecção

/** Diferença de ouro (você − oponente) por minuto, até o último minuto que os dois têm. */
export function serieDiferenca(ctx: Contexto): number[] {
  const a = ctx.ouro.get(ctx.eu.id) ?? [];
  const b = ctx.ouro.get(ctx.op.id) ?? [];
  const n = Math.min(a.length, b.length);
  const d: number[] = [];
  for (let m = 0; m < n; m++) d.push((a[m] ?? a[m - 1] ?? 0) - (b[m] ?? b[m - 1] ?? 0));
  return d;
}

/**
 * Trechos em que a diferença muda pelo menos `limiar` dentro de `janela` minutos.
 * O trecho se estende enquanto a variação continua forte no mesmo sentido.
 */
export function detectarViradas(d: number[], o: OpcoesAnalise): Array<{ inicio: number; fim: number; variacao: number }> {
  const res: Array<{ inicio: number; fim: number; variacao: number }> = [];
  const ritmoForte = o.limiar / (2 * o.janela);
  let m = o.janela;
  while (m < d.length) {
    const delta = d[m]! - d[m - o.janela]!;
    if (Math.abs(delta) < o.limiar) {
      m++;
      continue;
    }
    const sinal = Math.sign(delta);
    let inicio = m - o.janela;
    const anterior = res.at(-1);
    if (anterior && inicio < anterior.fim) inicio = anterior.fim;
    // Começa no último minuto antes de a variação ganhar força.
    while (inicio < m - 1 && (d[inicio + 1]! - d[inicio]!) * sinal < ritmoForte / 2) inicio++;
    let fim = m;
    while (fim + 1 < d.length && (d[fim + 1]! - d[fim]!) * sinal >= ritmoForte) fim++;
    const variacao = d[fim]! - d[inicio]!;
    if (Math.abs(variacao) >= o.limiar) res.push({ inicio, fim, variacao });
    m = fim + 1;
  }
  return res;
}

// ---------------------------------------------------------------- explicação

const numero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const noTrecho = (e: Evento, ini: number, fim: number) => e.tempo > ini * 60_000 && e.tempo <= fim * 60_000;

export function relogio(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const fmt = new Intl.NumberFormat('pt-BR');
const ouroTxt = (v: number) => fmt.format(Math.round(v));
const sinalTxt = (v: number) => (v > 0 ? `+${ouroTxt(v)}` : ouroTxt(v));

function valorEm(serie: number[] | undefined, m: number): number {
  if (!serie) return 0;
  for (let i = Math.min(m, serie.length - 1); i >= 0; i--) if (serie[i] !== undefined) return serie[i]!;
  return 0;
}

export function fontes(ctx: Contexto, pid: number, ini: number, fim: number): Fontes {
  const f: Fontes = {
    ouro: valorEm(ctx.ouro.get(pid), fim) - valorEm(ctx.ouro.get(pid), ini),
    cs: valorEm(ctx.cs.get(pid), fim) - valorEm(ctx.cs.get(pid), ini),
    ouroAbates: 0,
    ouroTorres: 0,
    ouroMonstros: 0,
    ouroOutros: 0,
    kills: 0,
    mortes: 0,
    assistencias: 0,
    maiorMultikill: 0,
    placas: 0,
    torres: 0,
    monstros: [],
    sentinelas: 0,
  };
  for (const e of ctx.eventos) {
    if (!noTrecho(e, ini, fim)) continue;
    switch (e.tipo) {
      case 'CHAMPION_KILL':
        if (e.autor === pid) {
          f.kills++;
          f.ouroAbates += numero(e.dados.bounty) + numero(e.dados.shutdownBounty);
        }
        if (e.vitima === pid) f.mortes++;
        if (e.assistencias.includes(pid)) f.assistencias++;
        break;
      case 'CHAMPION_SPECIAL_KILL':
        if (e.autor === pid && e.dados.killType === 'KILL_MULTI') {
          f.maiorMultikill = Math.max(f.maiorMultikill, numero(e.dados.multiKillLength));
        }
        break;
      case 'TURRET_PLATE_DESTROYED':
        if (e.autor === pid) f.placas++;
        break;
      case 'BUILDING_KILL':
        if (e.autor === pid) {
          f.torres++;
          f.ouroTorres += numero(e.dados.bounty);
        }
        break;
      case 'ELITE_MONSTER_KILL':
        if (e.autor === pid) {
          f.monstros.push(String(e.dados.monsterSubType ?? e.dados.monsterType ?? 'monstro'));
          f.ouroMonstros += numero(e.dados.bounty);
        }
        break;
      case 'WARD_PLACED':
        if (e.autor === pid) f.sentinelas++;
        break;
    }
  }
  f.ouroOutros = f.ouro - f.ouroAbates - f.ouroTorres - f.ouroMonstros;
  return f;
}

const MULTI = ['', '', 'double kill', 'triple kill', 'quadra kill', 'penta kill'];

function nome(ctx: Contexto, pid: number | null): string {
  if (pid === null || pid === 0) return 'torre/tropas';
  const j = ctx.jogadores.get(pid);
  if (!j) return `jogador ${pid}`;
  return j.posicao === 'JUNGLE' ? `${j.campeao} (caçador)` : j.campeao;
}

function cacador(ctx: Contexto, time: number): number | null {
  for (const j of ctx.jogadores.values()) if (j.time === time && j.posicao === 'JUNGLE') return j.id;
  return null;
}

export function explicar(ctx: Contexto, inicio: number, fim: number, variacao: number): Episodio {
  const eu = fontes(ctx, ctx.eu.id, inicio, fim);
  const op = fontes(ctx, ctx.op.id, inicio, fim);
  const perdeu = variacao < 0;
  const cacadorInimigo = cacador(ctx, ctx.op.time);
  const cacadorAliado = cacador(ctx, ctx.eu.time);
  const zonaEu = ZONA_DA_POSICAO[ctx.eu.posicao];
  const zonaOp = ZONA_DA_POSICAO[ctx.op.posicao];
  const causas = new Set<Causa>();
  const leitura: string[] = [];
  const dicas: string[] = [];
  let gankSemSentinela = false;

  leitura.push(
    `${relogio(inicio * 60_000)} a ${relogio(fim * 60_000)}: você ${perdeu ? 'perdeu' : 'ganhou'} ${ouroTxt(Math.abs(variacao))} de ouro ${perdeu ? 'para' : 'sobre'} ${ctx.op.campeao}.`,
  );
  const resumoFontes = (quem: string, f: Fontes) =>
    `${quem}: ${sinalTxt(f.ouro)} de ouro (abates ${ouroTxt(f.ouroAbates)}, torres/monstros ${ouroTxt(f.ouroTorres + f.ouroMonstros)}, farm e outros ${ouroTxt(f.ouroOutros)}), ${sinalTxt(f.cs)} CS.`;
  leitura.push(resumoFontes('Você', eu), resumoFontes(ctx.op.campeao, op));

  const abates = ctx.eventos.filter((e) => e.tipo === 'CHAMPION_KILL' && noTrecho(e, inicio, fim));

  // Suas mortes no trecho.
  for (const e of abates.filter((x) => x.vitima === ctx.eu.id)) {
    const envolvidos = [e.autor, ...e.assistencias].filter((x): x is number => x !== null && x !== 0);
    const ajuda = e.assistencias.length ? ` com ajuda de ${e.assistencias.map((a) => nome(ctx, a)).join(', ')}` : '';
    leitura.push(`Você morreu aos ${relogio(e.tempo)} para ${nome(ctx, e.autor)}${ajuda}${e.x !== null ? ` ${NOME_ZONA[zona(e.x, e.y!)]}` : ''}.`);
    const minuto = Math.floor(e.tempo / 60_000);
    if (cacadorInimigo !== null && envolvidos.includes(cacadorInimigo)) {
      causas.add('gank_sofrido');
      const sentinelas = ctx.eventos.filter(
        (w) => w.tipo === 'WARD_PLACED' && w.autor === ctx.eu.id && w.tempo <= e.tempo && w.tempo > e.tempo - 180_000,
      ).length;
      if (sentinelas === 0) {
        gankSemSentinela = true;
        dicas.push('Você não colocou nenhuma sentinela nos 3 minutos antes do gank. Uma sentinela no rio ou na entrada da selva teria mostrado o caçador chegando.');
      } else {
        dicas.push(`Você tinha colocado ${sentinelas} sentinela(s) nos 3 minutos antes, mas o gank veio mesmo assim. Confira se elas cobriam o caminho do caçador ou se você avançou demais na rota.`);
      }
    } else if (e.autor === ctx.op.id && e.assistencias.length === 0) {
      causas.add('morte_1x1');
      const nivelEu = valorEm(ctx.nivel.get(ctx.eu.id), minuto);
      const nivelOp = valorEm(ctx.nivel.get(ctx.op.id), minuto);
      dicas.push(
        nivelOp > nivelEu
          ? `Na morte, ${ctx.op.campeao} estava no nível ${nivelOp} contra o seu ${nivelEu}. Evite a troca até igualar o nível.`
          : `Você perdeu a troca 1x1 sem desvantagem de nível (${nivelEu} x ${nivelOp}). Reveja a troca: feitiços, recarga das habilidades e a onda de tropas.`,
      );
    } else {
      causas.add('morte_em_luta');
      dicas.push('Você morreu numa luta com mais de um inimigo. Confira se a luta valia a pena ou se dava para recuar.');
    }
  }

  // Abates do oponente em outros jogadores.
  for (const e of abates.filter((x) => x.autor === ctx.op.id && x.vitima !== ctx.eu.id)) {
    const z = e.x !== null ? zona(e.x, e.y!) : null;
    const foraDaRota = z !== null && zonaOp !== undefined && z !== zonaOp && z !== 'base';
    leitura.push(`${ctx.op.campeao} abateu ${nome(ctx, e.vitima)} aos ${relogio(e.tempo)}${z ? ` ${NOME_ZONA[z]}` : ''}${foraDaRota ? ', fora da rota dele' : ''}.`);
    if (foraDaRota && perdeu) {
      causas.add('roam_do_oponente');
      dicas.push(`Quando ${ctx.op.campeao} sumir da rota, avise o time e aproveite para empurrar a onda e derrubar placas.`);
    }
  }

  // Seus abates.
  for (const e of abates.filter((x) => x.autor === ctx.eu.id)) {
    const z = e.x !== null ? zona(e.x, e.y!) : null;
    const foraDaRota = z !== null && zonaEu !== undefined && z !== zonaEu && z !== 'base';
    leitura.push(`Você abateu ${nome(ctx, e.vitima)} aos ${relogio(e.tempo)}${z ? ` ${NOME_ZONA[z]}` : ''}.`);
    if (perdeu) continue;
    if (e.vitima === ctx.op.id && e.assistencias.length === 0) causas.add('abate_1x1');
    else if (cacadorAliado !== null && e.assistencias.includes(cacadorAliado)) causas.add('gank_aliado');
    else if (foraDaRota) causas.add('seu_roam');
    else causas.add('abate_em_luta');
  }

  for (const [quem, f] of [['Você', eu], [ctx.op.campeao, op]] as const) {
    if (f.maiorMultikill >= 2) leitura.push(`${quem} fez um ${MULTI[Math.min(f.maiorMultikill, 5)]} no trecho.`);
  }

  const difCs = perdeu ? op.cs - eu.cs : eu.cs - op.cs;
  const difOutros = perdeu ? op.ouroOutros - eu.ouroOutros : eu.ouroOutros - op.ouroOutros;
  if (difCs >= 6 && difOutros > 0) {
    causas.add('farm');
    leitura.push(`${perdeu ? ctx.op.campeao : 'Você'} fez ${difCs} CS a mais no trecho.`);
    if (perdeu && eu.mortes === 0) dicas.push('Ele farmou mais sem você morrer. Reveja o último golpe nas tropas e o controle da onda nesse trecho.');
    if (perdeu && eu.mortes > 0) dicas.push('Parte do farm perdido foi o tempo morto ou voltando à rota depois da morte.');
  }

  const objs = (f: Fontes) => {
    const p: string[] = [];
    if (f.placas) p.push(`${f.placas} placa(s)`);
    if (f.torres) p.push(`${f.torres} torre(s)`);
    if (f.monstros.length) p.push(f.monstros.join(', ').toLowerCase().replace(/_/g, ' '));
    return p.join(', ');
  };
  const objOp = objs(op);
  const objEu = objs(eu);
  if (objOp) leitura.push(`${ctx.op.campeao} pegou ${objOp}.`);
  if (objEu) leitura.push(`Você pegou ${objEu}.`);
  if ((perdeu && objOp) || (!perdeu && objEu)) causas.add('objetivos');

  if (causas.size === 0) causas.add('indefinida');

  // Causa principal: o componente de ouro que mais explica a virada.
  const lado = perdeu ? -1 : 1;
  const compAbates = (eu.ouroAbates - op.ouroAbates) * lado;
  const compObj = (eu.ouroTorres + eu.ouroMonstros - op.ouroTorres - op.ouroMonstros) * lado;
  const compOutros = (eu.ouroOutros - op.ouroOutros) * lado;
  const ordemAbates: Causa[] = perdeu
    ? ['gank_sofrido', 'morte_1x1', 'roam_do_oponente', 'morte_em_luta']
    : ['abate_1x1', 'gank_aliado', 'seu_roam', 'abate_em_luta'];
  let causaPrincipal: Causa = [...causas][0]!;
  const maior = Math.max(compAbates, compObj, compOutros);
  const escolher = (lista: Causa[]) => lista.find((c) => causas.has(c));
  if (maior === compAbates) causaPrincipal = escolher(ordemAbates) ?? causaPrincipal;
  else if (maior === compObj) causaPrincipal = escolher(['objetivos']) ?? causaPrincipal;
  else causaPrincipal = escolher(['farm', ...ordemAbates]) ?? causaPrincipal;
  // Morrer custa farm: se a maior parte foi "farm e outros" mas você morreu, a morte é a causa.
  if (perdeu && causaPrincipal === 'farm' && eu.mortes > 0) causaPrincipal = escolher(ordemAbates) ?? 'farm';

  return {
    inicio,
    fim,
    variacao,
    eu,
    oponente: op,
    causas: [...causas],
    causaPrincipal,
    leitura,
    dicas: [...new Set(dicas)],
    gankSemSentinela,
  };
}

export function analisarPartida(db: DatabaseSync, matchId: string, participanteId: number, o: OpcoesAnalise = PADRAO_ANALISE): AnalisePartida | null {
  const ctx = carregarContexto(db, matchId, participanteId);
  if (!ctx) return null;
  const diferenca = serieDiferenca(ctx);
  const episodios = detectarViradas(diferenca, o).map((v) => explicar(ctx, v.inicio, v.fim, v.variacao));
  return { ctx, diferenca, episodios };
}

// ---------------------------------------------------------------- várias partidas

export interface LinhaCausa {
  causa: string;
  viradas: number;
  jogos: number;
  ouro: number;
  ouro_por_virada: number;
  pct_do_ouro: number;
}

export interface ResumoCausas {
  partidas: number;
  perdas: LinhaCausa[];
  ganhos: LinhaCausa[];
  ganks: number;
  ganksSemSentinela: number;
}

/** Partidas suas com timeline e oponente de rota, da mais nova para a mais antiga. */
export function partidasAnalisaveis(db: DatabaseSync, f: Filtro, limite?: number): Array<{ match_id: string; participant_id: number }> {
  const w = where(f, 'v');
  return db
    .prepare(
      `SELECT v.match_id, v.participant_id FROM v_minhas_partidas v ${w.sql} ${w.sql ? 'AND' : 'WHERE'}
       v.oponente_id IS NOT NULL AND EXISTS (SELECT 1 FROM timelines t WHERE t.match_id = v.match_id)
       ORDER BY v.inicio_ms DESC ${limite ? 'LIMIT ?' : ''}`,
    )
    .all(...w.params, ...(limite ? [limite] : [])) as Array<{ match_id: string; participant_id: number }>;
}

export function resumirCausas(db: DatabaseSync, f: Filtro, o: OpcoesAnalise = PADRAO_ANALISE): ResumoCausas {
  const partidas = partidasAnalisaveis(db, f);
  const acum = { perdas: new Map<Causa, { v: number; jogos: Set<string>; ouro: number }>(), ganhos: new Map<Causa, { v: number; jogos: Set<string>; ouro: number }>() };
  let ganks = 0;
  let ganksSemSentinela = 0;
  for (const p of partidas) {
    const a = analisarPartida(db, p.match_id, p.participant_id, o);
    if (!a) continue;
    for (const ep of a.episodios) {
      const mapa = ep.variacao < 0 ? acum.perdas : acum.ganhos;
      const item = mapa.get(ep.causaPrincipal) ?? { v: 0, jogos: new Set<string>(), ouro: 0 };
      item.v++;
      item.jogos.add(p.match_id);
      item.ouro += Math.abs(ep.variacao);
      mapa.set(ep.causaPrincipal, item);
      if (ep.causas.includes('gank_sofrido')) {
        ganks++;
        if (ep.gankSemSentinela) ganksSemSentinela++;
      }
    }
  }
  const linhas = (mapa: Map<Causa, { v: number; jogos: Set<string>; ouro: number }>): LinhaCausa[] => {
    const total = [...mapa.values()].reduce((s, x) => s + x.ouro, 0) || 1;
    return [...mapa.entries()]
      .map(([c, x]) => ({
        causa: NOME_CAUSA[c],
        viradas: x.v,
        jogos: x.jogos.size,
        ouro: x.ouro,
        ouro_por_virada: Math.round(x.ouro / x.v),
        pct_do_ouro: Math.round((x.ouro / total) * 1000) / 10,
      }))
      .sort((a, b) => b.ouro - a.ouro);
  };
  return { partidas: partidas.length, perdas: linhas(acum.perdas), ganhos: linhas(acum.ganhos), ganks, ganksSemSentinela };
}
