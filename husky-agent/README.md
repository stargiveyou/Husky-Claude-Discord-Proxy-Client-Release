# Husky Windows 에이전트

권한 요청을 **Windows 토스트 알림**으로 받아 그 자리에서 승인·거부합니다.
트레이 아이콘으로 연결 상태를 보여주고, 알림을 클릭하면 웹 대시보드가 열립니다.

훅(`client/hook/husky-hook.js`)만으로도 디스코드 승인은 동작합니다.
**이 에이전트는 선택 사항**이며, 데스크톱 알림이 필요할 때만 설치하세요.

---

## 요구 사항

| 항목 | 값 |
| :--- | :--- |
| OS | Windows 10 / 11 |
| Node.js | **20.0.0 이상** (LTS 권장) |
| 관리자 권한 | 필요 없음 |
| 인터넷 | 필요 없음 (의존성이 묶음에 들어 있습니다) |

Node는 동봉하지 않습니다. 없으면 [nodejs.org](https://nodejs.org)에서 LTS를 먼저 설치하세요.

```powershell
node -v      # v20 이상이어야 합니다
```

---

## 설치

먼저 훅 클라이언트(`client/` 폴더)가 개발 PC에 있어야 합니다. 에이전트는 그 폴더의
`.husky.env`를 **공유**하기 때문입니다. 설치 위치는 언제나 `<client>/agent/` 입니다.

```powershell
# 1) 이 묶음(husky-agent 폴더)을 아무 곳에나 풀어 놓고, 그 안에서
node install-agent.mjs

# 2) client/ 폴더를 자동으로 못 찾으면 직접 지정
node install-agent.mjs --target C:\path\to\client
```

`client/` 폴더는 **cwd에서 위로 올라가며 `hook/husky-hook.js`가 있는 디렉터리**를 찾습니다.
환경 변수 `HUSKY_CLIENT_DIR`로도 지정할 수 있습니다.

| 명령 | 동작 |
| :--- | :--- |
| `node install-agent.mjs` | 설치 / 업데이트 |
| `node install-agent.mjs --force` | 내용이 같아도 다시 설치 |
| `node install-agent.mjs --check` | 설치 상태만 점검 (1~5번) |
| `node install-agent.mjs --doctor` | 전체 점검 (1~9번) |
| `node uninstall-agent.mjs` | 제거 |
| `node uninstall-agent.mjs --check` | 지울 대상 미리 보기 |

### 설정

에이전트는 **`<client>/.husky.env`를 훅과 공유**합니다.
**이 설치기는 그 파일을 만들거나 고치지 않습니다.** 없다면 훅 쪽 도구로 만드세요.

```powershell
cd C:\path\to\client
node install.mjs
```

에이전트가 쓰는 항목은 다음과 같습니다 (전부 선택 사항이며, 없으면 기본값을 씁니다).

| 키 | 기본값 | 뜻 |
| :--- | :--- | :--- |
| `HUSKY_URL` 또는 `HUSKY_HOST`/`HUSKY_PORT` | `127.0.0.1:3001` | 서버 주소 |
| `HUSKY_TOKEN` | (비어 있음) | 서버 `API_SECRET_KEY`와 같은 값 |
| `HUSKY_HOST_LABEL` | 컴퓨터 이름 | 승인 기록에 남는 이 PC의 이름 |
| `HUSKY_AGENT_NOTIFICATIONS` | `1` | `0`/`false`/`off`/`no` 면 토스트를 끕니다 |
| `HUSKY_AGENT_HEARTBEAT_MS` | `30000` | 세션 하트비트 주기 |
| `HUSKY_DASHBOARD_URL` | 서버 origin + `/proxyDashboard/` | 알림·트레이 메뉴가 여는 주소 |

---

## 실행

```powershell
cd C:\path\to\client\agent
node dist/index.js
```

정상이면 이런 로그가 나옵니다.

```
[husky-agent] 서버: http://husky-mini.local:3001
[husky-agent] 호스트 라벨: MY-PC
[husky-agent] 알림: 켜짐
[husky-agent] 서버 연결 확인 · authEnabled=true
[husky-agent] 대기 중입니다. 종료하려면 Ctrl-C.
[husky-agent] 트레이 아이콘을 표시했습니다.
[husky-agent] 실시간 연결됨
```

`알림:` 줄은 `HUSKY_AGENT_NOTIFICATIONS` 값에 따라 `켜짐` 또는 `꺼짐`입니다.

서버가 꺼져 있어도 **에이전트는 종료되지 않습니다.**

```
[husky-agent] 서버에 연결할 수 없습니다: connect ECONNREFUSED 127.0.0.1:3001
[husky-agent] 연결될 때까지 자동으로 재시도합니다.
```

종료는 `Ctrl-C` 또는 트레이 아이콘 우클릭 → 종료입니다.

> **자동 시작은 지원하지 않습니다.** 레지스트리·시작 프로그램 폴더를 건드리지 않습니다.
> 로그인할 때마다 직접 실행하세요.

---

## 업데이트

새 묶음 안에서 `node install-agent.mjs`를 다시 실행하면 됩니다.

- 실행 중이면 **설치기가 알아서 종료**시킵니다 (PID 파일 → `taskkill /T /F` → 잔여 트레이 정리).
- 내용이 같으면(`dist/`·`assets/`의 sha256 다이제스트가 동일) `변경 없음`으로 건너뜁니다.
  다시 넣고 싶으면 `--force`.
- 교체는 **폴더 통째 rename**입니다. 중간에 실패해도 옛 설치로 되돌아가며, 새 파일과 옛 파일이
  섞인 상태가 남지 않습니다.
- `<client>/.husky.env`는 교체 대상 밖이라 **설정이 그대로 보존**됩니다.

5초 안에 종료되지 않으면 설치를 중단합니다. 트레이 아이콘에서 종료한 뒤 다시 실행하세요.

---

## 진단

```powershell
node install-agent.mjs --doctor --target C:\path\to\client
```

| # | 검사 | 실패 시 |
| :-- | :--- | :--- |
| 1 | Node 20 이상 | FAIL |
| 2 | 설치 경로 존재 | FAIL |
| 3 | `dist/index.js`, `dist/config.js` | FAIL |
| 4 | `assets/tray.ps1`, 아이콘 | WARN (트레이만 꺼짐) |
| 5 | `node_modules/ws`, `node_modules/node-notifier` | FAIL |
| 6 | 설정 해석 (`baseUrl`·`hostLabel`·`dashboardUrl`·토큰 유무) | FAIL |
| 7 | 그룹 정책 실행 정책 | WARN |
| 8 | MOTW (`Zone.Identifier`) | WARN |
| 9 | PowerShell 언어 모드 | WARN |

7~9번은 **트레이가 조용히 안 뜨는 원인 셋**입니다. 예를 들면 이렇게 나옵니다.

```
[7] 실행 정책 (그룹 정책)
  WARN  그룹 정책이 실행 정책을 고정했습니다 (MachinePolicy=AllSigned).
        -ExecutionPolicy Bypass 가 무시되어 트레이가 뜨지 않을 수 있습니다.

[8] MOTW (다른 PC에서 받은 파일 표시)
  WARN  Zone.Identifier 스트림이 붙어 있습니다 (인터넷에서 받은 파일로 표시됨).
        PowerShell이 스크립트 실행을 거부할 수 있습니다. 해제:
          Get-ChildItem -Recurse "C:\path\to\client\agent" | Unblock-File

[9] 언어 모드
  WARN  ConstrainedLanguage 입니다 — .NET 타입을 못 써서 트레이 아이콘을 만들 수 없습니다.
```

셋 다 **트레이에만** 영향을 줍니다. 토스트 알림과 승인은 그대로 동작합니다.

> 묶음을 메일·USB·네트워크 드라이브로 받았다면 Windows가 파일에 차단 표시(MOTW)를 붙입니다.
> 설치 직후 한 번 풀어 두면 안전합니다.
>
> ```powershell
> Get-ChildItem -Recurse C:\path\to\client\agent | Unblock-File
> ```

**서버 도달성·인증·타임아웃 체인은 이 도구가 보지 않습니다.** 그쪽은 훅 도구의 몫입니다.

```powershell
node C:\path\to\client\install.mjs --doctor
```

---

## 제거

```powershell
node uninstall-agent.mjs --check     # 무엇이 지워지는지 먼저 확인
node uninstall-agent.mjs
```

`<client>/agent/` 만 지웁니다. **`.husky.env`, `hook/`, `~/.claude/settings.json`의 훅 등록은
보존**합니다. 훅까지 해제하려면 `node ..\install.mjs --remove` 를 쓰세요.

---

## 알아둘 것

- 실행 중임을 `%LOCALAPPDATA%\husky-agent\agent.pid` 에 기록합니다. 설치 디렉터리 **밖**에 두는
  이유는, 업데이트가 폴더를 통째로 교체하기 때문입니다.
- 에이전트 프로세스의 CommandLine은 `node.exe dist/index.js` 뿐이라 어느 설치본인지 구분할 수
  없습니다. 그래서 PID 파일로 식별합니다.
- 통신은 서버 설정에 따라 평문 HTTP일 수 있습니다. LAN 밖에서 쓰려면 VPN이나 HTTPS 터널을 쓰세요.
