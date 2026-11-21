import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Data Dragon: o CDN público e oficial da Riot com ícones e nomes (não usa a chave da API).
 * Cada arquivo é baixado uma vez e guardado em data/ddragon, então depois funciona sem internet.
 */

const CDN = 'https://ddragon.leagueoflegends.com';
const UM_DIA = 86_400_000;

/** O nome do campeão na partida nem sempre é o nome do arquivo no Data Dragon. */
const ARQUIVO_CAMPEAO: Record<string, string> = { FiddleSticks: 'Fiddlesticks' };

export class DataDragon {
  private readonly pasta: string;
  private readonly http: typeof fetch;
  private versaoCache: { valor: string; em: number } | null = null;
  private itensCache: Record<string, string> | null = null;

  constructor(pasta: string, http: typeof fetch = fetch) {
    this.pasta = pasta;
    this.http = http;
  }

  private async lerOuBaixar(relativo: string, url: string): Promise<Buffer | null> {
    const local = join(this.pasta, relativo);
    try {
      return await readFile(local);
    } catch {
      // ainda não baixado
    }
    try {
      const r = await this.http(url);
      if (!r.ok) return null;
      const dados = Buffer.from(await r.arrayBuffer());
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, dados);
      return dados;
    } catch {
      return null; // sem internet: a tela mostra só o texto
    }
  }

  /** Versão mais recente do jogo no Data Dragon (consulta no máximo uma vez por dia). */
  async versao(): Promise<string | null> {
    if (this.versaoCache && Date.now() - this.versaoCache.em < UM_DIA) return this.versaoCache.valor;
    const arquivo = join(this.pasta, 'versao.json');
    try {
      const r = await this.http(`${CDN}/api/versions.json`);
      if (r.ok) {
        const lista = (await r.json()) as string[];
        const v = lista.find((x) => /^\d+\.\d+\.\d+$/.test(x));
        if (v) {
          await mkdir(this.pasta, { recursive: true });
          await writeFile(arquivo, JSON.stringify({ versao: v }));
          this.versaoCache = { valor: v, em: Date.now() };
          return v;
        }
      }
    } catch {
      // sem internet: usa a última versão guardada
    }
    try {
      const v = (JSON.parse(await readFile(arquivo, 'utf8')) as { versao: string }).versao;
      this.versaoCache = { valor: v, em: Date.now() };
      return v;
    } catch {
      return null;
    }
  }

  async iconeCampeao(nome: string): Promise<Buffer | null> {
    if (!/^[A-Za-z]{2,30}$/.test(nome)) return null;
    const v = await this.versao();
    if (!v) return null;
    const arquivo = ARQUIVO_CAMPEAO[nome] ?? nome;
    return this.lerOuBaixar(`${v}/champion/${arquivo}.png`, `${CDN}/cdn/${v}/img/champion/${arquivo}.png`);
  }

  async iconeItem(id: string): Promise<Buffer | null> {
    if (!/^\d{1,7}$/.test(id) || id === '0') return null;
    const v = await this.versao();
    if (!v) return null;
    return this.lerOuBaixar(`${v}/item/${id}.png`, `${CDN}/cdn/${v}/img/item/${id}.png`);
  }

  /** Nomes dos itens em português (id → nome). */
  async itens(): Promise<Record<string, string>> {
    if (this.itensCache) return this.itensCache;
    const v = await this.versao();
    if (!v) return {};
    const dados = await this.lerOuBaixar(`${v}/item_pt_BR.json`, `${CDN}/cdn/${v}/data/pt_BR/item.json`);
    if (!dados) return {};
    const json = JSON.parse(dados.toString('utf8')) as { data: Record<string, { name: string }> };
    this.itensCache = Object.fromEntries(Object.entries(json.data).map(([id, i]) => [id, i.name]));
    return this.itensCache;
  }
}
