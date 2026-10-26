[CmdletBinding()]
param(
  [string]$Repository = "TechShady/dynatrace-oncall"
)

$ErrorActionPreference = "Stop"
$installerPattern = '^Dynatrace-OnCall-Setup-[0-9]+(?:\.[0-9]+){1,3}\.exe$'
$apiBase = "https://api.github.com/repos/$Repository"
$headers = @{
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "Dynatrace-OnCall-Installer"
}

$githubToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
if ($githubToken) {
  $headers.Authorization = "Bearer $githubToken"
}

$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDirectory | Out-Null

try {
  Write-Host "Checking the latest Dynatrace OnCall release..."
  $release = Invoke-RestMethod -Uri "$apiBase/releases/latest" -Headers $headers
  $installerAsset = @($release.assets) | Where-Object { $_.name -match $installerPattern } | Select-Object -First 1
  if (-not $installerAsset) {
    throw "No Windows installer was found in release '$($release.tag_name)' for $Repository."
  }

  $checksumAsset = @($release.assets) | Where-Object { $_.name -eq "$($installerAsset.name).sha256" } | Select-Object -First 1
  $expectedHash = $null
  if ($checksumAsset) {
    $checksumPath = Join-Path $tempDirectory $checksumAsset.name
    $checksumHeaders = $headers.Clone()
    $checksumHeaders.Accept = "application/octet-stream"
    Invoke-WebRequest -Uri "$apiBase/releases/assets/$($checksumAsset.id)" -Headers $checksumHeaders -OutFile $checksumPath
    $expectedHash = (Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+' | Select-Object -First 1
  } elseif ($installerAsset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
    $expectedHash = $Matches[1]
  }
  if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Release '$($release.tag_name)' has no valid SHA-256 checksum. Publish a checksum asset before installing."
  }

  $installerPath = Join-Path $tempDirectory $installerAsset.name
  Write-Host "Downloading $($installerAsset.name)..."
  $downloadHeaders = $headers.Clone()
  $downloadHeaders.Accept = "application/octet-stream"
  Invoke-WebRequest -Uri "$apiBase/releases/assets/$($installerAsset.id)" -Headers $downloadHeaders -OutFile $installerPath

  $actualHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
  if ($actualHash -ine $expectedHash) {
    throw "Installer checksum verification failed. The downloaded file will not be run."
  }

  Write-Host "Verified $($release.tag_name) (SHA-256: $actualHash). Starting the installer..."
  $process = Start-Process -FilePath $installerPath -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "The installer exited with code $($process.ExitCode)."
  }
  Write-Host "Dynatrace OnCall installation completed."
} catch {
  Write-Error $_
  exit 1
} finally {
  Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}