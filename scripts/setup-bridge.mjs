#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = join(root, 'bridge', 'third_party', 'rplidar_sdk')
const sdkUrl = 'https://github.com/Slamtec/rplidar_sdk'

function run(command, args, options = {}) {
  console.log(`==> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: false
  })
  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!existsSync(sdkDir)) {
  mkdirSync(dirname(sdkDir), { recursive: true })
  run('git', ['clone', '--depth', '1', sdkUrl, sdkDir])
} else {
  console.log(`==> SDK already present: ${sdkDir}`)
}

run(process.execPath, [join(root, 'scripts', 'build-bridge.mjs')])
