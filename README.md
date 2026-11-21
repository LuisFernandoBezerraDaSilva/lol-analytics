# lol analytics

Baixa o seu histórico de partidas do League of Legends pela **API oficial da Riot** e guarda tudo
num banco SQLite local. Daí saem relatórios por campeão, posição, oponente, mês e duração, além da
curva de ouro minuto a minuto e de kills por faixa de tempo. Também exporta CSV para o Excel.

O diferencial é a **análise das viradas de ouro**: o sistema acha os trechos em que o oponente de
rota abriu vantagem sobre você (ou você sobre ele), explica de onde veio o ouro de cada um e sugere
o que dava para fazer. Por exemplo: "9:00 a 10:00, você perdeu 950 de ouro. Você morreu para Zed
com ajuda do caçador inimigo e não tinha colocado sentinela nos 3 minutos antes."

É uma ferramenta pessoal de análise **pós-jogo**: não faz nada durante a partida.

## O app (.exe)

O jeito mais simples de usar é o `lol-analytics.exe`: um arquivo só, sem instalar Node, npm ou banco.

1. Coloque o `lol-analytics.exe` numa pasta sua (por exemplo `Documentos\lol-analytics`).
2. Dê dois cliques. Ele abre uma janela preta (o servidor local) e o navegador em
   `http://127.0.0.1:5170`. Para fechar o app, feche a janela preta.
3. Na primeira vez abre a tela de **Configurações**: preencha o Riot ID, o servidor e a chave da Riot.
4. Clique em **Sincronizar partidas**. O andamento aparece na própria tela.

Tudo fica ao lado do .exe: o `.env` com a configuração e a pasta `data` com o banco (`lol.db`).
Para trocar de computador, leve os três juntos.

O app tem abas para a visão geral, as viradas de ouro partida a partida, as causas somadas,
os grupos (campeão, posição, oponente, mês, duração), a curva de ouro, os abates por tempo,
a lista de partidas, outros jogadores, o elo e a exportação para CSV. Os filtros do topo valem
para todas as abas.

- **Placar completo:** clique numa partida para ver os 10 jogadores com K/D/A, CS, ouro, dano,
  visão e itens (com ícones). Clique no nome de alguém para consultar esse jogador.
- **Outros jogadores (aba Jogadores):** digite o Riot ID e o app baixa as partidas recentes
  dele (10, 20 ou 40). Os dados dele nunca entram nos seus relatórios. A consulta é eventual:
  ao consultar outra pessoa, a anterior é apagada do banco. Para acompanhar alguém sempre,
  clique em **Registrar em memória**: o histórico fica guardado e é atualizado (últimas 20
  partidas) a cada sincronização. **Remover da memória** volta a ser eventual.

Detalhes:

- O app só escuta em `127.0.0.1`, então ninguém da rede acessa.
- O .exe não é assinado digitalmente. Na primeira execução o Windows pode mostrar
  "O Windows protegeu o computador": clique em **Mais informações** e **Executar assim mesmo**.
- Os gráficos usam o [Chart.js](https://www.chartjs.org) (MIT), embutido no .exe e sem internet.
- Os ícones e nomes de itens vêm do Data Dragon, o CDN público da Riot (sem chave). Cada ícone
  é baixado uma vez e guardado em `data\ddragon`; sem internet, o placar mostra só o texto.
- O banco é SQLite, o mesmo que já vem dentro do Node (`node:sqlite`).

### Gerar o .exe

Precisa do Node 22.18+ só na máquina que gera o executável:

```powershell
npm install
npm run exe        # cria dist\lol-analytics.exe (~80 MB, leva o Node dentro)
npm run app        # roda o mesmo app sem gerar o .exe, para desenvolver
```

O .exe usa o [Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
do próprio Node: o app é empacotado com esbuild e injetado numa cópia do `node.exe` com o postject.

## Linha de comando

Tudo o que o app faz também existe por linha de comando, para quem tem Node instalado.
Não tem dependência de execução: usa o TypeScript e o SQLite que já vêm no Node 22.18+.

## 1. Pegar a chave da Riot

1. Entre em https://developer.riotgames.com com a sua conta Riot.
2. **Para testar hoje:** copie a *Development API Key* do painel. Ela expira a cada 24h.
3. **Para usar sempre:** em *Register Product* escolha **Personal API Key**. Descreva o projeto,
   por exemplo: "Ferramenta pessoal e privada que baixa o meu próprio histórico de partidas
   (account-v1, match-v5 com timeline, league-v4) para gerar estatísticas pós-jogo só para mim.
   Não é pública, não tem monetização nem recursos durante a partida." A chave pessoal não precisa
   de verificação e não expira a cada 24h.

## 2. Configurar (linha de comando)

No app, a configuração é feita pela tela. Pela linha de comando:

```powershell
git clone https://github.com/LuisFernandoBezerraDaSilva/lol-analytics.git
cd lol-analytics
npm install
Copy-Item .env.example .env
notepad .env
```

No `.env`, preencha `RIOT_API_KEY` e `RIOT_ID`. O Riot ID vai **entre aspas**, porque sem elas
tudo depois do `#` vira comentário: `RIOT_ID="SeuNome#BR1"`. Várias contas ficam separadas por
vírgula dentro das mesmas aspas.

## 3. Usar

```powershell
npm run sync                          # baixa até 200 partidas novas por vez
npm run sync -- --tudo                # baixa todo o histórico que a Riot guarda (desde ~2021)
npm run relatorio                     # por campeão
npm run relatorio -- campeao Ahri     # tudo de um campeão: oponentes, curva de ouro, abates, últimas
npm run relatorio -- curva --fila solo
npm run relatorio -- abates --dias 30
npm run relatorio -- ouro             # a última partida: onde o oponente abriu vantagem e por quê
npm run relatorio -- causas --fila solo
npm run exportar                      # CSV em data\export
npm run ajuda                         # todos os comandos e filtros
```

Cada partida custa 2 requisições (partida + timeline). Com o limite de 100 a cada 2 minutos,
são cerca de 50 partidas a cada 2 minutos. O sync espera sozinho quando chega no limite e passa a
usar os limites reais da sua chave, que a Riot informa em toda resposta (header `X-App-Rate-Limit`).

### Relatórios

| Comando | O que mostra |
|---|---|
| `campeoes` | jogos, % de vitória, KDA, kills/min, mortes/min, ouro/min, CS/min, dano/min, % de participação em abates, CS@10, diferença de ouro aos 10 e 15 min |
| `posicoes`, `oponentes`, `filas` | as mesmas métricas agrupadas por posição, campeão adversário de rota ou fila |
| `meses`, `semanas` | evolução no tempo |
| `duracao` | métricas por duração da partida (menos de 20 min, 20-25, ..., 35+) |
| `curva` | ouro, CS e XP médios por minuto, você x oponente de rota (`--ate 20`) |
| `abates` | kills, mortes e assistências por faixa de 5 minutos |
| `recentes` | últimas partidas (`--n 30`) |
| `campeao <Nome>` | todos os anteriores, só daquele campeão |

### Viradas de ouro

| Comando | O que mostra |
|---|---|
| `ouro` | a última partida trecho a trecho: diferença de ouro por minuto, cada virada com a origem do ouro, as mortes, os abates, os objetivos e as dicas |
| `ouro BR1_123` | o mesmo para uma partida específica (aceita só o número) |
| `viradas` | uma linha por partida com a maior perda e o maior ganho (`--n 20`) |
| `causas` | somado em várias partidas: de onde vem o ouro que você perde e ganha, e quantos ganks pegaram você sem sentinela |

Como funciona:

1. Calcula a diferença de ouro total entre você e o oponente de rota a cada minuto.
2. Marca como virada uma mudança de pelo menos 500 de ouro em até 2 minutos
   (`--limiar` e `--janela` mudam isso).
3. Separa o ouro de cada um no trecho com o que a timeline da Riot informa:
   abates (bounty e shutdown), torres e monstros (bounty), e o resto, que inclui farm,
   assistências, placas e ouro passivo.
4. Classifica a causa: gank do caçador inimigo, morte 1x1, morte em luta, roam do oponente,
   farm ou objetivos. Do lado bom: abate 1x1, gank do seu caçador, seu roam ou abates em luta.
5. Escreve dicas por regra, por exemplo sentinela antes do gank, nível na hora da troca perdida
   e o que fazer quando o oponente some da rota.

A zona do mapa (top, mid, bot, rio, selva) é aproximada pelas coordenadas do evento. ARAM e Arena
ficam de fora, porque não têm oponente de rota.

Filtros: `--fila solo|flex|aram|normal|rapida|arena`, `--dias 30`, `--posicao mid`,
`--campeao Ahri`, `--conta Nome#TAG`, `--min-jogos 5`, `--remakes`.

As métricas "por minuto" somam o total e dividem pelo tempo total jogado, o que dá peso certo
para partidas longas e curtas. Remakes ficam de fora, a menos que você passe `--remakes`.

## 4. Trabalhar com os dados do seu jeito

O banco fica em `data\lol.db`. Abra no [DB Browser for SQLite](https://sqlitebrowser.org) ou no DBeaver.

| Tabela / view | Conteúdo |
|---|---|
| `v_minhas_partidas` | uma linha por partida sua, com todas as métricas prontas |
| `partidas.json`, `timelines.json` | o JSON **completo** que a Riot devolveu: nada se perde |
| `participantes` | os 10 jogadores de cada partida |
| `frames` | ouro, XP, nível e CS de cada jogador, minuto a minuto |
| `eventos` | todos os eventos da timeline: abates, compras de item, dragões, torres, sentinelas |
| `elo` | histórico do seu elo a cada sync |

Exemplo, ouro aos 10 min por campeão só na solo:

```sql
SELECT campeao, count(*) AS jogos, round(avg(ouro_10)) AS ouro_10, round(avg(dif_ouro_10)) AS dif_10
FROM v_minhas_partidas
WHERE fila_id = 420 AND remake = 0
GROUP BY campeao ORDER BY jogos DESC;
```

Campos que estão no JSON e não viraram coluna podem ser lidos com `json_extract`. O bloco
`challenges` da Riot traz dezenas de métricas prontas:

```sql
SELECT match_id, json_extract(value, '$.challenges.soloKills') AS solo_kills
FROM partidas, json_each(partidas.json, '$.info.participants')
WHERE json_extract(value, '$.puuid') = (SELECT puuid FROM contas LIMIT 1);
```

Se você mudar o esquema derivado, `npm run reprocessar` refaz tudo a partir do JSON salvo,
sem chamar a API de novo.

## 5. Regras da Riot

Conferido nas políticas oficiais em 2026-11-20
(https://developer.riotgames.com/policies/general, atualizada em 29/05/2025).

**Está dentro das regras:**

- A Riot lista "personal projects to gather your own stats" como uso aceito da chave pessoal.
- Só usa a API oficial, sem raspar sites como op.gg ou u.gg.
- Respeita o limite de requisições e para pelo tempo do `Retry-After` quando recebe 429.
- A chave fica no `.env`, que está no `.gitignore`. Ela vai no header da requisição, nunca na URL nem no código.
- Só estatística pós-jogo. Não faz nada durante a partida.

**O que não fazer, para continuar dentro das regras:**

- **Não publicar.** Chave pessoal não pode servir a um site, app ou ferramenta de outras pessoas.
  Para isso seria preciso uma chave de produção, com aprovação da Riot.
- **Não compartilhar a chave**, nem em print. Se vazar, gere outra no portal.
- **Não criar nota de habilidade, MMR ou "elo calculado".** A Riot proíbe alternativas ao ranking oficial.
- **Não usar os dados dos outros 9 jogadores para identificar pessoas** nem para cruzá-las entre
  partidas. O banco guarda esses dados porque vêm na partida. Use só para comparação com o
  oponente de rota e mantenha local.
- **Não criar recursos que deem vantagem durante a partida**, como timers de feitiço ou de selva.

O código é aberto, mas cada pessoa usa a própria chave e os próprios dados.
Nenhuma chave, banco ou partida faz parte do repositório.

## Aviso legal

lol analytics isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games
or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all
associated properties are trademarks or registered trademarks of Riot Games, Inc.

## Desenvolvimento

```powershell
npm test          # 56 testes com partidas sintéticas; nenhum chama a Riot
npm run typecheck
```
