import type { DatabaseSync } from 'node:sqlite';
import { nomeDaFila } from '../filas.ts';
import { duracaoEmSegundos } from '../processar.ts';
import type { Participante, Partida } from '../riot/tipos.ts';

export interface JogadorPlacar {
  puuid: string;
  riotId: string;
  campeao: string;
  posicao: string;
  nivel: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  cs: number;
  csMin: number;
  ouro: number;
  dano: number;
  danoRecebido: number;
  visao: number;
  sentinelas: number;
  /** item0 a item5 e o amuleto (item6); 0 = espaço vazio. */
  itens: number[];
  /** É uma das suas contas. */
  eu: boolean;
  /** É o jogador em foco (consultado). */
  foco: boolean;
}

export interface TimePlacar {
  timeId: number;
  lado: string;
  vitoria: boolean;
  kills: number;
  ouro: number;
  jogadores: JogadorPlacar[];
}

export interface Placar {
  matchId: string;
  data: string;
  duracao: string;
  fila: string;
  versao: string;
  remake: boolean;
  temTimeline: boolean;
  times: TimePlacar[];
}

const ORDEM_POSICAO: Record<string, number> = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };

/** O placar completo de uma partida salva, montado a partir do JSON da Riot. */
export function placar(db: DatabaseSync, matchId: string, foco?: string): Placar | null {
  const linha = db
    .prepare(
      `SELECT m.json, m.remake, datetime(m.inicio_ms / 1000, 'unixepoch', 'localtime') AS data,
         EXISTS (SELECT 1 FROM timelines t WHERE t.match_id = m.match_id) AS tem_timeline
       FROM partidas m WHERE m.match_id = ?`,
    )
    .get(matchId) as { json: string; remake: number; data: string; tem_timeline: number } | undefined;
  if (!linha) return null;
  const partida = JSON.parse(linha.json) as Partida;
  const minhas = new Set((db.prepare('SELECT puuid FROM contas').all() as Array<{ puuid: string }>).map((c) => c.puuid));
  const seg = duracaoEmSegundos(partida);
  const min = Math.max(seg / 60, 1);

  const jogador = (p: Participante): JogadorPlacar => {
    const cru = p as unknown as Record<string, unknown>;
    const nome = p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline ?? ''}` : String(cru.summonerName ?? '?');
    const cs = p.totalMinionsKilled + p.neutralMinionsKilled;
    return {
      puuid: p.puuid,
      riotId: nome,
      campeao: p.championName,
      posicao: p.teamPosition || '',
      nivel: p.champLevel,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      kda: Math.round(((p.kills + p.assists) / Math.max(p.deaths, 1)) * 100) / 100,
      cs,
      csMin: Math.round((cs / min) * 10) / 10,
      ouro: p.goldEarned,
      dano: p.totalDamageDealtToChampions,
      danoRecebido: p.totalDamageTaken,
      visao: p.visionScore,
      sentinelas: p.wardsPlaced,
      itens: [0, 1, 2, 3, 4, 5, 6].map((i) => Number(cru[`item${i}`] ?? 0)),
      eu: minhas.has(p.puuid),
      foco: foco !== undefined && p.puuid === foco,
    };
  };

  const times = [100, 200].map((timeId) => {
    const js = partida.info.participants
      .filter((p) => p.teamId === timeId)
      .sort((a, b) => (ORDEM_POSICAO[a.teamPosition] ?? 9) - (ORDEM_POSICAO[b.teamPosition] ?? 9))
      .map(jogador);
    return {
      timeId,
      lado: timeId === 100 ? 'Time azul' : 'Time vermelho',
      vitoria: partida.info.participants.some((p) => p.teamId === timeId && p.win),
      kills: js.reduce((s, j) => s + j.kills, 0),
      ouro: js.reduce((s, j) => s + j.ouro, 0),
      jogadores: js,
    };
  });

  return {
    matchId,
    data: linha.data,
    duracao: `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`,
    fila: nomeDaFila(partida.info.queueId),
    versao: partida.info.gameVersion.split('.').slice(0, 2).join('.'),
    remake: linha.remake === 1,
    temTimeline: linha.tem_timeline === 1,
    times,
  };
}
