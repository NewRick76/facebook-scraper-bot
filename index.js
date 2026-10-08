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
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Usa /tmp invece di /dev/shm per risparmiare RAM
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu'
  ]
});
// Sostituisci dalla riga 44 alla riga 75 con questo blocco:

  for (const squadra of squadre) {
    if (!squadra.facebook_page_url) continue;

    console.log(`Scansione per: ${squadra.facebook_page_url}`);
    const page = await browser.newPage();

    try {
      // Blocca risorse pesanti per risparmiare memoria RAM su Render
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Naviga direttamente nella sezione /videos/ della pagina
      const targetUrl = squadra.facebook_page_url.endsWith('/')
        ? `${squadra.facebook_page_url}videos/`
        : `${squadra.facebook_page_url}/videos/`;

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Esegui 7 scroll verso il basso per caricare anche i video di fine settembre
      for (let i = 0; i < 7; i++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await new Promise(r => setTimeout(r, 1200));
      }

      // Estrai ed escludi URL generici
      const videoLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links
          .map(a => a.href)
          .filter(href => {
            const isVideo = href.includes('/videos/') || href.includes('/watch/?v=') || href.includes('/reel/');
            const isNotGeneric = href !== 'https://www.facebook.com/watch/' && 
                                 !href.endsWith('/videos/') && 
                                 !href.endsWith('/videos');
            return isVideo && isNotGeneric;
          });
      });

      const uniqueVideoLinks = [...new Set(videoLinks)];
      console.log(`Trovati ${uniqueVideoLinks.length} video per ${squadra.facebook_page_url}`);

      // Salva i video in Supabase
      for (const url of uniqueVideoLinks) {
        const { data, error } = await supabase
          .from('highlights_partite')
          .upsert(
            {
              id_squadra_autore: squadra.id_squadra,
              video_url: url
            },
            { onConflict: 'video_url' }
          );

        if (error) {
          console.error(`❌ Errore salvataggio Supabase per ${url}:`, error.message);
        } else {
          console.log(`✅ Inserito con successo: ${url}`);
        }
      }

    } catch (e) {
      console.error(`Errore durante lo scraping di ${squadra.facebook_page_url}:`, e.message);
    } finally {
      // Chiude la singola scheda per liberare subito la RAM
      await page.close();
    }
  }

          if (error) {
            console.error(`❌ Errore salvataggio Supabase per ${url}:`, error.message, error.details);
          } else {
            console.log(`✅ Inserito/Aggiornato con successo: ${url}`);
          }
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
