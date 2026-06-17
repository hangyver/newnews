# NewNews Live Search

키워드나 문장을 검색하면 전세계 최신 뉴스를 최신 시각순으로 정렬해 보여주는 간단한 웹앱입니다.

## 기능

- 키워드/문장 기반 글로벌 최신 뉴스 검색
- 최근 기사부터 정렬된 뉴스 피드
- 60초 자동 새로고침
- 주식 종목 검색 시 당일 차트 동시 표시
- 별도 패키지 설치 없이 `node server.mjs`로 실행

## 실행

```bash
node server.mjs
```

브라우저에서 `http://127.0.0.1:4178`로 접속하면 됩니다.

## Cloudflare Pages 설정

Cloudflare Pages에 연결할 때는 아래처럼 설정합니다.

```txt
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
```

만약 위 설정 후에도 루트 404가 계속 나오면, 임시 복구용으로 아래 설정도 동작합니다.

```txt
Framework preset: None
Build command: 비워둠
Build output directory: /
Root directory: /
```

`/api/search`와 `/api/health`는 `functions/` 폴더의 Pages Functions가 처리합니다.

## 데이터 소스

- 뉴스: Google News RSS
- 국내 뉴스 보강: Naver Search API 뉴스 검색
- 주식 차트: Yahoo Finance chart API

외부 서비스 응답 정책이 바뀌면 일부 데이터가 일시적으로 실패할 수 있습니다.

## 네이버 뉴스 검색 연결

네이버 개발자 센터에서 검색 API 애플리케이션을 등록한 뒤, 프로젝트 루트에 `.env` 파일을 만들고 아래 값을 넣으면 네이버 뉴스가 Google News 결과와 함께 최신순으로 합쳐집니다.

```bash
NAVER_CLIENT_ID=발급받은_CLIENT_ID
NAVER_CLIENT_SECRET=발급받은_CLIENT_SECRET
```

키가 없으면 기존처럼 Google News만 사용합니다.

Cloudflare Pages에서는 `.env` 파일을 올리지 말고, Pages 프로젝트의 Settings > Environment variables에 아래 두 값을 추가합니다.

```bash
NAVER_CLIENT_ID=발급받은_CLIENT_ID
NAVER_CLIENT_SECRET=발급받은_CLIENT_SECRET
```
