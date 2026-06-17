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

// 사용할 수 있는 무료 CORS 프록시 제공업체 목록입니다.
// 특정 프록시가 오버로드되거나 522 타임아웃이 발생하면 다음 순서의 프록시로 자동 전환됩니다.
const PROXY_PROVIDERS = [
  // 1순위: corsproxy.io (대역폭이 넓고 속도가 빠름)
  {
    name: "corsproxy.io",
    getUrl: (url) => `https://corsproxy.io/?${encodeURIComponent(url.toString())}`,
    parse: async (res) => await res.text()
  },
  // 2순위: allorigins.win (무료 오픈소스 프록시, JSON 래핑 형태)
  {
    name: "allorigins.win",
    getUrl: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url.toString())}`,
    parse: async (res) => {
      const payload = await res.json();
      if (!payload || !payload.contents) {
        throw new Error("Empty allorigins payload");
      }
      return payload.contents;
    }
  },
  // 3순위: codetabs.com (API 요청용 대체 프록시)
  {
    name: "codetabs.com",
    getUrl: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url.toString())}`,
    parse: async (res) => await res.text()
  }
];

async function fetchRssWithProxy(url) {
  let lastError = null;

  // 순차적으로 프록시 리스트를 순회하며 정상 데이터를 획득할 때까지 시도합니다.
  for (const provider of PROXY_PROVIDERS) {
    try {
      const proxyUrl = provider.getUrl(url);
      
      // 6초 이상 지연되는 프록시는 522 타임아웃 대기 전에 중단시키고 다음 프록시로 넘기기 위해 AbortSignal을 설정합니다.
      const response = await fetch(proxyUrl, {
        headers: {
          "User-Agent": "newnews-local-app/1.0",
        },
        signal: AbortSignal.timeout(6000) // 6초 타임아웃 설정
      });

      if (!response.ok) {
        throw new Error(`${provider.name} responded with status ${response.status}`);
      }

      const contents = await provider.parse(response);
      if (contents && contents.trim()) {
        return contents; // 정상 파싱 완료 시 즉시 XML 반환
      }
      throw new Error(`Empty response from proxy ${provider.name}`);
    } catch (error) {
      lastError = error;
      // 현재 프록시가 지연되거나 오류가 나면 기록 후 다음 프록시로 계속 진행합니다.
    }
  }

  throw new Error(`모든 우회 프록시 서버 호출에 실패했습니다. 마지막 오류: ${lastError ? lastError.message : "알 수 없음"}`);
}

async function fetchRssWithFallback(url) {
  try {
    // 1차 시도: 직접 요청 (로컬 환경 등 구글 차단 대역이 아니면 고속 전송 수행)
    const response = await fetch(url, {
      headers: {
        "User-Agent": "newnews-local-app/1.0",
      },
      signal: AbortSignal.timeout(5000) // 직접 호출은 5초 타임아웃 제한
    });

    if (response.ok) {
      return await response.text();
    }

    // 구글 RSS 차단 응답(403, 429, 503) 발생 시 프록시 폴백 실행
    if ([403, 429, 503].includes(response.status)) {
      return await fetchRssWithProxy(url);
    }

    throw new Error(`Direct fetch status failed with ${response.status}`);
  } catch (error) {
    // 네트워크 단절 또는 예외 차단 시 다중 프록시 안전판 가동
    return await fetchRssWithProxy(url);
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
  // 동시 요청량을 조절하여 로컬 및 API 런타임의 동시성 요청 제한과 구글 번역 API 차단을 예방합니다.
  const batchSize = 5;
  const translated = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const chunkResults = await Promise.all(
      chunk.map(async (item) => ({
        ...item,
        originalTitle: item.title,
        translatedTitle: await translateToKorean(item.title),
      })),
    );
    translated.push(...chunkResults);
  }
  
  return translated;
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

  // 프록시 우회 처리가 결합된 헬퍼를 이용하여 호출하도록 전환합니다.
  const xml = await fetchRssWithFallback(rssUrl);
  return parseGoogleNewsRss(xml).slice(0, 40);
}

async function fetchGdeltNews(query) {
  const gdeltUrl = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  gdeltUrl.searchParams.set("query", query);
  gdeltUrl.searchParams.set("mode", "ArtList");
  gdeltUrl.searchParams.set("format", "json");
  gdeltUrl.searchParams.set("sort", "DateDesc");
  gdeltUrl.searchParams.set("maxrecords", "50");

  try {
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
  } catch (error) {
    // GDELT 차단이 발생할 시에도 AllOrigins 프록시를 통해 우회 수집을 하도록 안전장치를 덧댑니다.
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(gdeltUrl.toString())}`;
      const response = await fetch(proxyUrl);
      const payload = await response.json();
      const parsed = JSON.parse(payload.contents);
      const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
      return articles.map((item) => ({
        title: sanitizeText(item.title),
        url: item.url,
        source: item.domain || getHostname(item.url) || "GDELT",
        provider: "GDELT",
        publishedAt: item.seendate ? new Date(item.seendate).toISOString() : null,
      })).filter((item) => item.title && item.url);
    } catch {
      throw error;
    }
  }
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

async function fetchYoutubeSearch(query, env) {
  const safeEnv = env || {};
  const apiKey = safeEnv.YOUTUBE_API_KEY;

  // 유튜브 API Key가 주입되어 있다면 공식 API를 우선 사용합니다.
  if (apiKey) {
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("q", query);
      url.searchParams.set("type", "video");
      url.searchParams.set("maxResults", "20");
      url.searchParams.set("order", "date");
      url.searchParams.set("key", apiKey);

      const response = await fetch(url, {
        headers: {
          "User-Agent": "newnews-local-app/1.0",
        },
      });

      if (!response.ok) {
        let errMsg = `Youtube API returned ${response.status}`;
        try {
          const errPayload = await response.json();
          if (errPayload?.error?.message) {
            errMsg = `Youtube API Error: ${errPayload.error.message} (${response.status})`;
          }
        } catch {}
        throw new Error(errMsg);
      }

      const payload = await response.json();
      const items = Array.isArray(payload.items) ? payload.items : [];

      return items.map((item) => ({
        title: decodeHtmlEntities(sanitizeText(item.snippet.title)),
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        source: item.snippet.channelTitle,
        provider: "Youtube",
        publishedAt: item.snippet.publishedAt ? new Date(item.snippet.publishedAt).toISOString() : null,
        thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || "",
      }));
    } catch (error) {
      // 명시적인 유튜브 API 스펙 에러(예: 키 인증 실패, 할당량 초과)인 경우 
      // 우회 RSS로 숨기지 않고 원인을 명확하게 밖으로 던집니다.
      if (error instanceof Error && error.message.startsWith("Youtube API Error:")) {
        throw error;
      }
      // 그 외의 일반 네트워크 에러인 경우에만 RSS 우회 연동 폴백을 진행합니다.
      return fetchYoutubeRss(query);
    }
  } else {
    // API 키가 없을 때 무중단 서빙을 위한 우회 RSS 파싱 처리
    return fetchYoutubeRss(query);
  }
}

async function fetchYoutubeRss(query) {
  const rssUrl = new URL("https://news.google.com/rss/search");
  rssUrl.searchParams.set("q", `site:youtube.com ${query}`);
  rssUrl.searchParams.set("hl", "en-US");
  rssUrl.searchParams.set("gl", "US");
  rssUrl.searchParams.set("ceid", "US:en");

  // 프록시 우회 처리가 결합된 헬퍼를 활용합니다.
  const xml = await fetchRssWithFallback(rssUrl);
  const items = parseGoogleNewsRss(xml).slice(0, 20);

  return items.map((item) => ({
    ...item,
    provider: "Youtube",
    thumbnail: "", // RSS 파싱 결과에는 공식 썸네일 경로가 없으므로 FE에서 플레이스홀더 이미지를 노출합니다.
  }));
}

async function fetchSnsSearch(query) {
  const rssUrl = new URL("https://news.google.com/rss/search");
  // 트위터/X, 페이스북, 인스타그램, 스레드 4가지 플랫폼만 검색하도록 필터를 최적화합니다.
  rssUrl.searchParams.set("q", `(site:twitter.com OR site:x.com OR site:facebook.com OR site:instagram.com OR site:threads.net) ${query}`);
  rssUrl.searchParams.set("hl", "en-US");
  rssUrl.searchParams.set("gl", "US");
  rssUrl.searchParams.set("ceid", "US:en");

  // 프록시 우회 처리가 결합된 헬퍼를 활용합니다.
  const xml = await fetchRssWithFallback(rssUrl);
  const rawItems = parseGoogleNewsRss(xml).slice(0, 30);

  return rawItems.map((item) => {
    const host = getHostname(item.url);
    let provider = "SNS";
    
    // 호스트 도메인 명에 맞게 플랫폼 뱃지를 할당합니다.
    if (host.includes("twitter.com") || host.includes("x.com")) {
      provider = "Twitter";
    } else if (host.includes("facebook.com")) {
      provider = "Facebook";
    } else if (host.includes("instagram.com")) {
      provider = "Instagram";
    } else if (host.includes("threads.net")) {
      provider = "Threads";
    }

    return {
      ...item,
      provider,
    };
  });
}

async function fetchLatestNews(query, mode) {
  // 유튜브 모드일 경우 비디오 수집 로직 실행
  if (mode === "youtube") {
    try {
      const items = await fetchYoutubeSearch(query, process.env);
      return {
        items: await translateNewsItems(items),
        providers: {
          youtube: {
            enabled: true,
            count: items.length,
            error: null,
          },
        },
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Youtube search failed");
    }
  }

  // SNS 모드일 경우 트위터/인스타/스레드/레딧 통합 피드 로직 실행
  if (mode === "sns") {
    try {
      const items = await fetchSnsSearch(query);
      return {
        items: await translateNewsItems(items),
        providers: {
          sns: {
            enabled: true,
            count: items.length,
            error: null,
          },
        },
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "SNS search failed");
    }
  }

  const globalQueries = await getGlobalSearchQueries(query);
  
  // Promise.all 대신 Promise.allSettled를 도입하여 로컬 구동 시 특정 채널 장애가 메인 검색을 중단시키지 않도록 합니다.
  const results = await Promise.allSettled([
    fetchNaverNews(query).catch((error) => ({
      enabled: Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET),
      error: error instanceof Error ? error.message : "Naver news request failed",
      items: [],
    })),
    fetchNewsSource("Google News", async () => {
      // 다중 언어 쿼리 병렬 호출 시 일부 쿼리 에러로 전체 구글 뉴스 수집이 실패하지 않도록 allSettled 처리합니다.
      const queryResults = await Promise.allSettled(globalQueries.map((item) => fetchGoogleNews(item)));
      const groups = queryResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const errors = queryResults.filter((r) => r.status === "rejected").map((r) => r.reason?.message || "Unknown error");
      
      if (groups.length === 0 && errors.length > 0) {
        throw new Error(errors[0]);
      }
      return mergeNewsItems(...groups);
    }),
    fetchNewsSource("GDELT", async () => {
      const queryResults = await Promise.allSettled(globalQueries.map((item) => fetchGdeltNews(item)));
      const groups = queryResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const errors = queryResults.filter((r) => r.status === "rejected").map((r) => r.reason?.message || "Unknown error");
      
      if (groups.length === 0 && errors.length > 0) {
        throw new Error(errors[0]);
      }
      return mergeNewsItems(...groups);
    }),
  ]);

  // 각 데이터 프로바이더 별 정상 수집 완료 여부를 확인하고 대체 객체를 생성합니다.
  const naverNews = results[0].status === "fulfilled" 
    ? results[0].value 
    : { enabled: false, items: [], error: results[0].reason?.message || "Naver news request failed" };
    
  const googleNews = results[1].status === "fulfilled" 
    ? results[1].value 
    : { name: "Google News", error: results[1].reason?.message || "Google News request failed", items: [] };
    
  const gdeltNews = results[2].status === "fulfilled" 
    ? results[2].value 
    : { name: "GDELT", error: results[2].reason?.message || "GDELT news request failed", items: [] };

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
        fetchLatestNews(query, mode),
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
