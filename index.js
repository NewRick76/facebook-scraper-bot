import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Metti true SOLO se durata_formattata NON si calcola da sola dal valore di durata_secondi
const SCRIVI_DURATA_FORMATTATA = false;

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

// Converte "2:48" o "1:02:30" in secondi
function durataInSecondi(str) {
  if (!str) return null;
  const parti = str.trim().split(':').map(Number);
  if (parti.some((n) => Number.isNaN(n))) return null;
  if (parti.length === 3) return parti[0] * 3600 + parti[1] * 60 + parti[2];
  if (parti.length === 2) return parti[0] * 60 + parti[1];
  return null;
}

// Converte secondi in "m:ss" oppure "h:mm:ss"
function secondiInFormattata(secondi) {
  if (secondi == null) return null;
  const h = Math.floor(secondi / 3600);
  const m = Math.floor((secondi % 3600) / 60);
  const s = secondi % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
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
    if (proc && proc.pid) {
      process.kill(-proc.pid, 'SIGKILL');
    }
  } catch (e) {
    try {
      const proc = browser.process();
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch (err) {}
  }
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
        '--disable-software-rasterizer',
        '--disable-extensions'
      ]
    });

    page = await browser.newPage();
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(25000);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let targetUrl = squadra.facebook_page_url;
    if (targetUrl.includes('profile.php')) {
      targetUrl = targetUrl.includes('?')
        ? `${targetUrl}&sk=videos`
        : `${targetUrl}?sk=videos`;
    } else {
      targetUrl = targetUrl.endsWith('/') ? `${targetUrl}videos/` : `${targetUrl}/videos/`;
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    for (let i = 0; i < 4; i++) {
      await withTimeout(page.evaluate(() => window.scrollBy(0, 1500)), 2000).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
    }

    // ESTRAZIONE LEGGERA: una sola passata per trovare le durate, poi associazione ai link
    let rawItems = [];
    try {
      rawItems = await withTimeout(
        page.evaluate(() => {
          const regexDurata = /^\d{1,2}:\d{2}(?::\d{2})?$/;

          // 1. Link video validi (una sola passata sui link)
          const videoLinks = [];
          document.querySelectorAll('a').forEach((a) => {
            const href = a.href || '';
            const isVideo = href.includes('/videos/') || href.includes('/watch') || href.includes('/reel/') || href.includes('story.php');
            const isNotGeneric = href !== 'https://www.facebook.com/watch/' && !href.endsWith('/videos/') && !href.endsWith('/videos');
            if (isVideo && isNotGeneric) {
              videoLinks.push({ el: a, url: href.split('?')[0] });
            }
          });

          // 2. Elementi "foglia" il cui testo è ESATTAMENTE una durata (una sola passata sul DOM)
          const durataEls = [];
          document.querySelectorAll('span, div').forEach((el) => {
            if (el.children.length === 0) {
              const txt = (el.textContent || '').trim();
              if (txt.length <= 8 && regexDurata.test(txt)) {
                durataEls.push({ el, txt });
              }
            }
          });

          // 3. Per ogni link, risali pochi livelli e cerca una durata contenuta
          //    nell'antenato, fermandoti se l'antenato contiene più video diversi
          const mappa = new Map();

          for (const link of videoLinks) {
            let durata = null;

            // Il testo del link stesso può già essere la durata
            const testoLink = (link.el.innerText || '').trim();
            const matchLink = testoLink.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
            if (matchLink && regexDurata.test(matchLink[1]) && testoLink.length <= 12) {
              durata = matchLink[1];
            }

            if (!durata && durataEls.length > 0) {
              let container = link.el;
              for (let i = 0; i < 6 && container && !durata; i++) {
                const urlDiversi = new Set();
                for (const vl of videoLinks) {
                  if (container.contains(vl.el)) urlDiversi.add(vl.url);
                  if (urlDiversi.size > 1) break;
                }
                if (urlDiversi.size > 1) break; // contenitore troppo ampio

                const trovata = durataEls.find((d) => container.contains(d.el));
                if (trovata) durata = trovata.txt;

                container = container.parentElement;
              }
            }

            const article = link.el.closest('div[role="article"]') || link.el.closest('div[data-s2n]') || link.el.parentElement;
            const parentText = article?.innerText || link.el.innerText || '';
            const timeEl = article?.querySelector('time');
            const postDate = timeEl ? timeEl.getAttribute('datetime') : null;

            const esistente = mappa.get(link.url);
            if (esistente) {
              if (!esistente.durata && durata) esistente.durata = durata;
              if (parentText.length > esistente.fullText.length) esistente.fullText = parentText;
              if (!esistente.postDate && postDate) esistente.postDate = new Date(postDate).toISOString();
            } else {
              mappa.set(link.url, {
                url: link.url,
                fullText: parentText,
                durata,
                postDate: postDate ? new Date(postDate).toISOString() : null
              });
            }
          }

          return Array.from(mappa.values());
        }),
        15000
      );
    } catch (errEstrazione) {
      console.error(`⚠️ [ESTRAZIONE] ${squadra.nome}: ${errEstrazione.message}`);
      rawItems = [];
    }

    const conDurata = rawItems.filter((r) => r.durata).length;
    console.log(`🔍 [DEBUG] ${squadra.nome}: Trovati ${rawItems.length} elementi univoci (${conDurata} con durata).`);

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

      let partitaScelta = null;

      if (partiteCandidate.length === 1) {
        partitaScelta = partiteCandidate[0];
      } else if (partiteCandidate.length > 1) {
        const dataPost = item.postDate ? new Date(item.postDate) : new Date();
        partiteCandidate.sort((a, b) => {
          return differenzaGiorni(dataPost, new Date(a.data_partita)) - differenzaGiorni(dataPost, new Date(b.data_partita));
        });
        partitaScelta = partiteCandidate[0];
      }

      if (!partitaScelta) continue;

      const payloadUpsert = {
        id_partita: partitaScelta.id_partita,
        id_squadra_autore: squadra.id_squadra,
        video_url: item.url,
        titolo: categoriaTitolo,
        piattaforma: 'facebook'
      };

      // La durata viene scritta solo se trovata, così non sovrascrive valori già presenti con null
      const secondi = durataInSecondi(item.durata);
      if (secondi != null) {
        payloadUpsert.durata_secondi = secondi;
        if (SCRIVI_DURATA_FORMATTATA) {
          payloadUpsert.durata_formattata = secondiInFormattata(secondi);
        }
      }

      const { error: dbError } = await supabase.from('highlights_partite').upsert(
        payloadUpsert,
        { onConflict: 'video_url' }
      );

      if (dbError) {
        console.error(`      ❌ Errore Supabase UPSERT:`, dbError.message);
      } else {
        console.log(`      🎉 SALVATAGGIO OK -> [${categoriaTitolo}] (Durata: ${item.durata || 'N/D'}) Partita ID ${partitaScelta.id_partita}: ${item.url}`);
      }
    }

  } catch (err) {
    console.error(`❌ [ERRORE CRITICO] Squadra ${squadra.nome}:`, err.message);
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

      console.log(`\n========================================`);
      console.log(`Scansione (${counter}/${tutteSquadre.length}) per: ${squadra.nome}`);
      console.log(`========================================`);

      try {
        await withTimeout(scansionaSquadra(squadra, tutteSquadre, tutteLePartite), 45000);
      } catch (err) {
        console.error(`⚠️ Salto ${squadra.nome}: ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, 1000));
      if (global.gc) global.gc();
    }

    console.log(`\n🎉 Scraping completato per il blocco ${offset} - ${offset + squadreSelezionate.length}!`);
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
