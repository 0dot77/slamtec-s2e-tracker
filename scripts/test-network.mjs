// Focused network regressions with mocked OS/commands: never configures an adapter.
// Run with: node --test scripts/test-network.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/main/network.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const request = { interfaceName: 'Ethernet', ip: '192.168.11.100', prefixLength: 24 }
const ipv4 = (address, netmask = '255.255.255.0') => ({ family: 'IPv4', address, netmask, internal: false })
const failure = (code, stderr = '', stdout = '') => Object.assign(new Error('command failed'), { code, stderr, stdout })

function harness({ platform = 'win32', interfaces, execute, output = {}, enumerate, temporaryDirectory } = {}) {
  let current = interfaces ?? { Ethernet: [ipv4('169.254.1.10', '255.255.0.0')] }
  let clock = 0
  let enumerations = 0
  const commands = []
  const removed = []
  const execFile = () => { throw new Error('unmocked command') }
  execFile[promisify.custom] = async (command, args) => {
    commands.push({ command, args })
    return await execute?.(command, args, { setInterfaces: (value) => { current = value } }) ?? { stdout: '', stderr: '' }
  }
  const mocks = {
    'node:os': {
      networkInterfaces: () => {
        current = enumerate?.(++enumerations, current) ?? current
        return current
      },
      tmpdir: () => "C:/mock-temp/Operator's files"
    },
    'node:child_process': { execFile },
    'node:fs/promises': {
      mkdtemp: async (prefix) => temporaryDirectory ?? `${prefix}unique`,
      readFile: async (path) => {
        if (output[basename(path)] === undefined) throw new Error('ENOENT')
        return output[basename(path)]
      },
      rm: async (path) => { removed.push(path) }
    }
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (id) => mocks[id] ?? require(id),
    process: { platform, env: { SystemRoot: 'C:\\Windows' } },
    Buffer,
    Date: class extends Date { static now() { return clock } },
    setTimeout: (callback, duration) => { clock += duration; callback() },
    console
  }, { filename: 'network.ts' })
  return { api: module.exports, commands, removed }
}

function helperOf(command) {
  const encoded = command.args.at(-1).match(/'-EncodedCommand','([^']+)'/)[1]
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

test('stale renderer default is overridden by the latest sensor diagnosis', async () => {
  const h = harness({
    execute: (_command, _args, os) => os.setInterfaces({ Ethernet: [ipv4('192.168.12.100')] })
  })
  await h.api.diagnose('192.168.12.2')
  const result = await h.api.configure(request)
  assert.equal(result.ok, true)
  assert.equal(result.diagnosis.targetIp, '192.168.12.2')
  assert.match(helperOf(h.commands[0]), /'192\.168\.12\.100','255\.255\.255\.0'/)
  assert.equal(h.removed.length, 1)
})

test('an explicit sensor target wins and .100 sensors use a .101 host', async () => {
  const h = harness({
    execute: (_command, _args, os) => os.setInterfaces({ Ethernet: [ipv4('192.168.13.101')] })
  })
  await h.api.diagnose('192.168.12.2')
  const result = await h.api.configure({ ...request, targetIp: '192.168.13.100' })
  assert.equal(result.ok, true)
  assert.equal(result.diagnosis.targetIp, '192.168.13.100')
  assert.match(helperOf(h.commands[0]), /'192\.168\.13\.101'/)
})

test('without a prior diagnosis, configuration uses the requested host /24', async () => {
  const h = harness({ interfaces: { Ethernet: [ipv4('192.168.12.100')] } })
  assert.equal((await h.api.configure({ ...request, ip: '192.168.12.100' })).ok, true)
  assert.match(helperOf(h.commands[0]), /'192\.168\.12\.100'/)
})

test('a known .100 sensor uses .101 and verification preserves the sensor target', async () => {
  const h = harness({
    execute: (_command, _args, os) => os.setInterfaces({ Ethernet: [ipv4('192.168.12.101')] })
  })
  await h.api.diagnose('192.168.12.100')
  for (let i = 0; i < 2; i++) {
    const result = await h.api.configure(request)
    assert.equal(result.ok, true)
    assert.equal(result.diagnosis.targetIp, '192.168.12.100')
    assert.match(helperOf(h.commands[i]), /'192\.168\.12\.101'/)
  }
})

test('an explicit target is remembered for a subsequent legacy request', async () => {
  const h = harness({ interfaces: { Ethernet: [ipv4('192.168.13.100')] } })
  await h.api.diagnose('192.168.12.2')
  assert.equal((await h.api.configure({ ...request, targetIp: '192.168.13.2' })).ok, true)
  const result = await h.api.configure(request)
  assert.equal(result.ok, true)
  assert.equal(result.diagnosis.targetIp, '192.168.13.2')
  assert.match(helperOf(h.commands[1]), /'192\.168\.13\.100'/)
})

for (const [label, interfaces] of [
  ['another adapter on the target /24', { Ethernet: [ipv4('169.254.1.10')], Other: [ipv4('192.168.12.100')] }],
  ['selected adapter with a wrong IP', { Ethernet: [ipv4('192.168.12.50')] }],
  ['selected adapter with a wrong prefix', { Ethernet: [ipv4('192.168.12.100', '255.255.0.0')] }]
]) {
  test(`${label} cannot verify success`, async () => {
    const h = harness({ interfaces })
    await h.api.diagnose('192.168.12.2')
    const result = await h.api.configure(request)
    assert.equal(result.ok, false)
    assert.equal(result.diagnosis.ok, true)
    assert.match(result.error, /Ethernet does not have 192\.168\.12\.100\/24/)
  })
}

test('polling waits for the selected interface to acquire the exact address', async () => {
  const h = harness({
    enumerate: (n, current) => n >= 6 ? { Ethernet: [ipv4('192.168.12.100')] } : current
  })
  await h.api.diagnose('192.168.12.2')
  assert.equal((await h.api.configure(request)).ok, true)
})

test('netsh exit code and both redirected streams survive elevation failure', async () => {
  const h = harness({
    execute: () => { throw failure(87) },
    output: { 'stderr.txt': 'adapter not found', 'stdout.txt': 'The parameter is incorrect.' }
  })
  await h.api.diagnose('192.168.12.2')
  const result = await h.api.configure(request)
  assert.equal(result.ok, false)
  assert.match(result.error, /exit code 87/)
  assert.match(result.error, /adapter not found/)
  assert.match(result.error, /The parameter is incorrect/)
  assert.equal(h.removed.length, 1)
})

test('UAC cancellation retains its stderr and is reported as cancelled', async () => {
  const h = harness({ execute: () => { throw failure(1, 'Win32Exception (1223): operation cancelled by the user') } })
  const result = await h.api.configure(request)
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.match(result.error, /exit code 1.*1223/)
  assert.equal(h.removed.length, 1)
})

test('verification can succeed after a command error while retaining that error', async () => {
  const h = harness({ interfaces: { Ethernet: [ipv4('192.168.11.100')] }, execute: () => { throw failure(5, 'diagnostic error') } })
  const result = await h.api.configure(request)
  assert.equal(result.ok, true)
  assert.equal(result.cancelled, false)
  assert.match(result.error, /exit code 5.*diagnostic error/)
})

test('IP, target, prefix, and quoted interface validation prevents command execution', async () => {
  for (const [changes, expected] of [
    [{ ip: '192.168.11.100; whoami' }, 'invalid-ip'],
    [{ ip: '256.168.11.100' }, 'invalid-ip'],
    [{ targetIp: '192.168.11.2; whoami' }, 'invalid-target-ip'],
    [{ targetIp: 123 }, 'invalid-target-ip'],
    [{ targetIp: null }, 'invalid-target-ip'],
    [{ ip: null, targetIp: 123 }, 'invalid-ip'],
    [{ prefixLength: 16 }, 'unsupported-prefix'],
    [{ interfaceName: 'Ethernet"; whoami' }, 'invalid-interface-name']
  ]) {
    const h = harness()
    const result = await h.api.configure({ ...request, ...changes })
    assert.equal(result.ok, false)
    assert.equal(result.error, expected)
    assert.equal(h.commands.length, 0)
  }
})

test('Windows aliases and temporary paths remain valid PowerShell literals', async () => {
  const alias = "이더넷 Operator's $(whoami); `test`"
  const h = harness({ interfaces: { [alias]: [ipv4('192.168.11.100')] } })
  assert.equal((await h.api.configure({ ...request, interfaceName: alias })).ok, true)
  const helper = helperOf(h.commands[0])
  assert.ok(helper.includes(`'name="${alias.replace(/'/g, "''")}"'`))
  assert.match(helper, /Operator''s files/)
  if (process.platform === 'win32') {
    // Parse only; the privileged commands are never invoked.
    const parser = '$scripts = [Console]::In.ReadToEnd() | ConvertFrom-Json; foreach ($scriptText in $scripts) { $tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($scriptText, [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 } }'
    const parsed = spawnSync(h.commands[0].command, ['-NoProfile', '-NonInteractive', '-Command', parser], {
      input: JSON.stringify([helper, h.commands[0].args.at(-1)]), encoding: 'utf8', shell: false
    })
    assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message)
  }
})

const serviceList = '(3) USB LAN\n(Hardware Port: USB LAN, Device: en5)\n'

test('Windows helper captures output and propagates the child exit code through both processes', {
  skip: process.platform !== 'win32'
}, async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url))
  const outputDir = mkdtempSync(join(scriptsDir, '.network-test-'))
  try {
    const h = harness({ temporaryDirectory: outputDir })
    await h.api.configure(request)
    const command = h.commands[0]
    const originalHelper = helperOf(command)
    const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`
    // Substitute a harmless child that writes markers and exits 87. The actual
    // netsh command and UAC elevation are never executed by this test.
    const child = Buffer.from("[Console]::Out.WriteLine('stdout marker'); [Console]::Error.WriteLine('stderr marker'); exit 87", 'utf16le').toString('base64')
    const helper = originalHelper.replace(/-FilePath .*? -ArgumentList .*? -Wait/,
      `-FilePath ${psLiteral(command.command)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${child}' -Wait`)
    assert.notEqual(helper, originalHelper)
    const script = command.args.at(-1)
      .replace(Buffer.from(originalHelper, 'utf16le').toString('base64'), Buffer.from(helper, 'utf16le').toString('base64'))
      .replace('-Verb RunAs ', '')
    assert.doesNotMatch(script, /-Verb RunAs/)
    const result = spawnSync(command.command, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: scriptsDir, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000
    })
    assert.equal(result.status, 87, result.stderr || result.error?.message)
    assert.match(readFileSync(join(outputDir, 'stdout.txt'), 'utf8'), /stdout marker/)
    assert.match(readFileSync(join(outputDir, 'stderr.txt'), 'utf8'), /stderr marker/)
  } finally {
    // Verify the absolute target is the test-created directory inside scripts.
    assert.equal(dirname(outputDir), scriptsDir)
    assert.ok(outputDir.startsWith(join(scriptsDir, '.network-test-')))
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('macOS keeps the networksetup manual argument list and uses the target /24', async () => {
  const h = harness({
    platform: 'darwin', interfaces: { en5: [ipv4('169.254.1.10')] },
    execute: (command, args, os) => {
      if (command === 'networksetup') return { stdout: serviceList }
      assert.equal(command, 'osascript')
      assert.match(args[1], / & " 192\.168\.12\.100 255\.255\.255\.0" with administrator privileges/)
      os.setInterfaces({ en5: [ipv4('192.168.12.100')] })
    }
  })
  await h.api.diagnose('192.168.12.2')
  assert.equal((await h.api.configure({ ...request, interfaceName: 'en5' })).ok, true)
})

test('macOS networksetup listing failures expose their exit code and stderr', async () => {
  const h = harness({ platform: 'darwin', execute: () => { throw failure(9, 'networksetup denied') } })
  const result = await h.api.configure({ ...request, interfaceName: 'en5' })
  assert.equal(result.ok, false)
  assert.match(result.error, /networksetup -listnetworkserviceorder failed \(exit code 9\): networksetup denied/)
})

test('macOS admin cancellation exposes the AppleScript error', async () => {
  const h = harness({
    platform: 'darwin',
    execute: (command) => {
      if (command === 'networksetup') return { stdout: serviceList }
      throw failure(1, 'User canceled. (-128)')
    }
  })
  const result = await h.api.configure({ ...request, interfaceName: 'en5' })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.match(result.error, /exit code 1.*-128/)
})

test('macOS configuration failures preserve the exit code and both command streams', async () => {
  const h = harness({
    platform: 'darwin',
    execute: (command) => {
      if (command === 'networksetup') return { stdout: serviceList }
      throw failure(1, 'execution error: networksetup failed (64)', 'Invalid parameters')
    }
  })
  const result = await h.api.configure({ ...request, interfaceName: 'en5' })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, false)
  assert.match(result.error, /exit code 1.*networksetup failed \(64\)/)
  assert.match(result.error, /Invalid parameters/)
})
