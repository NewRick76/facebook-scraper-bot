import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { exec } from 'child_process';

const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ===================== CONFIGURAZIONE =====================
// Metti true SOLO se durata_formattata NON si calcola da sola dal valore di durata_secondi
const SCRIVI_DURATA_FORMATTATA = false;

// Video più vecchi di questa data vengono ignorati (puoi cambiarla con la variabile d'ambiente DATA_MINIMA)
const DATA_MINIMA = new Date(process.env.DATA_MINIMA || '2026-09-22T00:00:00+02:00');

// Se true, scarta anche i video di cui non si riesce a leggere la data
const SCARTA_SE_DATA_SCONOSCIUTA = false;

// Quante volte provare una pagina (con browser nuovo) se Facebook mostra il login
const MAX_TENTATIVI = 2;

// Tempo massimo per una singola squadra (tutti i tentativi compresi)
const TIMEOUT_SQUADRA_MS = 150000;
// ==========================================================

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

// Stima la data di pubblicazione del video da attributo datetime o da righe brevi tipo "3 sett.", "ieri", "5 ott"
function stimaDataVideo(item) {
  const adesso = new Date();

  if (item.postDate) {
    const d = new Date(item.postDate);
    if (!isNaN(d.getTime())) return d;
  }

  const mesi = { gen: 0, feb: 1, mar: 2, apr: 3, mag: 4, giu: 5, lug: 6, ago: 7, set: 8, ott: 9, nov: 10, dic: 11 };

  for (const riga of item.righe || []) {
    const l = riga.toLowerCase().replace(/^[\s·•\-–—]+/, '');
    let m;

    if ((m = l.match(/^(\d+)\s*(?:min|minuti|minuto)\b/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 60000);
    if ((m = l.match(/^(\d+)\s*(?:h|ore|ora)\b/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 3600000);
    if ((m = l.match(/^(\d+)\s*(?:g|gg|giorni|giorno)\b/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 86400000);
    // "22 sett" con numero alto è con ogni probabilità "22 settembre" abbreviato: lo lascio all'ramo delle date assolute
    if ((m = l.match(/^(\d+)\s*(?:sett|settimane|settimana)\b/)) && parseInt(m[1], 10) <= 5) {
      return new Date(adesso.getTime() - parseInt(m[1], 10) * 7 * 86400000);
    }
    if ((m = l.match(/^(\d+)\s*(?:mesi|mese)\b/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 30 * 86400000);
    if ((m = l.match(/^(\d+)\s*(?:anni|anno)\b/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 365 * 86400000);
    if (/^ieri\b/.test(l)) return new Date(adesso.getTime() - 86400000);

    m = l.match(/^(\d{1,2})\s+(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[a-zà]*\.?(?:\s+(\d{4}))?/);
    if (m) {
      const giorno = parseInt(m[1], 10);
      const mese = mesi[m[2]];
      let anno = m[3] ? parseInt(m[3], 10) : adesso.getFullYear();
      let d = new Date(anno, mese, giorno, 12, 0, 0);
      // Senza anno esplicito, una data nel futuro è dell'anno scorso
      if (!m[3] && d.getTime() > adesso.getTime() + 86400000) {
        d = new Date(anno - 1, mese, giorno, 12, 0, 0);
      }
      return d;
    }
  }

  return null;
}

function differenzaGiorni(d1, d2) {
  const diffTime = Math.abs(d1 - d2);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout superato (${ms / 1000}s)`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// Ultima risorsa: uccide eventuali processi Chrome rimasti vivi (se pkill non esiste nel container, non fa nulla)
function pulisciChrome() {
  return new Promise((resolve) => {
    try {
      exec('pkill -9 chrome', () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

async function killBrowser(browser) {
  if (!browser) return;
  let proc = null;
  try { proc = browser.process(); } catch (e) {}

  try {
    await withTimeout(browser.close(), 5000);
  } catch (e) {}

  try {
    if (proc && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch (e) {
        proc.kill('SIGKILL');
      }
    }
  } catch (e) {}
}

// Lancia Chromium; se non parte (memoria satura) ripulisce e riprova una volta
async function apriBrowser(ctx) {
  const opzioni = {
    headless: 'new',
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--lang=it-IT'
    ]
  };

  try {
    ctx.browser = await puppeteer.launch(opzioni);
  } catch (err) {
    console.error(`⚠️ [LAUNCH] Chromium non è partito (${err.message}). Pulisco e riprovo.`);
    await pulisciChrome();
    await sleep(3000);
    ctx.browser = await puppeteer.launch(opzioni);
  }
  return ctx.browser;
}

// Costruisce l'URL della sezione video di una pagina Facebook
function costruisciUrlVideos(baseUrl) {
  if (baseUrl.includes('profile.php')) {
    return baseUrl.includes('?') ? `${baseUrl}&sk=videos` : `${baseUrl}?sk=videos`;
  }
  return baseUrl.endsWith('/') ? `${baseUrl}videos/` : `${baseUrl}/videos/`;
}

function paginaDiLogin(page) {
  try {
    return /facebook\.com\/(login|checkpoint)/i.test(page.url());
  } catch (e) {
    return false;
  }
}

// Prova a chiudere banner cookie e popup di login
async function gestisciPopup(page) {
  try {
    await withTimeout(
      page.evaluate(() => {
        const testi = [
          'rifiuta cookie facoltativi',
          'decline optional cookies',
          'consenti solo i cookie essenziali',
          'only allow essential cookies',
          'consenti tutti i cookie',
          'allow all cookies',
          'accetta tutti',
          'consenti cookie essenziali e facoltativi'
        ];
        const bottoni = Array.from(document.querySelectorAll('div[role="button"], button, span'));
        for (const testo of testi) {
          const b = bottoni.find((el) => (el.innerText || '').trim().toLowerCase() === testo);
          if (b) {
            b.click();
            break;
          }
        }

        const chiudi = document.querySelector(
          'div[role="dialog"] [aria-label="Chiudi"], div[role="dialog"] [aria-label="Close"]'
        );
        if (chiudi) chiudi.click();
      }),
      3000
    );
  } catch (e) {}

  try {
    await page.keyboard.press('Escape');
  } catch (e) {}
}

// Diagnostica: aiuta a capire perché una pagina restituisce 0 video
async function diagnosticaPagina(page, nomeSquadra) {
  try {
    const info = await withTimeout(
      page.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return {
          url: location.href,
          title: document.title,
          loginForm: !!document.querySelector('input[name="pass"]'),
          testoLogin: body.includes('accedi a facebook') || body.includes('log in to facebook') || body.includes('devi accedere') || body.includes('you must log in'),
          testoCookie: body.includes('cookie'),
          nLinkTotali: document.querySelectorAll('a').length,
          nLinkVideoLike: document.querySelectorAll('a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch"]').length,
          snippet: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200)
        };
      }),
      4000
    );
    console.log(`🩺 [DIAGNOSI] ${nomeSquadra}:`, JSON.stringify(info));
  } catch (e) {
    console.log(`🩺 [DIAGNOSI] ${nomeSquadra}: impossibile leggere la pagina (${e.message})`);
  }
}

// Estrazione video dalla pagina corrente (una passata leggera + deduplicazione per ID video)
async function estraiVideo(page) {
  return withTimeout(
    page.evaluate(() => {
      const regexDurata = /^\d{1,2}:\d{2}(?::\d{2})?$/;

      const toIso = (s) => {
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d.toISOString();
      };

      const idDa = (u) => {
        const m =
          u.match(/\/videos\/(?:[^\/?]+\/)?(\d{6,})/) ||
          u.match(/\/reel\/(\d+)/) ||
          u.match(/[?&]v=(\d+)/);
        return m ? m[1] : u.split('?')[0];
      };

      // 1. Link video validi
      const videoLinks = [];
      document.querySelectorAll('a').forEach((a) => {
        const href = a.href || '';
        const isVideo = href.includes('/videos/') || href.includes('/watch') || href.includes('/reel/') || href.includes('story.php');
        const isNotGeneric = href !== 'https://www.facebook.com/watch/' && !href.endsWith('/videos/') && !href.endsWith('/videos');
        if (isVideo && isNotGeneric) {
          videoLinks.push({ el: a, url: href.split('?')[0], id: idDa(href) });
        }
      });

      // 2. Elementi foglia il cui testo è ESATTAMENTE una durata
      const durataEls = [];
      document.querySelectorAll('span, div').forEach((el) => {
        if (el.children.length === 0) {
          const txt = (el.textContent || '').trim();
          if (txt.length <= 8 && regexDurata.test(txt)) {
            durataEls.push({ el, txt });
          }
        }
      });

      // 3. Associazione link -> durata / data, deduplicando per ID video
      const mappa = new Map();

      for (const link of videoLinks) {
        let durata = null;

        const testoLink = (link.el.innerText || '').trim();
        const matchLink = testoLink.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
        if (matchLink && regexDurata.test(matchLink[1]) && testoLink.length <= 12) {
          durata = matchLink[1];
        }

        // Risale fino a 6 livelli, fermandosi quando il contenitore include più video diversi.
        // Tiene il contenitore più grande che contiene UN SOLO video (serve per durata e data).
        let contenitoreValido = null;
        let container = link.el;
        for (let i = 0; i < 6 && container; i++) {
          const idDiversi = new Set();
          for (const vl of videoLinks) {
            if (container.contains(vl.el)) idDiversi.add(vl.id);
            if (idDiversi.size > 1) break;
          }
          if (idDiversi.size > 1) break;

          contenitoreValido = container;

          if (!durata && durataEls.length > 0) {
            const trovata = durataEls.find((d) => container.contains(d.el));
            if (trovata) durata = trovata.txt;
          }

          container = container.parentElement;
        }

        const article = link.el.closest('div[role="article"]') || link.el.closest('div[data-s2n]') || link.el.parentElement;
        const parentText = article?.innerText || link.el.innerText || '';

        // Data: attributo datetime / data-utime, altrimenti restano le righe brevi per il parsing lato Node
        const radice = contenitoreValido || article;
        let postDate = null;
        const timeEl = (radice && radice.querySelector('time[datetime]')) || (article && article.querySelector('time[datetime]'));
        if (timeEl) {
          postDate = toIso(timeEl.getAttribute('datetime'));
        } else {
          const abbr = radice && radice.querySelector('abbr[data-utime]');
          if (abbr) {
            const secondi = parseInt(abbr.getAttribute('data-utime'), 10);
            if (!isNaN(secondi)) postDate = toIso(secondi * 1000);
          }
        }

        const testoContenitore = radice ? (radice.innerText || '') : '';
        const righe = testoContenitore
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s && s.length <= 60)
          .slice(0, 25);

        const esistente = mappa.get(link.id);
        if (esistente) {
          if (!esistente.durata && durata) esistente.durata = durata;
          if (parentText.length > esistente.fullText.length) esistente.fullText = parentText;
          if (!esistente.postDate && postDate) esistente.postDate = postDate;
          for (const r of righe) {
            if (!esistente.righe.includes(r)) esistente.righe.push(r);
          }
          esistente.righe = esistente.righe.slice(0, 40);
          // Tiene l'URL più lungo (quello con lo slug), che è il più stabile tra le esecuzioni
          if (link.url.length > esistente.url.length) esistente.url = link.url;
        } else {
          mappa.set(link.id, {
            id: link.id,
            url: link.url,
            fullText: parentText,
            durata,
            postDate,
            righe
          });
        }
      }

      return Array.from(mappa.values());
    }),
    15000
  );
}

// Un tentativo completo con un browser nuovo. Il browser viene SEMPRE chiuso alla fine.
async function tentaEstrazione(squadra, ctx) {
  const browser = await apriBrowser(ctx);

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(25000);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' });

    // Risparmia memoria: niente video e font (le durate sono testo, quindi non servono)
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const tipo = req.resourceType();
        if (tipo === 'media' || tipo === 'font') {
          Promise.resolve(req.abort()).catch(() => {});
        } else {
          Promise.resolve(req.continue()).catch(() => {});
        }
      });
    } catch (e) {}

    const urlVideos = costruisciUrlVideos(squadra.facebook_page_url);
    await page.goto(urlVideos, { waitUntil: 'domcontentloaded', timeout: 25000 });

    if (paginaDiLogin(page)) return { items: [], loginWall: true, errore: false };

    await sleep(1500);
    await gestisciPopup(page);

    if (paginaDiLogin(page)) return { items: [], loginWall: true, errore: false };

    // Aspetta che compaia almeno un link video (non bloccante)
    await page
      .waitForSelector('a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch"]', { timeout: 7000 })
      .catch(() => {});

    for (let i = 0; i < 4; i++) {
      await withTimeout(page.evaluate(() => window.scrollBy(0, 1500)), 2000).catch(() => {});
      await sleep(700);
      if (i === 1) await gestisciPopup(page);
    }

    if (paginaDiLogin(page)) return { items: [], loginWall: true, errore: false };

    const items = await estraiVideo(page);

    if (items.length === 0) {
      await diagnosticaPagina(page, squadra.nome);
    }

    return { items, loginWall: false, errore: false };
  } catch (err) {
    console.error(`⚠️ [TENTATIVO] ${squadra.nome}: ${err.message}`);
    return { items: [], loginWall: false, errore: true };
  } finally {
    await killBrowser(browser);
    ctx.browser = null;
  }
}

async function scansionaSquadra(squadra, tutteLeSquadre, tutteLePartite, ctx) {
  try {
    // ---------- FASE 1: estrazione (con retry in caso di login wall o errore) ----------
    let rawItems = [];
    let ultimoLoginWall = false;

    for (let t = 1; t <= MAX_TENTATIVI && !ctx.annullato; t++) {
      const esito = await tentaEstrazione(squadra, ctx);
      rawItems = esito.items;
      ultimoLoginWall = esito.loginWall;

      if (rawItems.length > 0) break;
      if (!esito.loginWall && !esito.errore) break; // pagina caricata ma davvero senza video: inutile riprovare

      if (t < MAX_TENTATIVI) {
        console.log(`🔁 [RETRY] ${squadra.nome}: ${esito.loginWall ? 'Facebook mostra il login' : 'errore'}, riprovo con un browser nuovo (tentativo ${t + 1}/${MAX_TENTATIVI}).`);
        await sleep(4000 + Math.random() * 4000);
      }
    }

    if (ctx.annullato) return;

    if (rawItems.length === 0 && ultimoLoginWall) {
      console.log(`🚧 [LOGIN WALL] ${squadra.nome}: Facebook ha reindirizzato al login anche dopo ${MAX_TENTATIVI} tentativi.`);
    }

    const conDurata = rawItems.filter((r) => r.durata).length;
    const dateStimate = new Map();
    for (const item of rawItems) dateStimate.set(item.id, stimaDataVideo(item));
    const conData = rawItems.filter((r) => dateStimate.get(r.id)).length;

    console.log(`🔍 [DEBUG] ${squadra.nome}: Trovati ${rawItems.length} elementi univoci (${conDurata} con durata, ${conData} con data).`);

    // Aiuto per capire come Facebook mostra la data quando non riusciamo a leggerla
    let campioni = 0;
    for (const item of rawItems) {
      if (!dateStimate.get(item.id) && campioni < 2) {
        console.log(`🧪 [DATA?] ${squadra.nome}: data non leggibile. Righe brevi del contenitore:`, JSON.stringify((item.righe || []).slice(0, 10)));
        campioni++;
      }
    }

    // ---------- FASE 2: abbinamento alle partite e salvataggio ----------
    const avversariStessoGirone = squadra.girone
      ? tutteLeSquadre.filter(s => s.girone === squadra.girone && s.id_squadra !== squadra.id_squadra)
      : tutteLeSquadre.filter(s => s.id_squadra !== squadra.id_squadra);

    const partiteSquadra = tutteLePartite.filter(
      p => p.id_squadra_casa === squadra.id_squadra || p.id_squadra_ospite === squadra.id_squadra
    );

    let scartatiData = 0;
    let dataSconosciuta = 0;
    let scartatiClassificazione = 0;
    let scartatiPartita = 0;

    for (const item of rawItems) {
      // Filtro data
      const dataVideo = dateStimate.get(item.id) || null;
      if (dataVideo) {
        if (dataVideo.getTime() < DATA_MINIMA.getTime()) {
          scartatiData++;
          console.log(`      ⏭️ Scartato per data (${dataVideo.toLocaleDateString('it-IT')}): ${item.url}`);
          continue;
        }
      } else {
        dataSconosciuta++;
        if (SCARTA_SE_DATA_SCONOSCIUTA) continue;
      }

      const categoriaTitolo = classificaTitoloVideo(item.fullText);
      if (!categoriaTitolo) {
        scartatiClassificazione++;
        continue;
      }

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
        const dataPost = dataVideo || new Date();
        partiteCandidate.sort((a, b) => {
          return differenzaGiorni(dataPost, new Date(a.data_partita)) - differenzaGiorni(dataPost, new Date(b.data_partita));
        });
        partitaScelta = partiteCandidate[0];
      }

      if (!partitaScelta) {
        scartatiPartita++;
        continue;
      }

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
        console.log(`      🎉 SALVATAGGIO OK -> [${categoriaTitolo}] (Durata: ${item.durata || 'N/D'}${dataVideo ? ', Data: ' + dataVideo.toLocaleDateString('it-IT') : ''}) Partita ID ${partitaScelta.id_partita}: ${item.url}`);
      }
    }

    if (rawItems.length > 0) {
      console.log(`📊 [RIEPILOGO] ${squadra.nome}: ${scartatiData} scartati per data (prima del ${DATA_MINIMA.toLocaleDateString('it-IT')}), ${scartatiClassificazione} dal classificatore, ${scartatiPartita} senza partita abbinata, ${dataSconosciuta} senza data leggibile${SCARTA_SE_DATA_SCONOSCIUTA ? ' (scartati)' : ' (salvati comunque)'}.`);
    }
  } catch (err) {
    console.error(`❌ [ERRORE CRITICO] Squadra ${squadra.nome}:`, err.message);
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

      await pulisciChrome();

      const ctx = { browser: null, annullato: false };
      try {
        await withTimeout(scansionaSquadra(squadra, tutteSquadre, tutteLePartite, ctx), TIMEOUT_SQUADRA_MS);
      } catch (err) {
        ctx.annullato = true;
        console.error(`⚠️ Salto ${squadra.nome}: ${err.message}`);
      } finally {
        // Qualunque cosa sia successa, il browser di questa squadra deve morire
        await killBrowser(ctx.browser);
        ctx.browser = null;
      }

      await sleep(2500 + Math.random() * 3000);
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
