import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { carregarDbPath } from '../config.ts';
import { abrirBanco } from '../db.ts';
import { criarApi } from './api.ts';

/**
 * App local: só escuta em 127.0.0.1 (nada fica exposto na rede) e só aceita requisições
 * com Host localhost, para nenhum site aberto no navegador conseguir chamar a API.
 *
 * Dentro do .exe (Node SEA) a página vem embutida no executável, e o .env e a pasta data
 * ficam ao lado do .exe.
 */

const NO_EXE = isSea();
if (NO_EXE) process.chdir(dirname(process.execPath));

/** Arquivos da página embutidos no .exe (mesma lista do sea-config.json). */
export const ARQUIVOS_DA_PAGINA = ['index.html', 'app.js', 'estilo.css', 'icone.svg', 'vendor/chart.umd.js'];

const RAIZ = NO_EXE ? '' : resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const PASTA_PUBLICA = NO_EXE ? '' : join(RAIZ, 'public');
/** Bibliotecas do navegador servidas direto do node_modules (no .exe elas vão embutidas). */
const BIBLIOTECAS: Record<string, string> = { 'vendor/chart.umd.js': 'node_modules/chart.js/dist/chart.umd.js' };

async function lerArquivoDaPagina(relativo: string): Promise<Buffer | null> {
  if (NO_EXE) {
    if (!ARQUIVOS_DA_PAGINA.includes(relativo)) return null;
    return Buffer.from(getAsset(relativo));
  }
  if (BIBLIOTECAS[relativo]) return readFile(join(RAIZ, BIBLIOTECAS[relativo])).catch(() => null);
  const completo = normalize(join(PASTA_PUBLICA, relativo));
  if (!completo.startsWith(PASTA_PUBLICA)) return null;
  try {
    return await readFile(completo);
  } catch {
    return null;
  }
}

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const HOST = '127.0.0.1';
const db = abrirBanco(carregarDbPath()); // também carrega o .env
const porta = Number(process.env.APP_PORTA || 5170);
const api = criarApi(db);

function hostPermitido(host: string | undefined): boolean {
  return host === `127.0.0.1:${porta}` || host === `localhost:${porta}`;
}

async function lerCorpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const p of req) {
    tamanho += (p as Buffer).length;
    if (tamanho > 64 * 1024) throw new Error('Corpo grande demais.');
    partes.push(p as Buffer);
  }
  if (tamanho === 0) return {};
  return JSON.parse(Buffer.concat(partes).toString('utf8'));
}

function responder(res: ServerResponse, status: number, tipo: string, corpo: string | Buffer, extras: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': tipo,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    ...extras,
  });
  res.end(corpo);
}

async function arquivoEstatico(res: ServerResponse, caminho: string) {
  const relativo = caminho === '/' ? 'index.html' : caminho.slice(1);
  const dados = await lerArquivoDaPagina(relativo);
  if (!dados) return responder(res, 404, 'text/plain; charset=utf-8', 'Não encontrado');
  responder(res, 200, TIPOS[extname(relativo)] ?? 'application/octet-stream', dados);
}

const servidor = createServer(async (req, res) => {
  try {
    if (!hostPermitido(req.headers.host)) return responder(res, 403, 'text/plain', 'Host não permitido');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return responder(res, 405, 'text/plain', 'Método não permitido');
      return arquivoEstatico(res, url.pathname);
    }
    let corpo: unknown;
    if (req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return responder(res, 415, 'application/json', JSON.stringify({ erro: 'Use application/json.' }));
      }
      corpo = await lerCorpo(req);
    }
    const r = await api.tratar({ metodo: req.method ?? 'GET', caminho: url.pathname, query: url.searchParams, corpo });
    const extras: Record<string, string> = r.arquivo ? { 'Content-Disposition': `attachment; filename="${r.arquivo}"` } : {};
    if (r.cache) extras['Cache-Control'] = 'max-age=604800';
    responder(res, r.status, r.tipo, r.corpo, extras);
  } catch (e) {
    responder(res, 400, 'application/json', JSON.stringify({ erro: e instanceof Error ? e.message : String(e) }));
  }
});

function abrirNavegador(url: string) {
  if (process.env.APP_ABRIR === '0') return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Sem navegador: o endereço já foi impresso.
  }
}

servidor.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`A porta ${porta} já está em uso. O app talvez já esteja aberto: http://${HOST}:${porta}`);
    console.error('Para usar outra porta, defina APP_PORTA no .env.');
  } else console.error(e);
  process.exit(1);
});

servidor.listen(porta, HOST, () => {
  const url = `http://${HOST}:${porta}`;
  console.log(`lol analytics rodando em ${url}  (Ctrl+C para fechar)`);
  abrirNavegador(url);
});
