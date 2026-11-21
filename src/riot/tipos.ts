// Só os campos que o projeto usa. O JSON completo da Riot fica salvo cru no banco.

export interface ContaRiot {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface Participante {
  puuid: string;
  participantId: number;
  teamId: number;
  championId: number;
  championName: string;
  teamPosition: string;
  individualPosition?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  totalDamageDealtToChampions: number;
  totalDamageTaken: number;
  visionScore: number;
  wardsPlaced: number;
  champLevel: number;
  gameEndedInEarlySurrender?: boolean;
  riotIdGameName?: string;
  riotIdTagline?: string;
  challenges?: Record<string, number>;
}

export interface Partida {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameCreation: number;
    gameDuration: number;
    gameEndTimestamp?: number;
    gameVersion: string;
    queueId: number;
    participants: Participante[];
  };
}

export interface FrameParticipante {
  participantId: number;
  totalGold: number;
  currentGold: number;
  xp: number;
  level: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
}

export interface EventoTimeline {
  type: string;
  timestamp: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  position?: { x: number; y: number };
  [campo: string]: unknown;
}

export interface Timeline {
  metadata: { matchId: string };
  info: {
    frameInterval: number;
    frames: Array<{
      timestamp: number;
      participantFrames: Record<string, FrameParticipante>;
      events: EventoTimeline[];
    }>;
  };
}

export interface EntradaRanqueada {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}
