// lol analytics: página única, sem framework. Fala só com a API local (/api/*).

const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const conteudo = $('#conteudo');
let abaAtual = 'visao';
let partidaOuro = null;
let jogadorAtual = null;
try { jogadorAtual = sessionStorage.getItem('jogador'); } catch { /* sem storage */ }

// ------------------------------------------------------------ utilidades

function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}

function num(v) {
  if (v === null || v === undefined || v === '') return '-';
  return typeof v === 'number' ? fmt.format(v) : String(v);
}
const sinal = (v) => (v > 0 ? `+${fmt.format(v)}` : fmt.format(v));

function filtros(extra = {}) {
  const p = new URLSearchParams();
  const pares = { fila: $('#fFila').value, dias: $('#fDias').value, posicao: $('#fPosicao').value, campeao: $('#fCampeao').value };
  for (const [k, v] of Object.entries(pares)) if (v) p.set(k, v);
  if ($('#fRemakes').checked) p.set('remakes', '1');
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  return p;
}

async function api(caminho, params, opcoes = {}) {
  const url = params ? `${caminho}?${params}` : caminho;
  const r = await fetch(url, opcoes);
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.erro || `Erro ${r.status}`);
  return corpo;
}

const post = (caminho, corpo) =>
  api(caminho, null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });

function vazio(msg) {
  return el('div', { class: 'vazio' }, msg);
}

/**
 * Tabela ordenável. `colunas`: [{chave, rotulo}]. Células numéricas alinhadas à direita.
 * O primeiro clique numa coluna põe o melhor em cima: maior primeiro, ou menor primeiro
 * nas colunas de `menorMelhor` (ex.: erros). `ordenarPor` define a ordem inicial.
 */
function tabela(colunas, linhas, { aoClicar, selecionada, cores = [], menorMelhor = [], ordenarPor = null } = {}) {
  if (!linhas.length) return vazio('Nenhuma partida com esses filtros.');
  let ordem = ordenarPor;
  let desc = ordenarPor ? !menorMelhor.includes(ordenarPor) : true;
  const corpo = el('tbody');
  const ehNum = (c) => linhas.every((l) => l[c] === null || typeof l[c] === 'number');
  const desenhar = () => {
    const lista = [...linhas];
    if (ordem) {
      lista.sort((a, b) => {
        const x = a[ordem];
        const y = b[ordem];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x < y ? -1 : 1) * (desc ? -1 : 1);
      });
    }
    corpo.replaceChildren(
      ...lista.map((l) =>
        el(
          'tr',
          {
            class: [aoClicar ? 'clicavel' : '', selecionada && selecionada(l) ? 'selecionada' : ''].join(' ').trim() || undefined,
            onclick: aoClicar ? () => aoClicar(l) : undefined,
          },
          colunas.map((c) => {
            const v = l[c.chave];
            const classes = [ehNum(c.chave) ? 'num' : ''];
            if (cores.includes(c.chave) && typeof v === 'number') classes.push(v > 0 ? 'pos' : v < 0 ? 'neg' : '');
            return el('td', { class: classes.join(' ').trim() || undefined }, cores.includes(c.chave) && typeof v === 'number' ? sinal(v) : num(v));
          }),
        ),
      ),
    );
  };
  const cab = el(
    'tr',
    {},
    colunas.map((c) =>
      el(
        'th',
        {
          class: ehNum(c.chave) ? 'num' : undefined,
          title: 'Clique para ordenar',
          onclick: () => {
            desc = ordem === c.chave ? !desc : !menorMelhor.includes(c.chave);
            ordem = c.chave;
            desenhar();
          },
        },
        c.rotulo,
      ),
    ),
  );
  desenhar();
  return el('div', { class: 'tabela-caixa' }, el('table', {}, el('thead', {}, cab), corpo));
}

const colunasDe = (resp, chaves) => (chaves ? chaves.map((k) => resp.colunas.find((c) => c.chave === k)).filter(Boolean) : resp.colunas);

// ------------------------------------------------------------ gráficos (Chart.js, embutido no app)

const graficos = [];
const cor = (nome) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
function comAlfa(hex, alfa) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

/** Destrói os gráficos que saíram da tela (troca de aba ou de partida). */
function limparGraficos() {
  for (let i = graficos.length - 1; i >= 0; i--) {
    if (!graficos[i].canvas.isConnected) graficos.splice(i, 1)[0].destroy();
  }
}

function novoGrafico(config, altura, rotulo) {
  const Chart = window.Chart;
  Chart.defaults.color = cor('--texto-2');
  Chart.defaults.borderColor = cor('--borda');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const canvas = el('canvas', { role: 'img', 'aria-label': rotulo });
  const caixa = el('div', { class: 'grafico-caixa', style: `height:${altura}px` }, canvas);
  config.options = { responsive: true, maintainAspectRatio: false, animation: { duration: 450 }, ...config.options };
  graficos.push(new Chart(canvas, config));
  return caixa;
}

const tituloMinuto = (itens) => `${itens[0].dataIndex} min`;

/** Barras da diferença de ouro por minuto. As barras dentro de uma virada ficam com a cor cheia. */
function graficoDiferenca(dif, episodios = []) {
  const virada = (i) => episodios.find((e) => i > e.inicio && i <= e.fim);
  const pos = cor('--pos');
  const neg = cor('--neg');
  const temViradas = episodios.length > 0;
  return novoGrafico(
    {
      type: 'bar',
      data: {
        labels: dif.map((_, i) => `${i}'`),
        datasets: [
          {
            label: 'Diferença de ouro',
            data: dif,
            backgroundColor: dif.map((v, i) => comAlfa(v >= 0 ? pos : neg, !temViradas || virada(i) ? 0.95 : 0.4)),
            borderRadius: 3,
            borderSkipped: false,
          },
        ],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: tituloMinuto,
              label: (it) => {
                const ep = virada(it.dataIndex);
                return [`Diferença: ${sinal(it.parsed.y)} de ouro`, ...(ep?.causa ? [`Virada: ${ep.causa}`] : [])];
              },
            },
          },
        },
        scales: {
          y: { ticks: { callback: (v) => sinal(v) }, grid: { color: (c) => (c.tick.value === 0 ? cor('--texto-2') : cor('--borda')) } },
          x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
        },
      },
    },
    230,
    'Diferença de ouro por minuto',
  );
}

/** Linhas por minuto. `series`: [{nome, valores, cor: '--variavel-css'}]. */
function graficoLinhas(series, unidade = 'de ouro') {
  const n = Math.max(...series.map((s) => s.valores.length), 1);
  return novoGrafico(
    {
      type: 'line',
      data: {
        labels: Array.from({ length: n }, (_, i) => `${i}'`),
        datasets: series.map((s) => {
          const c = cor(s.cor);
          return { label: s.nome, data: s.valores, borderColor: c, backgroundColor: c, tension: 0.25, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2.5 };
        }),
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'rectRounded' } },
          tooltip: { callbacks: { title: tituloMinuto, label: (it) => `${it.dataset.label}: ${fmt.format(it.parsed.y)} ${unidade}` } },
        },
        scales: { y: { ticks: { callback: (v) => fmt.format(v) } }, x: { grid: { display: false }, ticks: { maxRotation: 0 } } },
      },
    },
    300,
    'Ouro por minuto',
  );
}

/** Barras agrupadas por faixa (ex.: kills x mortes por faixa de tempo). */
function graficoBarras(rotulos, series) {
  return novoGrafico(
    {
      type: 'bar',
      data: {
        labels: rotulos,
        datasets: series.map((s) => ({ label: s.nome, data: s.valores, backgroundColor: cor(s.cor), borderRadius: 4 })),
      },
      options: {
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'rectRounded' } },
          tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${fmt.format(it.parsed.y)} por partida` } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => fmt.format(v) } }, x: { grid: { display: false } } },
      },
    },
    260,
    'Abates por faixa de tempo',
  );
}

// ------------------------------------------------------------ abas

const COLS_GRUPO = ['grupo', 'jogos', 'vitoria_pct', 'kda', 'kills_min', 'deaths_min', 'ouro_min', 'cs_min', 'dano_min', 'kp_pct', 'cs_10', 'dif_ouro_10', 'dif_ouro_15', 'duracao_min'];

const ABAS = {
  async visao() {
    const [r, camp, causas] = await Promise.all([api('/api/resumo', filtros()), api('/api/grupo/campeao', filtros()), api('/api/causas', filtros())]);
    if (!r.jogos) return vazio('Nenhuma partida ainda. Clique em "Sincronizar partidas" lá em cima.');
    const kpi = (rotulo, valor, cor) => el('div', { class: 'kpi' }, el('div', { class: 'rotulo' }, rotulo), el('div', { class: `valor ${cor || ''}` }, valor));
    const difCor = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const perdas = causas.perdas.slice(0, 4);
    return el(
      'div',
      {},
      el(
        'div',
        { class: 'kpis' },
        kpi('Jogos', num(r.jogos)),
        kpi('Vitórias', `${num(r.vitoria_pct)}%`),
        kpi('KDA', num(r.kda)),
        kpi('Ouro/min', num(r.ouro_min)),
        kpi('CS/min', num(r.cs_min)),
        kpi('Kills/min', num(r.kills_min)),
        kpi('ΔOuro aos 10', r.dif_ouro_10 === null ? '-' : sinal(r.dif_ouro_10), difCor(r.dif_ouro_10)),
        kpi('ΔOuro aos 15', r.dif_ouro_15 === null ? '-' : sinal(r.dif_ouro_15), difCor(r.dif_ouro_15)),
      ),
      el(
        'div',
        { class: 'grade' },
        el('section', { class: 'painel' }, el('h2', {}, 'Por campeão'), tabela(colunasDe(camp, ['grupo', 'jogos', 'vitoria_pct', 'kda', 'ouro_min', 'dif_ouro_10']).map((c) => (c.chave === 'grupo' ? { ...c, rotulo: 'Campeão' } : c)), camp.linhas, {
          cores: ['dif_ouro_10'],
          aoClicar: (l) => {
            $('#fCampeao').value = l.grupo;
            mostrar('visao');
          },
        })),
        el(
          'section',
          { class: 'painel' },
          el('h2', {}, 'Onde você mais perde ouro para o oponente'),
          perdas.length
            ? tabela(
                [{ chave: 'causa', rotulo: 'Causa' }, { chave: 'viradas', rotulo: 'Viradas' }, { chave: 'ouro', rotulo: 'Ouro' }, { chave: 'pct_do_ouro', rotulo: '% do ouro' }],
                perdas,
              )
            : vazio('Nenhuma virada de ouro contra você.'),
          causas.ganks ? el('p', { class: 'ajuda' }, `${causas.ganksSemSentinela} de ${causas.ganks} ganks pegaram você sem sentinela nos 3 minutos antes.`) : null,
          el('button', { class: 'link', onclick: () => mostrar('causas') }, 'Ver todas as causas'),
        ),
      ),
    );
  },

  async desempenho() {
    const porRota = el('input', { type: 'checkbox' });
    const minJogos = el('input', { type: 'number', min: 1, value: 1 });
    try {
      porRota.checked = sessionStorage.getItem('porRota') === '1';
      minJogos.value = sessionStorage.getItem('minJogosDesempenho') || 1;
    } catch { /* sem storage */ }
    const caixa = el('div', {}, vazio('Carregando…'));
    const ROTA = { TOP: 'Top', JUNGLE: 'Selva', MIDDLE: 'Mid', BOTTOM: 'Atirador', UTILITY: 'Suporte' };
    const carregar = async () => {
      try { sessionStorage.setItem('porRota', porRota.checked ? '1' : '0'); sessionStorage.setItem('minJogosDesempenho', minJogos.value); } catch { /* sem storage */ }
      const r = await api('/api/desempenho', filtros({ porRota: porRota.checked ? '1' : '', minJogos: minJogos.value }));
      const linhas = r.linhas.map((l) => ({ ...l, posicao: l.posicao ? ROTA[l.posicao] || l.posicao : null }));
      const chaves = ['campeao', ...(porRota.checked ? ['posicao'] : []), 'jogos', 'vitoria_pct', 'stomp_pct', 'stomp_derrota', 'acertos_pct', 'kp_pct', 'objetivos_pct', 'visao_pct', 'erros_jogo', 'kda'];
      const colunas = chaves.map((k) => ({ chave: k, rotulo: k === 'campeao' ? 'Campeão' : k === 'posicao' ? 'Rota' : (r.colunas.find((c) => c.chave === k) || { rotulo: k }).rotulo }));
      const melhores = r.melhores.map((m) => ({ ...m, posicao: ROTA[m.posicao] || m.posicao }));
      caixa.replaceChildren(
        el('section', { class: 'painel' },
          el('h2', {}, 'Seu melhor campeão em cada rota'),
          melhores.length
            ? tabela(
                [{ chave: 'posicao', rotulo: 'Rota' }, { chave: 'vitoria', rotulo: 'Mais vitórias' }, { chave: 'stomp', rotulo: 'Mais stomps' }, { chave: 'acertos', rotulo: 'Mais acertos' }, { chave: 'menos_erros', rotulo: 'Menos erros' }],
                melhores,
              )
            : vazio('Sem partidas com rota definida nesses filtros (ARAM e Arena não têm rota).')),
        el('section', { class: 'painel' },
          el('h2', {}, porRota.checked ? 'Por campeão e rota' : 'Por campeão'),
          el('p', { class: 'ajuda' }, 'Clique no título de uma coluna para ordenar: o melhor fica em cima (em Erros/jogo e Stomp e derrota, o menor).'),
          tabela(colunas, linhas, { menorMelhor: ['erros_jogo', 'stomp_derrota'], ordenarPor: 'vitoria_pct' })),
      );
    };
    porRota.addEventListener('change', () => carregar().catch((e) => caixa.replaceChildren(el('p', { class: 'erro' }, e.message))));
    minJogos.addEventListener('change', () => carregar().catch((e) => caixa.replaceChildren(el('p', { class: 'erro' }, e.message))));
    await carregar();
    const legenda = el('section', { class: 'painel' },
      el('h3', {}, 'Como cada número é calculado'),
      el('ul', { class: 'ajuda' },
        el('li', {}, '% Vit: partidas ganhas sobre partidas jogadas.'),
        el('li', {}, '% Stomp: partidas em que você chegou aos 15 minutos com 1.000 de ouro ou mais sobre o oponente de rota, ganhando ou perdendo o jogo. "Stomp e derrota" conta as que terminaram em derrota mesmo assim.'),
        el('li', {}, '% Acertos (macro): média de três participações. Abates do time (% Part.), objetivos do time (dragões, arautos, vastilarvas, barão e torres) e visão comparada ao oponente de rota (50% = igual a ele).'),
        el('li', {}, 'Erros/jogo: viradas de ouro contra você em que você morreu (gank, 1x1 ou luta), pela análise das viradas. Menor é melhor.'),
        el('li', {}, 'Stomp, objetivos, visão e erros só contam partidas com timeline e oponente de rota.'),
      ));
    return el('div', {},
      el('section', { class: 'painel' },
        el('div', { class: 'linha-form' }, el('label', { class: 'check' }, porRota, ' Separar por rota'), el('label', {}, 'Mínimo de jogos', minJogos)),
        el('p', { class: 'ajuda' }, 'Os filtros lá de cima (fila, período, posição e campeão) também valem aqui.')),
      caixa, legenda);
  },

  async ouro() {
    const lista = await api('/api/viradas', filtros({ n: 40 }));
    if (!lista.length) return vazio('Nenhuma partida com timeline e oponente de rota. ARAM e Arena não têm oponente de rota.');
    if (!partidaOuro || !lista.some((p) => p.matchId === partidaOuro)) partidaOuro = lista[0].matchId;
    const detalhe = el('section', { class: 'painel' }, 'Carregando…');
    const linhas = lista.map((p) => ({
      matchId: p.matchId,
      data: p.data.slice(0, 16),
      partida: `${p.campeao} x ${p.oponente}`,
      r: p.vitoria ? 'V' : 'D',
      perda: p.maiorPerda ? p.maiorPerda.variacao : null,
      ganho: p.maiorGanho ? p.maiorGanho.variacao : null,
    }));
    const caixaLista = el('section', { class: 'painel' });
    const desenharLista = () =>
      caixaLista.replaceChildren(
        el('h2', {}, 'Partidas'),
        el('p', { class: 'ajuda' }, 'Clique numa partida para ver o que aconteceu.'),
        tabela(
          [{ chave: 'data', rotulo: 'Data' }, { chave: 'partida', rotulo: 'Partida' }, { chave: 'r', rotulo: 'R' }, { chave: 'perda', rotulo: 'Maior perda' }, { chave: 'ganho', rotulo: 'Maior ganho' }],
          linhas,
          {
            cores: ['perda', 'ganho'],
            selecionada: (l) => l.matchId === partidaOuro,
            aoClicar: (l) => {
              partidaOuro = l.matchId;
              desenharLista();
              carregarDetalhe(detalhe);
            },
          },
        ),
      );
    desenharLista();
    carregarDetalhe(detalhe);
    return el('div', { class: 'dividido' }, caixaLista, detalhe);
  },

  async causas() {
    const r = await api('/api/causas', filtros());
    if (!r.partidas) return vazio('Nenhuma partida com timeline e oponente de rota com esses filtros.');
    const cols = [
      { chave: 'causa', rotulo: 'Causa' },
      { chave: 'viradas', rotulo: 'Viradas' },
      { chave: 'jogos', rotulo: 'Jogos' },
      { chave: 'ouro', rotulo: 'Ouro' },
      { chave: 'ouro_por_virada', rotulo: 'Ouro por virada' },
      { chave: 'pct_do_ouro', rotulo: '% do ouro' },
    ];
    return el(
      'div',
      {},
      el('p', { class: 'ajuda' }, `${r.partidas} partida(s) analisada(s). Uma virada é uma mudança de pelo menos 500 de ouro em até 2 minutos contra o oponente de rota.`),
      el('div', { class: 'grade' },
        el('section', { class: 'painel' }, el('h2', {}, 'Onde você perde ouro'), r.perdas.length ? tabela(cols, r.perdas) : vazio('Nenhuma.')),
        el('section', { class: 'painel' }, el('h2', {}, 'Onde você ganha ouro'), r.ganhos.length ? tabela(cols, r.ganhos) : vazio('Nenhuma.')),
      ),
      r.ganks
        ? el('section', { class: 'painel' }, el('h2', {}, 'Visão'), el('p', {}, `Ganks sofridos: ${r.ganks}. Em ${r.ganksSemSentinela} deles (${Math.round((r.ganksSemSentinela / r.ganks) * 100)}%) você não tinha colocado sentinela nos 3 minutos antes.`))
        : null,
    );
  },

  async grupos() {
    const sel = el('select', {}, [
      ['campeao', 'Campeão'], ['posicao', 'Posição'], ['oponente', 'Oponente de rota'], ['fila', 'Fila'], ['mes', 'Mês'], ['semana', 'Semana'], ['duracao', 'Duração da partida'],
    ].map(([v, t]) => el('option', { value: v }, t)));
    sel.value = sessionStorage.getItem('grupo') || 'campeao';
    const minJogos = el('input', { type: 'number', min: 1, value: sessionStorage.getItem('minJogos') || 1 });
    const caixa = el('div', {});
    const carregar = async () => {
      try { sessionStorage.setItem('grupo', sel.value); sessionStorage.setItem('minJogos', minJogos.value); } catch { /* sem storage */ }
      const r = await api(`/api/grupo/${sel.value}`, filtros({ minJogos: minJogos.value }));
      const rotulo = sel.options[sel.selectedIndex].text;
      caixa.replaceChildren(tabela(colunasDe(r, COLS_GRUPO).map((c) => (c.chave === 'grupo' ? { ...c, rotulo } : c)), r.linhas, { cores: ['dif_ouro_10', 'dif_ouro_15'] }));
    };
    sel.addEventListener('change', carregar);
    minJogos.addEventListener('change', carregar);
    await carregar();
    return el('section', { class: 'painel' }, el('div', { class: 'filtros', style: 'padding:0 0 12px;border:0;background:none' }, el('label', {}, 'Agrupar por', sel), el('label', {}, 'Mínimo de jogos', minJogos)), caixa);
  },

  async curva() {
    const r = await api('/api/curva', filtros({ ate: 35 }));
    if (!r.linhas.length) return vazio('Sem timeline para esses filtros.');
    return el(
      'div',
      {},
      el('section', { class: 'painel' }, el('h2', {}, 'Ouro médio por minuto: você x oponente de rota'),
        graficoLinhas([
          { nome: 'Você', valores: r.linhas.map((l) => l.meu_ouro), cor: '--destaque' },
          { nome: 'Oponente de rota', valores: r.linhas.map((l) => l.ouro_oponente), cor: '--azul' },
        ])),
      el('section', { class: 'painel' }, el('h2', {}, 'Diferença média'), graficoDiferenca(r.linhas.map((l) => l.diferenca ?? 0))),
      el('section', { class: 'painel' }, tabela(r.colunas, r.linhas, { cores: ['diferenca'] })),
    );
  },

  async abates() {
    const r = await api('/api/abates', filtros());
    if (!r.linhas.length) return vazio('Sem timeline para esses filtros.');
    return el(
      'section',
      { class: 'painel' },
      el('h2', {}, 'Kills, mortes e assistências por faixa de tempo'),
      el('p', { class: 'ajuda' }, 'Média por partida, a partir da timeline.'),
      graficoBarras(r.linhas.map((l) => l.faixa), [
        { nome: 'Kills', valores: r.linhas.map((l) => l.kills_por_jogo), cor: '--pos' },
        { nome: 'Mortes', valores: r.linhas.map((l) => l.mortes_por_jogo), cor: '--neg' },
        { nome: 'Assistências', valores: r.linhas.map((l) => l.assist_por_jogo), cor: '--azul' },
      ]),
      tabela(r.colunas, r.linhas),
    );
  },

  async partidas() {
    const r = await api('/api/recentes', filtros({ n: 100 }));
    return el('section', { class: 'painel' }, el('h2', {}, 'Partidas'), el('p', { class: 'ajuda' }, 'Clique numa partida para ver o placar completo.'),
      tabela(colunasDe(r).filter((c) => c.chave !== 'match_id'), r.linhas, {
        cores: ['dif_ouro_10'],
        aoClicar: (l) => abrirPlacar(l.match_id),
      }));
  },

  async jogadores() {
    const [lista, estado] = await Promise.all([api('/api/jogadores'), api('/api/sync')]);
    const riotId = el('input', { type: 'text', placeholder: 'Nome#TAG', autocomplete: 'off', value: riotIdPendente || '' });
    riotIdPendente = null;
    const qtd = el('select', {}, ...[10, 20, 40].map((n) => el('option', { value: n, selected: n === 20 }, `${n} partidas`)));
    const erro = el('p', { class: 'erro' });
    const log = el('pre', { id: 'jLog', class: 'log', hidden: !(estado.rodando && estado.tipo === 'consulta') }, estado.log.join('\n'));
    const botao = el('button', { class: 'primario', type: 'button' }, 'Consultar');
    const consultar = async (corpo) => {
      erro.textContent = '';
      try {
        await post('/api/jogadores/consultar', corpo);
        log.hidden = false;
        acompanharTarefa();
      } catch (e) {
        erro.textContent = e.message;
      }
    };
    botao.addEventListener('click', () => consultar({ riotId: riotId.value, n: Number(qtd.value) }));
    riotId.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), botao.click()));

    const busca = el('section', { class: 'painel' },
      el('h2', {}, 'Consultar jogador'),
      el('p', { class: 'ajuda' }, 'Baixa as partidas recentes de qualquer jogador pelo Riot ID. Cada partida custa 2 requisições à Riot. A consulta é eventual: ao consultar outra pessoa, a anterior é descartada, a menos que você a registre em memória.'),
      el('div', { class: 'linha-form' }, el('label', {}, 'Riot ID', riotId), el('label', {}, 'Quantas', qtd), botao),
      erro, log);

    const salvos = lista.filter((j) => j.registrado);
    const memoria = el('section', { class: 'painel' }, el('h2', {}, 'Jogadores em memória'),
      salvos.length
        ? tabela([{ chave: 'riotId', rotulo: 'Jogador' }, { chave: 'partidas', rotulo: 'Partidas' }, { chave: 'consultadoEm', rotulo: 'Atualizado em' }], salvos, {
            selecionada: (j) => j.puuid === jogadorAtual,
            aoClicar: (j) => abrirJogador(j.puuid),
          })
        : vazio('Nenhum jogador registrado. Consulte alguém e clique em "Registrar em memória".'));

    const partes = [el('div', { class: 'grade' }, busca, memoria)];
    if (jogadorAtual && lista.some((j) => j.puuid === jogadorAtual)) partes.push(await painelJogador(jogadorAtual, consultar));
    return el('div', {}, ...partes);
  },
};

let riotIdPendente = null;

function abrirJogador(puuid) {
  jogadorAtual = puuid;
  try { sessionStorage.setItem('jogador', puuid); } catch { /* sem storage */ }
  mostrar('jogadores');
}

/** Ficha do jogador consultado: elo, números gerais, campeões e partidas recentes. */
async function painelJogador(puuid, consultar) {
  const f = (extra = {}) => filtros({ puuid, ...extra });
  const [j, r, camp, rec] = await Promise.all([
    api('/api/jogador', new URLSearchParams({ puuid })),
    api('/api/resumo', f()),
    api('/api/grupo/campeao', f()),
    api('/api/recentes', f({ n: 40 })),
  ]);
  const botaoMemoria = el('button', {
    class: j.registrado ? 'secundario' : 'primario',
    type: 'button',
    onclick: async () => {
      botaoMemoria.disabled = true;
      try {
        await post('/api/jogadores/registrar', { puuid, registrar: !j.registrado });
        mostrar('jogadores');
      } catch (e) {
        botaoMemoria.disabled = false;
        alert(e.message);
      }
    },
  }, j.registrado ? 'Remover da memória' : 'Registrar em memória');
  const atualizar = el('button', { class: 'secundario', type: 'button', onclick: () => consultar({ puuid, n: 20 }) }, 'Atualizar partidas');
  const kpi = (rotulo, valor) => el('div', { class: 'kpi' }, el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor' }, valor));
  return el('section', { class: 'painel' },
    el('div', { class: 'cab-dialogo' },
      el('div', {}, el('h2', {}, j.riotId), el('p', { class: 'ajuda' }, j.registrado ? 'Registrado em memória: atualizado a cada sincronização.' : 'Consulta eventual: será descartada na próxima consulta.')),
      el('div', { class: 'acoes' }, atualizar, botaoMemoria)),
    el('div', { class: 'ficha' }, j.elo.length ? j.elo.map((e) => el('span', { class: 'etiqueta' }, `${e.fila === 'RANKED_SOLO_5x5' ? 'Solo/Duo' : e.fila === 'RANKED_FLEX_SR' ? 'Flex' : e.fila}: ${e.elo} ${e.pdl} PDL · ${num(e.vitoria_pct)}% em ${e.vitorias + e.derrotas} jogos`)) : el('span', { class: 'etiqueta' }, 'Sem ranqueada')),
    r.jogos
      ? el('div', { class: 'kpis' }, kpi('Jogos', num(r.jogos)), kpi('Vitórias', `${num(r.vitoria_pct)}%`), kpi('KDA', num(r.kda)), kpi('Ouro/min', num(r.ouro_min)), kpi('CS/min', num(r.cs_min)), kpi('Dano/min', num(r.dano_min)))
      : vazio('Nenhuma partida com esses filtros.'),
    el('div', { class: 'grade' },
      el('div', {}, el('h3', {}, 'Campeões'), tabela(colunasDe(camp, ['grupo', 'jogos', 'vitoria_pct', 'kda', 'ouro_min', 'cs_min']).map((c) => (c.chave === 'grupo' ? { ...c, rotulo: 'Campeão' } : c)), camp.linhas)),
      el('div', {}, el('h3', {}, 'Partidas recentes'), tabela(colunasDe(rec, ['data', 'campeao', 'oponente', 'resultado', 'kda_linha', 'ouro_min']), rec.linhas, { aoClicar: (l) => abrirPlacar(l.match_id, puuid) }))),
  );
}

// ------------------------------------------------------------ placar

let nomesItens = null;

function icone(tipo, nome, classe, titulo) {
  const img = el('img', { class: classe, src: `/api/ddragon/${tipo}/${encodeURIComponent(nome)}`, alt: titulo || '', title: titulo || '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(el('span', { class: classe, title: titulo || '' })));
  return img;
}

async function abrirPlacar(matchId, puuid) {
  const dlg = $('#dlgPartida');
  const caixa = $('#pConteudo');
  $('#pTitulo').textContent = 'Carregando…';
  $('#pSub').textContent = '';
  caixa.replaceChildren();
  if (!dlg.open) dlg.showModal();
  try {
    const params = new URLSearchParams({ match: matchId });
    if (puuid) params.set('puuid', puuid);
    if (!nomesItens) nomesItens = await api('/api/ddragon/itens').catch(() => ({}));
    const p = await api('/api/partida', params);
    $('#pTitulo').textContent = `${p.fila} · ${p.duracao}${p.remake ? ' · remake' : ''}`;
    $('#pSub').textContent = `${p.data} · versão ${p.versao} · ${p.matchId}`;
    const maxDano = Math.max(...p.times.flatMap((t) => t.jogadores.map((j) => j.dano)), 1);
    const linha = (j) =>
      el('tr', { class: j.eu ? 'eu' : j.foco ? 'foco' : undefined },
        el('td', {}, el('div', { class: 'campeao' }, icone('campeao', j.campeao, 'icone', j.campeao), el('div', {}, el('div', {}, j.campeao), el('div', { class: 'nivel' }, `Nível ${j.nivel}`)))),
        el('td', {}, j.eu ? el('strong', {}, j.riotId) : el('button', { class: 'link', type: 'button', title: 'Consultar este jogador', onclick: () => { dlg.close(); riotIdPendente = j.riotId; mostrar('jogadores'); } }, j.riotId)),
        el('td', { class: 'num' }, `${j.kills}/${j.deaths}/${j.assists}`, el('div', { class: 'nivel' }, `KDA ${num(j.kda)}`)),
        el('td', { class: 'num' }, num(j.cs), el('div', { class: 'nivel' }, `${num(j.csMin)}/min`)),
        el('td', { class: 'num' }, num(j.ouro)),
        el('td', { class: 'num' }, num(j.dano), el('div', { class: 'barra' }, el('span', { style: `width:${Math.round((j.dano / maxDano) * 100)}%` }))),
        el('td', { class: 'num' }, num(j.visao)),
        el('td', {}, el('div', { class: 'itens' }, j.itens.map((id, i) => {
          const classe = i === 6 ? 'item amuleto' : 'item';
          return id ? icone('item', String(id), classe, nomesItens[id] || `Item ${id}`) : el('span', { class: classe });
        }))),
      );
    const cab = el('tr', {}, ['Campeão', 'Jogador', 'K/D/A', 'CS', 'Ouro', 'Dano', 'Visão', 'Itens'].map((t, i) => el('th', { class: i >= 2 && i <= 6 ? 'num' : undefined }, t)));
    const times = p.times.map((t) =>
      el('section', { class: `placar-time ${t.timeId === 100 ? 'azul' : 'vermelho'}` },
        el('div', { class: 'titulo' }, el('strong', {}, `${t.lado} · ${t.vitoria ? 'Vitória' : 'Derrota'}`), el('span', { class: 'ajuda' }, `${t.kills} abates · ${num(t.ouro)} de ouro`)),
        el('div', { class: 'tabela-caixa' }, el('table', { class: 'placar' }, el('thead', {}, cab.cloneNode(true)), el('tbody', {}, t.jogadores.map(linha))))),
    );
    const focoOuEu = p.times.flatMap((t) => t.jogadores).find((j) => j.foco || j.eu);
    const extras = [];
    if (p.temTimeline && focoOuEu && focoOuEu.posicao) {
      const caixaOuro = el('div', {});
      const botao = el('button', { class: 'secundario', type: 'button', onclick: () => { botao.remove(); carregarDetalhe(caixaOuro, p.matchId, focoOuEu.eu ? undefined : focoOuEu.puuid, false); } }, `Ver viradas de ouro de ${focoOuEu.eu ? 'você' : focoOuEu.riotId}`);
      extras.push(el('div', { style: 'margin-top:16px' }, botao, caixaOuro));
    }
    caixa.replaceChildren(...times, ...extras);
  } catch (e) {
    $('#pTitulo').textContent = 'Partida';
    caixa.replaceChildren(el('p', { class: 'erro' }, e.message));
  }
}

// Abas de elo e exportação (definidas aqui, depois das funções do placar e dos jogadores).
Object.assign(ABAS, {
  async elo() {
    const caixa = el('div', {});
    const desenhar = (r) => caixa.replaceChildren(r.linhas.length ? tabela(r.colunas, r.linhas) : vazio('Sem elo registrado. Sincronize ou clique em Atualizar.'));
    const fila = $('#fFila').value;
    const qFila = fila ? new URLSearchParams({ fila }) : null;
    desenhar(await api('/api/elo', qFila));
    const erro = el('p', { class: 'erro' });
    const botao = el('button', {
      class: 'secundario',
      onclick: async () => {
        botao.disabled = true;
        erro.textContent = '';
        try { desenhar(await post(qFila ? `/api/elo?${qFila}` : '/api/elo', {})); } catch (e) { erro.textContent = e.message; } finally { botao.disabled = false; }
      },
    }, 'Atualizar elo agora');
    return el('section', { class: 'painel' }, el('h2', {}, 'Elo atual'), caixa, erro, botao);
  },

  async exportar() {
    const formato = el('select', {}, el('option', { value: '' }, 'Excel em português (; e vírgula decimal)'), el('option', { value: 'padrao' }, 'Padrão (, e ponto decimal)'));
    const links = el('div', { class: 'botoes', style: 'justify-content:flex-start' });
    const desenhar = () =>
      links.replaceChildren(
        ...[['partidas.csv', 'Partidas'], ['curva_ouro.csv', 'Curva de ouro'], ['abates.csv', 'Abates e mortes']].map(([arq, nome]) =>
          el('a', { href: `/api/exportar/${arq}?${filtros({ formato: formato.value })}`, download: arq }, el('button', { class: 'secundario', type: 'button' }, `Baixar ${nome}`)),
        ),
      );
    formato.addEventListener('change', desenhar);
    desenhar();
    return el('section', { class: 'painel' }, el('h2', {}, 'Exportar para CSV'), el('p', { class: 'ajuda' }, 'Usa os filtros lá de cima.'), el('label', {}, 'Formato', formato), links);
  },
});

async function carregarDetalhe(caixa, matchId = partidaOuro, puuid = undefined, comBotaoPlacar = true) {
  caixa.replaceChildren('Carregando…');
  try {
    const params = new URLSearchParams({ match: matchId });
    if (puuid) params.set('puuid', puuid);
    const d = await api('/api/ouro', params);
    const p = d.partida;
    const eps = d.episodios.map((e) =>
      el(
        'article',
        { class: `episodio ${e.variacao > 0 ? 'ganho' : ''}` },
        el('div', { class: 'cab' }, el('span', {}, `${e.inicio}:00 a ${e.fim}:00 · ${e.variacao < 0 ? 'perdeu' : 'ganhou'} ${fmt.format(Math.abs(e.variacao))} de ouro`), el('span', { class: 'etiqueta' }, e.causa)),
        el('ul', {}, e.leitura.map((l) => el('li', {}, l))),
        e.dicas.map((t) => el('div', { class: 'dica' }, t)),
      ),
    );
    caixa.replaceChildren(
      el('div', { class: 'cab-dialogo' },
        el('h2', {}, `${p.campeao} x ${p.oponente} · ${p.vitoria ? 'Vitória' : 'Derrota'}`),
        comBotaoPlacar ? el('button', { class: 'secundario', type: 'button', onclick: () => abrirPlacar(p.matchId, puuid) }, 'Ver placar') : null),
      el('p', { class: 'ajuda' }, `${p.data} · ${p.matchId}`),
      el('h3', {}, `Diferença de ouro por minuto (você − ${p.oponente})`),
      graficoDiferenca(d.diferenca, d.episodios),
      ...(eps.length ? eps : [vazio('Nenhuma virada de 500 de ouro em até 2 minutos nesta partida.')]),
    );
    limparGraficos();
  } catch (e) {
    caixa.replaceChildren(el('p', { class: 'erro' }, e.message));
  }
}

async function mostrar(aba) {
  abaAtual = aba;
  for (const b of document.querySelectorAll('.abas button')) b.classList.toggle('ativa', b.dataset.aba === aba);
  conteudo.replaceChildren(vazio('Carregando…'));
  try {
    // Na aba Jogadores, o filtro de campeão lista os campeões do jogador consultado.
    const dono = aba === 'jogadores' && jogadorAtual ? jogadorAtual : null;
    if (dono !== opcoesDe) {
      opcoesDe = dono;
      await carregarOpcoes();
    }
    conteudo.replaceChildren(await ABAS[aba]());
    limparGraficos();
  } catch (e) {
    conteudo.replaceChildren(el('p', { class: 'erro' }, e.message));
  }
}

// ------------------------------------------------------------ estado, sync e configuração

async function atualizarEstado() {
  const e = await api('/api/estado');
  const b = e.banco;
  const partes = [];
  partes.push(b.contas.length ? b.contas.join(', ') : 'Nenhuma conta sincronizada');
  partes.push(`${fmt.format(b.partidas)} partida(s)`);
  if (b.ultimaPartida) partes.push(`última em ${new Date(b.ultimaPartida).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`);
  if (!e.config.chaveConfigurada) partes.push('chave da Riot não configurada');
  $('#status').textContent = partes.join(' · ');
  return e;
}

/** De quem são os campeões do filtro: null = as suas contas; puuid = jogador consultado. */
let opcoesDe = null;

async function carregarOpcoes() {
  const o = await api('/api/opcoes', opcoesDe ? new URLSearchParams({ puuid: opcoesDe }) : null);
  const preencher = (sel, itens, primeiro) => {
    const atual = sel.value;
    sel.replaceChildren(el('option', { value: '' }, primeiro), ...itens.map(([v, t]) => el('option', { value: v }, t)));
    if (itens.some(([v]) => v === atual)) sel.value = atual;
  };
  preencher($('#fFila'), o.filas.map((f) => [f.apelido, f.nome]), 'Todas');
  preencher($('#sFila'), o.filas.map((f) => [f.apelido, f.nome]), 'Todas');
  preencher($('#fCampeao'), o.campeoes.map((c) => [c, c]), 'Todos');
}

let vigia = null;
/** Acompanha a tarefa em segundo plano (sincronização ou consulta de jogador) até terminar. */
function acompanharTarefa() {
  clearInterval(vigia);
  let terminou = false;
  const passo = async () => {
    if (terminou) return;
    const s = await api('/api/sync');
    const texto = s.log.join('\n') || 'Começando…';
    const logs = s.tipo === 'consulta' ? [$('#jLog')] : [$('#sLog')];
    for (const l of logs) {
      if (!l) continue;
      l.hidden = false;
      l.textContent = texto;
      l.scrollTop = l.scrollHeight;
    }
    $('#sIniciar').disabled = s.rodando;
    $('#btnSync').textContent = s.rodando && s.tipo === 'sync' ? 'Sincronizando…' : 'Sincronizar partidas';
    if (!s.rodando && !terminou) {
      terminou = true;
      clearInterval(vigia);
      if (s.tipo === 'consulta' && s.resultado && !s.erro) {
        jogadorAtual = s.resultado.puuid;
        try { sessionStorage.setItem('jogador', jogadorAtual); } catch { /* sem storage */ }
      }
      await atualizarEstado();
      await carregarOpcoes();
      if (!(s.tipo === 'consulta' && s.erro)) await mostrar(abaAtual);
      if (s.tipo === 'consulta' && s.erro && $('#jLog')) $('#jLog').textContent = texto;
    }
  };
  vigia = setInterval(() => passo().catch(() => {}), 1000);
  passo().catch(() => {});
}

async function abrirConfig() {
  const e = await api('/api/estado');
  $('#cRiotId').value = e.config.riotId;
  $('#cServidor').replaceChildren(...e.config.servidores.map((s) => el('option', { value: s.id }, `${s.nome} (${s.id})`)));
  $('#cServidor').value = e.config.servidor;
  $('#cChave').value = '';
  $('#cChaveAtual').textContent = e.config.chaveConfigurada ? `(atual termina em …${e.config.finalDaChave})` : '(nenhuma configurada)';
  $('#cErro').textContent = '';
  $('#dlgConfig').showModal();
}

$('#cSalvar').addEventListener('click', async () => {
  $('#cErro').textContent = '';
  try {
    await post('/api/config', { riotId: $('#cRiotId').value, servidor: $('#cServidor').value, apiKey: $('#cChave').value });
    $('#cChave').value = '';
    $('#dlgConfig').close();
    await atualizarEstado();
  } catch (e) {
    $('#cErro').textContent = e.message;
  }
});

$('#btnConfig').addEventListener('click', abrirConfig);

$('#btnSync').addEventListener('click', async () => {
  const e = await api('/api/estado');
  if (!e.config.chaveConfigurada || !e.config.riotId) return abrirConfig();
  $('#dlgSync').showModal();
  if (e.sync.rodando) acompanharTarefa();
  else $('#sLog').textContent = e.sync.log.join('\n');
});

$('#sTudo').addEventListener('change', () => ($('#sMax').disabled = $('#sTudo').checked));

$('#sIniciar').addEventListener('click', async () => {
  try {
    await post('/api/sync', { max: Number($('#sMax').value), tudo: $('#sTudo').checked, fila: $('#sFila').value, desde: $('#sDesde').value });
    acompanharTarefa();
  } catch (e) {
    $('#sLog').textContent = `Erro: ${e.message}`;
  }
});

for (const b of document.querySelectorAll('.abas button')) b.addEventListener('click', () => mostrar(b.dataset.aba));
for (const id of ['#fFila', '#fDias', '#fPosicao', '#fCampeao', '#fRemakes']) $(id).addEventListener('change', () => mostrar(abaAtual));

(async () => {
  try {
    const e = await atualizarEstado();
    await carregarOpcoes();
    await mostrar('visao');
    if (e.sync.rodando) acompanharTarefa();
    if (!e.config.chaveConfigurada) abrirConfig();
  } catch (e) {
    conteudo.replaceChildren(el('p', { class: 'erro' }, `Não consegui falar com o app: ${e.message}`));
  }
})();
