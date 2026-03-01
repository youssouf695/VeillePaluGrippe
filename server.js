const express = require("express");
const cors = require("cors");
const pool = require("./db");
const axios = require("axios");
const cheerio = require("cheerio");
const Parser = require("rss-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "veille_sante_secret";

app.use(cors());
app.use(express.json());

/* =============================
   MIDDLEWARES AUTH
============================= */
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Non autorisé" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token invalide ou expiré" });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Accès admin requis" });
  next();
};

/* =============================
   RSS DETECTION
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
    } catch { return null; }
  }
}

/* =============================
   WHITELIST THÈMES
============================= */
const ALLOWED_THEMES = [
  "paludisme","malaria","plasmodium","anophèle","anophele","moustique",
  "artemisinine","artémisinine","chloroquine","quinine","antipaludique",
  "moustiquaire","parasitemie","parasitémie","splenomegalie","splénomégalie",
  "transmission","vecteur","endémie","endemie","fièvre","fievre",
  "grippe","influenza","h1n1","h3n2","h5n1","h5n2",
  "vaccination","vaccin","antigène","antigene","anticorps",
  "immunite","immunité","pandemie","pandémie","antiviral","antiviraux",
  "pneumonie","toux","courbature",
  "epidemie","épidémie","epidemiologie","épidémiologie","surveillance",
  "pathogene","pathogène","diagnostic","depistage","dépistage",
  "incidence","prevalence","prévalence","contagion","quarantaine",
  "symptome","symptôme","traitement","prevention","prévention",
  "mortalite","mortalité","morbidite","morbidité","sante","santé",
  "oms","who","cas","contamination","infection","infectieux",
];

function isThemeAllowed(name) {
  const normalized = name.trim().toLowerCase();
  return ALLOWED_THEMES.some((t) => normalized.includes(t) || t.includes(normalized));
}

/* =============================
   WHITELIST DOMAINES
============================= */
const DEFAULT_ALLOWED_DOMAINS = [
  "who.int","santepubliquefrance.fr","pubmed.ncbi.nlm.nih.gov",
  "cidrap.umn.edu","cdc.gov","pasteur.fr","inserm.fr",
  "ecdc.europa.eu","afro.who.int","rfi.fr","sante.gouv.fr",
  "rollbackmalaria.org","onlinelibrary.wiley.com",
  "thelancet.com","nejm.org","bmj.com","nature.com",
  "sciencedirect.com","ncbi.nlm.nih.gov","eurosurveillance.org",
];

const HEALTH_KEYWORDS = [
  "malaria","paludisme","grippe","influenza","health","santé","sante",
  "disease","virus","epidemic","pandemic","vaccine","médical","medical",
  "patient","symptom","treatment","hospital","clinical","pathogen",
  "epidemiology","épidémiologie","morbidity","mortality",
];

async function getAllowedDomains() {
  try {
    const result = await pool.query("SELECT domain FROM approved_domains");
    const dbDomains = result.rows.map((r) => r.domain);
    return [...DEFAULT_ALLOWED_DOMAINS, ...dbDomains];
  } catch { return DEFAULT_ALLOWED_DOMAINS; }
}

async function isDomainAllowed(url) {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    const domains = await getAllowedDomains();
    return domains.some((d) => hostname.includes(d));
  } catch { return false; }
}

async function isContentHealthRelated(rssUrl) {
  try {
    const { data } = await axios.get(
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=5`
    );
    if (!data.items || data.items.length === 0) return false;
    const text = data.items.map((i) => `${i.title} ${i.description || ""}`).join(" ").toLowerCase();
    return HEALTH_KEYWORDS.filter((kw) => text.includes(kw)).length >= 2;
  } catch { return false; }
}

/* =============================
   SCAN RSS
============================= */
let lastScanTime = new Date();

async function scanFeeds() {
  console.log("-----------------------------");
  console.log("-- 🔄 Scan des sources RSS...");
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
             ON CONFLICT (link) DO NOTHING RETURNING *`,
            [feed.id, item.title || "", item.link,
             item.contentSnippet || item.content || "",
             item.pubDate ? new Date(item.pubDate) : null]
          );
          if (insertArticle.rows.length > 0) {
            const article = insertArticle.rows[0];
            for (const theme of themes) {
              const text = (article.title + " " + article.content).toLowerCase();
              if (text.includes(theme.name.toLowerCase())) {
                await pool.query(
                  `INSERT INTO article_themes (article_id, theme_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                  [article.id, theme.id]
                );
              }
            }
          }
        } catch { continue; }
      }
    } catch { console.log("❌ Feed error:", feed.url); }
  }

  lastScanTime = new Date();
  console.log("-----------------------------");
  console.log("---     Scan finished     ---");
  console.log("-----------------------------");
}

/* =============================
   AUTH
============================= */
app.post("/auth/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
  const hash = await bcrypt.hash(password, 10);
  try {
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, role",
      [email, hash, name || null]
    );
    const user = result.rows[0];
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });
    res.json({ user, token });
  } catch {
    res.status(400).json({ error: "Email déjà utilisé" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE email = $1 AND is_active = true", [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Email ou mot de passe incorrect" });
  }
  const payload = { id: user.id, email: user.email, role: user.role, name: user.name };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.json({ user: payload, token });
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT id, email, name, role, created_at FROM users WHERE id = $1",
    [req.user.id]
  );
  res.json(result.rows[0]);
});

/* =============================
   THEMES GLOBAUX (admin)
============================= */
app.get("/themes", async (req, res) => {
  const result = await pool.query("SELECT * FROM themes ORDER BY categorie, name");
  res.json(result.rows);
});

app.post("/themes", authMiddleware, adminMiddleware, async (req, res) => {
  const { name, categorie } = req.body;
  if (!["PALUDISME", "GRIPPE"].includes(categorie)) {
    return res.status(400).json({ error: "Catégorie invalide" });
  }
  if (!isThemeAllowed(name)) {
    return res.status(400).json({ error: `"${name}" n'est pas un terme médical reconnu.` });
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

app.delete("/themes/:id", authMiddleware, adminMiddleware, async (req, res) => {
  await pool.query("DELETE FROM themes WHERE id = $1", [req.params.id]);
  res.json({ message: "Supprimé" });
});

/* =============================
   THEMES PERSONNELS (user)
============================= */
app.get("/themes/personal", authMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM user_themes WHERE user_id = $1 ORDER BY name",
    [req.user.id]
  );
  res.json(result.rows);
});

app.post("/themes/personal", authMiddleware, async (req, res) => {
  const { name, categorie } = req.body;
  if (!["PALUDISME", "GRIPPE"].includes(categorie)) {
    return res.status(400).json({ error: "Catégorie invalide" });
  }
  if (!isThemeAllowed(name)) {
    return res.status(400).json({ error: `"${name}" n'est pas un terme médical reconnu.` });
  }
  try {
    const result = await pool.query(
      "INSERT INTO user_themes (user_id, name, categorie) VALUES ($1, $2, $3) RETURNING *",
      [req.user.id, name, categorie]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(400).json({ error: "Ce thème existe déjà" });
  }
});

app.delete("/themes/personal/:id", authMiddleware, async (req, res) => {
  await pool.query(
    "DELETE FROM user_themes WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  res.json({ message: "Supprimé" });
});

// Tous les thèmes (globaux + perso)
app.get("/themes/all", authMiddleware, async (req, res) => {
  const global = await pool.query("SELECT *, 'global' as type FROM themes ORDER BY categorie, name");
  const personal = await pool.query(
    "SELECT *, 'personal' as type FROM user_themes WHERE user_id = $1 ORDER BY name",
    [req.user.id]
  );
  res.json({ global: global.rows, personal: personal.rows });
});

/* =============================
   ACTIVE THEMES (par user)
============================= */
app.get("/active-themes", authMiddleware, async (req, res) => {
  const global = await pool.query(`
    SELECT t.*, 'global' as type FROM themes t
    JOIN user_active_themes uat ON t.id = uat.theme_id
    WHERE uat.user_id = $1 AND uat.theme_id IS NOT NULL
  `, [req.user.id]);

  const personal = await pool.query(`
    SELECT ut.*, 'personal' as type FROM user_themes ut
    JOIN user_active_themes uat ON ut.id = uat.user_theme_id
    WHERE uat.user_id = $1 AND uat.user_theme_id IS NOT NULL
  `, [req.user.id]);

  res.json([...global.rows, ...personal.rows]);
});

app.post("/active-themes", authMiddleware, async (req, res) => {
  const { theme_id, user_theme_id } = req.body;
  try {
    await pool.query(
      `INSERT INTO user_active_themes (user_id, theme_id, user_theme_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.user.id, theme_id || null, user_theme_id || null]
    );
    res.json({ message: "Activé" });
  } catch {
    res.status(400).json({ error: "Erreur" });
  }
});

app.delete("/active-themes/:theme_id", authMiddleware, async (req, res) => {
  await pool.query(
    "DELETE FROM user_active_themes WHERE user_id = $1 AND (theme_id = $2 OR user_theme_id = $2)",
    [req.user.id, req.params.theme_id]
  );
  res.json({ message: "Désactivé" });
});

/* =============================
   FEEDS
============================= */
app.get("/feeds", async (req, res) => {
  const result = await pool.query("SELECT * FROM feeds ORDER BY id DESC");
  res.json(result.rows);
});

// User soumet un flux → va dans pending
app.post("/feeds", authMiddleware, async (req, res) => {
  const { url, name } = req.body;
  const rssUrl = await detectRSS(url);
  if (!rssUrl) return res.status(400).json({ error: "Aucun flux RSS trouvé" });

  // Si admin → ajout direct
  if (req.user.role === "admin") {
    try {
      const result = await pool.query(
        "INSERT INTO feeds (url, name) VALUES ($1, $2) RETURNING *",
        [rssUrl, name || null]
      );
      return res.json(result.rows[0]);
    } catch {
      return res.status(400).json({ error: "Ce flux existe déjà" });
    }
  }

  // Si domaine whitelisté → ajout direct
  if (await isDomainAllowed(rssUrl)) {
    try {
      const result = await pool.query(
        "INSERT INTO feeds (url, name) VALUES ($1, $2) RETURNING *",
        [rssUrl, name || null]
      );
      return res.json(result.rows[0]);
    } catch {
      return res.status(400).json({ error: "Ce flux existe déjà" });
    }
  }

  // Sinon → validation contenu puis pending
  const isHealth = await isContentHealthRelated(rssUrl);
  if (!isHealth) {
    return res.status(400).json({
      error: "Ce flux ne semble pas lié à la santé. Seules les sources médicales sont autorisées.",
    });
  }

  // Contenu ok mais domaine inconnu → pending
  try {
    await pool.query(
      "INSERT INTO pending_feeds (url, name, submitted_by) VALUES ($1, $2, $3)",
      [rssUrl, name || null, req.user.id]
    );
    res.json({ message: "Flux soumis pour validation par un administrateur.", pending: true });
  } catch {
    res.status(400).json({ error: "Ce flux est déjà en attente de validation" });
  }
});

app.delete("/feeds/:id", authMiddleware, adminMiddleware, async (req, res) => {
  await pool.query("DELETE FROM feeds WHERE id = $1", [req.params.id]);
  res.json({ message: "Supprimé" });
});

/* =============================
   ARTICLES
============================= */
app.get("/articles/active", authMiddleware, async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT a.*, f.name AS source, f.url AS feed_url
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    JOIN article_themes art ON a.id = art.article_id
    JOIN user_active_themes uat ON art.theme_id = uat.theme_id
    WHERE uat.user_id = $1
    ORDER BY a.pub_date DESC
    LIMIT 100
  `, [req.user.id]);
  res.json(result.rows);
});

app.get("/articles/new", authMiddleware, async (req, res) => {
  const { since } = req.query;
  try {
    const result = await pool.query(`
      SELECT DISTINCT a.*, f.name AS source, f.url AS feed_url
      FROM articles a
      JOIN feeds f ON a.feed_id = f.id
      JOIN article_themes art ON a.id = art.article_id
      JOIN user_active_themes uat ON art.theme_id = uat.theme_id
      WHERE uat.user_id = $1 AND a.created_at > $2
      ORDER BY a.pub_date DESC
    `, [req.user.id, since || new Date(Date.now() - 60 * 60 * 1000)]);
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =============================
   SAVED ARTICLES (par user)
============================= */
app.post("/saved", authMiddleware, async (req, res) => {
  const { title, link, description, source, pub_date } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO saved_articles (title, link, description, source, pub_date, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (link) DO NOTHING RETURNING *`,
      [title, link, description, source, pub_date || null, req.user.id]
    );
    res.json(result.rows[0] || { message: "Déjà sauvegardé" });
  } catch {
    res.status(400).json({ error: "Erreur lors de la sauvegarde" });
  }
});

app.get("/saved", authMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM saved_articles WHERE user_id = $1 ORDER BY saved_at DESC",
    [req.user.id]
  );
  res.json(result.rows);
});

app.delete("/saved/:id", authMiddleware, async (req, res) => {
  await pool.query(
    "DELETE FROM saved_articles WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  res.json({ message: "Supprimé" });
});

/* =============================
   ADMIN
============================= */
// Lister tous les users
app.get("/admin/users", authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT id, email, name, role, created_at, is_active FROM users ORDER BY created_at DESC"
  );
  res.json(result.rows);
});

// Activer/désactiver un user
app.patch("/admin/users/:id/toggle", authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    "UPDATE users SET is_active = NOT is_active WHERE id = $1 RETURNING id, email, is_active",
    [req.params.id]
  );
  res.json(result.rows[0]);
});

// Changer le rôle d'un user
app.patch("/admin/users/:id/role", authMiddleware, adminMiddleware, async (req, res) => {
  const { role } = req.body;
  if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "Rôle invalide" });
  const result = await pool.query(
    "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role",
    [role, req.params.id]
  );
  res.json(result.rows[0]);
});

// Flux en attente
app.get("/admin/feeds/pending", authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(`
    SELECT pf.*, u.email as submitted_by_email
    FROM pending_feeds pf
    JOIN users u ON pf.submitted_by = u.id
    WHERE pf.status = 'pending'
    ORDER BY pf.created_at DESC
  `);
  res.json(result.rows);
});

// Approuver un flux
app.patch("/admin/feeds/:id/approve", authMiddleware, adminMiddleware, async (req, res) => {
  const feed = await pool.query("SELECT * FROM pending_feeds WHERE id = $1", [req.params.id]);
  if (!feed.rows[0]) return res.status(404).json({ error: "Flux introuvable" });
  await pool.query(
    "INSERT INTO feeds (url, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [feed.rows[0].url, feed.rows[0].name]
  );
  await pool.query(
    "UPDATE pending_feeds SET status = 'approved', reviewed_by = $1 WHERE id = $2",
    [req.user.id, req.params.id]
  );
  res.json({ message: "Flux approuvé" });
});

// Rejeter un flux
app.patch("/admin/feeds/:id/reject", authMiddleware, adminMiddleware, async (req, res) => {
  await pool.query(
    "UPDATE pending_feeds SET status = 'rejected', reviewed_by = $1 WHERE id = $2",
    [req.user.id, req.params.id]
  );
  res.json({ message: "Flux rejeté" });
});

// Ajouter un domaine approuvé
app.post("/admin/domains", authMiddleware, adminMiddleware, async (req, res) => {
  const { domain } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO approved_domains (domain, added_by) VALUES ($1, $2) RETURNING *",
      [domain, req.user.id]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(400).json({ error: "Domaine déjà présent" });
  }
});

// Lister les domaines approuvés
app.get("/admin/domains", authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query("SELECT * FROM approved_domains ORDER BY created_at DESC");
  res.json(result.rows);
});

// Supprimer un domaine
app.delete("/admin/domains/:id", authMiddleware, adminMiddleware, async (req, res) => {
  await pool.query("DELETE FROM approved_domains WHERE id = $1", [req.params.id]);
  res.json({ message: "Supprimé" });
});

// Stats globales
app.get("/admin/stats", authMiddleware, adminMiddleware, async (req, res) => {
  const users = await pool.query("SELECT COUNT(*) FROM users");
  const articles = await pool.query("SELECT COUNT(*) FROM articles");
  const feeds = await pool.query("SELECT COUNT(*) FROM feeds");
  const pending = await pool.query("SELECT COUNT(*) FROM pending_feeds WHERE status = 'pending'");
  const themes = await pool.query("SELECT COUNT(*) FROM themes");
  res.json({
    users: parseInt(users.rows[0].count),
    articles: parseInt(articles.rows[0].count),
    feeds: parseInt(feeds.rows[0].count),
    pending_feeds: parseInt(pending.rows[0].count),
    themes: parseInt(themes.rows[0].count),
  });
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