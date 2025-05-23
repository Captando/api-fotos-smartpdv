require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 6261;
app.use(express.json());

// — Webshare Proxy Fetcher —
const WEBSHARE_TOKEN = process.env.WEBSHARE_TOKEN;
if (!WEBSHARE_TOKEN) throw new Error('⚠️ Defina WEBSHARE_TOKEN no .env');

async function fetchProxies(token) {
  const list = [];
  let page = 1;
  while (true) {
    const resp = await axios.get(
      `https://proxy.webshare.io/api/v2/proxy/list/?page=${page}&mode=direct`,
      { headers: { Authorization: token }, timeout: 10000 }
    );
    if (resp.status !== 200) break;
    resp.data.results.forEach(p => {
      list.push(`${p.username}:${p.password}@${p.proxy_address}:${p.port}`);
    });
    if (!resp.data.next) break;
    page++;
  }
  if (!list.length) throw new Error('🚨 Nenhum proxy carregado — cheque .env ou saldo Webshare');
  console.log(`🔀 Carregados ${list.length} proxies da Webshare`);
  return list;
}

let PROXIES = [];
let lastProxyFetch = Date.now();
async function ensureProxiesFresh() {
  if (Date.now() - lastProxyFetch > 1000 * 60 * 60) { // a cada 1h
    PROXIES = await fetchProxies(WEBSHARE_TOKEN);
    lastProxyFetch = Date.now();
  }
}
function getRandomProxy() {
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
}

// — Cache SQLite —
const db = new Database('cache.db');
db.prepare(`
  CREATE TABLE IF NOT EXISTS fotos_cache (
    loja TEXT,
    referencia TEXT,
    link TEXT,
    nome TEXT,
    fetched_at INTEGER,
    PRIMARY KEY(loja, referencia)
  )
`).run();

// — Scraper com proxy e checagens aprimoradas —
const CACHE_TTL = 1000 * 60 * 60 * 24;   // 24h
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 15000;

async function buscarFoto(loja, referencia) {
  await ensureProxiesFresh();

  const now = Date.now();
  const row = db.prepare(
    'SELECT link, nome, fetched_at FROM fotos_cache WHERE loja=? AND referencia=?'
  ).get(loja, referencia);

  if (row && now - row.fetched_at < CACHE_TTL) {
    console.log(`[CACHE HIT] ${loja}/${referencia}`);
    return { link: row.link, nome: row.nome };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await ensureProxiesFresh();

    const proxyStr = getRandomProxy();
    const [auth, hostPort] = proxyStr.split('@');
    const [username, password] = auth.split(':');
    const proxyUrl = `http://${hostPort}`;

    console.log(`[TENTATIVA ${attempt}] ${loja}/${referencia} via ${hostPort}`);

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: '/usr/bin/chromium-browser',
      args: [
        `--proxy-server=${proxyUrl}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage'
      ]
    });
    const page = await browser.newPage();
    await page.authenticate({ username, password });

    try {
      const url = `https://${loja}.smartpdvstore.com/produto/${referencia}`;
      const resp = await page.goto(url, { waitUntil: 'networkidle2' });
      const status = resp?.status() ?? 0;

      if (status >= 400) {
        await browser.close();
        return { link: null, nome: null, error: 'Produto não encontrado' };
      }

      const bodyText = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes('Sua pesquisa não retornou resultados!')) {
        await browser.close();
        return { link: null, nome: null, error: 'Produto não encontrado' };
      }

      await page.waitForSelector('h2.mantine-Title-root', { timeout: 60000 });
      await page.waitForSelector('img.mantine-Image-root', { timeout: 60000 });

      const nome = await page.$eval('h2.mantine-Title-root', el => el.textContent.trim())
        .catch(() => page.title());
      const link = await page.$eval('img.mantine-Image-root', img => img.src)
        .catch(async () => {
          const arr = await page.$$eval('img', (imgs, ref) =>
            imgs.map(i => i.src).filter(s => s.includes(ref)), referencia
          );
          return arr[0] || null;
        });

      if (link && nome) {
        db.prepare(`
          INSERT OR REPLACE INTO fotos_cache(loja, referencia, link, nome, fetched_at)
          VALUES(?,?,?,?,?)
        `).run(loja, referencia, link, nome, now);
        console.log(`[SUCCESS] ${loja}/${referencia} -> ${link}`); // log de sucesso
        await browser.close();
        return { link, nome };
      }
    } catch (err) {
      console.warn(`[ERRO] ${referencia}: ${err.message}`);
    } finally {
      await browser.close();
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  throw new Error(`Falha ao buscar ${referencia} após ${MAX_ATTEMPTS} tentativas`);
}

// — Endpoint /fotos —
app.post('/fotos', async (req, res) => {
  const { loja, referencias } = req.body;
  if (!loja || !Array.isArray(referencias)) {
    return res.status(400).json({ error: 'Envie { loja, referencias: [] }' });
  }
  const results = await Promise.all(referencias.map(async ref => {
    try {
      const data = await buscarFoto(loja, ref);
      return data.error ? { referencia: ref, error: data.error } : { referencia: ref, ...data };
    } catch (e) {
      return { referencia: ref, error: e.message };
    }
  }));
  res.json({ results });
});

// — Startup —
(async () => {
  PROXIES = await fetchProxies(WEBSHARE_TOKEN);
  lastProxyFetch = Date.now();
  app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));
  process.on('SIGINT', () => process.exit());
})();
