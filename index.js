import express from 'express';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { exec } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ ERRORE: Verificare che nel file .env ci siano SUPABASE_URL e SUPABASE_KEY valide!");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

// Intercettazione dei log per mostrarli nella pagina HTML della Dashboard
let logBuffer = [];
const maxLogLines = 200;

function logToBuffer(tipo, args) {
  const messaggio = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  const timestamp = new Date().toLocaleTimeString('it-IT');
  logBuffer.push(`[${timestamp}] ${messaggio}`);
  if (logBuffer.length > maxLogLines) {
    logBuffer.shift();
  }
}

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function(...args) {
  originalConsoleLog.apply(console, args);
  logToBuffer('LOG', args);
};

console.error = function(...args) {
  originalConsoleError.apply(console, args);
  logToBuffer('ERR', args);
};

// ===================== CONFIGURAZIONE =====================
const DATA_MINIMA = new Date(process.env.DATA_MINIMA || '2026-09-22T00:00:00+02:00');
const SCARTA_SE_DATA_SCONOSCIUTA = true;

// Pausa prudente tra una squadra e l'altra per proteggere l'IP da Render
const PAUSA_TRA_SQUADRE_MIN_MS = 8000;
const PAUSA_TRA_SQUADRE_RANDOM_MS = 7000;
const TIMEOUT_SQUADRA_MS = 180000;
// ==========================================================

const NOMI_SQUADRE_MAP = {
  'agrigento': ['agrigento', 'moncada'],
  'omegna': ['omegna', 'fulgor', 'paffoni'],
  'imola': ['imola', 'andrea costa'],
  'virtus gvm roma 1960': ['virtus roma', 'roma 1960', 'virtus gvm'],
  'luiss roma': ['luiss', 'luiss roma'],
  'cestistica san severo': ['san severo', 'sansevero', 'cestistica san severo'],
  'faenza': ['faenza', 'raggisolaris', 'tema sinergie'],
  'siena': ['siena', 'mens sana'],
  'ltc group sangiorgese basket': ['sangiorgese'],
  'ucc assigeco piacenza': ['assigeco'],
  'myenergy reggio calabria': ['reggio calabria', 'viola reggio'],
  'felice scandone avellino': ['scandone', 'scandone avellino'],
  'halley campania avellino basket': ['avellino basket'],
  'basketball club lucca': ['basketball lucca', 'bc lucca'],
  'consultinvest loreto pesaro': ['loreto pesaro', 'loreto']
};

let isScrapingRunning = false;

function formattaData(d) {
  return d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
}

function classificaTitoloVideo(testo) {
  if (!testo) return null;
  const t = testo.toLowerCase();

  if (
    t.includes('allenament') || t.includes('training') ||
    t.includes('dietro le quinte') || t.includes('backstage') ||
    t.includes('minibasket') || t.includes('giovanil') ||
    t.includes('scuola basket') || t.includes('presentazione del main') ||
    t.includes('presentazione maglie') || t.includes('presentazione roster') ||
    t.includes('presentazione squadra') || t.includes('presentazione giocatore') ||
    t.includes('presentazione acquisto') || t.includes('conferme roster') ||
    t.includes('nuovo acquisto') || t.includes('nuovo giocatore') ||
    t.includes('benvenuto') || t.includes('firmato') || t.includes('ingaggio')
  ) {
    return null;
  }

  if (
    t.includes('highlight') || t.includes('sintesi') ||
    t.includes('azioni salienti') || t.includes('top 10') ||
    t.includes('best of') || t.includes('mini film') ||
    (t.includes('canestri') && !t.includes('minibasket'))
  ) {
    return 'Highlights';
  }

  if (
    t.includes('postpartita') || t.includes('post-partita') ||
    t.includes('post gara') || t.includes('dopo gara') ||
    t.includes('dopo match') || t.includes('commento al match') ||
    t.includes('commento del') || t.includes('commento di') ||
    t.includes('al termine della') || t.includes('al termine del') ||
    t.includes('al termine di') || t.includes('commenta la vittoria') ||
    t.includes('commenta la sconfitta') || t.includes('dichiarazioni a caldo') ||
    t.includes('intervista') || t.includes('le parole di') ||
    (t.includes('conferenza') && !t.includes('roster') && !t.includes('sponsor')) ||
    (t.includes('sala stampa') && !t.includes('presentazione roster') && !t.includes('presentazione gara'))
  ) {
    return 'Post-Partita';
  }

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
    if (t.includes(`${parola} giornata`)) return num;
  }
  return null;
}

function durataInSecondi(str) {
  if (!str) return null;
  const parti = str.trim().split(':').map(Number);
  if (parti.some((n) => Number.isNaN(n))) return null;
  if (parti.length === 3) return parti[0] * 3600 + parti[1] * 60 + parti[2];
  if (parti.length === 2) return parti[0] * 60 + parti[1];
  return null;
}

function stimaDataVideo(item) {
  const adesso = new Date();
  if (item.postDate) {
    const d = new Date(item.postDate);
    if (!isNaN(d.getTime())) return d;
  }

  const MESI = { gen: 0, jan: 0, feb: 1, mar: 2, apr: 3, mag: 4, may: 4, giu: 5, jun: 5, lug: 6, jul: 6, ago: 7, aug: 7, set: 8, sep: 8, ott: 9, oct: 9, nov: 10, dic: 11, dec: 11 };
  const REGEX_MESE = '(gen|jan|feb|mar|apr|mag|may|giu|jun|lug|jul|ago|aug|set|sep|ott|oct|nov|dic|dec)[a-zà]*\\.?';

  const costruisciData = (giorno, meseKey, annoStr) => {
    const mese = MESI[meseKey];
    if (mese === undefined) return null;
    const anno = annoStr ? parseInt(annoStr, 10) : adesso.getFullYear();
    let d = new Date(anno, mese, giorno, 12, 0, 0);
    if (!annoStr && d.getTime() > adesso.getTime() + 86400000) {
      d = new Date(anno - 1, mese, giorno, 12, 0, 0);
    }
    return d;
  };

  for (const riga of item.righe || []) {
    const l = riga.toLowerCase().replace(/^[\s·•\-–—]+/, '').trim();
    let m;
    if (/^(just now|adesso|ora|proprio ora)$/.test(l)) return adesso;
    if ((m = l.match(/^(\d+)\s*(?:min|mins|minute|minutes|minuti|minuto|m)\b(?:\s*ago|\s*fa)?$/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 60000);
    if ((m = l.match(/^(\d+)\s*(?:h|hr|hrs|hour|hours|ore|ora)\b(?:\s*ago|\s*fa)?$/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 3600000);
    if ((m = l.match(/^(\d+)\s*(?:d|day|days|g|gg|giorni|giorno)\b(?:\s*ago|\s*fa)?$/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 86400000);
    if ((m = l.match(/^(\d+)\s*(?:w|wk|wks|week|weeks|sett|settimane|settimana)\b(?:\s*ago|\s*fa)?$/)) && parseInt(m[1], 10) <= 5) {
      return new Date(adesso.getTime() - parseInt(m[1], 10) * 7 * 86400000);
    }
    if ((m = l.match(/^(\d+)\s*(?:month|months|mesi|mese)\b(?:\s*ago|\s*fa)?$/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 30 * 86400000);
    if ((m = l.match(/^(\d+)\s*(?:y|yr|yrs|year|years|anni|anno)\b(?:\s*ago|\s*fa)?$/))) return new Date(adesso.getTime() - parseInt(m[1], 10) * 365 * 86400000);
    if (/^(yesterday|ieri)\b/.test(l)) return new Date(adesso.getTime() - 86400000);

    m = l.match(new RegExp(`^(\\d{1,2})\\s+${REGEX_MESE}(?:,?\\s+(\\d{4}))?`));
    if (m) {
      const d = costruisciData(parseInt(m[1], 10), m[2], m[3]);
      if (d) return d;
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

function pulisciChrome() {
  return new Promise((resolve) => {
    try { exec('pkill -9 chrome', () => resolve()); } catch (e) { resolve(); }
  });
}

async function killBrowser(browser) {
  if (!browser) return;
  let proc = null;
  try { proc = browser.process(); } catch (e) {}
  try { await withTimeout(browser.close(), 5000); } catch (e) {}
  try { if (proc && proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch (e) {}
}

async function apriBrowser(ctx) {
  const opzioni = {
    headless: 'new',
    timeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--lang=it-IT']
  };
  try {
    ctx.browser = await puppeteer.launch(opzioni);
  } catch (err) {
    console.error(`⚠️ [LAUNCH] Errore avvio browser: ${err.message}`);
    await pulisciChrome();
    await sleep(3000);
    ctx.browser = await puppeteer.launch(opzioni);
  }
  return ctx.browser;
}

function costruisciUrlVideos(baseUrl) {
  if (baseUrl.includes('profile.php')) {
    return baseUrl.includes('?') ? `${baseUrl}&sk=videos` : `${baseUrl}?sk=videos`;
  }
  return baseUrl.endsWith('/') ? `${baseUrl}videos/` : `${baseUrl}/videos/`;
}

function paginaDiLogin(page) {
  try { return /facebook\.com\/(login|checkpoint)/i.test(page.url()); } catch (e) { return false; }
}

async function gestisciPopup(page) {
  try {
    await withTimeout(page.evaluate(() => {
      const testi = ['rifiuta cookie facoltativi', 'decline optional cookies', 'accetta tutti', 'allow all cookies'];
      const bottoni = Array.from(document.querySelectorAll('div[role="button"], button, span'));
      for (const testo of testi) {
        const b = bottoni.find((el) => (el.innerText || '').trim().toLowerCase() === testo);
        if (b) { b.click(); break; }
      }
    }), 3000);
  } catch (e) {}
  try { await page.keyboard.press('Escape'); } catch (e) {}
}

async function estraiVideo(page) {
  return withTimeout(page.evaluate(() => {
    const regexDurata = /^\d{1,2}:\d{2}(?::\d{2})?$/;
    const toIso = (s) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); };
    const idDa = (u) => {
      const m = u.match(/\/videos\/(?:[^\/?]+\/)?(\d{6,})/) || u.match(/\/reel\/(\d+)/) || u.match(/[?&]v=(\d+)/);
      return m ? m[1] : u.split('?')[0];
    };

    const videoLinks = [];
    document.querySelectorAll('a').forEach((a) => {
      const href = a.href || '';
      if ((href.includes('/videos/') || href.includes('/watch') || href.includes('/reel/')) && href !== 'https://www.facebook.com/watch/') {
        videoLinks.push({ el: a, url: href.split('?')[0], id: idDa(href) });
      }
    });

    const mappa = new Map();
    for (const link of videoLinks) {
      let durata = null;
      const testoLink = (link.el.innerText || '').trim();
      const matchLink = testoLink.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
      if (matchLink && regexDurata.test(matchLink[1])) durata = matchLink[1];

      let container = link.el;
      let radice = null;
      for (let i = 0; i < 5 && container; i++) {
        radice = container;
        container = container.parentElement;
      }

      const article = link.el.closest('div[role="article"]') || radice;
      const parentText = article?.innerText || link.el.innerText || '';
      const timeEl = article?.querySelector('time[datetime]');
      const postDate = timeEl ? toIso(timeEl.getAttribute('datetime')) : null;
      const righe = (article?.innerText || '').split('\n').map(s => s.trim()).filter(s => s && s.length <= 60).slice(0, 25);

      if (!mappa.has(link.id)) {
        mappa.set(link.id, { id: link.id, url: link.url, fullText: parentText, durata, postDate, righe });
      }
    }
    return Array.from(mappa.values());
  }), 15000);
}

// 1 TENTATIVO UNICO OTTIMIZZATO (Niente retry aggressivi che fanno scattare il ban IP)
async function tentaEstrazioneSingola(squadra, ctx) {
  const browser = await apriBrowser(ctx);
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    await page.goto(costruisciUrlVideos(squadra.facebook_page_url), { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (paginaDiLogin(page)) {
      console.log(`🚧 [LOGIN WALL] ${squadra.nome}: Facebook richiede il login.`);
      return { items: [], loginWall: true };
    }

    await sleep(1500);
    await gestisciPopup(page);
    if (paginaDiLogin(page)) return { items: [], loginWall: true };

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
      await sleep(1000);
    }

    const items = await estraiVideo(page);
    return { items, loginWall: false };
  } catch (err) {
    console.error(`⚠️ [TENTATIVO] ${squadra.nome}: ${err.message}`);
    return { items: [], loginWall: false };
  } finally {
    await killBrowser(browser);
    ctx.browser = null;
  }
}

async function scansionaSquadra(squadra, tutteLeSquadre, tutteLePartite, ctx) {
  const esito = await tentaEstrazioneSingola(squadra, ctx);
  const rawItems = esito.items;

  if (rawItems.length === 0) return;

  const dateStimate = new Map();
  for (const item of rawItems) dateStimate.set(item.id, stimaDataVideo(item));

  const conDurata = rawItems.filter((r) => r.durata).length;
  const conData = rawItems.filter((r) => dateStimate.get(r.id)).length;
  console.log(`🔍 [DEBUG] ${squadra.nome}: Trovati ${rawItems.length} elementi univoci (${conDurata} con durata, ${conData} con data).`);

  const avversariStessoGirone = squadra.girone
    ? tutteLeSquadre.filter(s => s.girone === squadra.girone && s.id_squadra !== squadra.id_squadra)
    : tutteLeSquadre.filter(s => s.id_squadra !== squadra.id_squadra);

  const partiteSquadra = tutteLePartite.filter(p => p.id_squadra_casa === squadra.id_squadra || p.id_squadra_ospite === squadra.id_squadra);

  let scartatiData = 0;
  let dataSconosciuta = 0;
  let scartatiClassificazione = 0;
  let scartatiPartita = 0;

  for (const item of rawItems) {
    const dataVideo = dateStimate.get(item.id) || null;
    if (dataVideo) {
      if (dataVideo.getTime() < DATA_MINIMA.getTime()) {
        scartatiData++;
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
      partiteCandidate = partiteCandidate.filter(p => p.id_squadra_casa === avversarioTrovato.id_squadra || p.id_squadra_ospite === avversarioTrovato.id_squadra);
    }

    if (partiteCandidate.length !== 1) {
      const numeroGiornataEstratto = estraiNumeroGiornata(item.fullText);
      if (numeroGiornataEstratto) {
        const filtratePerGiornata = partiteCandidate.filter(p => parseInt(p.id_giornata, 10) === numeroGiornataEstratto);
        if (filtratePerGiornata.length > 0) partiteCandidate = filtratePerGiornata;
      }
    }

    let partitaScelta = null;
    if (partiteCandidate.length === 1) {
      partitaScelta = partiteCandidate[0];
    } else if (partiteCandidate.length > 1) {
      const dataPost = dataVideo || new Date();
      partiteCandidate.sort((a, b) => differenzaGiorni(dataPost, new Date(a.data_partita)) - differenzaGiorni(dataPost, new Date(b.data_partita)));
      partitaScelta = partiteCandidate[0];
    }

    if (!partitaScelta) {
      scartatiPartita++;
      continue;
    }

    const payload = {
      id_partita: partitaScelta.id_partita,
      id_squadra_autore: squadra.id_squadra,
      video_url: item.url,
      titolo: categoriaTitolo,
      piattaforma: 'facebook',
      durata_secondi: durataInSecondi(item.durata)
    };

    const { error } = await supabase.from('highlights_partite').upsert(payload, { onConflict: 'video_url' });
    if (!error) {
      console.log(`🎉 [SALVATO] [${categoriaTitolo}] Squadra: ${squadra.nome} -> Partita ID ${partitaScelta.id_partita}`);
    }
  }

  console.log(`📊 [RIEPILOGO] ${squadra.nome}: ${scartatiData} scartati per data, ${scartatiClassificazione} dal classificatore, ${scartatiPartita} senza partita abbinata.`);
}

async function eseguiScrapingInBackground(offset, limit) {
  try {
    console.log(`\n🔍 [SUPABASE] Interrogazione tabelle in corso...`);
    const { data: tutteSquadre, error: errSquadre } = await supabase.from('squadre').select('id_squadra, nome, facebook_page_url, girone');
    const { data: tutteLePartite, error: errPartite } = await supabase.from('partite').select('id_partita, id_squadra_casa, id_squadra_ospite, data_partita, id_giornata');

    if (errSquadre || errPartite) {
      console.error(`❌ [SUPABASE ERRORE]:`, errSquadre?.message || errPartite?.message);
      return;
    }

    if (!tutteSquadre || tutteSquadre.length === 0) return;

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
        console.error(`⚠️ Salto ${squadra.nome}: ${err.message}`);
      } finally {
        await killBrowser(ctx.browser);
      }
      
      // Pausa sicura e rilassata per proteggere l'IP
      await sleep(PAUSA_TRA_SQUADRE_MIN_MS + Math.random() * PAUSA_TRA_SQUADRE_RANDOM_MS);
    }
    console.log(`\n🎉 Blocco ${offset} - ${offset + squadreSelezionate.length} completato!`);
  } catch (err) {
    console.error('❌ Errore generale nello scraping:', err);
  } finally {
    isScrapingRunning = false;
  }
}

// ===================== INTERFACCIA HTML / DASHBOARD =====================
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <title>Dashboard Facebook Scraper</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f4f6f9; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 900px; margin: auto; background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        h1 { color: #1877f2; margin-top: 0; }
        .buttons { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
        button { padding: 10px 18px; background: #1877f2; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; font-weight: bold; }
        button:hover { background: #145dbf; }
        button.stop { background: #e4405f; }
        button.stop:hover { background: #b02a43; }
        button.action-btn { background: #28a745; }
        button.action-btn:hover { background: #218838; }
        .log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .log-header h3 { margin: 0; }
        #log-box { background: #1e1e1e; color: #00ff66; padding: 15px; border-radius: 5px; height: 400px; overflow-y: auto; font-family: monospace; font-size: 13px; white-space: pre-wrap; }
        .status { margin-bottom: 15px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏀 Facebook Scraper Dashboard</h1>
        <div class="status" id="status-text">Stato: Pronto</div>
        
        <p>Scegli il blocco di squadre da scansionare:</p>
        <div class="buttons">
          <button onclick="avviaScraping(0, 15)">Blocco 1 (0 - 15)</button>
          <button onclick="avviaScraping(15, 15)">Blocco 2 (15 - 30)</button>
          <button onclick="avviaScraping(30, 15)">Blocco 3 (30 - 45)</button>
          <button onclick="avviaScraping(45, 15)">Blocco 4 (45 - 56)</button>
          <button class="stop" onclick="resetLock()">Ferma / Sblocca</button>
        </div>

        <div class="log-header">
          <h3>Log in tempo reale:</h3>
          <div>
            <button class="action-btn" onclick="copiaLog()">📋 Copia Log</button>
            <button class="action-btn" id="toggle-scroll-btn" onclick="toggleAutoScroll()">🔒 Auto-scroll: ON</button>
          </div>
        </div>

        <div id="log-box">Caricamento log...</div>
      </div>

      <script>
        let autoScrollEnabled = true;

        function avviaScraping(offset, limit) {
          fetch('/scrape?offset=' + offset + '&limit=' + limit)
            .then(res => res.json())
            .then(data => { if (data.error) console.error(data.error); })
            .catch(err => console.error("Errore di connessione"));
        }

        function resetLock() {
          fetch('/reset-lock')
            .then(res => res.json())
            .then(data => console.log(data.message));
        }

        function copiaLog() {
          const box = document.getElementById('log-box');
          navigator.clipboard.writeText(box.textContent).then(() => {
            alert("✅ Log copiati negli appunti!");
          }).catch(err => {
            alert("Errore durante la copia dei log");
          });
        }

        function toggleAutoScroll() {
          autoScrollEnabled = !autoScrollEnabled;
          const btn = document.getElementById('toggle-scroll-btn');
          if (autoScrollEnabled) {
            btn.textContent = "🔒 Auto-scroll: ON";
            btn.style.background = "#28a745";
          } else {
            btn.textContent = "🔓 Auto-scroll: OFF";
            btn.style.background = "#6c757d";
          }
        }

        setInterval(() => {
          fetch('/logs')
            .then(res => res.json())
            .then(data => {
              const box = document.getElementById('log-box');
              box.textContent = data.logs.join('\\n');
              if (autoScrollEnabled) {
                box.scrollTop = box.scrollHeight;
              }
              document.getElementById('status-text').textContent = "Stato: " + (data.isRunning ? "🟡 In esecuzione..." : "🟢 Pronto");
            });
        }, 1500);
      </script>
    </body>
    </html>
  `);
});

app.get('/logs', (req, res) => {
  res.json({ logs: logBuffer, isRunning: isScrapingRunning });
});

app.get('/scrape', (req, res) => {
  if (isScrapingRunning) {
    return res.status(429).json({ message: "Un processo di scraping è già in esecuzione!" });
  }
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 15;
  isScrapingRunning = true;
  res.json({ status: "ok", message: `Scraping avviato per il blocco ${offset}-${offset + limit}.` });
  eseguiScrapingInBackground(offset, limit);
});

app.get('/reset-lock', (req, res) => {
  isScrapingRunning = false;
  res.json({ message: "Lock dello scraper resettato con successo!" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
