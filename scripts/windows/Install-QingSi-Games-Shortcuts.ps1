[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$desktopPath = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktopPath) -or -not (Test-Path -LiteralPath $desktopPath -PathType Container)) {
    throw 'Windows Desktop is unavailable.'
}

$cmdPath = $env:ComSpec
if ([string]::IsNullOrWhiteSpace($cmdPath)) {
    $cmdPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
}
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcuts = @(
    @{ Name = '启动 QingSi Games'; Wrapper = 'Start-QingSi-Games.cmd'; Action = 'start'; Icon = 137 },
    @{ Name = '停止 QingSi Games'; Wrapper = 'Stop-QingSi-Games.cmd'; Action = 'stop'; Icon = 131 },
    @{ Name = 'QingSi Games 状态'; Wrapper = 'Status-QingSi-Games.cmd'; Action = 'status'; Icon = 23 }
)

foreach ($item in $shortcuts) {
    $shortcutPath = Join-Path $desktopPath ($item.Name + '.lnk')
    $marker = 'QingSi Games desktop control V1: ' + $item.Action
    $exists = Test-Path -LiteralPath $shortcutPath
    if ($exists) {
        $existing = $shortcutShell.CreateShortcut($shortcutPath)
        if ($existing.Description -ne $marker) {
            Write-Warning ('Skipped a shortcut not owned by this installer: ' + $item.Name)
            continue
        }
    }

    if ($Uninstall) {
        if ($exists) {
            Remove-Item -LiteralPath $shortcutPath
            Write-Host ('Removed: ' + $item.Name)
        }
        continue
    }

    $wrapperPath = Join-Path $PSScriptRoot $item.Wrapper
    if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) {
        throw ('Missing Windows wrapper: ' + $item.Wrapper)
    }
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $cmdPath
    # cmd.exe's outer quotes preserve a quoted command path, including UNC paths,
    # spaces and Chinese Windows usernames. Use a local working directory.
    $shortcut.Arguments = '/d /c ""{0}""' -f $wrapperPath
    $shortcut.WorkingDirectory = $env:USERPROFILE
    $shortcut.Description = $marker
    $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',' + $item.Icon
    $shortcut.Save()
    Write-Host ('Installed: ' + $item.Name)
}
