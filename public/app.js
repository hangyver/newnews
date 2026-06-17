const queryInput = document.querySelector("#queryInput");
const searchButton = document.querySelector("#searchButton");
const autoRefresh = document.querySelector("#autoRefresh");
const currentQuery = document.querySelector("#currentQuery");
const lastUpdated = document.querySelector("#lastUpdated");
const newsCount = document.querySelector("#newsCount");
const newsList = document.querySelector("#newsList");
const statusMessage = document.querySelector("#statusMessage");
const stockPanel = document.querySelector("#stockPanel");
const stockTitle = document.querySelector("#stockTitle");
const stockPrice = document.querySelector("#stockPrice");
const stockChange = document.querySelector("#stockChange");
const stockChart = document.querySelector("#stockChart");
const searchFeedback = document.querySelector("#searchFeedback");
const newsItemTemplate = document.querySelector("#newsItemTemplate");
const modeButtons = [...document.querySelectorAll(".mode-button")];

let currentMode = "auto";
let refreshTimer = null;

function formatRelativeDate(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return "시간 정보 없음";
  }

  const diffMs = Date.now() - time.getTime();
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));

  if (diffMinutes < 1) return "방금 전";
  if (diffMinutes < 60) return `${diffMinutes}분 전`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}시간 전`;

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}일 전`;
}

function formatAbsoluteDate(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return "알 수 없음";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

function formatCurrency(price, currency = "USD") {
  if (!Number.isFinite(price)) {
    return "-";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(price);
}

function setMode(mode) {
  currentMode = mode;
  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function renderEmptyState(message) {
  newsList.innerHTML = `<div class="empty-state">${message}</div>`;
}

function setFeedback(message, isError = false) {
  searchFeedback.textContent = message;
  searchFeedback.classList.toggle("is-error", isError);
}

function renderNews(items) {
  newsList.innerHTML = "";

  if (!items.length) {
    renderEmptyState("검색 결과가 없습니다. 다른 키워드나 종목명으로 시도해보세요.");
    return;
  }

  const fragment = document.createDocumentFragment();

  items.forEach((item) => {
    const node = newsItemTemplate.content.cloneNode(true);
    const title = node.querySelector(".news-title");
    const original = node.querySelector(".news-original");
    const source = node.querySelector(".news-source");
    const time = node.querySelector(".news-time");

    // 유튜브/SNS 썸네일 컨테이너 바인딩을 위한 선택기
    const thumbContainer = node.querySelector(".news-thumbnail-container");
    const thumbImg = node.querySelector(".news-thumbnail");

    const translatedTitle = item.translatedTitle || item.title;
    const originalTitle = item.originalTitle || item.title;

    title.textContent = translatedTitle;
    title.href = item.url;
    original.textContent = translatedTitle === originalTitle ? "" : originalTitle;
    original.hidden = translatedTitle === originalTitle;
    source.textContent = item.source;
    time.textContent = `${formatRelativeDate(item.publishedAt)} · ${formatAbsoluteDate(item.publishedAt)}`;
    time.dateTime = item.publishedAt || "";

    // 1. 소셜 미디어 플랫폼별 컬러 뱃지 렌더링 처리
    const provider = (item.provider || "").toLowerCase();
    const isSnsOrYoutube = ["twitter", "instagram", "threads", "reddit", "youtube"].includes(provider);
    if (isSnsOrYoutube) {
      const badge = document.createElement("span");
      badge.className = `badge-sns badge-${provider}`;
      badge.textContent = item.provider === "Twitter" ? "X" : item.provider;
      // 타이틀 앵커 태그 바로 앞에 뱃지 엘리먼트 배치
      title.parentNode.insertBefore(badge, title);
    }

    // 2. 유튜브 동영상일 경우 썸네일 활성화 및 이미지 설정
    if (item.provider === "Youtube") {
      thumbContainer.hidden = false;
      // 썸네일 데이터가 공백인 RSS 우회 방식일 때, 고품질 무료 유튜브 플레이스홀더를 사용하여 레이아웃 완성도를 높입니다.
      thumbImg.src = item.thumbnail || "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=320&q=80";
      thumbImg.alt = translatedTitle;
    } else {
      thumbContainer.hidden = true;
    }

    fragment.appendChild(node);
  });

  newsList.appendChild(fragment);
}

function renderStock(stock) {
  if (!stock || !Array.isArray(stock.data) || !stock.data.length) {
    stockPanel.hidden = true;
    return;
  }

  stockPanel.hidden = false;
  stockTitle.textContent = `${stock.symbol} ${stock.exchange ? `· ${stock.exchange}` : ""}`;
  stockPrice.textContent = formatCurrency(stock.regularMarketPrice, stock.currency);

  const changePrefix = stock.change > 0 ? "+" : "";
  stockChange.textContent = `${changePrefix}${stock.change} (${changePrefix}${stock.changePercent}%)`;
  stockChange.className = stock.change >= 0 ? "change-up" : "change-down";

  renderChart(stock.data);
}

function renderChart(points) {
  const width = 640;
  const height = 260;
  const padding = 18;
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const chartPoints = points.map((point, index) => {
    const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((point.price - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  });

  const polyline = chartPoints.join(" ");
  const areaPath = [
    `M ${padding} ${height - padding}`,
    `L ${chartPoints[0] || `${padding},${height - padding}`}`,
    ...chartPoints.slice(1).map((point) => `L ${point}`),
    `L ${width - padding} ${height - padding}`,
    "Z",
  ].join(" ");

  const latest = prices.at(-1) || 0;
  const earliest = prices[0] || 0;
  const stroke = latest >= earliest ? "#4ade80" : "#ff7b7b";
  const fill = latest >= earliest ? "rgba(74, 222, 128, 0.16)" : "rgba(255, 123, 123, 0.16)";

  stockChart.innerHTML = `
    <defs>
      <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${fill}" />
        <stop offset="100%" stop-color="rgba(255,255,255,0)" />
      </linearGradient>
    </defs>
    <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="rgba(255,255,255,0.08)" />
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="rgba(255,255,255,0.08)" />
    <path d="${areaPath}" fill="url(#chartFill)"></path>
    <polyline fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${polyline}"></polyline>
  `;
}

async function runSearch() {
  const query = queryInput.value.trim();
  if (!query) {
    renderEmptyState("검색어를 먼저 입력해주세요.");
    statusMessage.textContent = "검색어를 입력하면 최신 뉴스를 시간순으로 표시합니다.";
    setFeedback("검색어를 먼저 입력해주세요.", true);
    return;
  }

  searchButton.disabled = true;
  searchButton.textContent = "검색중...";
  statusMessage.textContent = "최신 기사와 주식 데이터를 가져오고 한국어로 번역하는 중입니다.";
  setFeedback(`"${query}" 검색 중입니다. 최신 기사 제목을 한국어로 번역하고 있어요.`);

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&mode=${encodeURIComponent(currentMode)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "검색에 실패했습니다.");
    }

    currentQuery.textContent = payload.query;
    lastUpdated.textContent = formatAbsoluteDate(payload.fetchedAt);
    newsCount.textContent = String(payload.news.length);
    statusMessage.textContent = `${payload.news.length}개의 최신 기사를 한국어 번역 제목으로 정렬했습니다.`;
    setFeedback(`검색 완료: ${payload.news.length}개의 최신 기사를 한국어로 표시했습니다.`);

    renderNews(payload.news);
    renderStock(payload.stock);
    document.querySelector(".dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    stockPanel.hidden = true;
    renderEmptyState("외부 뉴스 또는 주식 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해주세요.");
    statusMessage.textContent = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    setFeedback(statusMessage.textContent, true);
  } finally {
    searchButton.disabled = false;
    searchButton.textContent = "검색";
  }
}

function resetRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  if (autoRefresh.checked) {
    refreshTimer = setInterval(() => {
      if (queryInput.value.trim()) {
        runSearch();
      }
    }, 60000);
  }
}

searchButton.addEventListener("click", runSearch);
queryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runSearch();
  }
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setMode(button.dataset.mode);
    if (queryInput.value.trim()) {
      runSearch();
    }
  });
});

autoRefresh.addEventListener("change", resetRefreshTimer);

setMode("auto");
resetRefreshTimer();
renderEmptyState("검색어를 입력하면 여기서 가장 최근 뉴스부터 시간순으로 확인할 수 있습니다.");
setFeedback("검색어를 입력한 뒤 검색 버튼을 누르면 결과 영역으로 바로 이동합니다.");
