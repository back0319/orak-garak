# 다같이 오락가락 (Orak Garak)

React/Phaser 프론트엔드와 Node.js/Socket.IO 서버로 구성된 최대 4인용 웹 게임입니다.

- 프론트엔드: Vercel (`https://orak-garak.vercel.app`)
- 백엔드: Azure Container Apps 한국 중부 리전
- 게임: 사과게임, 플래피 버드, 지뢰찾기
- 방 상태: 단일 서버 프로세스의 메모리(서버 재시작 시 초기화)

## 로컬 실행

Node.js 24와 pnpm 9.12.3을 사용합니다.

```bash
git clone https://github.com/back0319/orak-garak.git
cd orak-garak
corepack enable
pnpm install --frozen-lockfile
```

터미널 두 개에서 서버와 클라이언트를 실행합니다.

```bash
pnpm dev:server
```

```bash
pnpm dev
```

클라이언트는 기본적으로 `packages/client/.env.example`과 같이
`http://localhost:3000`의 서버에 연결합니다. 로컬 설정이 필요하면
`packages/client/.env.local`을 만들고 아래 값을 넣습니다.

```dotenv
VITE_SERVER_URL=http://localhost:3000
```

브라우저에서 `http://localhost:5173`을 엽니다. 서버 상태는
`http://localhost:3000/health`에서 확인할 수 있습니다.

## 주요 명령어

| 명령어 | 설명 |
| --- | --- |
| `pnpm dev` | Vite 클라이언트 실행 |
| `pnpm dev:server` | Socket.IO 서버 실행 |
| `pnpm build` | Vercel용 프론트엔드 빌드 |
| `pnpm build:server` | Node 서버 번들 생성 |
| `pnpm type-check` | 전체 TypeScript 검사 |
| `pnpm test:server` | 서버와 게임 동작 테스트 |
| `pnpm check:deploy` | 타입, 테스트, 양쪽 빌드 배포 게이트 |

## 배포 구조

### Azure 백엔드

루트 `Dockerfile`은 서버만 빌드하는 멀티스테이지 이미지입니다. Azure 구성은
`infra/azure/main.bicep`에 선언되어 있습니다.

- Region: `koreacentral`
- Container App: `orak-garak-server`
- CPU/Memory: 0.25 vCPU / 0.5 GiB
- Scale: 최소 1개, 최대 1개 replica
- Ingress: 외부 HTTPS, WebSocket 지원
- Health check: `GET /health`

`main` 브랜치에서 서버, 공통 패키지, Docker 또는 Azure 구성이 바뀌면
`.github/workflows/azure-backend.yml`이 다음을 수행합니다.

1. 타입 검사, 서버 테스트와 빌드
2. `ghcr.io/back0319/orak-garak-server:<commit-sha>` 이미지 게시
3. GitHub OIDC로 Azure 로그인
4. Bicep으로 Container App 생성 또는 갱신

GHCR의 `orak-garak-server` 패키지는 최초 이미지 게시 후 한 번만 Public으로
설정해야 합니다. GitHub 저장소의 Actions secrets에는 다음 값을 등록합니다.

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

장기 Azure 비밀키는 사용하지 않습니다. OIDC 자격 증명의 subject는
`repo:back0319/orak-garak:ref:refs/heads/main`으로 제한합니다.

### Vercel 프론트엔드

Vercel에서 `back0319/orak-garak` 저장소를 연결하고 프로젝트 이름을
`orak-garak`으로 설정합니다. 루트 `vercel.json`이 pnpm 설치, Vite 빌드와 SPA
rewrite를 담당합니다.

Production과 Preview 환경 모두 아래 환경 변수를 설정합니다.

```dotenv
VITE_SERVER_URL=https://<azure-container-app-fqdn>
```

`main`은 Production, 다른 브랜치와 PR은 Preview로 배포됩니다. 서버 CORS는
운영 주소 `https://orak-garak.vercel.app`, Vercel Preview 주소와 로컬 개발
주소만 허용합니다.

## 프로젝트 구조

```text
orak-garak/
├── .github/workflows/azure-backend.yml
├── infra/azure/main.bicep
├── packages/
│   ├── client/       # React, Phaser, Socket.IO client
│   ├── common/       # 공통 패킷과 타입
│   └── server/       # Node.js, Socket.IO, 게임 판정
├── Dockerfile
└── vercel.json
```

## 운영 제약

- 방과 게임 상태는 Node 프로세스 메모리에만 보관됩니다.
- 빈 방은 마지막 사용 후 1시간 뒤 제거됩니다.
- 배포나 서버 재시작 시 진행 중인 방은 사라집니다.
- replica를 한 개로 고정하므로 별도 세션 고정이나 분산 저장소가 필요 없습니다.
- 실제 두 기기 테스트가 끝날 때까지 기존 Cloudflare 배포는 롤백용으로 유지합니다.
