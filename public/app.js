// lol analytics: página única, sem framework. Fala só com a API local (/api/*).

const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const conteudo = $('#conteudo');
let abaAtual = 'visao';
let partidaOuro = null;

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

/** Tabela ordenável. `colunas`: [{chave, rotulo}]. Células numéricas alinhadas à direita. */
function tabela(colunas, linhas, { aoClicar, selecionada, cores = [] } = {}) {
  if (!linhas.length) return vazio('Nenhuma partida com esses filtros.');
  let ordem = null;
  let desc = true;
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
            desc = ordem === c.chave ? !desc : true;
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
    return el('section', { class: 'painel' }, el('h2', {}, 'Partidas'), el('p', { class: 'ajuda' }, 'Clique numa partida para abrir as viradas de ouro.'),
      tabela(colunasDe(r).filter((c) => c.chave !== 'match_id'), r.linhas, {
        cores: ['dif_ouro_10'],
        aoClicar: (l) => {
          partidaOuro = l.match_id;
          mostrar('ouro');
        },
      }));
  },

  async elo() {
    const caixa = el('div', {});
    const desenhar = (r) => caixa.replaceChildren(r.linhas.length ? tabela(r.colunas, r.linhas) : vazio('Sem elo registrado. Sincronize ou clique em Atualizar.'));
    desenhar(await api('/api/elo'));
    const erro = el('p', { class: 'erro' });
    const botao = el('button', {
      class: 'secundario',
      onclick: async () => {
        botao.disabled = true;
        erro.textContent = '';
        try { desenhar(await post('/api/elo', {})); } catch (e) { erro.textContent = e.message; } finally { botao.disabled = false; }
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
};

async function carregarDetalhe(caixa) {
  caixa.replaceChildren('Carregando…');
  try {
    const d = await api('/api/ouro', new URLSearchParams({ match: partidaOuro }));
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
      el('h2', {}, `${p.campeao} x ${p.oponente} · ${p.vitoria ? 'Vitória' : 'Derrota'}`),
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

async function carregarOpcoes() {
  const o = await api('/api/opcoes');
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
function acompanharSync() {
  clearInterval(vigia);
  const passo = async () => {
    const s = await api('/api/sync');
    $('#sLog').textContent = s.log.join('\n') || 'Começando…';
    $('#sLog').scrollTop = $('#sLog').scrollHeight;
    $('#sIniciar').disabled = s.rodando;
    $('#btnSync').textContent = s.rodando ? 'Sincronizando…' : 'Sincronizar partidas';
    if (!s.rodando) {
      clearInterval(vigia);
      await atualizarEstado();
      await carregarOpcoes();
      mostrar(abaAtual);
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
  if (e.sync.rodando) acompanharSync();
  else $('#sLog').textContent = e.sync.log.join('\n');
});

$('#sTudo').addEventListener('change', () => ($('#sMax').disabled = $('#sTudo').checked));

$('#sIniciar').addEventListener('click', async () => {
  try {
    await post('/api/sync', { max: Number($('#sMax').value), tudo: $('#sTudo').checked, fila: $('#sFila').value, desde: $('#sDesde').value });
    acompanharSync();
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
    if (e.sync.rodando) acompanharSync();
    if (!e.config.chaveConfigurada) abrirConfig();
  } catch (e) {
    conteudo.replaceChildren(el('p', { class: 'erro' }, `Não consegui falar com o app: ${e.message}`));
  }
})();
