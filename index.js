import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

    // 2. Avvia Puppeteer con configurazione stabile per Docker/Render
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

    // 3. Ciclo per ogni squadra
    for (const squadra of squadre) {
      if (!squadra.facebook_page_url) continue;

      console.log(`Scansione per: ${squadra.facebook_page_url}`);
      const page = await browser.newPage();

      try {
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Blocco immagini e font prima della navigazione (manteniamo CSS attivi per consentire il rendering)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });

        // Navigazione alla scheda /videos/
        const targetUrl = squadra.facebook_page_url.endsWith('/')
          ? `${squadra.facebook_page_url}videos/`
          : `${squadra.facebook_page_url}/videos/`;

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });

        // Scroll automatico per caricare i video fino a fine settembre
        for (let i = 0; i < 7; i++) {
          await page.evaluate(() => window.scrollBy(0, 1200));
          await new Promise((r) => setTimeout(r, 1200));
        }

        // Estrazione ed eliminazione dei link generici
        const videoLinks = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          return links
            .map((a) => a.href)
            .filter((href) => {
              const isVideo =
                href.includes('/videos/') ||
                href.includes('/watch/?v=') ||
                href.includes('/reel/');
              const isNotGeneric =
                href !== 'https://www.facebook.com/watch/' &&
                !href.endsWith('/videos/') &&
                !href.endsWith('/videos');
              return isVideo && isNotGeneric;
            });
        });

        const uniqueVideoLinks = [...new Set(videoLinks)];
        console.log(`Trovati ${uniqueVideoLinks.length} video per ${squadra.facebook_page_url}`);

        if (uniqueVideoLinks.length === 0) continue;

        // Cerca l'id_partita più recente per questa squadra nella tabella `partite`
        const { data: partita, error: errPartita } = await supabase
          .from('partite')
          .select('id_partita')
          .or(`id_squadra_casa.eq.${squadra.id_squadra},id_squadra_ospite.eq.${squadra.id_squadra}`)
          .order('id_giornata', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (errPartita || !partita) {
          console.error(`⚠️ Impossibile trovare una partita per la squadra ${squadra.id_squadra}:`, errPartita?.message);
          continue;
        }

        // Salva i video associando id_partita e id_squadra_autore
        for (const url of uniqueVideoLinks) {
          const { data, error } = await supabase
            .from('highlights_partite')
            .upsert(
              {
                id_partita: partita.id_partita,
                id_squadra_autore: squadra.id_squadra,
                video_url: url,
                piattaforma: 'facebook'
              },
              { onConflict: 'video_url' }
            );

          if (error) {
            console.error(`❌ Errore salvataggio Supabase per ${url}:`, error.message);
          } else {
            console.log(`✅ Inserito per Partita ${partita.id_partita}: ${url}`);
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
