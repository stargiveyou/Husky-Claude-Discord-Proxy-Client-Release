# Husky Client Release

Windows PC에 Husky Claude Code 훅 클라이언트와 선택형 Windows agent를 설치하기 위한 배포 저장소입니다.
서버 소스와 개발용 도구는 포함하지 않습니다.

## 사전 준비

- Windows 10 또는 11
- Node.js 20 LTS 이상
- Claude Code
- 실행 중인 Husky 서버 주소와 서버 `API_SECRET_KEY`
- Git

관리자 권한은 필요하지 않습니다. 훅만 설치하는 경우에도 Node.js가 필요하며, 이 저장소는 Node 런타임을 포함하지 않습니다.

## 다운로드

```powershell
git clone https://github.com/stargiveyou/Husky-Claude-Discord-Proxy-Client-Release.git C:\Husky\Client-Release
Set-Location C:\Husky\Client-Release
```

Git을 사용하지 않는 경우 GitHub 저장소의 **Code → Download ZIP**으로 받아 압축을 풀어도 됩니다.

## 훅 설치

```powershell
node .\client\install.mjs
```

설치기는 사용자 전역 Claude Code 설정(`~\.claude\settings.json`)에 훅을 등록하고,
`client\.husky.env.example`을 바탕으로 `client\.husky.env`를 만듭니다.
기존 Claude Code 설정은 백업 후 보존합니다.

`client\.husky.env`를 열어 서버 주소와 인증 토큰을 설정합니다.

```env
HUSKY_URL=https://<Husky 서버 주소>
HUSKY_TOKEN=<서버의 API_SECRET_KEY>
```

LAN에서 평문 HTTP를 사용하는 서버라면 `HUSKY_URL=http://<서버 IP>:3001`처럼 설정할 수 있습니다.
`HUSKY_URL`을 사용하면 `HUSKY_HOST`와 `HUSKY_PORT`는 무시됩니다.

Discord 직접 폴백을 사용하지 않을 경우에는 같은 파일에서 `HUSKY_DIRECT_FALLBACK=0`으로 설정하세요.
실제 토큰이 포함된 `.husky.env`는 이 저장소에 커밋하지 마세요.

## 훅 연결 확인

```powershell
node .\client\install.mjs --doctor
```

진단에서 서버 연결·인증을 확인할 수 있습니다. `/health` 이외의 API는 설정에 따라 인증이 필요합니다.

## Windows agent 설치 (선택)

agent는 토스트 알림과 트레이 상태 표시를 제공합니다. 훅 및 Discord 승인만 사용할 경우 설치하지 않아도 됩니다.

```powershell
node .\husky-agent\install-agent.mjs --target C:\Husky\Client-Release\client
node .\husky-agent\install-agent.mjs --doctor --target C:\Husky\Client-Release\client
```

agent 설치기는 배포된 파일을 `client\agent\`에 설치합니다. `client\.husky.env`의 서버 설정을 훅과 공유하며,
`npm install`은 필요하지 않습니다.

agent를 실행합니다.

```powershell
Set-Location C:\Husky\Client-Release\client\agent
node .\dist\index.js
```

현재 agent는 Windows 로그인 시 자동 시작하지 않습니다. 로그인 후 위 명령으로 직접 실행해야 합니다.
Windows의 PowerShell 정책 또는 다운로드 파일 차단 표시(MOTW)에 따라 트레이 아이콘이 제한될 수 있습니다.
자세한 진단 방법은 [`husky-agent/README.md`](./husky-agent/README.md)를 참고하세요.

## 업데이트

이 저장소를 새로 내려받아 최신 배포 파일을 준비한 다음 agent 설치 명령을 다시 실행합니다.
기존 `client\.husky.env`는 agent 설치·업데이트 시 보존됩니다.

## 제거

agent만 제거하려면 배포 저장소에서 실행합니다.

```powershell
node .\husky-agent\uninstall-agent.mjs --target C:\Husky\Client-Release\client
```

Claude Code 훅 등록 해제:

```powershell
node .\client\install.mjs --remove
```

## 포함 파일

- `client\install.mjs`: Claude Code 훅 등록·진단·해제 도구
- `client\hook\husky-hook.js`: 의존성 없는 훅 실행 파일
- `client\.husky.env.example`: 비밀값이 없는 설정 예시
- `husky-agent\`: Windows agent 실행 파일, 빌드 결과, 런타임 의존성 및 설치·제거 도구

실제 서버 주소나 인증값은 배포 파일에 포함하지 않습니다. 네트워크 외부에서 사용할 때는 HTTPS 또는 VPN을 사용하세요.
