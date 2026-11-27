import type { DatabaseSync } from 'node:sqlite';
import type { DataDragon } from './ddragon.ts';

/**
 * Classes dos campeões, guardadas no banco para os cálculos (que são síncronos) poderem usar.
 * Vêm das tags do Data Dragon: Assassin, Fighter, Mage, Marksman, Support, Tank.
 */

export type Classe = 'Assassin' | 'Fighter' | 'Mage' | 'Marksman' | 'Support' | 'Tank';

export const NOME_CLASSE: Record<Classe, string> = {
  Assassin: 'Assassino',
  Fighter: 'Lutador',
  Mage: 'Mago',
  Marksman: 'Atirador',
  Support: 'Suporte',
  Tank: 'Tanque',
};

/** Sem a classe do Data Dragon, a posição dá um palpite razoável. */
export const CLASSE_DA_POSICAO: Record<string, Classe> = {
  TOP: 'Fighter',
  JUNGLE: 'Fighter',
  MIDDLE: 'Mage',
  BOTTOM: 'Marksman',
  UTILITY: 'Support',
};

/** O nome do campeão na partida nem sempre é o id do Data Dragon. */
const ID_DDRAGON: Record<string, string> = { FiddleSticks: 'Fiddlesticks' };

/** Baixa (uma vez por versão do jogo) e guarda as classes. Devolve quantos campeões foram gravados. */
export async function atualizarClasses(db: DatabaseSync, dd: Pick<DataDragon, 'classes'>): Promise<number> {
  const c = await dd.classes();
  if (!c) return 0;
  const atual = db.prepare('SELECT versao FROM campeoes_classes LIMIT 1').get() as { versao: string } | undefined;
  if (atual?.versao === c.versao) return 0;
  const ins = db.prepare('INSERT OR REPLACE INTO campeoes_classes (campeao, tags, versao) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const [id, tags] of Object.entries(c.tags)) ins.run(id, tags.join(','), c.versao);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return Object.keys(c.tags).length;
}

/** Classes de todos os campeões guardados (nome da partida → tags). */
export function classesSalvas(db: DatabaseSync): Map<string, Classe[]> {
  const m = new Map<string, Classe[]>();
  for (const r of db.prepare('SELECT campeao, tags FROM campeoes_classes').all() as Array<{ campeao: string; tags: string }>) {
    m.set(r.campeao.toLowerCase(), r.tags.split(',').filter(Boolean) as Classe[]);
  }
  return m;
}

/** As classes de um campeão: do Data Dragon, ou o palpite pela posição. */
export function classesDe(campeao: string, posicao: string, salvas: Map<string, Classe[]>): { classes: Classe[]; doDataDragon: boolean } {
  const tags = salvas.get((ID_DDRAGON[campeao] ?? campeao).toLowerCase());
  if (tags && tags.length) return { classes: tags.slice(0, 2), doDataDragon: true };
  const palpite = CLASSE_DA_POSICAO[posicao];
  return { classes: palpite ? [palpite] : [], doDataDragon: false };
}
