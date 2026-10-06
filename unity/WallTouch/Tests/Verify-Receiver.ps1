$ErrorActionPreference = 'Stop'

# No Unity install or external packages required. Test-only C# is excluded when
# this entire folder is copied into Assets (WALL_TOUCH_RECEIVER_TEST is unset).
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'Install/enable .NET Framework 4.x to run the standalone Windows checks.'
}
$sourceRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $PSScriptRoot ('.verify-' + [Guid]::NewGuid().ToString('N'))
$executable = Join-Path $buildDirectory 'VerifyReceiver.exe'
$sources = @(
    (Join-Path $sourceRoot 'WallTouchReceiver.cs'),
    (Join-Path $sourceRoot 'WallTouchDebugView.cs'),
    (Join-Path $sourceRoot 'WallTouchZoneFilter.cs'),
    (Join-Path $PSScriptRoot 'UnityStubs.cs'),
    (Join-Path $PSScriptRoot 'ReceiverChecks.cs')
)
New-Item -ItemType Directory -Path $buildDirectory | Out-Null
try {
    & $compiler /nologo /target:exe /define:WALL_TOUCH_RECEIVER_TEST /warnaserror "/out:$executable" @sources
    if ($LASTEXITCODE -ne 0) { throw 'Receiver compilation failed.' }
    & $executable
    if ($LASTEXITCODE -ne 0) { throw 'Receiver checks failed.' }
}
finally {
    # Remove only the fresh build folder, after checking its resolved location.
    $resolvedBuild = [IO.Path]::GetFullPath($buildDirectory)
    $testRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedBuild.StartsWith($testRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove a build path outside this test directory.'
    }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
}
