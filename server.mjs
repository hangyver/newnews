import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const localEnvPath = path.join(__dirname, ".env");
const PORT = Number(process.env.PORT || 4178);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const translationCache = new Map();

async function loadLocalEnv() {
  try {
    const envText = await readFile(localEnvPath, "utf8");
    envText.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        return;
      }

      const [rawKey, ...valueParts] = trimmed.split("=");
      const key = rawKey.trim();
      const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch {
    // Optional local config. Without it, the app uses Google News only.
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function sanitizeText(value) {
  return String(value || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, "")).trim();
}

function getHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? decodeHtmlEntities(sanitizeText(match[1])) : "";
}

function parseGoogleTranslateResponse(payload) {
  if (!Array.isArray(payload?.[0])) {
    return "";
  }

  return payload[0]
    .map((part) => (Array.isArray(part) ? part[0] : ""))
    .join("")
    .trim();
}

async function translateToKorean(text) {
  const cleanText = sanitizeText(text);
  if (!cleanText) {
    return "";
  }

  if (translationCache.has(cleanText)) {
    return translationCache.get(cleanText);
  }

  const translateUrl = new URL("https://translate.googleapis.com/translate_a/single");
  translateUrl.searchParams.set("client", "gtx");
  translateUrl.searchParams.set("sl", "auto");
  translateUrl.searchParams.set("tl", "ko");
  translateUrl.searchParams.set("dt", "t");
  translateUrl.searchParams.set("q", cleanText);

  try {
    const response = await fetch(translateUrl, {
      headers: {
        "User-Agent": "newnews-local-app/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Translation request failed with ${response.status}`);
    }

    const payload = await response.json();
    const translatedText = parseGoogleTranslateResponse(payload) || cleanText;
    translationCache.set(cleanText, translatedText);
    return translatedText;
  } catch {
    translationCache.set(cleanText, cleanText);
    return cleanText;
  }
}

async function translateToEnglish(text) {
  const cleanText = sanitizeText(text);
  if (!cleanText) {
    return "";
  }

  const translateUrl = new URL("https://translate.googleapis.com/translate_a/single");
  translateUrl.searchParams.set("client", "gtx");
  translateUrl.searchParams.set("sl", "auto");
  translateUrl.searchParams.set("tl", "en");
  translateUrl.searchParams.set("dt", "t");
  translateUrl.searchParams.set("q", cleanText);

  try {
    const response = await fetch(translateUrl, {
      headers: {
        "User-Agent": "newnews-local-app/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Query translation failed with ${response.status}`);
    }

    const payload = await response.json();
    return parseGoogleTranslateResponse(payload);
  } catch {
    return "";
  }
}

async function translateNewsItems(items) {
  const translatedItems = await Promise.all(
    items.map(async (item) => ({
      ...item,
      originalTitle: item.title,
      translatedTitle: await translateToKorean(item.title),
    })),
  );

  return translatedItems;
}

function parseGoogleNewsRss(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return items
    .map((match) => {
      const block = match[1];
      const title = extractTag(block, "title");
      const link = extractTag(block, "link");
      const pubDate = extractTag(block, "pubDate");
      const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      const source = sourceMatch ? decodeHtmlEntities(sanitizeText(sourceMatch[1])) : "Unknown source";
      return {
        title,
        url: link,
        source,
        provider: "Google News",
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
      };
    })
    .filter((item) => item.title && item.url)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

async function fetchGoogleNews(query) {
  const rssUrl = new URL("https://news.google.com/rss/search");
  rssUrl.searchParams.set("q", query);
  rssUrl.searchParams.set("hl", "en-US");
  rssUrl.searchParams.set("gl", "US");
  rssUrl.searchParams.set("ceid", "US:en");

  const response = await fetch(rssUrl, {
    headers: {
      "User-Agent": "newnews-local-app/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`News request failed with ${response.status}`);
  }

  const xml = await response.text();
  return parseGoogleNewsRss(xml).slice(0, 40);
}

async function fetchGdeltNews(query) {
  const gdeltUrl = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  gdeltUrl.searchParams.set("query", query);
  gdeltUrl.searchParams.set("mode", "ArtList");
  gdeltUrl.searchParams.set("format", "json");
  gdeltUrl.searchParams.set("sort", "DateDesc");
  gdeltUrl.searchParams.set("maxrecords", "50");

  const response = await fetch(gdeltUrl, {
    headers: {
      "User-Agent": "newnews-local-app/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`GDELT news request failed with ${response.status}`);
  }

  const payload = await response.json();
  const articles = Array.isArray(payload.articles) ? payload.articles : [];

  return articles
    .map((item) => ({
      title: sanitizeText(item.title),
      url: item.url,
      source: item.domain || getHostname(item.url) || "GDELT",
      provider: "GDELT",
      publishedAt: item.seendate ? new Date(item.seendate).toISOString() : null,
    }))
    .filter((item) => item.title && item.url);
}

async function fetchNaverNews(query) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      enabled: false,
      items: [],
    };
  }

  const naverUrl = new URL("https://openapi.naver.com/v1/search/news.json");
  naverUrl.searchParams.set("query", query);
  naverUrl.searchParams.set("display", "50");
  naverUrl.searchParams.set("start", "1");
  naverUrl.searchParams.set("sort", "date");

  const response = await fetch(naverUrl, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
      "User-Agent": "newnews-local-app/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Naver news request failed with ${response.status}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload.items) ? payload.items : [];

  return {
    enabled: true,
    items: items
      .map((item) => {
        const url = item.originallink || item.link;
        return {
          title: stripHtml(item.title),
          url,
          source: getHostname(url) || "Naver News",
          provider: "Naver",
          publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
        };
      })
      .filter((item) => item.title && item.url),
  };
}

async function fetchNewsSource(name, fetcher) {
  try {
    const items = await fetcher();
    return {
      name,
      error: null,
      items,
    };
  } catch (error) {
    return {
      name,
      error: error instanceof Error ? error.message : `${name} news request failed`,
      items: [],
    };
  }
}

function mergeNewsItems(...groups) {
  const seen = new Set();

  return groups
    .flat()
    .filter((item) => {
      const key = `${item.url}|${item.title}`.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, 60);
}

async function getGlobalSearchQueries(query) {
  const translatedQuery = await translateToEnglish(query);
  return [...new Set([query, translatedQuery].map((item) => sanitizeText(item)).filter(Boolean))];
}

async function fetchLatestNews(query) {
  const globalQueries = await getGlobalSearchQueries(query);
  const [naverNews, googleNews, gdeltNews] = await Promise.all([
    fetchNaverNews(query).catch((error) => ({
      enabled: Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET),
      error: error instanceof Error ? error.message : "Naver news request failed",
      items: [],
    })),
    fetchNewsSource("Google News", async () => {
      const groups = await Promise.all(globalQueries.map((item) => fetchGoogleNews(item)));
      return mergeNewsItems(...groups);
    }),
    fetchNewsSource("GDELT", async () => {
      const groups = await Promise.all(globalQueries.map((item) => fetchGdeltNews(item)));
      return mergeNewsItems(...groups);
    }),
  ]);

  const news = mergeNewsItems(naverNews.items, googleNews.items, gdeltNews.items);

  return {
    items: await translateNewsItems(news),
    providers: {
      google: {
        enabled: true,
        count: googleNews.items.length,
        error: googleNews.error,
      },
      naver: {
        enabled: naverNews.enabled,
        count: naverNews.items.length,
        error: naverNews.error || null,
      },
      gdelt: {
        enabled: true,
        count: gdeltNews.items.length,
        error: gdeltNews.error,
      },
    },
  };
}

async function fetchStockData(symbol) {
  const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  chartUrl.searchParams.set("interval", "5m");
  chartUrl.searchParams.set("range", "1d");
  chartUrl.searchParams.set("includePrePost", "true");

  const response = await fetch(chartUrl, {
    headers: {
      "User-Agent": "newnews-local-app/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Stock request failed with ${response.status}`);
  }

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const error = payload?.chart?.error;

  if (error || !result) {
    throw new Error(error?.description || "No stock data found");
  }

  const points = result?.indicators?.quote?.[0]?.close || [];
  const timestamps = result?.timestamp || [];
  const series = timestamps
    .map((time, index) => ({
      time: new Date(time * 1000).toISOString(),
      price: points[index],
    }))
    .filter((point) => Number.isFinite(point.price));

  const meta = result.meta || {};
  const previousClose = Number(meta.chartPreviousClose || meta.previousClose || 0);
  const currentPrice = series.at(-1)?.price ?? previousClose;
  const change = Number((currentPrice - previousClose).toFixed(2));
  const changePercent = previousClose
    ? Number((((currentPrice - previousClose) / previousClose) * 100).toFixed(2))
    : 0;

  return {
    symbol: meta.symbol || symbol.toUpperCase(),
    exchange: meta.exchangeName || meta.fullExchangeName || "",
    currency: meta.currency || "USD",
    regularMarketPrice: Number(currentPrice?.toFixed?.(2) || currentPrice || 0),
    previousClose,
    change,
    changePercent,
    data: series,
  };
}

function isLikelyStockQuery(query) {
  return /^[A-Za-z.\-]{1,10}$/.test(query.trim());
}

async function serveFile(reqPath, res) {
  const normalizedPath = reqPath === "/" ? "/index.html" : reqPath;
  const filePath = path.join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath);
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

await loadLocalEnv();

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/search") {
    const query = requestUrl.searchParams.get("q")?.trim();
    const mode = requestUrl.searchParams.get("mode")?.trim() || "auto";

    if (!query) {
      sendJson(res, 400, { error: "Search query is required." });
      return;
    }

    try {
      const [newsResult, stock] = await Promise.all([
        fetchLatestNews(query),
        mode === "stock" || (mode === "auto" && isLikelyStockQuery(query))
          ? fetchStockData(query).catch(() => null)
          : Promise.resolve(null),
      ]);

      sendJson(res, 200, {
        query,
        mode,
        fetchedAt: new Date().toISOString(),
        news: newsResult.items,
        providers: newsResult.providers,
        stock,
      });
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : "Upstream request failed",
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "newnews",
      now: new Date().toISOString(),
    });
    return;
  }

  await serveFile(requestUrl.pathname, res);
});

server.listen(PORT, () => {
  console.log(`NewNews server running at http://127.0.0.1:${PORT}`);
});
