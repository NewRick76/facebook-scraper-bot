import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: {
    timeout: 0,
    params: {
      eventsPerSecond: 0
    }
  }
});

// Mappa di sinonimi/nomi brevi usati sui social per le squadre
const NOMI_SQUADRE_MAP = {
  'agrigento': ['agrigento', 'moncada'],
  'omenga': ['omegna', 'fulgor'],
  'imola': ['imola', 'andrea costa'],
  'roma': ['roma', 'virtus roma'],
  // Aggiungi qui altri alias se li trovi nei post
};

function classificaTitoloVideo(testo) {
  if (!testo) return null;
  const t = testo.toLowerCase();

  if (
    t.includes('highlight') || t.includes('sintesi') ||
    t.includes('azioni salienti') || t.includes('top 10') ||
    t.includes('best of') || t.includes('mini film') || t.includes('canestri')
  ) {
    return 'Highlights';
  }

  if (
    t.includes('conferenza') || t.includes('postpartita') ||
    t.includes('post-partita') || t.includes('post gara') ||
    t.includes('dopo gara') || t.includes('intervist') ||
    t.includes('dopo match') || t.includes('sala stampa') ||
    t.includes('commenta') || t.includes('commento')
  ) {
    return 'Post-Partita';
  }

  if (
    t.includes('prepartita') || t.includes('pre-partita') ||
    t.includes('pre gara') || t.includes('anteprima') ||
    t.includes('presentazione gara') || t.includes('alla vigilia') ||
    t.includes('verso ') || t.includes('in vista') || t.includes('parla in vista')
  ) {
    return 'Prepartita';
  }

  if (t.includes('coach') || t.includes('parole')) {
    if (t.includes('dopo') || t.includes('vittoria') || t.includes('sconfitta')) return 'Post-Partita';
    if (t.includes('sfida') || t.includes('match') || t.includes('prossim')) return 'Prepartita';
  }

  return null;
}

// Calcola la differenza in giorni tra due date
function differenzaGiorni(d1, d2) {
  const diffTime = Math.abs(d1 - d2);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

app.get('/scrape', async (req, res) => {
  res.json({ message: "Scraping avviato in background..." });

  try {
    const { data: squadre } = await supabase.from('squadre').select('id_squadra, nome, facebook_page_url');
    const { data: tutteLePartite } = await supabase.from('partite').select('id_partita, id_squadra_casa, id_squadra_ospite, data_partita, id_giornata');

    if (!squadre || !tutteLePartite) return;

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    for (const squadra of squadre) {
      if (!squadra.facebook_page_url) continue;

      console.log(`Scansione per: ${squadra.facebook_page_url}`);
      const page = await browser.newPage();

      try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
          else req.continue();
        });

        const targetUrl = squadra.facebook_page_url.endsWith('/')
          ? `${squadra.facebook_page_url}videos/`
          : `${squadra.facebook_page_url}/videos/`;

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });

        for (let i = 0; i < 7; i++) {
          await page.evaluate(() => window.scrollBy(0, 1200));
          await new Promise((r) => setTimeout(r, 1200));
        }

        // Estrazione dati post (URL, Testo e Data di pubblicazione)
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
              
              // Tenta di estrarre il tag dell'ora/data dal post di Facebook
              const timeEl = article?.querySelector('time');
              const postDate = timeEl ? timeEl.getAttribute('datetime') : null;

              results.push({
                url: href,
                fullText: parentText,
                postDate: postDate ? new Date(postDate) : new Date() // Fallback a oggi se assente
              });
            }
          });
          return results;
        });

        // Partite della squadra corrente
        const partiteSquadra = tutteLePartite.filter(
          p => p.id_squadra_casa === squadra.id_squadra || p.id_squadra_ospite === squadra.id_squadra
        );

        for (const item of rawItems) {
          const categoriaTitolo = classificaTitoloVideo(item.fullText);
          if (!categoriaTitolo) continue;

          const testoLower = item.fullText.toLowerCase();
          let partitaScelta = null;

          // 1. Cercare se il testo menziona l'avversario
          for (const avversario of squadre) {
            if (avversario.id_squadra === squadra.id_squadra) continue; // Salta se stessa

            const nomeAvversarioLower = avversario.nome.toLowerCase();
            const aliasList = NOMI_SQUADRE_MAP[nomeAvversarioLower] || [nomeAvversarioLower];

            const trovato = aliasList.some(alias => testoLower.includes(alias));

            if (trovato) {
              // Trova i due match (Andata e Ritorno) contro questo avversario
              const matchScontri = partiteSquadra.filter(
                p => p.id_squadra_casa === avversario.id_squadra || p.id_squadra_ospite === avversario.id_squadra
              );

              if (matchScontri.length === 1) {
                partitaScelta = matchScontri[0];
              } else if (matchScontri.length > 1) {
                // Se ce ne sono due, scegli quella più vicina alla data del post su Facebook
                const dataPost = new Date(item.postDate);
                matchScontri.sort((a, b) => {
                  const diffA = differenzaGiorni(dataPost, new Date(a.data_partita));
                  const diffB = differenzaGiorni(dataPost, new Date(b.data_partita));
                  return diffA - diffB;
                });
                partitaScelta = matchScontri[0]; // Prende la più vicina nel tempo
              }
              break;
            }
          }

          // 2. Se l'avversario non è trovato nel testo, cerca solo in base alla data_partita più vicina
          if (!partitaScelta && partiteSquadra.length > 0) {
            const dataPost = new Date(item.postDate);
            partiteSquadra.sort((a, b) => {
              const diffA = differenzaGiorni(dataPost, new Date(a.data_partita));
              const diffB = differenzaGiorni(dataPost, new Date(b.data_partita));
              return diffA - diffB;
            });
            partitaScelta = partiteSquadra[0];
          }

          if (!partitaScelta) continue;

          // Inserimento finale nel DB con id_partita reale
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

          console.log(`✅ Inserito [${categoriaTitolo}] per Partita ID ${partitaScelta.id_partita}: ${item.url}`);
        }

      } catch (e) {
        console.error(`Errore scraping ${squadra.facebook_page_url}:`, e.message);
      } finally {
        if (!page.isClosed()) await page.close();
      }
    }

    await browser.close();
  } catch (err) {
    console.error('Errore generale:', err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
