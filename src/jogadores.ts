import type { DatabaseSync } from 'node:sqlite';
import { parseRiotId } from './config.ts';
import { emTransacao } from './db.ts';
import { gravarPartida } from './processar.ts';
import type { ClienteRiot } from './riot/cliente.ts';

/**
 * Outros jogadores, consultados pelo Riot ID.
 *
 * - Consulta eventual: baixa as últimas N partidas para ver agora. Na próxima consulta de outro
 *   jogador, as partidas que só serviam a ela são apagadas, para o banco não crescer à toa.
 * - Registrar em memória: o jogador fica guardado, aparece na lista e é atualizado a cada sync.
 *
 * Nada disso mistura com as suas partidas: os seus relatórios leem só as suas contas.
 */

type Riot = Pick<ClienteRiot, 'contaPorRiotId' | 'idsDePartidas' | 'partida' | 'timeline' | 'ranqueadas'>;

export interface Jogador {
  puuid: string;
  riotId: string;
  registrado: boolean;
  consultadoEm: string;
  partidas: number;
}

export interface OpcoesConsulta {
  /** Quantas partidas recentes baixar (cada uma custa 2 requisições com a timeline). */
  n: number;
  log?: (msg: string) => void;
}

/** Apaga as partidas que não envolvem nenhuma conta sua nem jogador registrado (nem `manter`). */
export function limparConsultasAvulsas(db: DatabaseSync, manter?: string): number {
  return emTransacao(db, () => {
    const guardados = `SELECT puuid FROM contas UNION SELECT puuid FROM jogadores WHERE registrado = 1${manter ? ' UNION SELECT ?' : ''}`;
    const params = manter ? [manter] : [];
    const orfas = db
      .prepare(
        `SELECT match_id FROM partidas m
         WHERE NOT EXISTS (SELECT 1 FROM participantes p WHERE p.match_id = m.match_id AND p.puuid IN (${guardados}))`,
      )
      .all(...params) as Array<{ match_id: string }>;
    for (const { match_id } of orfas) {
      for (const t of ['analise_viradas', 'analise_peso', 'eventos', 'frames', 'participantes', 'timelines', 'partidas']) {
        db.prepare(`DELETE FROM ${t} WHERE match_id = ?`).run(match_id);
      }
    }
    db.prepare(
      `DELETE FROM elo WHERE puuid NOT IN (SELECT puuid FROM contas UNION SELECT puuid FROM jogadores WHERE registrado = 1${manter ? ' UNION SELECT ?' : ''})`,
    ).run(...params);
    db.prepare(`DELETE FROM jogadores WHERE registrado = 0${manter ? ' AND puuid <> ?' : ''}`).run(...params);
    return orfas.length;
  });
}

/** Busca o jogador e baixa as partidas recentes que ainda não estão no banco. */
export async function consultarJogador(db: DatabaseSync, riot: Riot, riotId: string, o: OpcoesConsulta): Promise<{ puuid: string; riotId: string; novas: number }> {
  const log = o.log ?? (() => {});
  const { gameName, tagLine } = parseRiotId(riotId);
  const conta = await riot.contaPorRiotId(gameName, tagLine);
  const nome = `${conta.gameName}#${conta.tagLine}`;

  const ehMinha = db.prepare('SELECT 1 FROM contas WHERE puuid = ?').get(conta.puuid);
  if (ehMinha) throw new Error(`${nome} é uma das suas contas: os dados dela já estão nas outras abas.`);

  const apagadas = limparConsultasAvulsas(db, conta.puuid);
  if (apagadas) log(`Consulta anterior descartada (${apagadas} partida(s) que só serviam a ela).`);

  db.prepare(
    `INSERT INTO jogadores (puuid, game_name, tag_line, registrado, consultado_em) VALUES (?, ?, ?, 0, datetime('now'))
     ON CONFLICT (puuid) DO UPDATE SET game_name = excluded.game_name, tag_line = excluded.tag_line, consultado_em = excluded.consultado_em`,
  ).run(conta.puuid, conta.gameName, conta.tagLine);

  const novas = await baixarRecentes(db, riot, conta.puuid, nome, o);
  return { puuid: conta.puuid, riotId: nome, novas };
}

/** Baixa as últimas N partidas que faltam e o elo atual do jogador. */
async function baixarRecentes(db: DatabaseSync, riot: Riot, puuid: string, nome: string, o: OpcoesConsulta): Promise<number> {
  const log = o.log ?? (() => {});
  const ids = await riot.idsDePartidas(puuid, { start: 0, count: Math.min(o.n, 100) });
  const existe = db.prepare('SELECT 1 FROM partidas WHERE match_id = ?');
  const novos = ids.filter((id) => !existe.get(id));
  log(`${nome}: ${ids.length} partida(s) recente(s), ${novos.length} para baixar.`);
  let novas = 0;
  for (const [i, matchId] of novos.entries()) {
    const partida = await riot.partida(matchId);
    if (!partida) continue;
    gravarPartida(db, partida, await riot.timeline(matchId));
    novas++;
    if ((i + 1) % 5 === 0 || i === novos.length - 1) log(`  ${i + 1}/${novos.length} baixadas`);
  }
  const insElo = db.prepare(
    `INSERT INTO elo (puuid, fila, tier, divisao, pdl, vitorias, derrotas, registrado_em) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  for (const e of await riot.ranqueadas(puuid)) insElo.run(puuid, e.queueType, e.tier, e.rank, e.leaguePoints, e.wins, e.losses);
  db.prepare("UPDATE jogadores SET consultado_em = datetime('now') WHERE puuid = ?").run(puuid);
  log(`${nome}: pronto.`);
  return novas;
}

export function registrarJogador(db: DatabaseSync, puuid: string, registrar: boolean): void {
  const r = db.prepare('UPDATE jogadores SET registrado = ? WHERE puuid = ?').run(registrar ? 1 : 0, puuid);
  if (r.changes === 0) throw new Error('Jogador não encontrado. Consulte o Riot ID primeiro.');
}

export function listarJogadores(db: DatabaseSync): Jogador[] {
  const linhas = db
    .prepare(
      `SELECT j.puuid, j.game_name || '#' || j.tag_line AS riot_id, j.registrado, datetime(j.consultado_em, 'localtime') AS consultado_em,
         (SELECT count(*) FROM participantes p WHERE p.puuid = j.puuid) AS partidas
       FROM jogadores j ORDER BY j.registrado DESC, j.consultado_em DESC`,
    )
    .all() as Array<{ puuid: string; riot_id: string; registrado: number; consultado_em: string; partidas: number }>;
  return linhas.map((l) => ({ puuid: l.puuid, riotId: l.riot_id, registrado: l.registrado === 1, consultadoEm: l.consultado_em, partidas: l.partidas }));
}

/** Atualiza os jogadores registrados pelo PUUID (o Riot ID pode mudar). Não mexe na consulta eventual. */
export async function atualizarRegistrados(db: DatabaseSync, riot: Riot, n: number, log?: (m: string) => void): Promise<number> {
  let novas = 0;
  for (const j of listarJogadores(db).filter((x) => x.registrado)) {
    novas += await baixarRecentes(db, riot, j.puuid, j.riotId, { n, log });
  }
  return novas;
}

/** Atualiza um jogador já consultado (registrado ou não), sem descartar nada. */
export async function atualizarJogador(db: DatabaseSync, riot: Riot, puuid: string, o: OpcoesConsulta): Promise<number> {
  const j = listarJogadores(db).find((x) => x.puuid === puuid);
  if (!j) throw new Error('Jogador não encontrado. Consulte o Riot ID primeiro.');
  return baixarRecentes(db, riot, puuid, j.riotId, o);
}
