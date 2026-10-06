#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = join(root, 'bridge', 'third_party', 'rplidar_sdk')
const sdkUrl = 'https://github.com/Slamtec/rplidar_sdk'
const sdkCommit = '99478e5fb90de3b4a6db0080acacd373f8b36869'

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

if (!existsSync(sdkDir)) {
  mkdirSync(dirname(sdkDir), { recursive: true })
  run('git', ['clone', '--depth', '1', sdkUrl, sdkDir])
} else {
  console.log(`==> SDK already present: ${sdkDir}`)
}

if (!existsSync(join(sdkDir, '.git'))) {
  console.error(`SDK directory is not a Git checkout: ${sdkDir}`)
  process.exit(1)
}

const currentCommit = run('git', ['rev-parse', 'HEAD'], {
  cwd: sdkDir,
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8'
}).stdout.trim()
if (currentCommit !== sdkCommit) {
  console.log(`==> Updating SDK from ${currentCommit} to pinned ${sdkCommit}`)
  run('git', ['fetch', '--depth', '1', 'origin', sdkCommit], { cwd: sdkDir })
  run('git', ['checkout', '--detach', sdkCommit], { cwd: sdkDir })
} else {
  console.log(`==> SDK already at pinned ${sdkCommit}`)
}

run(process.execPath, [join(root, 'scripts', 'build-bridge.mjs')])
