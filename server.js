const express = require("express");
const cors = require("cors");
const pool = require("./db");
const axios = require("axios");
const cheerio = require("cheerio");
const Parser = require("rss-parser");

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

/* =============================
   RSS DETECTION FUNCTION
============================= */
async function detectRSS(url) {
  try {
    await parser.parseURL(url);
    return url;
  } catch {
    try {
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);
      const rssLink =
        $('link[type="application/rss+xml"]').attr("href") ||
        $('link[type="application/atom+xml"]').attr("href");
      if (!rssLink) return null;
      if (rssLink.startsWith("http")) return rssLink;
      return new URL(rssLink, url).href;
    } catch {
      return null;
    }
  }
}

/* =============================
   WHITELIST THÈMES
============================= */
const ALLOWED_THEMES = [
  // PALUDISME
  "paludisme", "malaria", "plasmodium", "anophèle", "anophele", "moustique",
  "artemisinine", "artémisinine", "chloroquine", "quinine", "antipaludique",
  "moustiquaire", "parasitemie", "parasitémie", "splenomegalie", "splénomégalie",
  "transmission", "vecteur", "endémie", "endemie", "fièvre", "fievre",
  // GRIPPE
  "grippe", "influenza", "h1n1", "h3n2", "h5n1", "h5n2",
  "vaccination", "vaccin", "antigène", "antigene", "anticorps",
  "immunite", "immunité", "pandemie", "pandémie", "antiviral", "antiviraux",
  "pneumonie", "toux", "courbature",
  // GÉNÉRAL SANTÉ
  "epidemie", "épidémie", "epidemiologie", "épidémiologie", "surveillance",
  "pathogene", "pathogène", "diagnostic", "depistage", "dépistage",
  "incidence", "prevalence", "prévalence", "contagion", "quarantaine",
  "symptome", "symptôme", "traitement", "prevention", "prévention",
  "mortalite", "mortalité", "morbidite", "morbidité", "sante", "santé",
  "oms", "who", "cas", "contamination", "infection", "infectieux",
];

function isThemeAllowed(name) {
  const normalized = name.trim().toLowerCase();
  return ALLOWED_THEMES.some(
    (t) => normalized.includes(t) || t.includes(normalized)
  );
}

/* =============================
   WHITELIST DOMAINES FLUX
============================= */
const ALLOWED_DOMAINS = [
  "who.int", "santepubliquefrance.fr", "pubmed.ncbi.nlm.nih.gov",
  "cidrap.umn.edu", "cdc.gov", "pasteur.fr", "inserm.fr",
  "ecdc.europa.eu", "afro.who.int", "rfi.fr", "sante.gouv.fr",
  "rollbackmalaria.org", "onlinelibrary.wiley.com",
  "thelancet.com", "nejm.org", "bmj.com", "nature.com",
  "sciencedirect.com", "ncbi.nlm.nih.gov", "eurosurveillance.org",
];

const HEALTH_KEYWORDS = [
  "malaria", "paludisme", "grippe", "influenza", "health", "santé", "sante",
  "disease", "virus", "epidemic", "pandemic", "vaccine", "médical", "medical",
  "patient", "symptom", "treatment", "hospital", "clinical", "pathogen",
  "epidemiology", "épidémiologie", "morbidity", "mortality",
];

function isDomainAllowed(url) {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    return ALLOWED_DOMAINS.some((d) => hostname.includes(d));
  } catch { return false; }
}

async function isContentHealthRelated(rssUrl) {
  try {
    const { data } = await axios.get(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=5`
    );
    if (!data.items || data.items.length === 0) return false;
    const text = data.items
      .map((i) => `${i.title} ${i.description || ""}`)
      .join(" ")
      .toLowerCase();
    const matches = HEALTH_KEYWORDS.filter((kw) => text.includes(kw));
    return matches.length >= 2;
  } catch { return false; }
}

/* =============================
   SCAN RSS
============================= */
let lastScanTime = new Date();

async function scanFeeds() {
  console.log("-----------------------------");
  console.log("-- 🔄 Scan des sources RSS... ");
  console.log("-----------------------------");

  const feedsResult = await pool.query("SELECT * FROM feeds");
  const themesResult = await pool.query("SELECT * FROM themes");

  const feeds = feedsResult.rows;
  const themes = themesResult.rows;

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items) {
        try {
          const insertArticle = await pool.query(
            `INSERT INTO articles (feed_id, title, link, content, pub_date)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (link) DO NOTHING
             RETURNING *`,
            [
              feed.id,
              item.title || "",
              item.link,
              item.contentSnippet || item.content || "",
              item.pubDate ? new Date(item.pubDate) : null,
            ]
          );

          if (insertArticle.rows.length > 0) {
            const article = insertArticle.rows[0];
            for (const theme of themes) {
              const text = (article.title + " " + article.content).toLowerCase();
              if (text.includes(theme.name.toLowerCase())) {
                await pool.query(
                  `INSERT INTO article_themes (article_id, theme_id)
                   VALUES ($1, $2)
                   ON CONFLICT DO NOTHING`,
                  [article.id, theme.id]
                );
              }
            }
          }
        } catch { continue; }
      }
    } catch {
      console.log("❌ Feed error:", feed.url);
    }
  }

  lastScanTime = new Date();
  console.log("-----------------------------");
  console.log("---     Scan finished     ---");
  console.log("-----------------------------");
}

/* =============================
   THEMES
============================= */
app.get("/themes", async (req, res) => {
  const result = await pool.query("SELECT * FROM themes ORDER BY categorie, name");
  res.json(result.rows);
});

app.post("/themes", async (req, res) => {
  const { name, categorie } = req.body;

  if (!["PALUDISME", "GRIPPE"].includes(categorie)) {
    return res.status(400).json({ error: "Catégorie invalide" });
  }

  // Validation whitelist
  if (!isThemeAllowed(name)) {
    return res.status(400).json({
      error: `"${name}" n'est pas reconnu comme terme médical lié au paludisme ou à la grippe.`,
    });
  }

  try {
    const result = await pool.query(
      "INSERT INTO themes (name, categorie) VALUES ($1, $2) RETURNING *",
      [name, categorie]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(400).json({ error: "Ce thème existe déjà" });
  }
});

app.delete("/themes/:id", async (req, res) => {
  await pool.query("DELETE FROM themes WHERE id = $1", [req.params.id]);
  res.json({ message: "Deleted" });
});

/* =============================
   FEEDS
============================= */
app.get("/feeds", async (req, res) => {
  const result = await pool.query("SELECT * FROM feeds ORDER BY id DESC");
  res.json(result.rows);
});

app.post("/feeds", async (req, res) => {
  const { url, name } = req.body;

  const rssUrl = await detectRSS(url);
  if (!rssUrl) return res.status(400).json({ error: "Aucun flux RSS trouvé" });

  // 1. Domaine whitelisté → accepté directement
  // 2. Domaine inconnu → valider le contenu
  if (!isDomainAllowed(rssUrl)) {
    const isHealth = await isContentHealthRelated(rssUrl);
    if (!isHealth) {
      return res.status(400).json({
        error: "Ce flux ne semble pas lié à la santé. Seules les sources médicales sont autorisées.",
      });
    }
  }

  try {
    const result = await pool.query(
      "INSERT INTO feeds (url, name) VALUES ($1, $2) RETURNING *",
      [rssUrl, name || null]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(400).json({ error: "Ce flux existe déjà" });
  }
});

app.delete("/feeds/:id", async (req, res) => {
  await pool.query("DELETE FROM feeds WHERE id = $1", [req.params.id]);
  res.json({ message: "Deleted" });
});

/* =============================
   ACTIVE THEMES
============================= */
app.get("/active-themes", async (req, res) => {
  const result = await pool.query(`
    SELECT t.* FROM themes t
    JOIN active_themes act ON t.id = act.theme_id
  `);
  res.json(result.rows);
});

app.post("/active-themes", async (req, res) => {
  const { theme_id } = req.body;
  try {
    await pool.query(
      "INSERT INTO active_themes (theme_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [theme_id]
    );
    res.json({ message: "Activé" });
  } catch {
    res.status(400).json({ error: "Erreur" });
  }
});

app.delete("/active-themes/:theme_id", async (req, res) => {
  await pool.query("DELETE FROM active_themes WHERE theme_id = $1", [req.params.theme_id]);
  res.json({ message: "Désactivé" });
});

/* =============================
   ARTICLES
============================= */
app.get("/articles/active", async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT a.*, f.url AS feed_url, f.name AS source
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN article_themes art ON a.id = art.article_id
    JOIN active_themes act ON art.theme_id = act.theme_id
    ORDER BY a.pub_date DESC
    LIMIT 100
  `);
  res.json(result.rows);
});

app.get("/articles/theme/:id", async (req, res) => {
  const result = await pool.query(`
    SELECT a.* FROM articles a
    JOIN article_themes art ON a.id = art.article_id
    WHERE art.theme_id = $1
    ORDER BY a.pub_date DESC
  `, [req.params.id]);
  res.json(result.rows);
});

app.get("/articles/new", async (req, res) => {
  const { since } = req.query;
  try {
    const result = await pool.query(`
      SELECT DISTINCT a.*, f.url AS feed_url, f.name AS source
      FROM articles a
      JOIN feeds f ON a.feed_id = f.id
      JOIN article_themes art ON a.id = art.article_id
      JOIN active_themes act ON art.theme_id = act.theme_id
      WHERE a.created_at > $1
      ORDER BY a.pub_date DESC
    `, [since || new Date(Date.now() - 60 * 60 * 1000)]);
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =============================
   SAVED ARTICLES
============================= */
app.post("/saved", async (req, res) => {
  const { title, link, description, source, pub_date } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO saved_articles (title, link, description, source, pub_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (link) DO NOTHING
       RETURNING *`,
      [title, link, description, source, pub_date || null]
    );
    res.json(result.rows[0] || { message: "Déjà sauvegardé" });
  } catch {
    res.status(400).json({ error: "Erreur lors de la sauvegarde" });
  }
});

app.get("/saved", async (req, res) => {
  const result = await pool.query("SELECT * FROM saved_articles ORDER BY saved_at DESC");
  res.json(result.rows);
});

app.delete("/saved/:id", async (req, res) => {
  await pool.query("DELETE FROM saved_articles WHERE id = $1", [req.params.id]);
  res.json({ message: "Supprimé" });
});

/* =============================
   START
============================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log("----------------------------------------------");
  console.log("--                                          --");
  console.log(`--     Server running on port ${PORT}          --`);
  console.log("--                                          --");
  console.log("----------------------------------------------");
});

setInterval(() => { scanFeeds(); }, 10 * 60 * 1000);
scanFeeds();