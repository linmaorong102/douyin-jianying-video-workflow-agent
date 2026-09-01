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
$sourceVideoScript = Join-Path $PSScriptRoot 'sync_video_library.js'
$sourceVoiceoverScript = Join-Path $PSScriptRoot 'sync_voiceover_tasks.js'
$sourcePrepareScript = Join-Path $PSScriptRoot 'prepare_next_task.js'
$sourceWordExtractor = Join-Path $PSScriptRoot 'extract_word_text.ps1'
$sourceTemplate = Join-Path $skillRoot 'assets\batch-voiceover-template.txt'
$sourceWorkflow00 = Join-Path $skillRoot 'workflows\00-一键准备下一条-v1.json'
$sourceWorkflow01 = Join-Path $skillRoot 'workflows\01-视频素材自动入库-v1.json'
$sourceWorkflow02 = Join-Path $skillRoot 'workflows\02-口播文案解析-v1.json'

$requiredSources = @(
    $sourceVideoScript,
    $sourceVoiceoverScript,
    $sourcePrepareScript,
    $sourceWordExtractor,
    $sourceTemplate,
    $sourceWorkflow00,
    $sourceWorkflow01,
    $sourceWorkflow02
)
foreach ($requiredSource in $requiredSources) {
    if (-not (Test-Path -LiteralPath $requiredSource -PathType Leaf)) {
        throw "Missing skill component: $requiredSource"
    }
}

$scriptsFolder = Join-Path $fullRoot 'scripts'
$workflowsFolder = Join-Path $fullRoot 'workflows'
$templatesFolder = Join-Path $fullRoot $templateFolderName
$targetTemplate = Join-Path $templatesFolder $templateFileName
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$workspaceFolders = @(
    '01_待入库',
    '02_素材库',
    '03_口播文案',
    '04_制作任务',
    '05_剪映草稿',
    '06_成片',
    'scripts',
    'workflows',
    'tools',
    $templateFolderName
)
foreach ($folderName in $workspaceFolders) {
    New-Item -ItemType Directory -Path (Join-Path $fullRoot $folderName) -Force | Out-Null
}

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
    Install-FileSafely -Source $sourceVideoScript -Target (Join-Path $scriptsFolder 'sync_video_library.js')
    Install-FileSafely -Source $sourceVoiceoverScript -Target (Join-Path $scriptsFolder 'sync_voiceover_tasks.js')
    Install-FileSafely -Source $sourcePrepareScript -Target (Join-Path $scriptsFolder 'prepare_next_task.js')
    Install-FileSafely -Source $sourceWordExtractor -Target (Join-Path $scriptsFolder 'extract_word_text.ps1')
    Install-FileSafely -Source $sourceTemplate -Target $targetTemplate
    Install-FileSafely -Source $sourceWorkflow00 -Target (Join-Path $workflowsFolder '00-一键准备下一条-v1.json')
    Install-FileSafely -Source $sourceWorkflow01 -Target (Join-Path $workflowsFolder '01-视频素材自动入库-v1.json')
    Install-FileSafely -Source $sourceWorkflow02 -Target (Join-Path $workflowsFolder '02-口播文案解析-v1.json')
)

$results | Format-Table -AutoSize
Write-Output "Workspace components installed: $fullRoot"
