import axios from "axios";
import https from "https";

const agent = new https.Agent({ family: 4 });

export const fetchRSS = async (url) => {
  const res = await axios.get(url, {
    httpsAgent: agent,
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
      "Connection": "keep-alive"
    }
  });

  return res.data;
};
