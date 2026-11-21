import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RiotId {
  gameName: string;
  tagLine: string;
}

export interface Config {
  apiKey: string;
  riotIds: RiotId[];
  platform: string;
  region: string;
  limitePorSegundo: number;
  limitePor2Minutos: number;
  dbPath: string;
}

export function parseRiotId(texto: string): RiotId {
  const limpo = texto.trim();
  const i = limpo.lastIndexOf('#');
  if (i <= 0 || i === limpo.length - 1) {
    throw new Error(`Riot ID inválido: "${texto}". Use o formato Nome#TAG.`);
  }
  return { gameName: limpo.slice(0, i), tagLine: limpo.slice(i + 1) };
}

function carregarEnv(): void {
  const arquivo = resolve(process.cwd(), '.env');
  if (existsSync(arquivo)) process.loadEnvFile(arquivo);
}

function numero(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (!v) return padrao;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${nome} precisa ser um número positivo.`);
  return n;
}

/** Só o banco: relatórios e exportação funcionam sem chave da Riot. */
export function carregarDbPath(): string {
  carregarEnv();
  return resolve(process.cwd(), process.env.DB_PATH || 'data/lol.db');
}

/** Tudo, inclusive a chave: usado pelo sync e pelo elo. */
export function carregarConfig(): Config {
  carregarEnv();
  const apiKey = process.env.RIOT_API_KEY?.trim() ?? '';
  if (!apiKey || apiKey.includes('coloque-a-sua-chave')) {
    throw new Error('RIOT_API_KEY não configurada. Copie .env.example para .env e cole a chave do developer.riotgames.com.');
  }
  const ids = (process.env.RIOT_ID ?? '').split(',').filter((s) => s.trim());
  if (ids.length === 0) throw new Error('RIOT_ID não configurado no .env (formato Nome#TAG).');
  if (ids.some((id) => !id.includes('#'))) {
    throw new Error('RIOT_ID sem a TAG. No .env, use aspas: RIOT_ID="Nome#TAG" (sem aspas, o # vira comentário).');
  }
  return {
    apiKey,
    riotIds: ids.map(parseRiotId),
    platform: (process.env.RIOT_PLATFORM || 'br1').toLowerCase(),
    region: (process.env.RIOT_REGION || 'americas').toLowerCase(),
    limitePorSegundo: numero('RIOT_LIMITE_POR_SEGUNDO', 20),
    limitePor2Minutos: numero('RIOT_LIMITE_POR_2_MINUTOS', 100),
    dbPath: carregarDbPath(),
  };
}
