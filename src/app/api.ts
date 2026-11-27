import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { atualizarClasses } from '../classes.ts';
import { DataDragon } from '../ddragon.ts';
import { atualizarJogador, atualizarRegistrados, consultarJogador, listarJogadores, registrarJogador } from '../jogadores.ts';
import { pesoDaPartida } from '../analise/peso.ts';
import { desempenhoPorCampeao, melhoresPorRota } from '../relatorios/desempenho.ts';
import { placar } from '../relatorios/placar.ts';
import { analiseDaPartida, analisarPartida, calcularAnalisesNovas, NOME_CAUSA, PADRAO_ANALISE, partidasAnalisaveis, resumirCausas, type OpcoesAnalise } from '../analise/ouro.ts';
import { carregarConfig } from '../config.ts';
import { resumoConfig, salvarConfig, type NovaConfig } from '../configurar.ts';
import { FILAS, idDaFila, nomeDaFila } from '../filas.ts';
import { AGRUPAMENTOS, abatesPorTempo, agrupar, curvaDeOuro, recentes, resumo, type Linha } from '../relatorios/consultas.ts';
import { ARQUIVOS_EXPORTACAO, CSV_EXCEL_BR, CSV_PADRAO, dadosExportacao, paraCsv } from '../relatorios/exportar.ts';
import type { Filtro } from '../relatorios/filtro.ts';
import { ROTULOS } from '../relatorios/tabela.ts';
import { ClienteRiot } from '../riot/cliente.ts';
import { registrarElo, sincronizar } from '../sync.ts';

export interface Requisicao {
  metodo: string;
  caminho: string;
  query: URLSearchParams;
  corpo?: unknown;
}

export interface Resposta {
  status: number;
  tipo: string;
  corpo: string | Buffer;
  arquivo?: string;
  /** Pode ficar no cache do navegador (ícones). */
  cache?: boolean;
}

/** Tarefa em segundo plano: sincronização ou consulta de jogador (uma de cada vez). */
export interface EstadoSync {
  rodando: boolean;
  tipo: 'sync' | 'consulta' | null;
  log: string[];
  inicio: string | null;
  fim: string | null;
  erro: string | null;
  /** Resultado da consulta de jogador (para a tela abrir o jogador). */
  resultado: { puuid: string; riotId: string } | null;
}

type Riot = Pick<ClienteRiot, 'contaPorRiotId' | 'idsDePartidas' | 'partida' | 'timeline' | 'ranqueadas'>;

export interface Dependencias {
  /** Troca o cliente da Riot nos testes. */
  criarRiot?: () => { riot: Riot; riotIds: Array<{ gameName: string; tagLine: string }> };
  /** Onde fica o .env (testes usam um arquivo temporário). */
  arquivoEnv?: string;
  /** Ícones e nomes de itens (testes usam um falso). */
  ddragon?: Pick<DataDragon, 'iconeCampeao' | 'iconeItem' | 'itens' | 'classes'>;
}

class ErroHttp extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const json = (corpo: unknown, status = 200): Resposta => ({ status, tipo: 'application/json; charset=utf-8', corpo: JSON.stringify(corpo) });

function inteiro(q: URLSearchParams, nome: string, padrao?: number): number | undefined {
  const v = q.get(nome);
  if (v === null || v === '') return padrao;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ErroHttp(400, `${nome} precisa ser um inteiro positivo.`);
  return n;
}

function filtroDaQuery(q: URLSearchParams): Filtro {
  try {
    return {
      fila: q.get('fila') ? idDaFila(q.get('fila')!) : undefined,
      dias: inteiro(q, 'dias'),
      campeao: q.get('campeao') || undefined,
      posicao: q.get('posicao') || undefined,
      conta: q.get('conta') || undefined,
      puuid: q.get('puuid') || undefined,
      incluirRemakes: q.get('remakes') === '1',
    };
  } catch (e) {
    throw new ErroHttp(400, e instanceof Error ? e.message : String(e));
  }
}

function opcoesAnalise(q: URLSearchParams): OpcoesAnalise {
  return { limiar: inteiro(q, 'limiar', PADRAO_ANALISE.limiar)!, janela: inteiro(q, 'janela', PADRAO_ANALISE.janela)! };
}

function tabela(linhas: Linha[]) {
  const chaves = linhas.length ? Object.keys(linhas[0]!) : [];
  return { colunas: chaves.map((c) => ({ chave: c, rotulo: ROTULOS[c] ?? c })), linhas };
}

export function criarApi(db: DatabaseSync, deps: Dependencias = {}) {
  const sync: EstadoSync = { rodando: false, tipo: null, log: [], inicio: null, fim: null, erro: null, resultado: null };
  const ddragon = deps.ddragon ?? new DataDragon(resolve(process.cwd(), 'data', 'ddragon'));

  /** Roda uma tarefa em segundo plano, com o andamento em `sync.log`. */
  function rodarTarefa(tipo: 'sync' | 'consulta', fn: (log: (m: string) => void) => Promise<void>): void {
    if (sync.rodando) throw new ErroHttp(409, sync.tipo === 'sync' ? 'Já existe uma sincronização em andamento.' : 'Já existe uma consulta em andamento.');
    Object.assign(sync, { rodando: true, tipo, log: [], inicio: new Date().toISOString(), fim: null, erro: null, resultado: null });
    const log = (m: string) => {
      sync.log.push(m);
      if (sync.log.length > 500) sync.log.splice(0, sync.log.length - 500);
    };
    void (async () => {
      try {
        await fn(log);
      } catch (e) {
        sync.erro = e instanceof Error ? e.message : String(e);
        log(`Erro: ${sync.erro}`);
      } finally {
        sync.rodando = false;
        sync.fim = new Date().toISOString();
      }
    })();
  }

  const criarRiot =
    deps.criarRiot ??
    (() => {
      let cfg;
      try {
        cfg = carregarConfig();
      } catch (e) {
        const motivo = e instanceof Error ? e.message : String(e);
        const semChave = motivo.startsWith('RIOT_API_KEY');
        throw new ErroHttp(400, semChave ? 'Configure a chave da Riot em "Configurações", lá em cima.' : `${motivo} Ajuste em "Configurações".`);
      }
      return { riot: new ClienteRiot(cfg), riotIds: cfg.riotIds };
    });

  function estadoBanco() {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const ultima = db.prepare('SELECT max(inicio_ms) AS t FROM partidas').get() as { t: number | null };
    const contas = db.prepare("SELECT game_name || '#' || tag_line AS conta FROM contas ORDER BY conta").all() as Array<{ conta: string }>;
    return {
      partidas: n('SELECT count(*) n FROM partidas'),
      comTimeline: n('SELECT count(*) n FROM timelines'),
      contas: contas.map((c) => c.conta),
      ultimaPartida: ultima.t ? new Date(ultima.t).toISOString() : null,
    };
  }

  function iniciarSync(corpo: Record<string, unknown>): void {
    if (sync.rodando) throw new ErroHttp(409, sync.tipo === 'sync' ? 'Já existe uma sincronização em andamento.' : 'Já existe uma consulta em andamento.');
    const { riot, riotIds } = criarRiot();
    const tudo = corpo.tudo === true;
    const max = tudo ? Infinity : Number(corpo.max ?? 200);
    if (!tudo && (!Number.isInteger(max) || max <= 0)) throw new ErroHttp(400, 'max precisa ser um inteiro positivo.');
    const fila = typeof corpo.fila === 'string' && corpo.fila ? idDaFila(corpo.fila) : undefined;
    let desde: number | undefined;
    if (typeof corpo.desde === 'string' && corpo.desde) {
      const t = Date.parse(`${corpo.desde}T00:00:00`);
      if (Number.isNaN(t)) throw new ErroHttp(400, 'desde precisa estar no formato AAAA-MM-DD.');
      desde = Math.floor(t / 1000);
    }
    rodarTarefa('sync', async (log) => {
      const res = await sincronizar(db, riot as ClienteRiot, riotIds, { max, fila, desde, log });
      for (const r of res) {
        const extras = [r.semTimeline ? `${r.semTimeline} sem timeline` : '', r.indisponiveis ? `${r.indisponiveis} indisponíveis` : ''].filter(Boolean);
        log(`${r.conta}: ${r.novas} partida(s) salva(s)${extras.length ? ` (${extras.join(', ')})` : ''}.`);
        if (Number.isFinite(max) && r.novas >= max) log('Ainda há partidas antigas: sincronize de novo para continuar.');
      }
      const n = await registrarElo(db, riot as ClienteRiot);
      log(`Elo registrado (${n} fila(s)).`);
      if (listarJogadores(db).some((j) => j.registrado)) {
        log('Atualizando os jogadores registrados em memória…');
        await atualizarRegistrados(db, riot as ClienteRiot, 20, log);
      }
      // As classes dos campeões entram antes do cálculo do peso (que depende delas).
      await atualizarClasses(db, ddragon).catch(() => 0);
      const analises = calcularAnalisesNovas(db);
      log(`Análise de ouro: ${analises} partida(s) nova(s) analisada(s); as anteriores continuam salvas.`);
      log('Pronto.');
    });
  }

  function iniciarConsulta(corpo: Record<string, unknown>): void {
    const riotId = typeof corpo.riotId === 'string' ? corpo.riotId.trim() : '';
    const puuid = typeof corpo.puuid === 'string' ? corpo.puuid : '';
    if (!riotId && !puuid) throw new ErroHttp(400, 'Informe o Riot ID (Nome#TAG).');
    const n = Number(corpo.n ?? 20);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new ErroHttp(400, 'Quantidade de partidas entre 1 e 100.');
    if (sync.rodando) throw new ErroHttp(409, sync.tipo === 'sync' ? 'Espere a sincronização terminar.' : 'Já existe uma consulta em andamento.');
    const { riot } = criarRiot();
    rodarTarefa('consulta', async (log) => {
      if (puuid) {
        await atualizarJogador(db, riot as ClienteRiot, puuid, { n, log });
        const j = listarJogadores(db).find((x) => x.puuid === puuid)!;
        sync.resultado = { puuid, riotId: j.riotId };
      } else {
        const r = await consultarJogador(db, riot as ClienteRiot, riotId, { n, log });
        sync.resultado = { puuid: r.puuid, riotId: r.riotId };
      }
    });
  }

  function jogador(puuid: string) {
    const j = listarJogadores(db).find((x) => x.puuid === puuid);
    if (!j) throw new ErroHttp(404, 'Jogador não encontrado. Consulte o Riot ID de novo.');
    const elo = db
      .prepare(
        `SELECT e.fila, e.tier || ' ' || e.divisao AS elo, e.pdl, e.vitorias, e.derrotas,
           round(e.vitorias * 100.0 / max(e.vitorias + e.derrotas, 1), 1) AS vitoria_pct
         FROM elo e
         WHERE e.puuid = ? AND e.registrado_em = (SELECT max(x.registrado_em) FROM elo x WHERE x.puuid = e.puuid AND x.fila = e.fila)
         ORDER BY e.fila`,
      )
      .all(puuid) as Linha[];
    return { ...j, elo };
  }

  /** Elo atual. Com o filtro de fila em Solo/Duo ou Flex, mostra só aquela fila ranqueada. */
  function elo(filaApelido?: string | null): Linha[] {
    const FILA_RANQUEADA: Record<string, string> = { solo: 'RANKED_SOLO_5x5', '420': 'RANKED_SOLO_5x5', flex: 'RANKED_FLEX_SR', '440': 'RANKED_FLEX_SR' };
    const fila = filaApelido ? FILA_RANQUEADA[filaApelido.toLowerCase()] : undefined;
    return db
      .prepare(
        `SELECT c.game_name || '#' || c.tag_line AS conta, e.fila, e.tier || ' ' || e.divisao AS elo, e.pdl,
           e.vitorias, e.derrotas, round(e.vitorias * 100.0 / max(e.vitorias + e.derrotas, 1), 1) AS vitoria_pct, e.registrado_em
         FROM elo e JOIN contas c ON c.puuid = e.puuid
         WHERE e.registrado_em = (SELECT max(x.registrado_em) FROM elo x WHERE x.puuid = e.puuid AND x.fila = e.fila)
           ${fila ? 'AND e.fila = ?' : ''}
         ORDER BY conta, e.fila`,
      )
      .all(...(fila ? [fila] : [])) as Linha[];
  }

  function ouro(q: URLSearchParams) {
    const id = q.get('match');
    let alvo: { match_id: string; participant_id: number } | undefined;
    const foco = q.get('puuid');
    if (id) {
      alvo = (
        foco
          ? db.prepare('SELECT match_id, participant_id FROM participantes WHERE match_id = ? AND puuid = ?').get(id, foco)
          : db.prepare('SELECT match_id, participant_id FROM v_minhas_partidas WHERE match_id = ? LIMIT 1').get(id)
      ) as typeof alvo;
    } else {
      alvo = partidasAnalisaveis(db, filtroDaQuery(q), 1)[0];
    }
    if (!alvo) throw new ErroHttp(404, 'Nenhuma partida com timeline e oponente de rota.');
    const an = analisarPartida(db, alvo.match_id, alvo.participant_id, opcoesAnalise(q));
    if (!an) throw new ErroHttp(404, 'Essa partida não tem timeline ou oponente de rota (ARAM e Arena não têm).');
    const { ctx } = an;
    return {
      partida: {
        matchId: ctx.matchId,
        data: ctx.data,
        vitoria: ctx.vitoria,
        campeao: ctx.eu.campeao,
        oponente: ctx.op.campeao,
        posicao: ctx.eu.posicao,
      },
      meuOuro: ctx.ouro.get(ctx.eu.id) ?? [],
      ouroOponente: ctx.ouro.get(ctx.op.id) ?? [],
      diferenca: an.diferenca,
      episodios: an.episodios.map((e) => ({
        inicio: e.inicio,
        fim: e.fim,
        variacao: e.variacao,
        causa: NOME_CAUSA[e.causaPrincipal],
        causas: e.causas.map((c) => NOME_CAUSA[c]),
        leitura: e.leitura.slice(1),
        dicas: e.dicas,
        eu: e.eu,
        oponente: e.oponente,
      })),
    };
  }

  function viradas(q: URLSearchParams) {
    const o = opcoesAnalise(q);
    return partidasAnalisaveis(db, filtroDaQuery(q), inteiro(q, 'n', 30)).map((p) => {
      const an = analiseDaPartida(db, p.match_id, p.participant_id, o)!.analise;
      const perda = an.episodios.filter((e) => e.variacao < 0).sort((x, y) => x.variacao - y.variacao)[0];
      const ganho = an.episodios.filter((e) => e.variacao > 0).sort((x, y) => y.variacao - x.variacao)[0];
      const resumir = (e: typeof perda) => (e ? { variacao: e.variacao, inicio: e.inicio, fim: e.fim, causa: NOME_CAUSA[e.causaPrincipal] } : null);
      return {
        matchId: an.matchId,
        data: an.data,
        campeao: an.campeao,
        oponente: an.oponente,
        vitoria: an.vitoria,
        difFinal: an.diferencaFinal,
        maiorPerda: resumir(perda),
        maiorGanho: resumir(ganho),
      };
    });
  }

  async function tratar(r: Requisicao): Promise<Resposta> {
    try {
      const q = r.query;
      const corpo = (r.corpo && typeof r.corpo === 'object' ? r.corpo : {}) as Record<string, unknown>;
      const rota = `${r.metodo} ${r.caminho}`;
      switch (rota) {
        case 'GET /api/estado':
          return json({ config: resumoConfig(), banco: estadoBanco(), sync });
        case 'POST /api/config':
          try {
            return json(salvarConfig(corpo as NovaConfig, deps.arquivoEnv));
          } catch (e) {
            throw new ErroHttp(400, e instanceof Error ? e.message : String(e));
          }
        case 'GET /api/sync':
          return json(sync);
        case 'POST /api/sync':
          try {
            iniciarSync(corpo);
          } catch (e) {
            if (e instanceof ErroHttp) throw e;
            throw new ErroHttp(400, e instanceof Error ? e.message : String(e));
          }
          return json(sync, 202);
        case 'GET /api/opcoes': {
          // Com puuid (aba Jogadores), a lista de campeões é a do jogador consultado.
          const puuid = q.get('puuid');
          const campeoes = (
            puuid
              ? db.prepare('SELECT DISTINCT campeao FROM v_partidas_jogador WHERE puuid = ? ORDER BY campeao').all(puuid)
              : db.prepare('SELECT DISTINCT campeao FROM v_minhas_partidas ORDER BY campeao').all()
          ) as Array<{ campeao: string }>;
          return json({
            filas: Object.entries(FILAS).map(([apelido, f]) => ({ apelido, nome: f.nome })),
            campeoes: campeoes.map((c) => c.campeao),
            agrupamentos: Object.keys(AGRUPAMENTOS),
          });
        }
        case 'GET /api/resumo':
          return json(resumo(db, filtroDaQuery(q)) ?? {});
        case 'GET /api/recentes': {
          // Cada partida ganha o veredito e, nas derrotas, o peso (calculado uma vez e salvo).
          const linhas = recentes(db, filtroDaQuery(q), inteiro(q, 'n', 30)).map((l) => {
            const p = pesoDaPartida(db, String(l.match_id), Number(l.participant_id));
            return { ...l, peso: p?.peso ?? null, veredito: p?.veredito ?? null };
          });
          return json(tabela(linhas));
        }
        case 'GET /api/peso': {
          const id = q.get('match') ?? '';
          const puuid = q.get('puuid');
          const alvo = (
            puuid
              ? db.prepare('SELECT participant_id FROM participantes WHERE match_id = ? AND puuid = ?').get(id, puuid)
              : db.prepare('SELECT participant_id FROM v_minhas_partidas WHERE match_id = ? LIMIT 1').get(id)
          ) as { participant_id: number } | undefined;
          if (!alvo) throw new ErroHttp(404, 'Partida não encontrada para esse jogador.');
          const p = pesoDaPartida(db, id, alvo.participant_id);
          if (!p) throw new ErroHttp(404, 'Sem cálculo para essa partida (remake?).');
          return json(p);
        }
        case 'GET /api/curva':
          return json(tabela(curvaDeOuro(db, filtroDaQuery(q), inteiro(q, 'ate', 30))));
        case 'GET /api/abates':
          return json(tabela(abatesPorTempo(db, filtroDaQuery(q))));
        case 'GET /api/viradas':
          return json(viradas(q));
        case 'GET /api/ouro':
          return json(ouro(q));
        case 'GET /api/causas':
          return json(resumirCausas(db, filtroDaQuery(q), opcoesAnalise(q)));
        case 'GET /api/elo':
          return json(tabela(elo(q.get('fila'))));
        case 'POST /api/elo': {
          const { riot } = criarRiot();
          await registrarElo(db, riot as ClienteRiot);
          return json(tabela(elo(q.get('fila'))));
        }
        case 'GET /api/desempenho': {
          const f = filtroDaQuery(q);
          const minJogos = inteiro(q, 'minJogos', 1);
          return json({
            ...tabela(desempenhoPorCampeao(db, f, { porRota: q.get('porRota') === '1', minJogos }) as unknown as Linha[]),
            melhores: melhoresPorRota(db, f, minJogos),
          });
        }
        case 'GET /api/partida': {
          const p = placar(db, q.get('match') ?? '', q.get('puuid') || undefined);
          if (!p) throw new ErroHttp(404, 'Partida não encontrada no banco.');
          return json(p);
        }
        case 'GET /api/jogadores':
          return json(listarJogadores(db));
        case 'GET /api/jogador':
          return json(jogador(q.get('puuid') ?? ''));
        case 'POST /api/jogadores/consultar':
          try {
            iniciarConsulta(corpo);
          } catch (e) {
            if (e instanceof ErroHttp) throw e;
            throw new ErroHttp(400, e instanceof Error ? e.message : String(e));
          }
          return json(sync, 202);
        case 'POST /api/jogadores/registrar':
          try {
            registrarJogador(db, String(corpo.puuid ?? ''), corpo.registrar === true);
          } catch (e) {
            throw new ErroHttp(404, e instanceof Error ? e.message : String(e));
          }
          return json(jogador(String(corpo.puuid)));
        case 'GET /api/ddragon/itens':
          return { ...json(await ddragon.itens()), cache: true };
      }
      if (r.metodo === 'GET' && r.caminho.startsWith('/api/ddragon/')) {
        const [, , , tipo, nome] = r.caminho.split('/');
        const img = tipo === 'campeao' ? await ddragon.iconeCampeao(nome ?? '') : tipo === 'item' ? await ddragon.iconeItem(nome ?? '') : null;
        if (!img) return { status: 404, tipo: 'text/plain; charset=utf-8', corpo: 'Sem ícone' };
        return { status: 200, tipo: 'image/png', corpo: img, cache: true };
      }
      if (r.metodo === 'GET' && r.caminho.startsWith('/api/grupo/')) {
        const por = r.caminho.slice('/api/grupo/'.length);
        if (!AGRUPAMENTOS[por]) throw new ErroHttp(404, `Agrupamento desconhecido: ${por}`);
        const linhas = agrupar(db, por, filtroDaQuery(q), inteiro(q, 'minJogos', 1));
        if (por === 'fila') for (const l of linhas) l.grupo = nomeDaFila(Number(l.grupo));
        return json(tabela(linhas));
      }
      if (r.metodo === 'GET' && r.caminho.startsWith('/api/exportar/')) {
        const arquivo = r.caminho.slice('/api/exportar/'.length);
        if (!(ARQUIVOS_EXPORTACAO as readonly string[]).includes(arquivo)) throw new ErroHttp(404, 'Arquivo desconhecido.');
        const dados = dadosExportacao(db, filtroDaQuery(q))[arquivo as (typeof ARQUIVOS_EXPORTACAO)[number]];
        const fmt = q.get('formato') === 'padrao' ? CSV_PADRAO : CSV_EXCEL_BR;
        return { status: 200, tipo: 'text/csv; charset=utf-8', corpo: paraCsv(dados, fmt), arquivo };
      }
      throw new ErroHttp(404, 'Rota não encontrada.');
    } catch (e) {
      if (e instanceof ErroHttp) return json({ erro: e.message }, e.status);
      return json({ erro: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  /** Baixa as classes dos campeões (uma vez por versão do jogo); chamado ao abrir o app. */
  const prepararClasses = () => atualizarClasses(db, ddragon).catch(() => 0);

  return { tratar, sync, prepararClasses };
}
