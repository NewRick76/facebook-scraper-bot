import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

const NOMI_SQUADRE_MAP = {
  'agrigento': ['agrigento', 'moncada'],
  'omegna': ['omegna', 'fulgor'],
  'imola': ['imola', 'andrea costa'],
  'roma': ['roma', 'virtus roma']
};

let isScrapingRunning = false;

function classificaTitoloVideo(testo) {
  if (!testo) return null;
  const t = testo.toLowerCase();

  // 0. ESCLUSIONI PREVENTIVE (Allenamenti, sponsor, eventi societari, giovanili, minibasket)
  if (
    t.includes('allenament') || t.includes('training') ||
    t.includes('dietro le quinte') || t.includes('backstage') ||
    t.includes('minibasket') || t.includes('giovanil') ||
    t.includes('scuola basket') || t.includes('sponsor') ||
    t.includes('presentazione del main') || t.includes('presentazione maglie') ||
    t.includes('presentazione roster')
  ) {
    return null;
  }

  // 1. HIGHLIGHTS (Priorità massima per le sintesi di gara)
  if (
    t.includes('highlight') || t.includes('sintesi') ||
    t.includes('azioni salienti') || t.includes('top 10') ||
    t.includes('best of') || t.includes('mini film') ||
    (t.includes('canestri') && !t.includes('minibasket'))
  ) {
    return 'Highlights';
  }

  // 2. PREPARTITA (Priorità per la presentazione di gare imminenti)
  if (
    t.includes('prepartita') || t.includes('pre-partita') ||
    t.includes('pre gara') || t.includes('anteprima') ||
    t.includes('presentazione gara') || t.includes('alla vigilia') ||
    t.includes('verso ') || t.includes('in vista') ||
    t.includes('guardiamo al match') || t.includes('presenta il match') ||
    t.includes('affronterà') || t.includes('presenta la sfida')
  ) {
    return 'Prepartita';
  }

  // 3. POST-PARTITA (Filtri dedicati esclusivamente al post-gara)
  if (
    t.includes('postpartita') || t.includes('post-partita') ||
    t.includes('post gara') || t.includes('dopo gara') ||
    t.includes('dopo match') || t.includes('commento al match') ||
    t.includes('commenta la vittoria') || t.includes('commenta la sconfitta') ||
    (t.includes('conferenza') && !t.includes('presentazione')) ||
    (t.includes('sala stampa') && !t.includes('presentazione'))
  ) {
    return 'Post-Partita';
  }

  // 4. CONTROLLI DI RIPIEGO CONTESTUALIZZATI SULLA PARTITA
  if (t.includes('coach') || t.includes('parole')) {
    if (t.includes('dopo la gara') || t.includes('vittoria') || t.includes('sconfitta')) return 'Post-Partita';
    if (t.includes('sfida') || t.includes('match') || t.includes('prossima gara') || t.includes('prossimo match')) return 'Prepartita';
  }

  return null;
}

function differenzaGiorni(d1, d2) {
  const diffTime = Math.abs(d1 - d2);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Helper per forzare un timeout massimale su un'operazione asincrona
function withTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout superato (${ms / 1000}s)`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function scansionaSquadra(squadra, squadre, tutteLePartite) {
  let browser = null;
  let page = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-speech-api',
        '--disable-background-networking'
      ]
    });

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const targetUrl = squadra.facebook_page_url.endsWith('/')
      ? `${squadra.facebook_page_url}videos/`
      : `${squadra.facebook_page_url}/videos/`;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await new Promise((r) => setTimeout(r, 600));
    }

    const rawItems = await page.evaluate(() => {
      const results = [];
      const links = Array.from(document.querySelectorAll('a'));

      links.forEach((a) => {
        const href = a.href || '';
        const isVideo = href.includes('/videos/') || href.includes('/watch/?v=') || href.includes('/reel/');
        const isNotGeneric = href !== 'https://www.facebook.com/watch/' && !href.endsWith('/videos/');

        if (isVideo && isNotGeneric) {
          const article = a.closest('div[role="article"]');
          const parentText = article?.innerText || a.innerText || '';
          const timeEl = article?.querySelector('time');
          const postDate = timeEl ? timeEl.getAttribute('datetime') : null;

          results.push({
            url: href,
            fullText: parentText,
            postDate: postDate ? new Date(postDate) : new Date()
          });
        }
      });
      return results;
    });

    const partiteSquadra = tutteLePartite.filter(
      p => p.id_squadra_casa === squadra.id_squadra || p.id_squadra_ospite === squadra.id_squadra
    );

    for (const item of rawItems) {
      const categoriaTitolo = classificaTitoloVideo(item.fullText);
      if (!categoriaTitolo) continue;

      const testoLower = item.fullText.toLowerCase();
      let partitaScelta = null;

      for (const avversario of squadre) {
        if (avversario.id_squadra === squadra.id_squadra) continue;

        const nomeAvversarioLower = avversario.nome.toLowerCase();
        const aliasList = NOMI_SQUADRE_MAP[nomeAvversarioLower] || [nomeAvversarioLower];

        if (aliasList.some(alias => testoLower.includes(alias))) {
          const matchScontri = partiteSquadra.filter(
            p => p.id_squadra_casa === avversario.id_squadra || p.id_squadra_ospite === avversario.id_squadra
          );

          if (matchScontri.length === 1) {
            partitaScelta = matchScontri[0];
          } else if (matchScontri.length > 1) {
            const dataPost = new Date(item.postDate);
            matchScontri.sort((a, b) => {
              return differenzaGiorni(dataPost, new Date(a.data_partita)) - differenzaGiorni(dataPost, new Date(b.data_partita));
            });
            partitaScelta = matchScontri[0];
          }
          break;
        }
      }

      if (!partitaScelta && partiteSquadra.length > 0) {
        const dataPost = new Date(item.postDate);
        partiteSquadra.sort((a, b) => {
          return differenzaGiorni(dataPost, new Date(a.data_partita)) - differenzaGiorni(dataPost, new Date(b.data_partita));
        });
        partitaScelta = partiteSquadra[0];
      }

      if (!partitaScelta) continue;

      await supabase.from('highlights_partite').upsert(
        {
          id_partita: partitaScelta.id_partita,
          id_squadra_autore: squadra.id_squadra,
          video_url: item.url,
          titolo: categoriaTitolo,
          piattaforma: 'facebook'
        },
        { onConflict: 'video_url' }
      );

      console.log(`✅ [${categoriaTitolo}] -> Partita ID ${partitaScelta.id_partita}: ${item.url}`);
    }

  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

app.get('/scrape', async (req, res) => {
  if (isScrapingRunning) {
    return res.status(429).json({ message: "Un processo di scraping è già in esecuzione!" });
  }

  isScrapingRunning = true;
  res.json({ message: "Scraping avviato in background..." });

  try {
    const { data: squadre } = await supabase.from('squadre').select('id_squadra, nome, facebook_page_url');
    const { data: tutteLePartite } = await supabase.from('partite').select('id_partita, id_squadra_casa, id_squadra_ospite, data_partita, id_giornata');

    if (!squadre || !tutteLePartite) return;

    let counter = 0;
    for (const squadra of squadre) {
      counter++;
      if (!squadra.facebook_page_url) continue;

      console.log(`Scansione (${counter}/${squadre.length}) per: ${squadra.facebook_page_url}`);

      try {
        // Forza un blocco di massimo 40 secondi a squadra per impedire stalli definitivi
        await withTimeout(scansionaSquadra(squadra, squadre, tutteLePartite), 40000);
      } catch (err) {
        console.error(`⚠️ Salto ${squadra.facebook_page_url}: ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log('Scraping completato per tutte le squadre!');
  } catch (err) {
    console.error('Errore generale:', err);
  } finally {
    isScrapingRunning = false;
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
