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
        "User-Agent": "newnews-pages-app/1.0",
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
  // 동시 요청량을 조절하여 Cloudflare Subrequest Limit(50개) 및 번역 API의 일시적 차단(Rate Limit)을 예방합니다.
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

async function fetchGdeltNews(query) {
  const gdeltUrl = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  gdeltUrl.searchParams.set("query", query);
  gdeltUrl.searchParams.set("mode", "ArtList");
  gdeltUrl.searchParams.set("format", "json");
  gdeltUrl.searchParams.set("sort", "DateDesc");
  gdeltUrl.searchParams.set("maxrecords", "50");

  const response = await fetch(gdeltUrl, {
    headers: {
      "User-Agent": "newnews-pages-app/1.0",
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

async function fetchNaverNews(query, env) {
  const safeEnv = env || {};
  const clientId = safeEnv.NAVER_CLIENT_ID;
  const clientSecret = safeEnv.NAVER_CLIENT_SECRET;

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
          "User-Agent": "newnews-pages-app/1.0",
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

  const response = await fetch(rssUrl, {
    headers: {
      "User-Agent": "newnews-pages-app/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Youtube RSS fallback failed with ${response.status}`);
  }

  const xml = await response.text();
  const items = parseGoogleNewsRss(xml).slice(0, 20);

  return items.map((item) => ({
    ...item,
    provider: "Youtube",
    thumbnail: "", // RSS 파싱 결과에는 공식 썸네일 경로가 없으므로 렌더러에서 플레이스홀더를 사용합니다.
  }));
}

async function fetchSnsSearch(query) {
  const rssUrl = new URL("https://news.google.com/rss/search");
  // 트위터/X, 인스타그램, 스레드, 레딧 검색 범주를 구글 RSS 연산자로 묶어 가져옵니다.
  rssUrl.searchParams.set("q", `(site:twitter.com OR site:x.com OR site:instagram.com OR site:threads.net OR site:reddit.com) ${query}`);
  rssUrl.searchParams.set("hl", "en-US");
  rssUrl.searchParams.set("gl", "US");
  rssUrl.searchParams.set("ceid", "US:en");

  const response = await fetch(rssUrl, {
    headers: {
      "User-Agent": "newnews-pages-app/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`SNS search request failed with ${response.status}`);
  }

  const xml = await response.text();
  const rawItems = parseGoogleNewsRss(xml).slice(0, 30);

  return rawItems.map((item) => {
    const host = getHostname(item.url);
    let provider = "SNS";
    
    // 호스트 도메인을 분석하여 플랫폼의 뱃지 유형을 개별적으로 할당합니다.
    if (host.includes("twitter.com") || host.includes("x.com")) {
      provider = "Twitter";
    } else if (host.includes("instagram.com")) {
      provider = "Instagram";
    } else if (host.includes("threads.net")) {
      provider = "Threads";
    } else if (host.includes("reddit.com")) {
      provider = "Reddit";
    }

    return {
      ...item,
      provider,
    };
  });
}

async function fetchLatestNews(query, mode, env) {
  const safeEnv = env || {};
  
  // 유튜브 모드일 경우 비디오 수집 로직 실행
  if (mode === "youtube") {
    try {
      const items = await fetchYoutubeSearch(query, safeEnv);
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
  
  // Promise.all 대신 Promise.allSettled를 도입하여 백엔드 소스 실패가 전체 검색 API 크래시로 이어지지 않게 격리합니다.
  const results = await Promise.allSettled([
    fetchNaverNews(query, safeEnv).catch((error) => ({
      enabled: Boolean(safeEnv.NAVER_CLIENT_ID && safeEnv.NAVER_CLIENT_SECRET),
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
      fetchLatestNews(query, mode, env),
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
