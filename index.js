import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const app = express();
app.use(express.json());

// Inserisci qui i tuoi dati di Supabase
const SUPABASE_URL = 'https://amhqonfunjmhakhbpktx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

app.get('/scrape', async (req, res) => {
  res.json({ message: "Scraping avviato in background..." });

  try {
    // 1. Recupera la lista delle squadre dal database con le colonne corrette
    const { data: squadre, error } = await supabase
      .from('squadre')
      .select('id_squadra, facebook_page_url')
      .not('facebook_page_url', 'is', null);

    if (error || !squadre) {
      console.error('Errore nel recupero squadre:', error);
      return;
    }

    const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
  headless: 'true',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu'
  ]
});

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    for (const squadra of squadre) {
      if (!squadra.facebook_page_url) continue;

      console.log(`Scansione per: ${squadra.facebook_page_url}`);
      
      try {
        await page.goto(squadra.facebook_page_url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Estrai i link dei video / post
        const videoLinks = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          return links
            .map(a => a.href)
            .filter(href => href.includes('/videos/') || href.includes('/watch/') || href.includes('/reel/'));
        });

        console.log(`Trovati ${videoLinks.length} video per ${squadra.facebook_page_url}`);

        // Salva i video trovati in Supabase
        for (const url of videoLinks) {
          await supabase.from('highlights_partite').upsert({
            id_squadra: squadra.id_squadra,
            video_url: url
          }, { onConflict: 'video_url' });
        }

      } catch (e) {
        console.error(`Errore durante lo scraping di ${squadra.facebook_page_url}:`, e.message);
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
