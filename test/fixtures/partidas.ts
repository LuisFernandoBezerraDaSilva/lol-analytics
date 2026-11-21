import type { EventoTimeline, Participante, Partida, Timeline } from '../../src/riot/tipos.ts';

export const EU = 'puuid-eu';
const POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

export interface Opcoes {
  matchId: string;
  campeao?: string;
  oponente?: string;
  vitoria?: boolean;
  kda?: [number, number, number];
  duracaoS?: number;
  inicioMs?: number;
  fila?: number;
  ouro?: number;
  /** Ouro por minuto na timeline: o meu e o do oponente de rota. */
  ritmoOuro?: [number, number];
  remake?: boolean;
  /** Abates com o minuto: 'k' = eu matei, 'm' = eu morri, 'a' = assisti. */
  abates?: Array<[number, 'k' | 'm' | 'a']>;
  semGameEnd?: boolean;
  /** Ouro extra somado ao jogador a partir de um minuto (simula abate, objetivo, farm). */
  ajusteOuro?: Array<{ pid: number; deMin: number; ouro: number }>;
  ajusteCs?: Array<{ pid: number; deMin: number; cs: number }>;
  /** Eventos crus da timeline, no formato da Riot. */
  eventos?: EventoTimeline[];
}

function participante(id: number, o: Opcoes): Participante {
  const time = id <= 5 ? 100 : 200;
  const pos = POS[(id - 1) % 5]!;
  const eu = id === 3;
  const op = id === 8;
  const venceu = (o.vitoria ?? true) === (time === 100);
  const [k, d, a] = eu ? (o.kda ?? [5, 2, 7]) : [2, 2, 2];
  return {
    puuid: eu ? EU : `puuid-${o.matchId}-${id}`,
    participantId: id,
    teamId: time,
    championId: id,
    championName: eu ? (o.campeao ?? 'Ahri') : op ? (o.oponente ?? 'Zed') : `Campeao${id}`,
    teamPosition: o.fila === 450 ? '' : pos,
    win: venceu,
    kills: k,
    deaths: d,
    assists: a,
    goldEarned: eu ? (o.ouro ?? 12_000) : 10_000,
    totalMinionsKilled: eu ? 180 : 150,
    neutralMinionsKilled: eu ? 20 : 0,
    totalDamageDealtToChampions: eu ? 24_000 : 15_000,
    totalDamageTaken: 18_000,
    visionScore: eu ? 30 : 20,
    wardsPlaced: 10,
    champLevel: 16,
    gameEndedInEarlySurrender: o.remake ?? false,
    riotIdGameName: eu ? 'Eu' : `Jogador${id}`,
    riotIdTagline: 'BR1',
  };
}

export function partida(o: Opcoes): Partida {
  const dur = o.duracaoS ?? 1800;
  return {
    metadata: { matchId: o.matchId, participants: [] },
    info: {
      gameCreation: o.inicioMs ?? Date.UTC(2026, 10, 1),
      gameDuration: o.semGameEnd ? dur * 1000 : dur,
      gameEndTimestamp: o.semGameEnd ? undefined : (o.inicioMs ?? 0) + dur * 1000,
      gameVersion: '16.22.1',
      queueId: o.fila ?? 420,
      participants: Array.from({ length: 10 }, (_, i) => participante(i + 1, o)),
    },
  };
}

export function timeline(o: Opcoes): Timeline {
  const minutos = Math.floor((o.duracaoS ?? 1800) / 60);
  const [meu, dele] = o.ritmoOuro ?? [400, 350];
  const frames: Timeline['info']['frames'] = [];
  for (let m = 0; m <= minutos; m++) {
    const pf: Timeline['info']['frames'][number]['participantFrames'] = {};
    for (let id = 1; id <= 10; id++) {
      const ritmo = id === 3 ? meu : id === 8 ? dele : 300;
      const extraOuro = (o.ajusteOuro ?? []).filter((a) => a.pid === id && m >= a.deMin).reduce((t, a) => t + a.ouro, 0);
      const extraCs = (o.ajusteCs ?? []).filter((a) => a.pid === id && m >= a.deMin).reduce((t, a) => t + a.cs, 0);
      pf[String(id)] = {
        participantId: id,
        totalGold: 500 + ritmo * m + extraOuro,
        currentGold: 100,
        xp: 300 * m,
        level: Math.min(18, 1 + Math.floor(m / 2)),
        minionsKilled: (id === 3 ? 8 : 7) * m + extraCs,
        jungleMinionsKilled: 0,
      };
    }
    const events: EventoTimeline[] = (o.abates ?? [])
      .filter(([min]) => Math.floor(min) === m)
      .map(([min, tipo]) => ({
        type: 'CHAMPION_KILL',
        timestamp: Math.round(min * 60_000),
        killerId: tipo === 'k' ? 3 : tipo === 'm' ? 8 : 1,
        victimId: tipo === 'm' ? 3 : 8,
        assistingParticipantIds: tipo === 'a' ? [3, 2] : [],
        position: { x: 7000, y: 7000 },
      }));
    events.push(...(o.eventos ?? []).filter((e) => Math.floor(e.timestamp / 60_000) === m));
    if (m === 1) events.push({ type: 'ITEM_PURCHASED', timestamp: 61_000, participantId: 3, itemId: 1056 });
    frames.push({ timestamp: m * 60_000 + (m ? 50 : 0), participantFrames: pf, events });
  }
  return { metadata: { matchId: o.matchId }, info: { frameInterval: 60_000, frames } };
}
