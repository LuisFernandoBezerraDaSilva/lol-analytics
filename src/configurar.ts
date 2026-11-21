import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRiotId } from './config.ts';

/** Servidor da conta → região de roteamento da account-v1/match-v5. */
export const SERVIDORES: Record<string, { regiao: string; nome: string }> = {
  br1: { regiao: 'americas', nome: 'Brasil' },
  na1: { regiao: 'americas', nome: 'América do Norte' },
  la1: { regiao: 'americas', nome: 'América Latina Norte' },
  la2: { regiao: 'americas', nome: 'América Latina Sul' },
  euw1: { regiao: 'europe', nome: 'Europa Oeste' },
  eun1: { regiao: 'europe', nome: 'Europa Nórdica e Leste' },
  tr1: { regiao: 'europe', nome: 'Turquia' },
  ru: { regiao: 'europe', nome: 'Rússia' },
  me1: { regiao: 'europe', nome: 'Oriente Médio' },
  kr: { regiao: 'asia', nome: 'Coreia' },
  jp1: { regiao: 'asia', nome: 'Japão' },
  oc1: { regiao: 'sea', nome: 'Oceania' },
  sg2: { regiao: 'sea', nome: 'Singapura e região' },
  tw2: { regiao: 'sea', nome: 'Taiwan' },
  vn2: { regiao: 'sea', nome: 'Vietnã' },
};

export interface NovaConfig {
  apiKey?: string;
  riotId?: string;
  servidor?: string;
}

export interface ResumoConfig {
  chaveConfigurada: boolean;
  /** Só os últimos 4 caracteres: a chave nunca volta inteira para a tela. */
  finalDaChave: string | null;
  riotId: string;
  servidor: string;
  servidores: Array<{ id: string; nome: string }>;
}

function caminhoEnv(): string {
  return resolve(process.cwd(), '.env');
}

export function resumoConfig(): ResumoConfig {
  const chave = process.env.RIOT_API_KEY?.trim() ?? '';
  const ok = chave !== '' && !chave.includes('coloque-a-sua-chave');
  return {
    chaveConfigurada: ok,
    finalDaChave: ok ? chave.slice(-4) : null,
    riotId: process.env.RIOT_ID ?? '',
    servidor: (process.env.RIOT_PLATFORM || 'br1').toLowerCase(),
    servidores: Object.entries(SERVIDORES).map(([id, s]) => ({ id, nome: s.nome })),
  };
}

/** Valida tudo antes de gravar: nada de quebra de linha ou valor estranho no .env. */
export function validar(c: NovaConfig): Record<string, string> {
  const valores: Record<string, string> = {};
  if (c.apiKey !== undefined && c.apiKey.trim() !== '') {
    const k = c.apiKey.trim();
    if (!/^RGAPI-[0-9a-fA-F-]{20,60}$/.test(k)) throw new Error('A chave da Riot começa com RGAPI- e tem só letras, números e hífens.');
    valores.RIOT_API_KEY = k;
  }
  if (c.riotId !== undefined && c.riotId.trim() !== '') {
    const ids = c.riotId.split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      parseRiotId(id);
      if (/[\r\n="'`\\]/.test(id) || id.length > 40) throw new Error(`Riot ID inválido: ${id}`);
    }
    valores.RIOT_ID = ids.join(',');
  }
  if (c.servidor !== undefined && c.servidor !== '') {
    const s = c.servidor.toLowerCase();
    const info = SERVIDORES[s];
    if (!info) throw new Error(`Servidor desconhecido: ${c.servidor}`);
    valores.RIOT_PLATFORM = s;
    valores.RIOT_REGION = info.regiao;
  }
  return valores;
}

/** Como o valor vai escrito no .env: o Riot ID entre aspas, porque o # sem aspas vira comentário. */
export function linhaEnv(chave: string, valor: string): string {
  return chave === 'RIOT_ID' ? `${chave}="${valor}"` : `${chave}=${valor}`;
}

/** Atualiza (ou cria) o .env mantendo as outras linhas e os comentários. */
export function salvarConfig(c: NovaConfig, arquivo = caminhoEnv()): ResumoConfig {
  const valores = validar(c);
  const modelo = resolve(process.cwd(), '.env.example');
  let texto = existsSync(arquivo) ? readFileSync(arquivo, 'utf8') : existsSync(modelo) ? readFileSync(modelo, 'utf8') : '';
  for (const [chave, valor] of Object.entries(valores)) {
    const linha = new RegExp(`^${chave}=.*$`, 'm');
    const nova = linhaEnv(chave, valor);
    texto = linha.test(texto) ? texto.replace(linha, () => nova) : `${texto.replace(/\s*$/, '')}\n${nova}\n`;
    process.env[chave] = valor;
  }
  writeFileSync(arquivo, texto, 'utf8');
  return resumoConfig();
}
