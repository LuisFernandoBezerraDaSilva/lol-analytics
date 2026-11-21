import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/db.ts';
import { gravarPartida } from '../src/processar.ts';
import { abatesPorTempo, agrupar, curvaDeOuro, recentes, resumo } from '../src/relatorios/consultas.ts';
import { CSV_EXCEL_BR, exportar, paraCsv } from '../src/relatorios/exportar.ts';
import { imprimirTabela } from '../src/relatorios/tabela.ts';
import { EU, partida, timeline, type Opcoes } from './fixtures/partidas.ts';

const DIA = 86_400_000;
const AGORA = Date.UTC(2026, 10, 20);
let db: DatabaseSync;

function salvar(o: Opcoes) {
  gravarPartida(db, partida(o), timeline(o));
}

beforeEach(() => {
  db = abrirBanco(':memory:');
  db.prepare("INSERT INTO contas (puuid, game_name, tag_line, atualizado_em) VALUES (?, 'Eu', 'BR1', '')").run(EU);
  salvar({ matchId: 'M1', campeao: 'Ahri', vitoria: true, inicioMs: AGORA - 2 * DIA, kda: [8, 2, 6], abates: [[3, 'k'], [7, 'k'], [12, 'm']] });
  salvar({ matchId: 'M2', campeao: 'Ahri', vitoria: false, inicioMs: AGORA - 3 * DIA, kda: [2, 6, 4], ritmoOuro: [300, 400], abates: [[4, 'm'], [8, 'a']] });
  salvar({ matchId: 'M3', campeao: 'Zed', oponente: 'Ahri', vitoria: true, inicioMs: AGORA - 40 * DIA, fila: 440, duracaoS: 1300 });
  salvar({ matchId: 'M4', campeao: 'Ahri', vitoria: false, inicioMs: AGORA - 1 * DIA, remake: true, duracaoS: 200 });
});

describe('relatórios', () => {
  it('agrupa por campeão, ignorando remakes', () => {
    const l = agrupar(db, 'campeao', { agoraMs: AGORA });
    assert.deepEqual(l.map((x) => [x.grupo, x.jogos, x.vitoria_pct]), [['Ahri', 2, 50], ['Zed', 1, 100]]);
    const ahri = l[0]!;
    assert.equal(ahri.kda, 2.5); // (8+6+2+4)/(2+6)
    assert.equal(ahri.kills_min, 0.167); // 10 kills em 60 minutos
    assert.equal(ahri.dif_ouro_10, -250); // +500 e -1000
  });

  it('inclui remakes só quando pedido e respeita os filtros', () => {
    assert.equal(resumo(db, { incluirRemakes: true })!.jogos, 4);
    assert.equal(resumo(db, { fila: 440 })!.jogos, 1);
    assert.equal(resumo(db, { dias: 30, agoraMs: AGORA })!.jogos, 2);
    assert.equal(resumo(db, { campeao: 'ahri' })!.jogos, 2);
    assert.equal(resumo(db, { posicao: 'meio' })!.jogos, 3);
    assert.equal(resumo(db, { posicao: 'top' })!.jogos, 0);
  });

  it('agrupa por duração da partida', () => {
    const l = agrupar(db, 'duracao', {});
    assert.deepEqual(l.map((x) => [x.grupo, x.jogos]), [['20-25 min', 1], ['30-35 min', 2]]);
  });

  it('curva de ouro mostra o meu ouro, o do oponente e a diferença por minuto', () => {
    const c = curvaDeOuro(db, { campeao: 'Ahri' }, 10);
    assert.equal(c.length, 11);
    const m10 = c[10]!;
    assert.equal(m10.jogos, 2);
    assert.equal(m10.meu_ouro, 4000); // média de 4500 e 3500
    assert.equal(m10.ouro_oponente, 4250); // média de 4000 e 4500
    assert.equal(m10.diferenca, -250);
  });

  it('abates por faixa de tempo vêm da timeline', () => {
    const a = abatesPorTempo(db, { campeao: 'Ahri' });
    assert.deepEqual(
      a.map((x) => [x.faixa, x.total_kills, x.total_mortes]),
      [['0-5 min', 1, 1], ['5-10 min', 1, 0], ['10-15 min', 0, 1]],
    );
    assert.equal(a[0]!.kills_por_jogo, 0.5);
  });

  it('recentes vem da mais nova para a mais antiga', () => {
    assert.deepEqual(recentes(db, {}, 5).map((r) => r.resultado), ['V', 'D', 'V']);
  });

  it('tabela do terminal usa vírgula decimal', () => {
    const t = imprimirTabela(agrupar(db, 'campeao', {}), ['grupo', 'jogos', 'kda'], 'Campeão');
    assert.match(t, /Ahri\s+2\s+2,5/);
  });

  it('CSV para Excel BR: BOM, ponto e vírgula, vírgula decimal e aspas quando preciso', () => {
    const csv = paraCsv([{ a: 1.5, b: 'x;y', c: null }], CSV_EXCEL_BR);
    assert.equal(csv, '﻿a;b;c\r\n1,5;"x;y";\r\n');
  });

  it('exporta partidas, curva de ouro e abates', () => {
    const pasta = join(tmpdir(), `lol-analytics-teste-${process.pid}`);
    try {
      const n = exportar(db, { campeao: 'Ahri' }, pasta, CSV_EXCEL_BR);
      assert.deepEqual(n, { 'partidas.csv': 2, 'curva_ouro.csv': 62, 'abates.csv': 5 });
      const csv = readFileSync(join(pasta, 'partidas.csv'), 'utf8');
      assert.ok(csv.split('\r\n')[0]!.includes('ouro_min;kills_min'));
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});
