#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bridgeDir = join(root, 'bridge')
const sdkDir = join(bridgeDir, 'third_party', 'rplidar_sdk')

function run(command, args, options = {}) {
  console.log(`==> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
    shell: false
  })
  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function capture(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: false
  })
}

function ensureSdk() {
  if (existsSync(sdkDir)) return
  console.error('Slamtec SDK is missing. Run `npm run bridge:setup` first.')
  process.exit(1)
}

function ensureOutput(file) {
  if (existsSync(file)) return
  console.error(`Expected bridge output was not created: ${file}`)
  process.exit(1)
}

function buildPosix() {
  ensureSdk()
  run('make', ['-C', bridgeDir])
  ensureOutput(join(bridgeDir, 'bin', 's2e_bridge'))
}

function findMSBuild() {
  if (process.env.MSBUILD_PATH && existsSync(process.env.MSBUILD_PATH)) {
    return {
      path: process.env.MSBUILD_PATH,
      toolset: process.env.BRIDGE_PLATFORM_TOOLSET
    }
  }

  const vswhereCandidates = [
    process.env['ProgramFiles(x86)'] &&
      join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    process.env.ProgramFiles &&
      join(process.env.ProgramFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  ].filter(Boolean)

  for (const vswhere of vswhereCandidates) {
    if (!existsSync(vswhere)) continue
    const found = capture(vswhere, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.Component.MSBuild',
      '-format',
      'json'
    ])
    if (found.status !== 0 || !found.stdout.trim()) continue
    try {
      const installs = JSON.parse(found.stdout)
      const install = installs[0]
      if (!install?.installationPath) continue
      const msbuild = join(install.installationPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe')
      if (!existsSync(msbuild)) continue
      const major = Number(String(install.installationVersion ?? '').split('.')[0])
      return {
        path: msbuild,
        toolset:
          process.env.BRIDGE_PLATFORM_TOOLSET ||
          (Number.isFinite(major) && major >= 17 ? 'v143' : 'v142')
      }
    } catch {
      // Fall through to the next detection path.
    }
  }

  const where = capture('where', ['MSBuild.exe'])
  const msbuild = where.stdout?.split(/\r?\n/).find(Boolean)
  if (where.status === 0 && msbuild) {
    return {
      path: msbuild,
      toolset: process.env.BRIDGE_PLATFORM_TOOLSET
    }
  }

  console.error(
    'MSBuild was not found. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload.'
  )
  process.exit(1)
}

function buildWindows() {
  ensureSdk()
  const msbuild = findMSBuild()
  const sdkSolutionDir = join(sdkDir, 'workspaces', 'vc14') + '\\'
  const common = [
    '/m',
    '/p:Configuration=Release',
    '/p:Platform=x64',
    '/p:PreferredToolArchitecture=x64'
  ]
  if (msbuild.toolset) common.push(`/p:PlatformToolset=${msbuild.toolset}`)

  run(msbuild.path, [
    join(sdkDir, 'workspaces', 'vc14', 'rplidar_driver', 'rplidar_driver.vcxproj'),
    '/t:Build',
    `/p:SolutionDir=${sdkSolutionDir}`,
    ...common
  ])
  run(msbuild.path, [join(bridgeDir, 'windows', 's2e_bridge.sln'), '/t:Build', ...common])
  ensureOutput(join(bridgeDir, 'bin', 's2e_bridge.exe'))
}

if (process.platform === 'win32') buildWindows()
else buildPosix()
