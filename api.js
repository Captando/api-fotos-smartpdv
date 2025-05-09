const express = require('express');
const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');

// Cria instância do Express
const app = express();
const PORT = 6261;
app.use(express.json());

// Inicializa cache SQLite
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

// Configurações gerais
const CACHE_TTL = 1000 * 60 * 60 * 6;       // 6 horas
const MAX_SCRAPE_ATTEMPTS = 5;              // tentativas máximas
const RETRY_DELAY_MS = 5000;                // 5 segundos entre tentativas

(async () => {
  // Abre o Chromium apenas uma vez para todo o servidor
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  /**
   * Busca foto e nome da peça usando uma nova aba
   */
  async function buscarFoto(loja, referencia) {
    const stmtCache = db.prepare(
      'SELECT link, nome, fetched_at FROM fotos_cache WHERE loja = ? AND referencia = ?'
    );

    for (let tentativa = 1; tentativa <= MAX_SCRAPE_ATTEMPTS; tentativa++) {
      const agora = Date.now();
      const row = stmtCache.get(loja, referencia);
      if (row && agora - row.fetched_at < CACHE_TTL) {
        console.log(`[CACHE HIT] loja=${loja} ref=${referencia}`);
        return { link: row.link, nome: row.nome };
      }

      console.log(`[TENTATIVA ${tentativa}/${MAX_SCRAPE_ATTEMPTS}] ref=${referencia}`);
      const page = await browser.newPage();
      let link = null;
      let nome = null;

      try {
        const url = `https://${loja}.smartpdvstore.com/produto/${referencia}`;
        console.log(`[INÍCIO BUSCA] ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2' });
        // Aguarda carregamento completo do título e imagem
        await page.waitForSelector('h2.mantine-Title-root', { timeout: 60000 });
        await page.waitForSelector('img.mantine-Image-root', { timeout: 60000 });

        // Extrai nome da peça
        try {
          nome = await page.$eval('h2.mantine-Title-root', el => el.textContent.trim());
        } catch {
          nome = await page.title();
        }

        // Extrai link da imagem
        try {
          link = await page.$eval('img.mantine-Image-root', img => img.src);
        } catch {
          const arr = await page.$$eval(
            'img',
            (imgs, ref) => imgs.map(i => i.src).filter(src => src.includes(ref)),
            referencia
          );
          link = arr[0] || null;
        }

        console.log(link ? `[SUCESSO] ref=${referencia}` : `[SEM RESULTADO] ref=${referencia}`);
      } catch (err) {
        console.error(`[ERRO] ref=${referencia}: ${err.message}`);
      } finally {
        await page.close();  // Fecha apenas a aba
      }

      if (link && nome) {
        db.prepare(
          `INSERT OR REPLACE INTO fotos_cache(loja, referencia, link, nome, fetched_at)
           VALUES(?, ?, ?, ?, ?)`
        ).run(loja, referencia, link, nome, agora);
        console.log(`[CACHE STORE] ref=${referencia}`);
        return { link, nome };
      }

      if (tentativa < MAX_SCRAPE_ATTEMPTS) {
        console.log(`[RETRY] ref=${referencia} em ${RETRY_DELAY_MS}ms`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    throw new Error(`Falha ao obter ref=${referencia} após ${MAX_SCRAPE_ATTEMPTS} tentativas`);
  }

  /**
   * Endpoint /fotos: executa scraping concorrente, cada ref em nova aba
   */
  app.post('/fotos', async (req, res) => {
    const { loja, referencias } = req.body;
    if (!loja || !Array.isArray(referencias)) {
      return res.status(400).json({ error: 'Envie loja e array de referencias.' });
    }

    try {
      const resultados = await Promise.all(
        referencias.map(async ref => {
          try {
            const { link, nome } = await buscarFoto(loja, ref);
            return { referencia: ref, link, nome };
          } catch (e) {
            return { referencia: ref, link: null, nome: null, error: e.message };
          }
        })
      );
      res.json({ results: resultados });
    } catch (e) {
      res.status(500).json({ error: 'Erro interno', details: e.message });
    }
  });

  app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));

  // Fecha o browser ao encerrar o servidor
  process.on('SIGINT', async () => {
    console.log('Finalizando browser...');
    await browser.close();
    process.exit();
  });
})();
