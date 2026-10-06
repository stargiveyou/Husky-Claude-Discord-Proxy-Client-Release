#
# Husky 에이전트 트레이 아이콘
# ==============================================================================
# Node(에이전트)가 stdio 파이프로 이 스크립트를 띄운다. 이 스크립트는 알림 영역에
# 아이콘 하나를 올리고, 메뉴 클릭을 stdout으로 되돌려 준다.
#
#   Node → PS (stdin)   {"type":"status","value":"connected"|"disconnected"}
#   PS → Node (stdout)  {"ready":true} / {"menu":"open"} / {"menu":"quit"}
#
# 파이프 위에 오가는 문자열은 ASCII만 쓴다. PowerShell 5.1의 리디렉션 stdout은
# UTF-8이 아니므로 한글을 실어 보내면 깨진다. 한글 라벨은 이 파일 안 상수로만 둔다.
# (이 파일 자체는 UTF-8 BOM으로 저장해야 PS 5.1이 한글을 올바로 읽는다.)
#
# 인자: $args[0] = 연결됨(컬러) .ico 절대 경로   (선택)
#       $args[1] = 연결 끊김(흑백) .ico 절대 경로 (선택)
#       읽지 못한 쪽은 다른 쪽으로, 둘 다 없으면 시스템 아이콘으로 대체한다.
# 종료: stdin EOF 하나뿐이다. 종료용 메시지는 정의하지 않는다.
# ==============================================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 한글 라벨 — 파이프가 아니라 이 파일 안에서만 쓴다.
$LABEL_OPEN = 'Husky 대시보드 열기'
$LABEL_QUIT = '에이전트 종료'
$LABEL_CONNECTED = '상태: 연결됨'
$LABEL_DISCONNECTED = '상태: 연결 끊김 · 재연결 중'
$TOOLTIP_PREFIX = 'Husky - '   # NotifyIcon.Text는 63자 제한

function Send-Line([string]$json) {
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# stdin 리더 — **[Console]::In을 쓰지 않는다.**
#
# 리디렉션된 [Console]::In은 SyncTextReader이고, 이 타입의 ReadLineAsync()는 이름과 달리
# 동기 실행된다(내부가 Task.FromResult(ReadLine())라 호출 즉시 블로킹된다).
# 그러면 아래 메시지 루프가 "다음 줄이 올 때까지" 멈춰 DoEvents()를 돌리지 못하고,
# 셸이 보낸 트레이 우클릭 메시지(WM_TRAYMOUSEMESSAGE)가 큐에 쌓인 채 처리되지 않는다.
# 증상은 "우클릭해도 아무 반응이 없다"이다. 상태 메시지는 연결/끊김 때만 오므로
# 사실상 프로세스가 내내 블로킹된다.
#
# 실측(2026-09-17): [Console]::In.ReadLineAsync() = 5247ms 블로킹(completed=true 반환),
#                   StreamReader.ReadLineAsync() = 2ms 반환(completed=false).
# StreamReader를 직접 만들면 SyncTextReader 래퍼를 거치지 않아 진짜 비동기가 된다.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::ASCII)

# 아이콘 로드 — 실패해도 계속한다. 아이콘 문제로 트레이 생성을 중단하지 않는다.
function Load-Icon([string]$path) {
  if (-not $path) { return $null }
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return New-Object System.Drawing.Icon($path) } catch { return $null }
}

$iconConnected = $null
$iconDisconnected = $null
if ($args.Count -ge 1) { $iconConnected = Load-Icon $args[0] }
if ($args.Count -ge 2) { $iconDisconnected = Load-Icon $args[1] }

# 한쪽만 읽혔으면 양쪽에 같은 것을 쓴다. 상태 표시는 메뉴·툴팁 문구로도 남는다.
if ($null -eq $iconConnected) { $iconConnected = $iconDisconnected }
if ($null -eq $iconDisconnected) { $iconDisconnected = $iconConnected }
if ($null -eq $iconConnected) {
  $iconConnected = [System.Drawing.SystemIcons]::Application
  $iconDisconnected = $iconConnected
}

# 메뉴 — 열기 / 상태(비활성) / 종료 순서. 초기 상태는 disconnected.
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$itemOpen.Text = $LABEL_OPEN
$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStatus.Text = $LABEL_DISCONNECTED
$itemStatus.Enabled = $false
$itemQuit = New-Object System.Windows.Forms.ToolStripMenuItem
$itemQuit.Text = $LABEL_QUIT
$menu.Items.Add($itemOpen) | Out-Null
$menu.Items.Add($itemStatus) | Out-Null
$menu.Items.Add($itemQuit) | Out-Null

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconDisconnected
$notify.Text = $TOOLTIP_PREFIX + $LABEL_DISCONNECTED
$notify.ContextMenuStrip = $menu

$script:run = $true
# 브라우저는 Node가 연다. 이 스크립트는 대시보드 주소를 알지 못한다.
$itemOpen.add_Click({ Send-Line '{"menu":"open"}' })
$itemQuit.add_Click({ Send-Line '{"menu":"quit"}'; $script:run = $false })

$notify.Visible = $true
Send-Line '{"ready":true}'

try {
  # Application::Run()을 쓰면 스레드를 점유해 stdin을 읽을 수 없다.
  # 그래서 DoEvents + 100ms 폴링으로 메시지 루프를 직접 돌린다.
  # 컨텍스트 메뉴는 표시 중 자체 메시지 루프를 돌리므로 클릭 반응은 지연되지 않는다.
  $task = $stdin.ReadLineAsync()
  while ($script:run) {
    [System.Windows.Forms.Application]::DoEvents()
    if ($task.IsCompleted) {
      $line = $null
      try { $line = $task.Result } catch { break }
      if ($null -eq $line) { break }   # stdin EOF → 종료
      try {
        $msg = $line | ConvertFrom-Json
        if ($msg.type -eq 'status') {
          if ($msg.value -eq 'connected') {
            $label = $LABEL_CONNECTED
            $stateIcon = $iconConnected
          } else {
            $label = $LABEL_DISCONNECTED
            $stateIcon = $iconDisconnected
          }
          $itemStatus.Text = $label
          $notify.Text = $TOOLTIP_PREFIX + $label
          # 아이콘 교체. 두 Icon 객체는 스크립트 수명 내내 살아 있으므로 Dispose하지 않는다
          # — 지금 표시 중인 쪽을 해제하면 셸이 빈 아이콘을 그린다.
          $notify.Icon = $stateIcon
        }
      } catch {
        # 알 수 없는 줄은 조용히 버린다. 승인 흐름을 막지 않는다.
      }
      $task = $stdin.ReadLineAsync()
    }
    Start-Sleep -Milliseconds 100
  }
} finally {
  # 순서가 중요하다 — 먼저 숨기고 나서 해제해야 고스트 아이콘이 남지 않는다.
  $notify.Visible = $false
  $notify.Dispose()
}
