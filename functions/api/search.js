const translationCache = new Map();

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
        "User-Agent": "newnews-pages-app/1.0",
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

async function translateNewsItems(items) {
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      originalTitle: item.title,
      translatedTitle: await translateToKorean(item.title),
    })),
  );
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
      "User-Agent": "newnews-pages-app/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`News request failed with ${response.status}`);
  }

  const xml = await response.text();
  return parseGoogleNewsRss(xml).slice(0, 40);
}

async function fetchNaverNews(query, env) {
  const clientId = env.NAVER_CLIENT_ID;
  const clientSecret = env.NAVER_CLIENT_SECRET;

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
      "User-Agent": "newnews-pages-app/1.0",
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

async function fetchLatestNews(query, env) {
  const [googleNews, naverNews] = await Promise.all([
    fetchGoogleNews(query),
    fetchNaverNews(query, env).catch((error) => ({
      enabled: Boolean(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET),
      error: error instanceof Error ? error.message : "Naver news request failed",
      items: [],
    })),
  ]);

  const news = mergeNewsItems(googleNews, naverNews.items);

  return {
    items: await translateNewsItems(news),
    providers: {
      google: {
        enabled: true,
        count: googleNews.length,
      },
      naver: {
        enabled: naverNews.enabled,
        count: naverNews.items.length,
        error: naverNews.error || null,
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
      "User-Agent": "newnews-pages-app/1.0",
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

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestGet({ request, env }) {
  const requestUrl = new URL(request.url);
  const query = requestUrl.searchParams.get("q")?.trim();
  const mode = requestUrl.searchParams.get("mode")?.trim() || "auto";

  if (!query) {
    return json({ error: "Search query is required." }, 400);
  }

  try {
    const [newsResult, stock] = await Promise.all([
      fetchLatestNews(query, env),
      mode === "stock" || (mode === "auto" && isLikelyStockQuery(query))
        ? fetchStockData(query).catch(() => null)
        : Promise.resolve(null),
    ]);

    return json({
      query,
      mode,
      fetchedAt: new Date().toISOString(),
      news: newsResult.items,
      providers: newsResult.providers,
      stock,
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Upstream request failed",
      },
      502,
    );
  }
}
