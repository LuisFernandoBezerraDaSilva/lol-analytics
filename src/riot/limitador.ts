export interface Janela {
  limite: number;
  ms: number;
}

export type Relogio = () => number;
export type Dormir = (ms: number) => Promise<void>;

export const dormirDeVerdade: Dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Limitador de janela deslizante. Garante que nenhuma janela (ex.: 20 por 1s e 100 por 120s)
 * passe do limite. As requisições são servidas na ordem em que chegaram.
 */
export class Limitador {
  private janelas: Janela[];
  private readonly agora: Relogio;
  private readonly dormir: Dormir;
  private readonly historico: number[] = [];
  private fila: Promise<void> = Promise.resolve();
  /** Instante até o qual tudo fica parado (após um 429 com Retry-After). */
  private pausadoAte = 0;

  constructor(janelas: Janela[], agora: Relogio = Date.now, dormir: Dormir = dormirDeVerdade) {
    this.janelas = janelas;
    this.agora = agora;
    this.dormir = dormir;
  }

  get limites(): readonly Janela[] {
    return this.janelas;
  }

  /** Troca os limites (a Riot informa os da sua chave no header X-App-Rate-Limit). */
  ajustar(janelas: Janela[]): void {
    if (janelas.length) this.janelas = janelas;
  }

  /** Para todas as requisições por `ms` a partir de agora. */
  pausar(ms: number): void {
    this.pausadoAte = Math.max(this.pausadoAte, this.agora() + ms);
  }

  aguardarVez(): Promise<void> {
    const vez = this.fila.then(() => this.esperarCapacidade());
    this.fila = vez.catch(() => undefined);
    return vez;
  }

  private async esperarCapacidade(): Promise<void> {
    for (;;) {
      const agora = this.agora();
      let espera = Math.max(0, this.pausadoAte - agora);
      const maiorJanela = Math.max(...this.janelas.map((j) => j.ms));
      while (this.historico.length && this.historico[0]! <= agora - maiorJanela) this.historico.shift();
      for (const j of this.janelas) {
        const dentro = this.historico.filter((t) => t > agora - j.ms);
        if (dentro.length >= j.limite) {
          const liberaEm = dentro[dentro.length - j.limite]! + j.ms;
          espera = Math.max(espera, liberaEm - agora);
        }
      }
      if (espera <= 0) {
        this.historico.push(agora);
        return;
      }
      await this.dormir(espera + 5);
    }
  }
}
