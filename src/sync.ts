import type { DatabaseSync } from 'node:sqlite';
import type { RiotId } from './config.ts';
import { gravarPartida } from './processar.ts';
import type { ClienteRiot } from './riot/cliente.ts';

export interface OpcoesSync {
  /** Máximo de partidas NOVAS baixadas por conta nesta execução (Infinity = todas). */
  max: number;
  fila?: number;
  /** Só partidas a partir desta data (epoch em segundos, como a Riot espera). */
  desde?: number;
  log?: (msg: string) => void;
}

export interface ResultadoSync {
  conta: string;
  novas: number;
  semTimeline: number;
  indisponiveis: number;
}

/**
 * Lista os IDs que ainda não estão no banco, do mais novo para o mais antigo.
 * Enquanto o histórico da conta não foi percorrido até o fim, pagina tudo (1 requisição
 * a cada 100 partidas); depois disso a lista vem da mais nova para a mais antiga, então a
 * primeira partida já salva marca o ponto onde o resto também está salvo.
 */
async function idsNovos(
  db: DatabaseSync,
  riot: ClienteRiot,
  puuid: string,
  o: OpcoesSync,
): Promise<{ ids: string[]; chegouAoFim: boolean }> {
  const existe = db.prepare(
    'SELECT 1 FROM partidas WHERE match_id = ? UNION ALL SELECT 1 FROM partidas_indisponiveis WHERE match_id = ?',
  );
  const conta = db.prepare('SELECT historico_completo FROM contas WHERE puuid = ?').get(puuid) as
    | { historico_completo: number }
    | undefined;
  const podeParar = conta?.historico_completo === 1;
  const ids: string[] = [];
  for (let start = 0; ; start += 100) {
    const pagina = await riot.idsDePartidas(puuid, { start, count: 100, queue: o.fila, startTime: o.desde });
    let jaTinha = 0;
    for (const id of pagina) {
      if (existe.get(id, id)) jaTinha++;
      else if (ids.length < o.max) ids.push(id);
      else return { ids, chegouAoFim: false };
    }
    if (pagina.length < 100) return { ids, chegouAoFim: true };
    if (podeParar && jaTinha > 0) return { ids, chegouAoFim: true };
  }
}

export async function sincronizar(db: DatabaseSync, riot: ClienteRiot, ids: RiotId[], o: OpcoesSync): Promise<ResultadoSync[]> {
  const log = o.log ?? (() => {});
  const resultados: ResultadoSync[] = [];
  for (const rid of ids) {
    const conta = await riot.contaPorRiotId(rid.gameName, rid.tagLine);
    const nome = `${conta.gameName}#${conta.tagLine}`;
    db.prepare(
      `INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (puuid) DO UPDATE SET game_name = excluded.game_name, tag_line = excluded.tag_line, atualizado_em = excluded.atualizado_em`,
    ).run(conta.puuid, conta.gameName, conta.tagLine);

    const { ids: novos, chegouAoFim } = await idsNovos(db, riot, conta.puuid, o);
    log(`${nome}: ${novos.length} partida(s) nova(s) para baixar (as que já estão salvas não são baixadas de novo).`);
    const r: ResultadoSync = { conta: nome, novas: 0, semTimeline: 0, indisponiveis: 0 };
    for (const [i, matchId] of novos.entries()) {
      const partida = await riot.partida(matchId);
      if (!partida) {
        db.prepare("INSERT OR IGNORE INTO partidas_indisponiveis (match_id, registrado_em) VALUES (?, datetime('now'))").run(matchId);
        r.indisponiveis++;
        continue;
      }
      const timeline = await riot.timeline(matchId);
      if (!timeline) r.semTimeline++;
      gravarPartida(db, partida, timeline);
      r.novas++;
      if ((i + 1) % 10 === 0 || i === novos.length - 1) log(`  ${i + 1}/${novos.length} baixadas`);
    }
    // Com filtro de fila/data a lista não é o histórico inteiro, então não marca como completo.
    if (chegouAoFim && o.fila === undefined && o.desde === undefined) {
      db.prepare('UPDATE contas SET historico_completo = 1 WHERE puuid = ?').run(conta.puuid);
    }
    resultados.push(r);
  }
  return resultados;
}

export async function registrarElo(db: DatabaseSync, riot: ClienteRiot): Promise<number> {
  const contas = db.prepare('SELECT puuid FROM contas').all() as Array<{ puuid: string }>;
  const ins = db.prepare(
    `INSERT INTO elo (puuid, fila, tier, divisao, pdl, vitorias, derrotas, registrado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  let n = 0;
  for (const { puuid } of contas) {
    for (const e of await riot.ranqueadas(puuid)) {
      ins.run(puuid, e.queueType, e.tier, e.rank, e.leaguePoints, e.wins, e.losses);
      n++;
    }
  }
  return n;
}
