import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Funzione di classificazione avanzata del contesto del video
function classificaTitoloVideo(testo) {
  if (!testo) return null;
  const t = testo.toLowerCase();

  // 1. HIGHLIGHTS (Priorità alta)
  if (
    t.includes('highlight') ||
    t.includes('sintesi') ||
    t.includes('azioni salienti') ||
    t.includes('top 10') ||
    t.includes('best of') ||
    t.includes('mini film') ||
    t.includes('canestri')
  ) {
    return 'Highlights';
  }

  // 2. POST-PARTITA
  if (
    t.includes('conferenza') ||
    t.includes('postpartita') ||
    t.includes('post-partita') ||
    t.includes('post gara') ||
    t.includes('dopo gara') ||
    t.includes('intervist') ||
    t.includes('dopo match') ||
    t.includes('dopo la vittoria') ||
    t.includes('dopo la sconfitta') ||
    t.includes('sala stampa') ||
    t.includes('commenta') ||
    t.includes('commento')
  ) {
    return 'Post-Partita';
  }

  // 3. PREPARTITA
  if (
    t.includes('prepartita') ||
    t.includes('pre-partita') ||
    t.includes('pre gara') ||
    t.includes('anteprima') ||
    t.includes('presentazione gara') ||
    t.includes('presenta la gara') ||
    t.includes('presenta il match') ||
    t.includes('alla vigilia') ||
    t.includes('verso ') ||
    t.includes('in vista') ||
    t.includes('parla in vista')
  ) {
    return 'Prepartita';
  }

  // Gestione avanzata del contesto per termini come "coach" o "parole"
  if (t.includes('coach') || t.includes('parole')) {
    if (t.includes('dopo') || t.includes('vittoria') || t.includes('sconfitta') || t.includes('gara')) {
      return 'Post-Partita';
    }
    if (t.includes('sfida') || t.includes('match') || t.includes('prossim')) {
      return 'Prepartita';
    }
  }

  // Scarta video promozionali, biglietteria o generici
  return null;
}

app.get('/scrape', async (req, res) => {
  res.json({ message: "Scraping avviato in background..." });

  try {
    // 1. Recupera la lista delle squadre dal database
    const { data: squadre, error } = await supabase
      .from('squadre')
      .select('id_squadra, facebook_page_url')
      .not('facebook_page_url', 'is', null);

    if (error || !squadre) {
      console.error('Errore nel recupero squadre:', error);
      return;
    }

    // 2. Avvia Puppeteer con opzioni di ottimizzazione RAM per Render
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    // 3. Ciclo per ciascuna squadra
    for (const squadra of squadre) {
      if (!squadra.facebook_page_url) continue;

      console.log(`Scansione per: ${squadra.facebook_page_url}`);
      const page = await browser.newPage();

      try {
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Blocca immagini, font e media per ridurre il carico di RAM
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });

        // Vai alla sezione /videos/ della pagina
        const targetUrl = squadra.facebook_page_url.endsWith('/')
          ? `${squadra.facebook_page_url}videos/`
          : `${squadra.facebook_page_url}/videos/`;

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });

        // Scroll graduale verso il basso per caricare i post fino alle prime giornate
        for (let i = 0; i < 7; i++) {
          await page.evaluate(() => window.scrollBy(0, 1200));
          await new Promise((r) => setTimeout(r, 1200));
        }

        // Estrazione degli elementi video e del relativo testo del post
        const rawItems = await page.evaluate(() => {
          const results = [];
          const links = Array.from(document.querySelectorAll('a'));

          links.forEach((a) => {
            const href = a.href || '';
            const isVideo =
              href.includes('/videos/') ||
              href.includes('/watch/?v=') ||
              href.includes('/reel/');
            const isNotGeneric =
              href !== 'https://www.facebook.com/watch/' &&
              !href.endsWith('/videos/') &&
              !href.endsWith('/videos');

            if (isVideo && isNotGeneric) {
              const parentText = a.closest('div[role="article"]')?.innerText || a.innerText || '';
              results.push({
                url: href,
                fullText: parentText
              });
            }
          });
          return results;
        });

        // Filtra ed assegna la categoria ('Highlights', 'Prepartita', 'Post-Partita')
        const itemsToSave = [];
        const seenUrls = new Set();

        for (const item of rawItems) {
          if (seenUrls.has(item.url)) continue;

          const categoriaTitolo = classificaTitoloVideo(item.fullText);

          if (categoriaTitolo) {
            seenUrls.add(item.url);
            itemsToSave.push({
              url: item.url,
              titolo: categoriaTitolo,
              fullText: item.fullText.toLowerCase()
            });
          }
        }

        console.log(`Trovati ${itemsToSave.length} video pertinenti per ${squadra.facebook_page_url}`);

        if (itemsToSave.length === 0) continue;

        // Recupera le partite della squadra ordinate per giornata
        const { data: partiteSquadra } = await supabase
          .from('partite')
          .select('id_partita, id_giornata')
          .or(`id_squadra_casa.eq.${squadra.id_squadra},id_squadra_ospite.eq.${squadra.id_squadra}`)
          .order('id_giornata', { ascending: false });

        if (!partiteSquadra || partiteSquadra.length === 0) continue;

        // Salva i video associando id_partita, titolo e id_squadra_autore
        for (const item of itemsToSave) {
          let partitaSelezionata = partiteSquadra[0]; // Default: partita più recente

          // Riconoscimento esplicito della giornata nel testo del post
          if (
            item.fullText.includes('giornata 1') ||
            item.fullText.includes('1^ giornata') ||
            item.fullText.includes('1a giornata')
          ) {
            partitaSelezionata = partiteSquadra.find((p) => p.id_giornata === 1) || partitaSelezionata;
          } else if (
            item.fullText.includes('giornata 2') ||
            item.fullText.includes('2^ giornata') ||
            item.fullText.includes('2a giornata')
          ) {
            partitaSelezionata = partiteSquadra.find((p) => p.id_giornata === 2) || partitaSelezionata;
          }

          const { error } = await supabase
            .from('highlights_partite')
            .upsert(
              {
                id_partita: partitaSelezionata.id_partita,
                id_squadra_autore: squadra.id_squadra,
                video_url: item.url,
                titolo: item.titolo,
                piattaforma: 'facebook'
              },
              { onConflict: 'video_url' }
            );

          if (error) {
            console.error(`❌ Errore salvataggio Supabase per ${item.url}:`, error.message);
          } else {
            console.log(`✅ Inserito [${item.titolo}] (Giornata ${partitaSelezionata.id_giornata}): ${item.url}`);
          }
        }

      } catch (e) {
        console.error(`Errore durante lo scraping di ${squadra.facebook_page_url}:`, e.message);
      } finally {
        if (!page.isClosed()) {
          await page.close();
        }
      }
    }

    await browser.close();
    console.log('Scraping completato per tutte le squadre!');
  } catch (err) {
    console.error('Errore generale:', err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server attivo sulla porta ${PORT}`);
});
