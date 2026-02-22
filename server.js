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


// Timestamp du dernier scan
let lastScanTime = new Date();
// Fonction de scan RSS
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

            // 🔎 Matching avec thèmes
            for (const theme of themes) {
              const text = (
                article.title +
                " " +
                article.content
              ).toLowerCase();

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
        } catch (err) {
          continue;
        }
      }
    } catch (err) {
      console.log("❌ Feed error:", feed.url);
    }
  }
  lastScanTime = new Date();
  console.log("-----------------------------");
  console.log("---     Scan finished     ---");
  console.log("-----------------------------");
}



// ============================= THEMES/ Keywords/ Mots-clés =========================

app.get("/themes", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM themes ORDER BY categorie, name"
  );
  res.json(result.rows);
});

app.post("/themes", async (req, res) => {
  const { name, categorie } = req.body;

  if (!["PALUDISME", "GRIPPE"].includes(categorie)) {
    return res.status(400).json({ error: "Invalid category" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO themes (name, categorie) VALUES ($1, $2) RETURNING *",
      [name, categorie]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(400).json({ error: "Theme already exists" });
  }
});

app.delete("/themes/:id", async (req, res) => {
  await pool.query("DELETE FROM themes WHERE id = $1", [req.params.id]);
  res.json({ message: "Deleted" });
});

/* ============================= FEEDS / flux ============================= */

app.get("/feeds", async (req, res) => {
  const result = await pool.query("SELECT * FROM feeds ORDER BY id DESC");
  res.json(result.rows);
});

app.post("/feeds", async (req, res) => {
  const { url, name } = req.body;  // ← ajouter name

  const rssUrl = await detectRSS(url);
  if (!rssUrl) return res.status(400).json({ error: "No RSS feed found" });

  try {
    const result = await pool.query(
      "INSERT INTO feeds (url, name) VALUES ($1, $2) RETURNING *",  // ← ajouter name
      [rssUrl, name || null]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(400).json({ error: "Feed already exists" });
  }
});

app.delete("/feeds/:id", async (req, res) => {
  await pool.query("DELETE FROM feeds WHERE id = $1", [req.params.id]);
  res.json({ message: "Deleted" });
});

// ============================= THEMES ACTIFS / Active Themes =============================
// Récupérer les thèmes actifs
app.get("/active-themes", async (req, res) => {
  const result = await pool.query(`
    SELECT t.* FROM themes t
    JOIN active_themes act ON t.id = act.theme_id
  `);
  res.json(result.rows);
});

// Activer un thème
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

// Désactiver un thème
app.delete("/active-themes/:theme_id", async (req, res) => {
  await pool.query("DELETE FROM active_themes WHERE theme_id = $1", [req.params.theme_id]);
  res.json({ message: "Désactivé" });
});

// =============== endpoint pour récupérer les articles avec l'URL du feed ====================

// Aller chercher les 100 derniers articles avec l'URL du feed associé
app.get("/articles/active", async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT a.*, f.url AS feed_url
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN article_themes art ON a.id = art.article_id
    JOIN active_themes act ON art.theme_id = act.theme_id
    ORDER BY a.pub_date DESC
    LIMIT 100
  `);
  res.json(result.rows);
});

// Récupérer les articles associés à un thème
app.get("/articles/theme/:id", async (req, res) => {
  const result = await pool.query(`
    SELECT a.*
    FROM articles a
    JOIN article_themes at ON a.id = at.article_id
    WHERE at.theme_id = $1
    ORDER BY a.pub_date DESC
  `, [req.params.id]);

  res.json(result.rows);
});

// Nouveaux articles depuis le dernier chargement
app.get("/articles/new", async (req, res) => {
  const { since } = req.query;
  try {
    const result = await pool.query(`
      SELECT DISTINCT a.*, f.url AS feed_url
      FROM articles a
      JOIN feeds f ON a.feed_id = f.id
      JOIN article_themes art ON a.id = art.article_id
      JOIN active_themes act ON art.theme_id = act.theme_id
      WHERE a.created_at > $1
      ORDER BY a.pub_date DESC
    `, [since || new Date(Date.now() - 60 * 60 * 1000)]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});


//============================ ARTICLES SAUVEGARDÉS =============================
// Sauvegarder un article
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

// Récupérer les articles sauvegardés
app.get("/saved", async (req, res) => {
  const result = await pool.query("SELECT * FROM saved_articles ORDER BY saved_at DESC");
  res.json(result.rows);
});

// Supprimer un article sauvegardé
app.delete("/saved/:id", async (req, res) => {
  await pool.query("DELETE FROM saved_articles WHERE id = $1", [req.params.id]);
  res.json({ message: "Supprimé" });
});


app.listen(PORT, "0.0.0.0", () => {
  console.log("----------------------------------------------");
  console.log("--                                          --");
  console.log("--                                          --");
  console.log(`--     Server running on port ${PORT}          --`);
  console.log("--                                          --");
  console.log("--                                          --"); 
  console.log("----------------------------------------------");
});






//pour scanner automatiquement les flux toutes les 10 minutes
setInterval(() => {
  scanFeeds();
}, 10 * 60 * 1000);

//lancer un scan au démarrage du serveur
scanFeeds();
