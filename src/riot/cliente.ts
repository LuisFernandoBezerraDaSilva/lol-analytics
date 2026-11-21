import { Limitador, dormirDeVerdade, type Dormir, type Janela } from './limitador.ts';
import type { ContaRiot, EntradaRanqueada, Partida, Timeline } from './tipos.ts';

export class ErroRiot extends Error {
  readonly status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}

/** "20:1,100:120" (limite:segundos) vira as janelas do limitador. */
export function lerLimites(header: string | null): Janela[] {
  if (!header) return [];
  const janelas: Janela[] = [];
  for (const parte of header.split(',')) {
    const [limite, segundos] = parte.split(':').map(Number);
    if (Number.isInteger(limite) && limite! > 0 && Number.isInteger(segundos) && segundos! > 0) {
      janelas.push({ limite: limite!, ms: segundos! * 1_000 });
    }
  }
  return janelas;
}

export interface OpcoesCliente {
  apiKey: string;
  platform: string;
  region: string;
  limitePorSegundo: number;
  limitePor2Minutos: number;
  fetch?: typeof fetch;
  limitador?: Limitador;
  dormir?: Dormir;
  tentativas?: number;
}

export interface FiltroIds {
  start?: number;
  count?: number;
  queue?: number;
  startTime?: number;
  endTime?: number;
}

/**
 * Cliente da API oficial da Riot. A chave vai no header X-Riot-Token (nunca na URL),
 * respeita os limites da chave e espera o Retry-After quando recebe 429.
 */
export class ClienteRiot {
  private readonly o: OpcoesCliente;
  private readonly limitador: Limitador;
  private readonly http: typeof fetch;
  private readonly dormir: Dormir;
  requisicoes = 0;

  constructor(o: OpcoesCliente) {
    this.o = o;
    this.http = o.fetch ?? fetch;
    this.dormir = o.dormir ?? dormirDeVerdade;
    this.limitador =
      o.limitador ??
      new Limitador([
        { limite: o.limitePorSegundo, ms: 1_000 },
        { limite: o.limitePor2Minutos, ms: 120_000 },
      ]);
  }

  private async get<T>(host: string, caminho: string, permitir404 = false): Promise<T | null> {
    const url = `https://${host}.api.riotgames.com${caminho}`;
    const tentativas = this.o.tentativas ?? 5;
    for (let tentativa = 1; ; tentativa++) {
      await this.limitador.aguardarVez();
      this.requisicoes++;
      let resp: Response;
      try {
        resp = await this.http(url, { headers: { 'X-Riot-Token': this.o.apiKey } });
      } catch (e) {
        if (tentativa >= tentativas) throw e;
        await this.dormir(1_000 * tentativa);
        continue;
      }
      this.ajustarLimites(resp.headers.get('X-App-Rate-Limit'));
      if (resp.ok) return (await resp.json()) as T;
      if (resp.status === 404 && permitir404) return null;
      if (resp.status === 401 || resp.status === 403) {
        throw new ErroRiot(resp.status, 'A Riot recusou a chave (401/403). Chave de desenvolvimento expira a cada 24h: gere outra no developer.riotgames.com.');
      }
      if (resp.status === 429 && tentativa < tentativas) {
        const segundos = Number(resp.headers.get('Retry-After')) || 10;
        this.limitador.pausar(segundos * 1_000);
        continue;
      }
      if (resp.status >= 500 && tentativa < tentativas) {
        await this.dormir(1_000 * 2 ** tentativa);
        continue;
      }
      throw new ErroRiot(resp.status, `Riot respondeu ${resp.status} em ${caminho}`);
    }
  }

  /** Usa os limites reais da chave, que a Riot manda em toda resposta. */
  private ajustarLimites(header: string | null): void {
    const novos = lerLimites(header);
    if (!novos.length) return;
    const atuais = this.limitador.limites;
    const iguais = novos.length === atuais.length && novos.every((j, i) => j.limite === atuais[i]!.limite && j.ms === atuais[i]!.ms);
    if (!iguais) this.limitador.ajustar(novos);
  }

  async contaPorRiotId(gameName: string, tagLine: string): Promise<ContaRiot> {
    const conta = await this.get<ContaRiot>(
      this.o.region,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      true,
    );
    if (!conta) throw new ErroRiot(404, `Riot ID ${gameName}#${tagLine} não encontrado.`);
    return conta;
  }

  async idsDePartidas(puuid: string, f: FiltroIds = {}): Promise<string[]> {
    const q = new URLSearchParams();
    q.set('start', String(f.start ?? 0));
    q.set('count', String(f.count ?? 100));
    if (f.queue !== undefined) q.set('queue', String(f.queue));
    if (f.startTime !== undefined) q.set('startTime', String(f.startTime));
    if (f.endTime !== undefined) q.set('endTime', String(f.endTime));
    return (await this.get<string[]>(this.o.region, `/lol/match/v5/matches/by-puuid/${puuid}/ids?${q}`)) ?? [];
  }

  partida(matchId: string): Promise<Partida | null> {
    return this.get<Partida>(this.o.region, `/lol/match/v5/matches/${matchId}`, true);
  }

  timeline(matchId: string): Promise<Timeline | null> {
    return this.get<Timeline>(this.o.region, `/lol/match/v5/matches/${matchId}/timeline`, true);
  }

  async ranqueadas(puuid: string): Promise<EntradaRanqueada[]> {
    return (await this.get<EntradaRanqueada[]>(this.o.platform, `/lol/league/v4/entries/by-puuid/${puuid}`)) ?? [];
  }
}
