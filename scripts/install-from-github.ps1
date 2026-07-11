[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $HOME "correcao-nome-latam"),
    [switch]$DownloadOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repository = "https://github.com/rogerioaraujocosta/correcao-nome-latam"
$ArchiveUrl = "$Repository/archive/refs/heads/main.zip"
$Destination = [IO.Path]::GetFullPath($Destination)
$TemporaryDirectory = $null

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-ProjectDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Test-Path -LiteralPath (Join-Path $Path "package.json") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path "scripts\install.ps1") -PathType Leaf)
}

function Test-DirectoryEmpty {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $true
    }

    return $null -eq (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)
}

try {
    Write-Host "Instalador do Bot de Correcao de Nome LATAM" -ForegroundColor White
    Write-Host "O projeto sera instalado em: $Destination"

    $isUpdate = Test-ProjectDirectory -Path $Destination
    if ($isUpdate) {
        Write-Host "Uma instalacao existente foi encontrada e sera atualizada." -ForegroundColor Green
    }
    elseif ((Test-Path -LiteralPath $Destination) -and -not (Test-DirectoryEmpty -Path $Destination)) {
        throw "A pasta de destino ja existe e contem outros arquivos: $Destination. Escolha uma pasta vazia ou remova o conteudo manualmente."
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    catch {
        Write-Verbose "O PowerShell atual gerencia TLS automaticamente."
    }

    $TemporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("correcao-nome-latam-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TemporaryDirectory | Out-Null
    $ArchivePath = Join-Path $TemporaryDirectory "projeto.zip"
    $ExtractedPath = Join-Path $TemporaryDirectory "extraido"

    Write-Step $(if ($isUpdate) { "Baixando a versao mais recente do GitHub" } else { "Baixando o projeto publico do GitHub" })
    Invoke-WebRequest -UseBasicParsing -Uri $ArchiveUrl -OutFile $ArchivePath

    Write-Step "Extraindo os arquivos"
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractedPath
    $SourcePath = Join-Path $ExtractedPath "correcao-nome-latam-main"
    if (-not (Test-ProjectDirectory -Path $SourcePath)) {
        throw "O arquivo baixado nao contem a estrutura esperada do projeto."
    }

    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Path $Destination | Out-Null
    }
    Get-ChildItem -LiteralPath $SourcePath -Force | Copy-Item -Destination $Destination -Recurse -Force

    if (-not (Test-ProjectDirectory -Path $Destination)) {
        throw "O projeto nao foi copiado corretamente para $Destination."
    }
    Write-Host $(if ($isUpdate) { "Projeto atualizado com sucesso." } else { "Projeto baixado com sucesso." }) -ForegroundColor Green

    if ($DownloadOnly) {
        Write-Host "Download validado em: $Destination" -ForegroundColor Green
        exit 0
    }

    Write-Step "Iniciando a instalacao guiada"
    Set-Location -LiteralPath $Destination
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Destination "scripts\install.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "O instalador do projeto terminou com codigo $LASTEXITCODE."
    }

    Write-Step "Concluido"
    Write-Host "Para iniciar novamente, abra $Destination e clique em INICIAR-WINDOWS.cmd"
}
catch {
    Write-Host ""
    Write-Host "Falha: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if ($null -ne $TemporaryDirectory -and (Test-Path -LiteralPath $TemporaryDirectory)) {
        $ResolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        $ResolvedTarget = [IO.Path]::GetFullPath($TemporaryDirectory)
        if ($ResolvedTarget.StartsWith($ResolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $ResolvedTarget) -like "correcao-nome-latam-*") {
            Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
