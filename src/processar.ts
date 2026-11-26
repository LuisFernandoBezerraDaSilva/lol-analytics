import type { DatabaseSync } from 'node:sqlite';
import { emTransacao } from './db.ts';
import type { Participante, Partida, Timeline } from './riot/tipos.ts';

/** Antes do patch 11.20 a Riot mandava gameDuration em milissegundos (sem gameEndTimestamp). */
export function duracaoEmSegundos(p: Partida): number {
  const d = p.info.gameDuration;
  return p.info.gameEndTimestamp === undefined ? Math.round(d / 1000) : d;
}

/** Remake: alguém saiu e o time rendeu cedo, ou a partida durou menos de 5 minutos. */
export function ehRemake(p: Partida): boolean {
  return duracaoEmSegundos(p) < 300 || p.info.participants.some((x) => x.gameEndedInEarlySurrender);
}

/** Oponente de rota: mesma posição no time adversário. Sem posição (ARAM, Arena) não há oponente. */
export function oponenteDeRota(eu: Participante, todos: Participante[]): number | null {
  if (!eu.teamPosition) return null;
  const op = todos.find((x) => x.teamId !== eu.teamId && x.teamPosition === eu.teamPosition);
  return op ? op.participantId : null;
}

/** Grava (ou regrava) a partida e a timeline: JSON cru + tabelas derivadas. */
export function gravarPartida(db: DatabaseSync, partida: Partida, timeline: Timeline | null): void {
  emTransacao(db, () => {
    const id = partida.metadata.matchId;
    db.prepare(
      `INSERT INTO partidas (match_id, inicio_ms, duracao_s, fila_id, versao, remake, json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (match_id) DO UPDATE SET inicio_ms = excluded.inicio_ms, duracao_s = excluded.duracao_s,
         fila_id = excluded.fila_id, versao = excluded.versao, remake = excluded.remake, json = excluded.json`,
    ).run(
      id,
      partida.info.gameCreation,
      duracaoEmSegundos(partida),
      partida.info.queueId,
      partida.info.gameVersion,
      ehRemake(partida) ? 1 : 0,
      JSON.stringify(partida),
    );
    if (timeline) {
      db.prepare(
        'INSERT INTO timelines (match_id, json) VALUES (?, ?) ON CONFLICT (match_id) DO UPDATE SET json = excluded.json',
      ).run(id, JSON.stringify(timeline));
    }
    derivar(db, partida, timeline);
  });
}

function derivar(db: DatabaseSync, partida: Partida, timeline: Timeline | null): void {
  const id = partida.metadata.matchId;
  for (const t of ['participantes', 'frames', 'eventos', 'analise_viradas', 'analise_peso']) db.prepare(`DELETE FROM ${t} WHERE match_id = ?`).run(id);

  const insP = db.prepare(
    `INSERT INTO participantes (match_id, participant_id, puuid, riot_id, time_id, campeao, campeao_id, posicao,
       oponente_id, vitoria, kills, deaths, assists, ouro, cs, dano_campeoes, dano_recebido, visao, wards, nivel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const todos = partida.info.participants;
  for (const p of todos) {
    insP.run(
      id,
      p.participantId,
      p.puuid,
      p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline ?? ''}` : null,
      p.teamId,
      p.championName,
      p.championId,
      p.teamPosition || '',
      oponenteDeRota(p, todos),
      p.win ? 1 : 0,
      p.kills,
      p.deaths,
      p.assists,
      p.goldEarned,
      p.totalMinionsKilled + p.neutralMinionsKilled,
      p.totalDamageDealtToChampions,
      p.totalDamageTaken,
      p.visionScore,
      p.wardsPlaced,
      p.champLevel,
    );
  }

  if (!timeline) return;
  const insF = db.prepare(
    `INSERT OR REPLACE INTO frames (match_id, participant_id, minuto, ouro_total, ouro_atual, xp, nivel, cs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insE = db.prepare(
    `INSERT INTO eventos (match_id, seq, tempo_ms, tipo, participant_id, vitima_id, assistencias, x, y, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let seq = 0;
  for (const frame of timeline.info.frames) {
    const minuto = Math.round(frame.timestamp / 60_000);
    for (const f of Object.values(frame.participantFrames)) {
      insF.run(id, f.participantId, minuto, f.totalGold, f.currentGold, f.xp, f.level, f.minionsKilled + f.jungleMinionsKilled);
    }
    for (const e of frame.events) {
      const autor = e.killerId ?? (e.participantId as number | undefined) ?? (e.creatorId as number | undefined) ?? null;
      insE.run(
        id,
        seq++,
        e.timestamp,
        e.type,
        autor,
        e.victimId ?? null,
        e.assistingParticipantIds?.length ? e.assistingParticipantIds.join(',') : null,
        e.position?.x ?? null,
        e.position?.y ?? null,
        JSON.stringify(e),
      );
    }
  }
}

/** Refaz as tabelas derivadas a partir do JSON salvo (útil quando o esquema evoluir). */
export function reprocessarTudo(db: DatabaseSync): number {
  const linhas = db
    .prepare('SELECT p.json AS pj, t.json AS tj FROM partidas p LEFT JOIN timelines t ON t.match_id = p.match_id')
    .all() as Array<{ pj: string; tj: string | null }>;
  for (const l of linhas) gravarPartida(db, JSON.parse(l.pj) as Partida, l.tj ? (JSON.parse(l.tj) as Timeline) : null);
  return linhas.length;
}
