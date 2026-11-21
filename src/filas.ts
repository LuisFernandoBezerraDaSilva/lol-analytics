// IDs de fila da Riot (queues.json do Data Dragon / static data).
export const FILAS: Record<string, { id: number; nome: string }> = {
  solo: { id: 420, nome: 'Ranqueada Solo/Duo' },
  flex: { id: 440, nome: 'Ranqueada Flex' },
  normal: { id: 400, nome: 'Normal (escolha alternada)' },
  blind: { id: 430, nome: 'Normal (escolha às cegas)' },
  rapida: { id: 490, nome: 'Partida rápida' },
  aram: { id: 450, nome: 'ARAM' },
  arena: { id: 1700, nome: 'Arena' },
  urf: { id: 900, nome: 'URF' },
};

export function nomeDaFila(id: number): string {
  return Object.values(FILAS).find((f) => f.id === id)?.nome ?? `Fila ${id}`;
}

/** Aceita apelido (solo, flex, aram...) ou o número da fila. */
export function idDaFila(texto: string): number {
  const f = FILAS[texto.toLowerCase()];
  if (f) return f.id;
  const n = Number(texto);
  if (Number.isInteger(n) && n > 0) return n;
  throw new Error(`Fila desconhecida: "${texto}". Use ${Object.keys(FILAS).join(', ')} ou o número da fila.`);
}
