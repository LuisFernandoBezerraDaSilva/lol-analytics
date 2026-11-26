import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Esquema: o JSON cru da Riot fica em partidas.json e timelines.json (para você extrair
 * o que quiser depois); as outras tabelas são derivadas dele e podem ser refeitas com
 * "npm run reprocessar".
 */
const ESQUEMA = `
CREATE TABLE IF NOT EXISTS contas (
  puuid TEXT PRIMARY KEY,
  game_name TEXT NOT NULL,
  tag_line TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  -- 1 quando um sync já percorreu a lista inteira de partidas desta conta.
  historico_completo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS partidas (
  match_id TEXT PRIMARY KEY,
  inicio_ms INTEGER NOT NULL,
  duracao_s INTEGER NOT NULL,
  fila_id INTEGER NOT NULL,
  versao TEXT NOT NULL,
  remake INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_partidas_inicio ON partidas (inicio_ms);

-- Partidas que a Riot listou mas não entrega mais (404): não tenta de novo a cada sync.
CREATE TABLE IF NOT EXISTS partidas_indisponiveis (
  match_id TEXT PRIMARY KEY,
  registrado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timelines (
  match_id TEXT PRIMARY KEY REFERENCES partidas (match_id),
  json TEXT NOT NULL
);

-- Os 10 jogadores de cada partida (você, aliados e inimigos).
CREATE TABLE IF NOT EXISTS participantes (
  match_id TEXT NOT NULL REFERENCES partidas (match_id),
  participant_id INTEGER NOT NULL,
  puuid TEXT NOT NULL,
  riot_id TEXT,
  time_id INTEGER NOT NULL,
  campeao TEXT NOT NULL,
  campeao_id INTEGER NOT NULL,
  posicao TEXT NOT NULL,
  oponente_id INTEGER,
  vitoria INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  deaths INTEGER NOT NULL,
  assists INTEGER NOT NULL,
  ouro INTEGER NOT NULL,
  cs INTEGER NOT NULL,
  dano_campeoes INTEGER NOT NULL,
  dano_recebido INTEGER NOT NULL,
  visao INTEGER NOT NULL,
  wards INTEGER NOT NULL,
  nivel INTEGER NOT NULL,
  PRIMARY KEY (match_id, participant_id)
);
CREATE INDEX IF NOT EXISTS ix_participantes_puuid ON participantes (puuid);

-- Um quadro por minuto da timeline, por jogador.
CREATE TABLE IF NOT EXISTS frames (
  match_id TEXT NOT NULL REFERENCES partidas (match_id),
  participant_id INTEGER NOT NULL,
  minuto INTEGER NOT NULL,
  ouro_total INTEGER NOT NULL,
  ouro_atual INTEGER NOT NULL,
  xp INTEGER NOT NULL,
  nivel INTEGER NOT NULL,
  cs INTEGER NOT NULL,
  PRIMARY KEY (match_id, participant_id, minuto)
);

-- Todos os eventos da timeline (abates, itens, objetivos, sentinelas...).
CREATE TABLE IF NOT EXISTS eventos (
  match_id TEXT NOT NULL REFERENCES partidas (match_id),
  seq INTEGER NOT NULL,
  tempo_ms INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  participant_id INTEGER,
  vitima_id INTEGER,
  assistencias TEXT,
  x INTEGER,
  y INTEGER,
  json TEXT NOT NULL,
  PRIMARY KEY (match_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_eventos_tipo ON eventos (match_id, tipo);

CREATE TABLE IF NOT EXISTS elo (
  puuid TEXT NOT NULL,
  fila TEXT NOT NULL,
  tier TEXT NOT NULL,
  divisao TEXT NOT NULL,
  pdl INTEGER NOT NULL,
  vitorias INTEGER NOT NULL,
  derrotas INTEGER NOT NULL,
  registrado_em TEXT NOT NULL
);

-- Outros jogadores consultados pelo Riot ID. registrado = 1: guardado e atualizado a cada sync;
-- registrado = 0: consulta eventual, descartada na próxima consulta de outro jogador.
CREATE TABLE IF NOT EXISTS jogadores (
  puuid TEXT PRIMARY KEY,
  game_name TEXT NOT NULL,
  tag_line TEXT NOT NULL,
  registrado INTEGER NOT NULL DEFAULT 0,
  consultado_em TEXT NOT NULL
);

-- Resultado da análise das viradas de ouro, calculado uma vez por partida e jogador.
-- A chave inclui o limiar, a janela e a versão do algoritmo: mudar qualquer um deles gera uma
-- análise nova, sem apagar a partida. Regravar a partida (reprocessar) apaga a análise dela.
-- Peso na derrota / contribuição na vitória (src/analise/peso.ts), calculado uma vez por partida.
CREATE TABLE IF NOT EXISTS analise_peso (
  match_id TEXT NOT NULL,
  participant_id INTEGER NOT NULL,
  versao INTEGER NOT NULL,
  json TEXT NOT NULL,
  calculado_em TEXT NOT NULL,
  PRIMARY KEY (match_id, participant_id, versao)
);

CREATE TABLE IF NOT EXISTS analise_viradas (
  match_id TEXT NOT NULL,
  participant_id INTEGER NOT NULL,
  limiar INTEGER NOT NULL,
  janela INTEGER NOT NULL,
  versao INTEGER NOT NULL,
  json TEXT NOT NULL,
  calculado_em TEXT NOT NULL,
  PRIMARY KEY (match_id, participant_id, limiar, janela, versao)
);

-- Partidas de qualquer jogador (uma linha por jogador por partida), com as métricas por minuto
-- e a comparação com o oponente de rota. v_minhas_partidas é esta view só com as suas contas.
DROP VIEW IF EXISTS v_minhas_partidas;
DROP VIEW IF EXISTS v_partidas_jogador;
CREATE VIEW v_partidas_jogador AS
SELECT
  m.match_id,
  m.inicio_ms,
  datetime(m.inicio_ms / 1000, 'unixepoch', 'localtime') AS data,
  m.fila_id,
  m.versao,
  m.duracao_s,
  round(m.duracao_s / 60.0, 2) AS duracao_min,
  m.remake,
  p.puuid,
  p.participant_id,
  p.campeao,
  p.posicao,
  p.oponente_id,
  op.campeao AS oponente,
  p.vitoria,
  p.kills, p.deaths, p.assists,
  round((p.kills + p.assists) * 1.0 / max(p.deaths, 1), 2) AS kda,
  round((p.kills + p.assists) * 100.0 / max(
    (SELECT sum(t.kills) FROM participantes t WHERE t.match_id = p.match_id AND t.time_id = p.time_id), 1), 1) AS participacao_abates,
  p.ouro, p.cs, p.dano_campeoes, p.dano_recebido, p.visao, p.wards, p.nivel,
  round(p.ouro * 60.0 / m.duracao_s, 1) AS ouro_min,
  round(p.kills * 60.0 / m.duracao_s, 3) AS kills_min,
  round(p.deaths * 60.0 / m.duracao_s, 3) AS deaths_min,
  round(p.assists * 60.0 / m.duracao_s, 3) AS assists_min,
  round(p.cs * 60.0 / m.duracao_s, 2) AS cs_min,
  round(p.dano_campeoes * 60.0 / m.duracao_s, 1) AS dano_min,
  round(p.visao * 60.0 / m.duracao_s, 2) AS visao_min,
  f10.ouro_total AS ouro_10, f10.cs AS cs_10, f10.xp AS xp_10,
  f10.ouro_total - o10.ouro_total AS dif_ouro_10,
  f10.cs - o10.cs AS dif_cs_10,
  f10.xp - o10.xp AS dif_xp_10,
  f15.ouro_total AS ouro_15, f15.cs AS cs_15,
  f15.ouro_total - o15.ouro_total AS dif_ouro_15,
  f15.cs - o15.cs AS dif_cs_15
FROM participantes p
JOIN partidas m ON m.match_id = p.match_id
LEFT JOIN participantes op ON op.match_id = p.match_id AND op.participant_id = p.oponente_id
LEFT JOIN frames f10 ON f10.match_id = p.match_id AND f10.participant_id = p.participant_id AND f10.minuto = 10
LEFT JOIN frames o10 ON o10.match_id = p.match_id AND o10.participant_id = p.oponente_id AND o10.minuto = 10
LEFT JOIN frames f15 ON f15.match_id = p.match_id AND f15.participant_id = p.participant_id AND f15.minuto = 15
LEFT JOIN frames o15 ON o15.match_id = p.match_id AND o15.participant_id = p.oponente_id AND o15.minuto = 15;

CREATE VIEW v_minhas_partidas AS
SELECT v.*, c.game_name || '#' || c.tag_line AS conta
FROM v_partidas_jogador v
JOIN contas c ON c.puuid = v.puuid;
`;

export function abrirBanco(caminho: string): DatabaseSync {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(ESQUEMA);
  return db;
}

export function emTransacao<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
