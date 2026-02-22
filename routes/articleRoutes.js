import express from "express";
import { fetchRSS } from "../services/rssService.js";

const router = express.Router();

router.get("/article", async (req, res) => {
  try {
    const data = await fetchRSS(
      "https://news.google.com/rss/search?q=paludisme"
    );

    res.send(data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Erreur récupération RSS" });
  }
});

export default router;
