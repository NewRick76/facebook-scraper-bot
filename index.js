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
  'omegna': ['omegna', 'fulgor', 'paffoni'],
  'imola': ['imola', 'andrea costa'],
  'virtus gvm roma 1960': ['virtus roma', 'roma 1960', 'virtus gvm'],
  'luiss roma': ['luiss', 'luiss roma'],
  'cestistica san severo': ['san severo', 'sansevero', 'cestistica san severo'],
  'faenza': ['faenza', 'raggisolaris', 'tema sinergie'],
  'siena': ['siena', 'mens sana']
};

let isScrapingRunning = false;

function classificaTitoloVideo(testo) {
  if (!testo) return null;
  const t = testo.toLowerCase();

  // 0. ESCLUSIONI PREVENTIVE
  if (
    t.includes('allenament') || t.includes('training') ||
    t.includes('dietro le quinte') || t.includes('backstage') ||
    t.includes('minibasket') || t.includes('giovanil') ||
    t.includes('scuola basket') || 
    t.includes('presentazione del main') || t.includes('presentazione maglie') ||
    t.includes('presentazione roster') || t.includes('presentazione squadra') ||
    t.includes('presentazione giocatore') || t.includes('presentazione acquisto') ||
    t.includes('conferme roster') || t.includes('nuovo acquisto') ||
    t.includes('nuovo giocatore') || t.includes('benvenuto') ||
    t.includes('firmato') || t.includes('ingaggio')
  ) {
    return null;
  }

  // 1. HIGHLIGHTS
  if (
    t.includes('highlight') || t.includes('sintesi') ||
    t.includes('azioni salienti') || t.includes('top 10') ||
    t.includes('best of') || t.includes('mini film') ||
    (t.includes('canestri') && !t.includes('minibasket'))
  ) {
    return 'Highlights';
  }

  // 2. POST-PARTITA
  if (
    t.includes('postpartita') || t.includes('post-partita') ||
    t.includes('post gara') || t.includes('dopo gara') ||
    t.includes('dopo match') || t.includes('commento al match') ||
    t.includes('commento del') || t.includes('commento di') ||
    t.includes('al termine della') || t.includes('al termine del') ||
    t.includes('al termine di') || t.includes('commenta la vittoria') ||
    t.includes('commenta la sconfitta') || t.includes('dichiarazioni a caldo') ||
    (t.includes('conferenza') && !t.includes('roster') && !t.includes('sponsor')) ||
    (t.includes('sala stampa') && !t.includes('presentazione roster') && !t.includes('presentazione gara'))
  ) {
    return 'Post-Partita';
  }

  // 3. PREPARTITA
  if (
    t.includes('prepartita') || t.includes('pre-partita') ||
    t.includes('pre gara') || t.includes('anteprima') ||
    t.includes('presentazione gara') || t.includes('alla vigilia') ||
    t.includes('verso ') || t.includes('in vista') ||
    t.includes('guardiamo al match') || t.includes('presenta il match') ||
    t.includes('presenta la sfida') || t.includes('presenta la gara') ||
    t.includes('presenta la partita') || t.includes('affronterà') ||
    t.includes('lavagna tecnica') || t.includes('prossima avversaria') ||
    t.includes('prossimo avversario') || t.includes('scouting') ||
    t.includes('racconta la') || t.includes('analisi del match')
  ) {
    return 'Prepartita';
  }

  // 4. CONTROLLI DI RIPIEGO
  if (t.includes('coach') || t.includes('parole') || t.includes('intervista')) {
    if (t.includes('dopo la gara') || t.includes('vittoria') || t.includes('sconfitta') || t.includes('al termine')) return 'Post-Partita';
    if (t.includes('sfida') || t.includes('match') || t.includes('prossima gara') || t.includes('prossimo match') || t.includes('domenica')) return 'Prepartita';
  }

  return null;
}

function estraiNumeroGiornata(testo) {
  if (!testo) return null;
  const t = testo.toLowerCase();

  const mappaParoleNumero = {
    'prima': 1, 'seconda': 2, 'terza': 3, 'quarta': 4, 'quinta': 5,
    'sesta': 6, 'settima': 7, 'ottava': 8, 'nona': 9, 'decima': 10,
    'undicesima': 11, 'dodicesima': 12, 'tredicesima': 13, 'quattordicesima': 14,
    'quindicesima': 15, 'sedicesima': 16, 'diciassettesima': 17, 'diciottesima': 18,
    'diciannovesima': 19, 'ventesima': 20
  };

  const regexNumerica = /(?:giornata\s*n?°?\s*(\d+))|(?:(\d+)[°ªa]?\s*giornata)/i;
  const matchNum = t.match(regexNumerica);
  if (matchNum) {
    const num = matchNum[1] || matchNum[2];
    if (num) return parseInt(num, 10);
  }

  for (const [parola, num] of Object.entries(mappaParoleNumero)) {
    if (t.includes(`${parola} giornata`)) {
      return num;
    }
  }

  return null;
}

function differenzaGiorni(d1, d2) {
  const diffTime = Math.abs(d1 - d2);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout superato (${ms / 1000}s)`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function killBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close().catch(() => {});
  } catch (e) {}
  
  try {
    const proc = browser.process();
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
    }
  } catch (e) {}
}

async function scansionaSquadra(squadra, tutteLeSquadre, tutteLePartite) {
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
        '--disable-background-networking',
        '--disable-extensions'
      ]
    });

    page = await browser.newPage();
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(25000);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Ripristiniamo l'intercettazione risorse identica a prima
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let targetUrl = squadra.facebook_page_url;
    if (targetUrl.includes('profile.php')) {
      targetUrl = targetUrl.includes('?') 
        ? `${targetUrl}&sk=videos` 
        : `${targetUrl}?sk=videos`;
    } else {
      targetUrl = targetUrl.endsWith('/') ? `${targetUrl}videos/` : `${targetUrl}/videos/`;
    }

    // Ripristinato waitUntil: 'domcontentloaded' originale
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    for (let i = 0; i < 3; i++) {
      await withTimeout(page.evaluate(() => window.scrollBy(0, 1200)), 2000).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }

    const rawItems = await withTimeout(
      page.evaluate(() => {
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
      }),
      8000
    ).catch(() => []);

    const avversariStessoGirone = squadra.girone 
      ? tutteLeSquadre.filter(s => s.girone === squadra.girone && s.id_squadra !== squadra.id_squadra)
      : tutteLeSquadre.filter(s => s.id_squadra !== squadra.id_squadra);

    const partiteSquadra = tutteLePartite.filter(
      p => p.id_squadra_casa === squadra.id_squadra || p.id_squadra_ospite === squadra.id_squadra
    );

    for (const item of rawItems) {
      const categoriaTitolo = classificaTitoloVideo(item.fullText);
      if (!categoriaTitolo) continue;

      const testoLower = item.fullText.toLowerCase();
      let partiteCandidate = [...partiteSquadra];

      // LIVELLO 1: AVVERSARIA
      let avversarioTrovato = null;
      for (const avversario of avversariStessoGirone) {
        const nomeAvvLower = avversario.nome.toLowerCase();
        const aliasList = NOMI_SQUADRE_MAP[nomeAvvLower] || [];
        const paroleSignificative = nomeAvvLower.split(' ').filter(w => w.length > 3 && !['basket', 'pallacanestro', 'virtus', 'real'].includes(w));
        
        const terminiDaCercare = [nomeAvvLower, ...aliasList, ...paroleSignificative];

        if (terminiDaCercare.some(termine => testoLower.includes(termine))) {
          avversarioTrovato = avversario;
          break;
        }
      }

      if (avversarioTrovato) {
        partiteCandidate = partiteCandidate.filter(
          p => p.id_squadra_casa === avversarioTrovato.id_squadra || p.id_squadra_ospite === avversarioTrovato.id_squadra
        );
      }

      // LIVELLO 2: GIORNATA
      if (partiteCandidate.length !== 1) {
        const numeroGiornataEstratto = estraiNumeroGiornata(item.fullText);
        if (numeroGiornataEstratto) {
          const filtratePerGiornata = partiteCandidate.filter(
            p => parseInt(p.id_giornata, 10) === numeroGiornataEstratto
          );

          if (filtratePerGiornata.length > 0) {
            partiteCandidate = filtratePerGiornata;
          }
        }
      }

      // LIVELLO 3: DATA
      let partitaScelta = null;

      if (partiteCandidate.length === 1) {
        partitaScelta = partiteCandidate[0];
      } else if (partiteCandidate.length > 1) {
        const dataPost = new Date(item.postDate);
        partiteCandidate.sort((a, b) => {
          return differenzaGiorni(dataPost, new Date(a.data_partita)) - differenzaGiorni(dataPost, new Date(b.data_partita));
        });
        partitaScelta = partiteCandidate[0];
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

      console.log(`✅ [${categoriaTitolo}] -> Partita ID ${partitaScelta.id_partita} (Giornata ${partitaScelta.id_giornata}): ${item.url}`);
    }

  } finally {
    if (page) await page.close().catch(() => {});
    await killBrowser(browser);
  }
}

async function eseguiScrapingInBackground(offset, limit) {
  try {
    const { data: tutteSquadre } = await supabase.from('squadre').select('id_squadra, nome, facebook_page_url, girone');
    const { data: tutteLePartite } = await supabase.from('partite').select('id_partita, id_squadra_casa, id_squadra_ospite, data_partita, id_giornata');

    if (!tutteSquadre || !tutteLePartite) return;

    const squadreSelezionate = tutteSquadre.slice(offset, offset + limit);

    let counter = offset;
    for (const squadra of squadreSelezionate) {
      counter++;
      if (!squadra.facebook_page_url) continue;

      console.log(`Scansione (${counter}/${tutteSquadre.length}) per: ${squadra.nome} (${squadra.facebook_page_url})`);

      try {
        await withTimeout(scansionaSquadra(squadra, tutteSquadre, tutteLePartite), 45000);
      } catch (err) {
        console.error(`⚠️ Salto ${squadra.nome}: ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, 500));
      if (global.gc) global.gc();
    }

    console.log(`🎉 Scraping completato con successo per il blocco ${offset} - ${offset + squadreSelezionate.length}!`);
  } catch (err) {
    console.error('Errore durante lo scraping in background:', err);
  } finally {
    isScrapingRunning = false;
  }
}

app.get('/scrape', (req, res) => {
  if (isScrapingRunning) {
    return res.status(429).json({ message: "Un processo di scraping è già in esecuzione!" });
  }

  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 15;

  isScrapingRunning = true;

  res.json({ 
    status: "ok", 
    message: `Scraping avviato in background per il blocco ${offset} - ${offset + limit}.` 
  });

  eseguiScrapingInBackground(offset, limit);
});

app.get('/reset-lock', (req, res) => {
  isScrapingRunning = false;
  res.json({ message: "Lock dello scraping resettato con successo!" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
