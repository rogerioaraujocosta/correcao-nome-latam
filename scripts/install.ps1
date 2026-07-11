[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$MinimumNodeMajor = 22
$TargetNodeMajor = 24
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Confirm-Action {
    param([Parameter(Mandatory = $true)][string]$Prompt)

    while ($true) {
        $answer = Read-Host "$Prompt [s/N]"
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $false
        }

        switch ($answer.Trim().ToLowerInvariant()) {
            { $_ -in @("s", "sim", "y", "yes") } { return $true }
            { $_ -in @("n", "nao", "no") } { return $false }
            default { Write-Host "Resposta invalida. Digite s ou n." -ForegroundColor Yellow }
        }
    }
}

function Update-ProcessPath {
    $pathParts = New-Object System.Collections.Generic.List[string]

    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $nodeInstallDirectory = Join-Path $env:ProgramFiles "nodejs"
        if (Test-Path -LiteralPath $nodeInstallDirectory -PathType Container) {
            $pathParts.Add($nodeInstallDirectory)
        }
    }

    foreach ($target in @("Machine", "User")) {
        try {
            $persistedPath = [Environment]::GetEnvironmentVariable("Path", $target)
            if (-not [string]::IsNullOrWhiteSpace($persistedPath)) {
                $pathParts.Add($persistedPath)
            }
        }
        catch {
            Write-Verbose "Nao foi possivel ler o PATH de escopo $target."
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($env:Path)) {
        $pathParts.Add($env:Path)
    }

    $env:Path = $pathParts -join ";"
}

function Get-NodeState {
    $nodeCommand = Get-Command -Name "node.exe" -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($null -eq $nodeCommand) {
        return [pscustomobject]@{
            Found    = $false
            Usable   = $false
            Version  = $null
            Major    = $null
            NodePath = $null
            NpmPath  = $null
            Reason   = "Node.js nao foi encontrado."
        }
    }

    $nodePath = $nodeCommand.Source
    $versionOutput = $null
    try {
        $versionOutput = (& $nodePath --version 2>$null).Trim()
    }
    catch {
        return [pscustomobject]@{
            Found    = $true
            Usable   = $false
            Version  = $null
            Major    = $null
            NodePath = $nodePath
            NpmPath  = $null
            Reason   = "O executavel Node.js encontrado nao pode ser iniciado."
        }
    }

    if ($versionOutput -notmatch '^v?(?<major>\d+)(?:\.\d+){1,2}') {
        return [pscustomobject]@{
            Found    = $true
            Usable   = $false
            Version  = $versionOutput
            Major    = $null
            NodePath = $nodePath
            NpmPath  = $null
            Reason   = "Nao foi possivel interpretar a versao do Node.js."
        }
    }

    $major = [int]$Matches.major
    $npmPath = Join-Path (Split-Path -Parent $nodePath) "npm.cmd"
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
        $npmCommand = Get-Command -Name "npm.cmd" -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $npmCommand) {
            $npmPath = $npmCommand.Source
        }
        else {
            $npmPath = $null
        }
    }

    if ($major -lt $MinimumNodeMajor) {
        return [pscustomobject]@{
            Found    = $true
            Usable   = $false
            Version  = $versionOutput
            Major    = $major
            NodePath = $nodePath
            NpmPath  = $npmPath
            Reason   = "Node.js $versionOutput e antigo; este projeto requer Node.js >= $MinimumNodeMajor."
        }
    }

    if ($null -eq $npmPath) {
        return [pscustomobject]@{
            Found    = $true
            Usable   = $false
            Version  = $versionOutput
            Major    = $major
            NodePath = $nodePath
            NpmPath  = $null
            Reason   = "Node.js $versionOutput foi encontrado, mas npm.cmd nao esta disponivel."
        }
    }

    return [pscustomobject]@{
        Found    = $true
        Usable   = $true
        Version  = $versionOutput
        Major    = $major
        NodePath = $nodePath
        NpmPath  = $npmPath
        Reason   = $null
    }
}

function Invoke-OfficialDownload {
    param(
        [Parameter(Mandatory = $true)][uri]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile
    )

    if ($Uri.Scheme -ne "https" -or $Uri.Host -ne "nodejs.org") {
        throw "Download recusado: a origem precisa ser https://nodejs.org."
    }

    if ($PSVersionTable.PSVersion.Major -lt 6) {
        Invoke-WebRequest -Uri $Uri.AbsoluteUri -OutFile $OutFile -UseBasicParsing
    }
    else {
        Invoke-WebRequest -Uri $Uri.AbsoluteUri -OutFile $OutFile
    }
}

function Get-WindowsArchitecture {
    $architecture = $env:PROCESSOR_ARCHITECTURE
    $wowArchitecture = $env:PROCESSOR_ARCHITEW6432

    if ($architecture -eq "ARM64" -or $wowArchitecture -eq "ARM64") {
        return "arm64"
    }

    if ($architecture -eq "AMD64" -or $wowArchitecture -eq "AMD64") {
        return "x64"
    }

    throw "Arquitetura do Windows nao suportada: $architecture."
}

function Get-Node24ReleaseMetadata {
    param([Parameter(Mandatory = $true)][string]$TempDirectory)

    $architecture = Get-WindowsArchitecture
    $baseUri = "https://nodejs.org/dist/latest-v$TargetNodeMajor.x"
    $sumsPath = Join-Path $TempDirectory "SHASUMS256.txt"

    Write-Step "Obtendo metadados oficiais do Node.js $TargetNodeMajor LTS"
    Invoke-OfficialDownload -Uri "$baseUri/SHASUMS256.txt" -OutFile $sumsPath

    $escapedArchitecture = [Regex]::Escape($architecture)
    $pattern = "^(?<sha>[A-Fa-f0-9]{64})\s+\*?(?<file>node-v(?<version>$TargetNodeMajor\.\d+\.\d+)-$escapedArchitecture\.msi)$"
    $releaseMatch = $null

    foreach ($line in Get-Content -LiteralPath $sumsPath) {
        $candidate = [Regex]::Match($line.Trim(), $pattern)
        if ($candidate.Success) {
            $releaseMatch = $candidate
            break
        }
    }

    if ($null -eq $releaseMatch) {
        throw "O manifesto oficial nao contem um MSI do Node.js $TargetNodeMajor para $architecture."
    }

    return [pscustomobject]@{
        Architecture = $architecture
        BaseUri       = $baseUri
        FileName      = $releaseMatch.Groups["file"].Value
        Version       = $releaseMatch.Groups["version"].Value
        Sha256        = $releaseMatch.Groups["sha"].Value.ToLowerInvariant()
        SumsPath      = $sumsPath
    }
}

function Install-NodeWithWinget {
    param([Parameter(Mandatory = $true)][string]$Version)

    $winget = Get-Command -Name "winget.exe" -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $winget) {
        Write-Host "WinGet nao esta disponivel; o instalador usara o MSI oficial." -ForegroundColor Yellow
        return $false
    }

    Write-Step "Instalando Node.js $Version LTS via WinGet"
    $arguments = @(
        "install",
        "--id", "OpenJS.NodeJS.LTS",
        "--exact",
        "--source", "winget",
        "--version", $Version,
        "--interactive"
    )

    & $winget.Source @arguments | ForEach-Object { Write-Host $_ }
    $wingetExitCode = $LASTEXITCODE

    Update-ProcessPath
    $state = Get-NodeState
    if ($state.Usable -and $state.Major -eq $TargetNodeMajor) {
        return $true
    }

    Write-Warning "WinGet terminou com codigo $wingetExitCode, mas o Node.js $TargetNodeMajor nao ficou disponivel."
    return $false
}

function Install-NodeWithOfficialMsi {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Metadata,
        [Parameter(Mandatory = $true)][string]$TempDirectory
    )

    $msiPath = Join-Path $TempDirectory $Metadata.FileName
    $downloadUri = "$($Metadata.BaseUri)/$($Metadata.FileName)"

    Write-Step "Baixando o MSI oficial do Node.js $($Metadata.Version)"
    Invoke-OfficialDownload -Uri $downloadUri -OutFile $msiPath

    Write-Step "Verificando SHA-256 e assinatura Authenticode"
    $actualHash = (Get-FileHash -LiteralPath $msiPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $Metadata.Sha256) {
        throw "SHA-256 invalido para $($Metadata.FileName). O arquivo nao sera executado."
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $msiPath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate) {
        throw "A assinatura Authenticode do MSI nao e valida. O arquivo nao sera executado."
    }

    if ($signature.SignerCertificate.Subject -notmatch '(?i)(OpenJS|Node\.js)') {
        throw "A identidade do assinante do MSI nao corresponde ao projeto Node.js/OpenJS."
    }

    Write-Host "Assinatura valida: $($signature.SignerCertificate.Subject)" -ForegroundColor Green
    Write-Step "Abrindo o instalador oficial (o Windows pode solicitar permissao)"

    $msiexec = Join-Path $env:SystemRoot "System32\msiexec.exe"
    $process = Start-Process -FilePath $msiexec `
        -ArgumentList "/i `"$msiPath`" /norestart" `
        -Wait `
        -PassThru

    if ($process.ExitCode -notin @(0, 1641, 3010)) {
        throw "A instalacao do Node.js foi cancelada ou falhou (codigo MSI $($process.ExitCode))."
    }

    if ($process.ExitCode -in @(1641, 3010)) {
        Write-Warning "O Windows informou que uma reinicializacao pode ser necessaria."
    }
}

function Install-Node24 {
    if (-not (Confirm-Action "Deseja instalar o Node.js $TargetNodeMajor LTS neste computador?")) {
        throw "Node.js >= $MinimumNodeMajor e necessario para continuar. Instalacao nao autorizada."
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    catch {
        Write-Verbose "O runtime atual gerencia TLS automaticamente."
    }

    $tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("latam-name-bot-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempDirectory | Out-Null
    $metadata = $null
    $msiPath = $null

    try {
        $metadata = Get-Node24ReleaseMetadata -TempDirectory $tempDirectory
        $installed = Install-NodeWithWinget -Version $metadata.Version

        if (-not $installed) {
            if (-not (Confirm-Action "Deseja usar o MSI oficial verificado como alternativa?")) {
                throw "Nao foi possivel instalar Node.js via WinGet e o fallback nao foi autorizado."
            }

            $msiPath = Join-Path $tempDirectory $metadata.FileName
            Install-NodeWithOfficialMsi -Metadata $metadata -TempDirectory $tempDirectory
        }

        Update-ProcessPath
        $state = Get-NodeState
        if (-not $state.Usable -or $state.Major -ne $TargetNodeMajor) {
            throw "Node.js $TargetNodeMajor foi instalado, mas nao ficou disponivel neste terminal. Feche o terminal, abra novamente e execute este script outra vez."
        }

        Write-Host "Node.js $($state.Version) e npm foram encontrados." -ForegroundColor Green
        return $state
    }
    finally {
        if ($null -ne $msiPath -and (Test-Path -LiteralPath $msiPath -PathType Leaf)) {
            Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
        }
        if ($null -ne $metadata -and (Test-Path -LiteralPath $metadata.SumsPath -PathType Leaf)) {
            Remove-Item -LiteralPath $metadata.SumsPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $tempDirectory -PathType Container) {
            Remove-Item -LiteralPath $tempDirectory -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-NpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$NpmPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )

    Write-Step $Description
    & $NpmPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "O comando npm $($Arguments -join ' ') falhou com codigo $LASTEXITCODE."
    }
}

function Invoke-Main {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json") -PathType Leaf)) {
        throw "package.json nao foi encontrado em $ProjectRoot. Execute o script dentro do projeto completo."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package-lock.json") -PathType Leaf)) {
        throw "package-lock.json nao foi encontrado. O bootstrap exige um lockfile para executar npm ci."
    }

    Write-Host "Instalador guiado - Bot de correcao de nome LATAM" -ForegroundColor White
    Write-Host "Projeto: $ProjectRoot"
    Write-Host "Este processo verifica Node.js >= $MinimumNodeMajor, instala dependencias, executa testes e inicia a configuracao."

    if (-not (Confirm-Action "Deseja continuar?")) {
        Write-Host "Instalacao cancelada. Nenhuma alteracao foi feita."
        return
    }

    Update-ProcessPath
    $state = Get-NodeState
    if ($state.Usable) {
        Write-Host "Node.js $($state.Version) encontrado em $($state.NodePath)." -ForegroundColor Green
    }
    else {
        Write-Host $state.Reason -ForegroundColor Yellow
        $state = Install-Node24
    }

    Push-Location $ProjectRoot
    try {
        Invoke-NpmStep -NpmPath $state.NpmPath -Arguments @("ci") -Description "Instalando dependencias exatas com npm ci"
        Invoke-NpmStep -NpmPath $state.NpmPath -Arguments @("test") -Description "Executando testes"
        Invoke-NpmStep -NpmPath $state.NpmPath -Arguments @("run", "setup") -Description "Iniciando o assistente de configuracao"
    }
    finally {
        Pop-Location
    }

    Write-Step "Instalacao concluida"
}

try {
    Invoke-Main
}
catch {
    Write-Host ""
    Write-Host "Falha na instalacao: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
