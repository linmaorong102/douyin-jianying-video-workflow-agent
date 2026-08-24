[CmdletBinding()]
param(
    [string]$WorkspaceRoot = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Join-UnicodeChars {
    param([int[]]$CodePoints)
    return -join ($CodePoints | ForEach-Object { [char]$_ })
}

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $defaultFolder = Join-UnicodeChars @(0x6296, 0x97F3, 0x4FE1, 0x606F, 0x89C6, 0x9891, 0x5DE5, 0x4F5C, 0x6D41)
    $WorkspaceRoot = Join-Path 'D:\' $defaultFolder
}

if (-not [IO.Path]::IsPathRooted($WorkspaceRoot)) {
    throw 'WorkspaceRoot must be an absolute path.'
}

$fullRoot = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
$driveRoot = [IO.Path]::GetPathRoot($fullRoot).TrimEnd('\')
if ($fullRoot -eq $driveRoot) {
    throw 'WorkspaceRoot cannot be a drive root.'
}

$templateFolderName = Join-UnicodeChars @(0x6587, 0x6848, 0x6A21, 0x677F)
$templateFileName = (Join-UnicodeChars @(0x6279, 0x91CF, 0x89C6, 0x9891, 0x6587, 0x6848, 0x6A21, 0x677F)) + '.txt'
$skillRoot = Split-Path -Parent $PSScriptRoot
$sourceScript = Join-Path $PSScriptRoot 'sync_voiceover_tasks.js'
$sourceTemplate = Join-Path $skillRoot 'assets\batch-voiceover-template.txt'

if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) {
    throw "Missing skill script: $sourceScript"
}
if (-not (Test-Path -LiteralPath $sourceTemplate -PathType Leaf)) {
    throw "Missing batch template: $sourceTemplate"
}

$scriptsFolder = Join-Path $fullRoot 'scripts'
$templatesFolder = Join-Path $fullRoot $templateFolderName
$targetScript = Join-Path $scriptsFolder 'sync_voiceover_tasks.js'
$targetTemplate = Join-Path $templatesFolder $templateFileName
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

New-Item -ItemType Directory -Path $scriptsFolder -Force | Out-Null
New-Item -ItemType Directory -Path $templatesFolder -Force | Out-Null

function Install-FileSafely {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $backup = $null
    if (Test-Path -LiteralPath $Target -PathType Leaf) {
        $sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
        if ($sourceHash -eq $targetHash) {
            return [pscustomobject]@{ Target = $Target; Action = 'Current'; Backup = '' }
        }
        if (-not $Force) {
            throw "Target differs: $Target. Re-run with -Force to back up and update it."
        }
        $backup = "$Target.backup-$timestamp"
        Copy-Item -LiteralPath $Target -Destination $backup
    }

    Copy-Item -LiteralPath $Source -Destination $Target -Force
    $backupText = if ($null -eq $backup) { '' } else { $backup }
    return [pscustomobject]@{ Target = $Target; Action = 'Installed'; Backup = $backupText }
}

$results = @(
    Install-FileSafely -Source $sourceScript -Target $targetScript
    Install-FileSafely -Source $sourceTemplate -Target $targetTemplate
)

$results | Format-Table -AutoSize
Write-Output "Workspace components installed: $fullRoot"
