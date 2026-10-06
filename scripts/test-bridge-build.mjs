// Exercise build orchestration with mocked processes: no Git/build state changes.
// Run with: node --test scripts/test-bridge-build.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import yaml from 'js-yaml'

const require = createRequire(import.meta.url)
const pinned = '99478e5fb90de3b4a6db0080acacd373f8b36869'
const root = fileURLToPath(new URL('../', import.meta.url))
class ScriptExit extends Error { constructor(status) { super(`exit ${status}`); this.status = status } }

function runScript(name, { platform = 'linux', env = {}, exists = () => true, spawn = () => ({ status: 0 }) } = {}) {
  const url = new URL(name, import.meta.url)
  const source = readFileSync(url, 'utf8').replaceAll('import.meta.url', JSON.stringify(url.href))
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowJs: true }
  }).outputText
  const calls = []
  const logs = []
  const mocks = {
    'node:fs': { existsSync: exists, mkdirSync: () => {} },
    'node:child_process': {
      spawnSync: (command, args, options) => { calls.push({ command, args, options }); return spawn(command, args, options) }
    }
  }
  const module = { exports: {} }
  let exitStatus = 0
  try {
    vm.runInNewContext(compiled, {
      module, exports: module.exports,
      require: (id) => mocks[id] ?? require(id),
      process: { platform, env, execPath: process.execPath, exit: (status) => { throw new ScriptExit(status) } },
      console: { log: (message) => logs.push(message), error: (message) => logs.push(message) }
    }, { filename: name })
  } catch (err) {
    if (!(err instanceof ScriptExit)) throw err
    exitStatus = err.status
  }
  return { calls, logs, exitStatus }
}

test('SDK setup clones, shallow-fetches and checks out the exact pin before building', () => {
  const h = runScript('setup-bridge.mjs', {
    exists: (path) => path.endsWith('.git'),
    spawn: (_command, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'old-sha\n' : '' })
  })
  assert.equal(h.exitStatus, 0)
  assert.deepEqual(Array.from(h.calls[0].args.slice(0, 3)), ['clone', '--depth', '1'])
  assert.deepEqual(Array.from(h.calls[2].args), ['fetch', '--depth', '1', 'origin', pinned])
  assert.deepEqual(Array.from(h.calls[3].args), ['checkout', '--detach', pinned])
  assert.equal(h.calls[4].command, process.execPath)
  assert.ok(h.calls[2].options.cwd.endsWith('rplidar_sdk'))
})

test('existing SDK checkouts at another commit are fetched and pinned', () => {
  const h = runScript('setup-bridge.mjs', {
    spawn: (_command, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'another-sha\n' : '' })
  })
  assert.equal(h.calls[0].args[0], 'rev-parse')
  assert.equal(h.calls[1].args[0], 'fetch')
  assert.equal(h.calls[2].args[0], 'checkout')
  assert.ok(h.logs.some((message) => message.includes(`from another-sha to pinned ${pinned}`)))
})

test('SDK setup at the pinned SHA does not fetch or checkout again', () => {
  const h = runScript('setup-bridge.mjs', { spawn: () => ({ status: 0, stdout: `${pinned}\n` }) })
  assert.equal(h.calls.length, 2)
  assert.ok(h.logs.some((message) => message.includes(`already at pinned ${pinned}`)))
})

test('failed fetch stops before checkout or build', () => {
  const h = runScript('setup-bridge.mjs', {
    spawn: (_command, args) => ({ status: args[0] === 'fetch' ? 128 : 0, stdout: 'old-sha\n' })
  })
  assert.equal(h.exitStatus, 128)
  assert.equal(h.calls.length, 2)
})

test('an SDK folder without its own checkout cannot mutate the parent repository', () => {
  const h = runScript('setup-bridge.mjs', { exists: (path) => !path.endsWith('.git') })
  assert.equal(h.exitStatus, 1)
  assert.equal(h.calls.length, 0)
})

test('shell SDK setup rejects a folder without .git before any Git command', () => {
  // The existing scripts directory stands in for an SDK folder without .git.
  // Git and make are functions so this test cannot change Git/build state.
  const source = readFileSync(new URL('../bridge/setup-sdk.sh', import.meta.url), 'utf8')
    .replace(/^HERE=.*$/m, 'HERE="$PWD/bridge"')
    .replace(/^SDK_DIR=.*$/m, 'SDK_DIR="$PWD/scripts"')
  const result = spawnSync('bash', ['-s'], {
    cwd: root,
    input: 'git() { echo "UNEXPECTED GIT COMMAND: $*" >&2; return 0; }\n' +
      'make() { echo "UNEXPECTED BUILD COMMAND: $*" >&2; return 0; }\n' + source,
    encoding: 'utf8', shell: false
  })
  assert.equal(result.status, 1, result.stderr || result.error?.message)
  assert.match(result.stderr, /SDK directory is not a Git checkout/)
  assert.doesNotMatch(result.stderr, /UNEXPECTED/)
})

test('Windows detection requires the C++ toolset and builds SDK then bridge', () => {
  const h = runScript('build-bridge.mjs', {
    platform: 'win32', env: { 'ProgramFiles(x86)': 'C:/Program Files (x86)' },
    spawn: (command) => ({
      status: 0,
      stdout: command.endsWith('vswhere.exe')
        ? JSON.stringify([{ installationPath: 'C:/Visual Studio', installationVersion: '17.0' }]) : ''
    })
  })
  assert.equal(h.exitStatus, 0)
  const query = h.calls[0].args
  assert.ok(query.includes('-requires'))
  assert.ok(query.includes('Microsoft.VisualStudio.Component.VC.Tools.x86.x64'))
  assert.ok(h.calls[1].args[0].endsWith('rplidar_driver.vcxproj'))
  assert.ok(h.calls[2].args[0].endsWith('s2e_bridge.sln'))
  assert.ok(h.calls[1].args.includes('/p:PlatformToolset=v143'))
})

test('release guards accept matching tags and reject a package version mismatch', () => {
  const workflow = yaml.load(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  for (const job of [workflow.jobs.macos, workflow.jobs.windows]) {
    const step = job.steps.find((item) => item.name === 'Verify release tag matches package version')
    const script = step.run.match(/^node -e '([\s\S]*)'\s*$/)[1]
    for (const [tag, expected] of [[`v${version}`, 0], ['v999.0.0', 1]]) {
      let exitStatus = 0
      try {
        vm.runInNewContext(script, {
          require: () => ({ version }), process: { env: { RELEASE_TAG: tag }, exit: (status) => { throw new ScriptExit(status) } },
          console: { error: () => {} }
        })
      } catch (err) {
        if (!(err instanceof ScriptExit)) throw err
        exitStatus = err.status
      }
      assert.equal(exitStatus, expected)
    }
  }
})

test('macOS archive names match electron-builder output and the upload glob', () => {
  const { PlatformPackager } = require('app-builder-lib/out/platformPackager')
  const { Platform } = require('app-builder-lib/out/index')
  const { Arch } = require('builder-util')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const workflow = yaml.load(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.macos.steps
  const zipStep = steps.find((step) => step.name === 'Zip macOS app')
  const uploadStep = steps.find((step) => step.name === 'Upload macOS release asset')
  const uploadPattern = new RegExp('^' + uploadStep.with.path
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$')
  assert.equal(pkg.build.mac.target, 'dir')
  for (const arch of [Arch.x64, Arch.arm64, Arch.universal]) {
    const appOutDir = PlatformPackager.prototype.computeAppOutDir.call({
      packagerOptions: {}, platform: Platform.MAC, platformSpecificBuildOptions: pkg.build.mac
    }, 'dist', arch)
    // Exercise the workflow's shell with the actual builder directory convention.
    // Mock find/ditto so neither packaging nor filesystem writes take place.
    const input = `find() { printf '%s\\n' '${appOutDir}/${pkg.build.productName}.app'; }\n` +
      'ditto() { printf "%s\\n" "${@: -1}"; }\n' + zipStep.run
    const result = spawnSync('bash', ['-s'], { cwd: root, input, encoding: 'utf8', shell: false })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    const artifact = result.stdout.trim()
    assert.equal(artifact, `dist/Slamtec-S2E-Tracker-mac-${Arch[arch]}.zip`)
    assert.match(artifact, uploadPattern)
  }
})
