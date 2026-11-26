import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { analiseDaPartida, analisarPartida, calcularAnalisesNovas, NOME_CAUSA, PADRAO_ANALISE, partidasAnalisaveis, relogio, resumirCausas, type OpcoesAnalise } from './analise/ouro.ts';
import { carregarConfig, carregarDbPath } from './config.ts';
import { abrirBanco } from './db.ts';
import { idDaFila, nomeDaFila } from './filas.ts';
import { reprocessarTudo } from './processar.ts';
import { abatesPorTempo, agrupar, curvaDeOuro, recentes, resumo } from './relatorios/consultas.ts';
import { CSV_EXCEL_BR, CSV_PADRAO, exportar } from './relatorios/exportar.ts';
import type { Filtro } from './relatorios/filtro.ts';
import { imprimirTabela, num } from './relatorios/tabela.ts';
import { ClienteRiot } from './riot/cliente.ts';
import { registrarElo, sincronizar } from './sync.ts';

const AJUDA = `
lol analytics — seu histórico do LoL pela API oficial da Riot

  npm run sync                         baixa as partidas novas (até 200 por vez)
  npm run sync -- --tudo               baixa o histórico inteiro que a Riot disponibiliza
  npm run sync -- --fila solo --desde 2026-01-01 --max 50

  npm run relatorio                    desempenho por campeão
  npm run relatorio -- posicoes        por posição (top, jungle, mid, adc, sup)
  npm run relatorio -- oponentes       contra quais campeões você joga melhor/pior
  npm run relatorio -- meses           evolução mês a mês (também: semanas)
  npm run relatorio -- duracao         vitória e ouro/min por duração da partida
  npm run relatorio -- recentes        últimas partidas (--n 30)
  npm run relatorio -- curva           ouro médio por minuto, você x oponente de rota
  npm run relatorio -- abates          kills/mortes por faixa de 5 minutos
  npm run relatorio -- campeao Ahri    tudo isso só de um campeão

  Viradas de ouro contra o oponente de rota (o que aconteceu e o que dava para fazer):
  npm run relatorio -- ouro            a última partida, trecho a trecho, com dicas
  npm run relatorio -- ouro BR1_123    uma partida específica
  npm run relatorio -- viradas         maior perda e maior ganho de cada partida (--n 20)
  npm run relatorio -- causas          de onde vem o ouro que você perde e ganha, somado
    --limiar 500 (ouro)   --janela 2 (minutos): o que conta como virada

  Filtros (valem para relatorio e exportar):
    --fila solo|flex|aram|normal|...   --dias 30   --posicao mid   --campeao Ahri
    --conta Nome#TAG   --min-jogos 5   --remakes (inclui remakes)

  npm run exportar                     CSV para Excel em data/export (--pasta, --csv-padrao)
  npm run elo                          elo atual das contas (e guarda o histórico)
  npm run reprocessar                  refaz as tabelas a partir do JSON salvo
`;

const COLS_GRUPO = [
  'grupo', 'jogos', 'vitoria_pct', 'kda', 'kills_min', 'deaths_min', 'ouro_min', 'cs_min',
  'dano_min', 'kp_pct', 'cs_10', 'dif_ouro_10', 'dif_ouro_15', 'duracao_min',
];

function lerArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      max: { type: 'string' },
      tudo: { type: 'boolean', default: false },
      fila: { type: 'string' },
      desde: { type: 'string' },
      dias: { type: 'string' },
      campeao: { type: 'string' },
      posicao: { type: 'string' },
      conta: { type: 'string' },
      'min-jogos': { type: 'string' },
      remakes: { type: 'boolean', default: false },
      n: { type: 'string' },
      ate: { type: 'string' },
      pasta: { type: 'string' },
      limiar: { type: 'string' },
      janela: { type: 'string' },
      'csv-padrao': { type: 'boolean', default: false },
    },
  });
}

type Args = ReturnType<typeof lerArgs>['values'];

function inteiro(v: string | undefined, nome: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${nome} precisa ser um inteiro positivo.`);
  return n;
}

function filtro(a: Args, campeao?: string): Filtro {
  return {
    fila: a.fila ? idDaFila(a.fila) : undefined,
    dias: inteiro(a.dias, 'dias'),
    campeao: campeao ?? a.campeao,
    posicao: a.posicao,
    conta: a.conta,
    incluirRemakes: a.remakes,
  };
}

function descreverFiltro(f: Filtro): string {
  const p: string[] = [];
  if (f.fila !== undefined) p.push(nomeDaFila(f.fila));
  if (f.dias) p.push(`últimos ${f.dias} dias`);
  if (f.campeao) p.push(f.campeao);
  if (f.posicao) p.push(f.posicao);
  if (f.conta) p.push(f.conta);
  return p.length ? ` (${p.join(', ')})` : ' (todas as filas)';
}

function opcoesAnalise(a: Args): OpcoesAnalise {
  return {
    limiar: inteiro(a.limiar, 'limiar') ?? PADRAO_ANALISE.limiar,
    janela: inteiro(a.janela, 'janela') ?? PADRAO_ANALISE.janela,
  };
}

const fmtNum = new Intl.NumberFormat('pt-BR');
const comSinal = (v: number) => (v > 0 ? `+${fmtNum.format(v)}` : fmtNum.format(v));

function relatorioOuro(db: DatabaseSync, a: Args, id: string | undefined): void {
  const o = opcoesAnalise(a);
  let alvo: { match_id: string; participant_id: number } | undefined;
  if (id) {
    alvo = db
      .prepare(
        "SELECT match_id, participant_id FROM v_minhas_partidas WHERE match_id = ? OR substr(match_id, instr(match_id, '_') + 1) = ? LIMIT 1",
      )
      .get(id.toUpperCase(), id) as typeof alvo;
    if (!alvo) throw new Error(`Partida ${id} não encontrada no banco.`);
  } else {
    alvo = partidasAnalisaveis(db, filtro(a), 1)[0];
    if (!alvo) throw new Error('Nenhuma partida com timeline e oponente de rota (ARAM e Arena não têm oponente de rota).');
  }
  const an = analisarPartida(db, alvo.match_id, alvo.participant_id, o);
  if (!an) throw new Error('Essa partida não tem timeline ou oponente de rota para comparar.');
  const { ctx, diferenca, episodios } = an;
  console.log(`\n== ${ctx.eu.campeao} x ${ctx.op.campeao} | ${ctx.data} | ${ctx.vitoria ? 'Vitória' : 'Derrota'} | ${ctx.matchId} ==\n`);
  console.log(`Diferença de ouro por minuto (você − ${ctx.op.campeao}):`);
  for (let i = 0; i < diferenca.length; i += 10) {
    const trecho = diferenca.slice(i, i + 10).map((v) => comSinal(v).padStart(7)).join('');
    const ultimo = Math.min(i + 9, diferenca.length - 1);
    const faixa = ultimo === i ? `${String(i).padStart(5)}` : `${String(i).padStart(2)}-${String(ultimo).padStart(2)}`;
    console.log(`  ${faixa} min ${trecho}`);
  }
  if (episodios.length === 0) {
    console.log(`\nNenhuma virada de ${o.limiar} de ouro em até ${o.janela} minutos.`);
    return;
  }
  for (const ep of episodios) {
    const titulo = `${relogio(ep.inicio * 60_000)} a ${relogio(ep.fim * 60_000)} | ${ep.variacao < 0 ? 'perdeu' : 'ganhou'} ${fmtNum.format(Math.abs(ep.variacao))} | ${NOME_CAUSA[ep.causaPrincipal]}`;
    console.log(`\n▸ ${titulo}`);
    for (const l of ep.leitura.slice(1)) console.log(`   ${l}`);
    for (const d of ep.dicas) console.log(`   Dica: ${d}`);
  }
}

function relatorioViradas(db: DatabaseSync, a: Args, n: number): void {
  const o = opcoesAnalise(a);
  const linhas = partidasAnalisaveis(db, filtro(a), n).map((p) => {
    const an = analiseDaPartida(db, p.match_id, p.participant_id, o)!.analise;
    const perda = an.episodios.filter((e) => e.variacao < 0).sort((x, y) => x.variacao - y.variacao)[0];
    const ganho = an.episodios.filter((e) => e.variacao > 0).sort((x, y) => y.variacao - x.variacao)[0];
    const desc = (e: typeof perda) => (e ? `${comSinal(e.variacao)} aos ${e.inicio}-${e.fim} min: ${NOME_CAUSA[e.causaPrincipal]}` : '-');
    return {
      match_id: an.matchId,
      data: an.data.slice(0, 16),
      campeao: an.campeao,
      oponente: an.oponente,
      resultado: an.vitoria ? 'V' : 'D',
      maior_perda: desc(perda),
      maior_ganho: desc(ganho),
    };
  });
  console.log(imprimirTabela(linhas));
  if (linhas.length) console.log('\nDetalhe de uma partida: npm run relatorio -- ouro <match_id>');
}

function relatorioCausas(db: DatabaseSync, a: Args): void {
  const r = resumirCausas(db, filtro(a), opcoesAnalise(a));
  if (r.partidas === 0) {
    console.log('Nenhuma partida com timeline e oponente de rota com esses filtros.');
    return;
  }
  const cols = ['causa', 'viradas', 'jogos', 'ouro', 'ouro_por_virada', 'pct_do_ouro'];
  console.log(`${r.partidas} partida(s) analisada(s).\n\nOnde você PERDE ouro para o oponente de rota:\n`);
  console.log(imprimirTabela(r.perdas as unknown as Array<Record<string, string | number>>, cols));
  console.log('\nOnde você GANHA ouro sobre o oponente de rota:\n');
  console.log(imprimirTabela(r.ganhos as unknown as Array<Record<string, string | number>>, cols));
  if (r.ganks) {
    const pct = Math.round((r.ganksSemSentinela / r.ganks) * 100);
    console.log(`\nGanks sofridos: ${r.ganks}. Em ${r.ganksSemSentinela} (${pct}%) você não tinha colocado sentinela nos 3 minutos antes.`);
  }
}

async function cmdSync(a: Args): Promise<void> {
  const cfg = carregarConfig();
  const db = abrirBanco(cfg.dbPath);
  const riot = new ClienteRiot(cfg);
  let desde: number | undefined;
  if (a.desde) {
    const t = Date.parse(`${a.desde}T00:00:00`);
    if (Number.isNaN(t)) throw new Error('--desde precisa estar no formato AAAA-MM-DD.');
    desde = Math.floor(t / 1000);
  }
  const max = a.tudo ? Infinity : (inteiro(a.max, 'max') ?? 200);
  const inicio = Date.now();
  const res = await sincronizar(db, riot, cfg.riotIds, {
    max,
    fila: a.fila ? idDaFila(a.fila) : undefined,
    desde,
    log: (m) => console.log(m),
  });
  for (const r of res) {
    const extras = [
      r.semTimeline ? `${r.semTimeline} sem timeline` : '',
      r.indisponiveis ? `${r.indisponiveis} indisponíveis na Riot` : '',
    ].filter(Boolean);
    console.log(`${r.conta}: ${r.novas} partida(s) salva(s)${extras.length ? ` (${extras.join(', ')})` : ''}.`);
  }
  const n = await registrarElo(db, riot);
  const seg = Math.round((Date.now() - inicio) / 1000);
  console.log(`Elo registrado (${n} fila(s)). ${riot.requisicoes} requisições em ${seg}s.`);
  console.log(`Análise de ouro: ${calcularAnalisesNovas(db)} partida(s) nova(s) analisada(s); as anteriores continuam salvas.`);
  if (Number.isFinite(max) && res.some((r) => r.novas >= max)) {
    console.log('Ainda há partidas antigas: rode o sync de novo (ou use --tudo).');
  }
}

function cmdRelatorio(a: Args, positionals: string[]): void {
  const db = abrirBanco(carregarDbPath());
  const tipo = (positionals[0] ?? 'campeoes').toLowerCase();
  const minJogos = inteiro(a['min-jogos'], 'min-jogos') ?? 1;
  const n = inteiro(a.n, 'n') ?? 20;
  const ate = inteiro(a.ate, 'ate') ?? 30;

  const grupos: Record<string, [string, string]> = {
    campeoes: ['campeao', 'Campeão'],
    posicoes: ['posicao', 'Posição'],
    oponentes: ['oponente', 'Oponente'],
    meses: ['mes', 'Mês'],
    semanas: ['semana', 'Semana'],
    duracao: ['duracao', 'Duração'],
    filas: ['fila', 'Fila'],
  };

  if (tipo === 'ouro') return relatorioOuro(db, a, positionals[1]);
  if (tipo === 'viradas') return relatorioViradas(db, a, n);
  if (tipo === 'causas') {
    console.log(`\ncausas${descreverFiltro(filtro(a))}\n`);
    return relatorioCausas(db, a);
  }

  if (tipo === 'campeao') {
    const nome = positionals[1] ?? a.campeao;
    if (!nome) throw new Error('Informe o campeão: npm run relatorio -- campeao Ahri');
    const f = filtro(a, nome);
    const r = resumo(db, f);
    if (!r || !r.jogos) {
      console.log(`Nenhuma partida de ${nome}${descreverFiltro({ ...f, campeao: undefined })}.`);
      return;
    }
    console.log(`\n== ${nome}${descreverFiltro({ ...f, campeao: undefined })} ==\n`);
    console.log(imprimirTabela([{ grupo: 'Total', ...r }], COLS_GRUPO));
    console.log('\nContra quem:\n');
    console.log(imprimirTabela(agrupar(db, 'oponente', f), COLS_GRUPO, 'Oponente'));
    console.log('\nOuro por minuto (você x oponente de rota):\n');
    console.log(imprimirTabela(curvaDeOuro(db, f, ate)));
    console.log('\nAbates por tempo de jogo:\n');
    console.log(imprimirTabela(abatesPorTempo(db, f)));
    console.log('\nViradas de ouro contra o oponente de rota:\n');
    relatorioCausas(db, { ...a, campeao: nome });
    console.log('\nÚltimas partidas:\n');
    console.log(imprimirTabela(recentes(db, f, n).map(({ participant_id: _, ...l }) => l)));
    return;
  }

  const f = filtro(a);
  console.log(`\n${tipo}${descreverFiltro(f)}\n`);
  if (grupos[tipo]) {
    const [por, rotulo] = grupos[tipo];
    const linhas = agrupar(db, por, f, minJogos);
    if (por === 'fila_id' || por === 'fila') for (const l of linhas) l.grupo = nomeDaFila(Number(l.grupo));
    console.log(imprimirTabela(linhas, COLS_GRUPO, rotulo));
    const r = resumo(db, f);
    if (r?.jogos) console.log(`\nTotal: ${r.jogos} jogos, ${r.vitoria_pct}% de vitória, KDA ${r.kda}, ${r.ouro_min} ouro/min.`);
  } else if (tipo === 'recentes') {
    console.log(imprimirTabela(recentes(db, f, n).map(({ participant_id: _, ...l }) => l)));
  } else if (tipo === 'curva') {
    console.log(imprimirTabela(curvaDeOuro(db, f, ate)));
  } else if (tipo === 'abates') {
    console.log(imprimirTabela(abatesPorTempo(db, f)));
  } else {
    throw new Error(`Relatório desconhecido: ${tipo}. Rode "npm run ajuda".`);
  }
}

function cmdExportar(a: Args): void {
  const db = abrirBanco(carregarDbPath());
  const pasta = resolve(process.cwd(), a.pasta ?? 'data/export');
  const contagem = exportar(db, filtro(a), pasta, a['csv-padrao'] ? CSV_PADRAO : CSV_EXCEL_BR);
  for (const [arq, n] of Object.entries(contagem)) console.log(`${arq}: ${n} linha(s)`);
  console.log(`Arquivos em ${pasta}`);
}

async function cmdElo(): Promise<void> {
  const cfg = carregarConfig();
  const db = abrirBanco(cfg.dbPath);
  await registrarElo(db, new ClienteRiot(cfg));
  const linhas = db
    .prepare(
      `SELECT c.game_name || '#' || c.tag_line AS conta, e.fila, e.tier || ' ' || e.divisao AS elo, e.pdl,
         e.vitorias, e.derrotas, round(e.vitorias * 100.0 / max(e.vitorias + e.derrotas, 1), 1) AS vitoria_pct,
         e.registrado_em
       FROM elo e JOIN contas c ON c.puuid = e.puuid
       WHERE e.registrado_em = (SELECT max(x.registrado_em) FROM elo x WHERE x.puuid = e.puuid AND x.fila = e.fila)
       ORDER BY conta, e.fila`,
    )
    .all() as Array<Record<string, string | number | null>>;
  if (linhas.length === 0) console.log('Nenhuma conta sincronizada ainda (rode npm run sync) ou sem partidas ranqueadas.');
  else console.log(imprimirTabela(linhas));
}

async function main(): Promise<void> {
  const [cmd = 'ajuda', ...resto] = process.argv.slice(2);
  const { values, positionals } = lerArgs(resto);
  switch (cmd) {
    case 'sync':
      return cmdSync(values);
    case 'relatorio':
      return cmdRelatorio(values, positionals);
    case 'exportar':
      return cmdExportar(values);
    case 'elo':
      return cmdElo();
    case 'reprocessar': {
      const n = reprocessarTudo(abrirBanco(carregarDbPath()));
      console.log(`${n} partida(s) reprocessada(s).`);
      return;
    }
    default:
      console.log(AJUDA);
  }
}

main().catch((e: unknown) => {
  console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
