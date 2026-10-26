# Brings the window that hosts a Claude Code chat to the front.
#
#   powershell -NoProfile -File focus-window.ps1 -ProcessId <pid> [-Cwd <folder>] [-DryRun]
#
# Walks up from the chat's process to the first ancestor that owns a visible
# top-level window (Windows Terminal, Cursor, a console host...), then raises it.
# An editor like Cursor keeps one window per workspace under one process, so
# when the host owns several windows the one whose title names a folder of -Cwd
# (deepest folder first) is raised. Windows Terminal and editors share a window
# between many chats, so this raises the window, not the tab. -DryRun only
# reports the window it found.
# Prints one line of JSON: { ok, window?, title?, host?, windows?, matched?, error? }.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$Cwd = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$result) {
  Write-Output ($result | ConvertTo-Json -Compress)
}

try {
  $parents = @{}
  Get-CimInstance Win32_Process | ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  if (-not $parents.ContainsKey($ProcessId)) {
    Write-Result @{ ok = $false; error = 'process not running' }
    exit 0
  }

  # The desktop shell owns windows too, but it is never where a chat runs
  $skip = @('explorer', 'svchost', 'services', 'wininit', 'winlogon', 'System', 'Idle')
  $found = $null
  $current = $parents[$ProcessId]
  for ($depth = 0; $depth -lt 16 -and $current -gt 0 -and $parents.ContainsKey($current); $depth++) {
    $proc = Get-Process -Id $current -ErrorAction SilentlyContinue
    if ($proc -and $skip -contains $proc.ProcessName) { break }
    if ($proc -and $proc.MainWindowHandle -ne 0) { $found = $proc; break }
    $current = $parents[$current]
  }

  if (-not $found) {
    Write-Result @{ ok = $false; error = 'no window found for this chat (background chats have none, and a terminal that was closed or reparented cannot be traced)' }
    exit 0
  }

  Add-Type -Namespace Win -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr lParam);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetWindow(System.IntPtr h, uint cmd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int max);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

  # Every visible top-level window the host owns (an editor has one per workspace)
  $owned = New-Object System.Collections.ArrayList
  $callback = [Win.Native+EnumProc] {
    param($h, $l)
    $owner = [uint32]0
    [void][Win.Native]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $found.Id -and [Win.Native]::IsWindowVisible($h) -and [Win.Native]::GetWindow($h, 4) -eq [System.IntPtr]::Zero) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][Win.Native]::GetWindowText($h, $sb, 512)
      if ($sb.Length -gt 0) { [void]$owned.Add(@{ handle = $h; title = $sb.ToString() }) }
    }
    return $true
  }
  [void][Win.Native]::EnumWindows($callback, [System.IntPtr]::Zero)

  $target = @{ handle = [System.IntPtr]$found.MainWindowHandle; title = $found.MainWindowTitle }
  $matched = $false
  if ($owned.Count -gt 0) { $target = $owned[0] }
  if ($owned.Count -gt 1 -and $Cwd) {
    # Deepest folder of the chat's directory first: its title says "file - folder - Cursor"
    $folders = @($Cwd.Split([char[]]@([char]92, [char]47)) | Where-Object { $_ })
    [array]::Reverse($folders)
    foreach ($folder in $folders) {
      $hit = $owned | Where-Object { ($_.title -split ' - ') -contains $folder } | Select-Object -First 1
      if (-not $hit) { $hit = $owned | Where-Object { $_.title -like "*$folder*" } | Select-Object -First 1 }
      if ($hit) { $target = $hit; $matched = $true; break }
    }
  }

  if ($DryRun) {
    Write-Result @{ ok = $true; dryRun = $true; host = $found.ProcessName; window = [int64]$target.handle; title = $target.title; windows = $owned.Count; matched = $matched; cwd = $Cwd; titles = @($owned | ForEach-Object { $_.title }) }
    exit 0
  }

  $handle = [System.IntPtr]$target.handle
  if ([Win.Native]::IsIconic($handle)) { [void][Win.Native]::ShowWindow($handle, 9) }

  if (-not [Win.Native]::SetForegroundWindow($handle)) {
    # Windows only lets the foreground process take focus: borrow its input
    # queue for a moment, and tap Alt, which lifts the restriction
    $fgPid = [uint32]0
    $fgThread = [Win.Native]::GetWindowThreadProcessId([Win.Native]::GetForegroundWindow(), [ref]$fgPid)
    $me = [Win.Native]::GetCurrentThreadId()
    [void][Win.Native]::AttachThreadInput($me, $fgThread, $true)
    [Win.Native]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
    [Win.Native]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
    [void][Win.Native]::SetForegroundWindow($handle)
    [void][Win.Native]::AttachThreadInput($me, $fgThread, $false)
  }

  Write-Result @{ ok = $true; host = $found.ProcessName; window = [int64]$target.handle; title = $target.title; windows = $owned.Count; matched = $matched }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
}
