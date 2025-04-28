const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;

app.use(express.json());

async function buscarFoto(loja, referencia, browser) {
  const url = `https://${loja}.smartpdvstore.com/produto/${referencia}`;
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });

  let linkFoto = null;
  try {
    await page.waitForSelector('img.mantine-Image-root', { visible: true, timeout: 5000 });
    linkFoto = await page.$eval('img.mantine-Image-root', img => img.src);
  } catch (e) {
    const imagens = await page.$$eval('img', (imgs, referencia) => imgs.map(img => img.src).filter(src => src.includes(referencia)), referencia);
    if (imagens.length > 0) {
      linkFoto = imagens[0];
    }
  }
  await page.close();
  return linkFoto;
}

app.post('/fotos', async (req, res) => {
  const { loja, referencias } = req.body;
  if (!loja || !Array.isArray(referencias)) {
    return res.status(400).json({ error: 'Envie "loja" e um array de "referencias" no corpo da requisição' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const links = [];
    for (const ref of referencias) {
      links.push(await buscarFoto(loja, ref, browser));
    }
    res.json({ links });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar fotos', details: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
}); 