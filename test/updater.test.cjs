const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
const { format, assetFor, download } = require('@electerm/updater/release')
const { archiveRoot } = require('..')

function temporary (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-updater-test-'))
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }))
  return dir
}

test('deb reopens through the original desktop session after elevation', { skip: process.platform !== 'linux' || process.getuid() === 0 }, () => {
  execFileSync('/bin/sh', [path.join(__dirname, 'deb-relaunch.sh')])
})

test('matches the exact release variant and excludes store packages and metadata', () => {
  for (const [platform, sources] of Object.entries({
    win32: ['win7.tar.gz', 'win-x64-loose.tar.gz', 'win-x64-portable.tar.gz', 'win-arm64-installer.exe'],
    linux: ['linux-amd64.deb', 'linux-aarch64-legacy.rpm', 'linux-loongarch64-legacy.deb', 'linux-ppc64el.deb', 'linux-riscv64.tar.gz', 'linux-armv7l-legacy.AppImage'],
    darwin: ['mac10-x64.dmg', 'mac-arm64.dmg']
  })) {
    const release = { tag_name: 'v1.2.3', assets: sources.map(src => ({ name: 'electerm-1.2.3-' + src, size: 1, digest: 'sha256:' + 'a'.repeat(64) })) }
    for (const src of sources) {
      assert.ok(format(src, platform))
      assert.equal(assetFor(release, 'v1.2.3', src).name, 'electerm-1.2.3-' + src)
    }
    assert.throws(() => assetFor(release, 'v1.2.4', sources[0]))
  }
  for (const [platform, src] of [['win32', 'win-x64.appx'], ['linux', 'linux-amd64.snap'], ['darwin', 'mac-x64.dmg.blockmap'], ['darwin', 'linux-x64.tar.gz']]) {
    assert.throws(() => format(src, platform))
  }
})

for (const mirror of ['atomgit', 'r2', 'github', 'gh-proxy', 'sourceforge']) {
  test(mirror + ' checks the exact asset before accepting a download', async t => {
    const tag = 'v1.2.3'
    const src = 'win-x64.tar.gz'
    const name = 'electerm-1.2.3-' + src
    const digest = createHash('sha256').update('good').digest('hex')
    const atomgit = mirror === 'atomgit'
    const url = atomgit
      ? 'https://atomgit.com/electerm/electerm/releases/download/v1.2.3/checksum.json'
      : 'https://electerm.org/sha256/' + name + '.checksum'
    let record
    let body = 'good'
    let assets = 0
    t.mock.method(require('axios'), 'create', () => ({
      get: async (request, config) => {
        if (config.responseType === 'stream') {
          assets++
          assert.ok(request.includes(name))
          return { data: Readable.from([Buffer.from(body)]) }
        }
        assert.equal(request, url)
        return { data: record }
      }
    }))
    const run = () => download({ tag, src, mirror }, temporary(t), () => {})
    for (const [file, hash] of [[name + '.other', digest], [name, 'invalid']]) {
      record = atomgit ? { [file]: hash } : hash + '  ' + file
      await assert.rejects(run, /checksum/)
    }
    assert.equal(assets, 0)
    record = atomgit ? { [name]: digest } : digest + '  ' + name + '\n'
    assert.equal(fs.readFileSync(await run(), 'utf8'), 'good')
    for (body of ['go', 'evil']) await assert.rejects(run, /verification/)
  })
}

test('all updater languages include every message and the release placeholder', () => {
  const { locale } = require('..')
  const messages = require('../src/messages.json')
  for (const [id, strings] of Object.entries(messages)) {
    assert.equal(locale(id.replace('_', '-')).language, id)
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(messages.en_us).sort())
    assert.ok(Object.values(strings).every(Boolean))
    assert.ok(strings.confirm.includes('{tag}'))
  }
  assert.equal(locale('zh-Hant-HK').language, 'zh_tw')
  assert.equal(locale('unknown').language, 'en_us')
})

test('finds flat, wrapped and loose archives and rejects ambiguous layouts', t => {
  const dir = temporary(t)
  const root = path.join(dir, 'versioned folder')
  fs.mkdirSync(path.join(root, 'resources/app'), { recursive: true })
  fs.writeFileSync(path.join(root, 'electerm.exe'), '')
  fs.writeFileSync(path.join(root, 'resources/app/package.json'), '{}')
  assert.equal(archiveRoot(dir, 'electerm.exe'), root)
  assert.equal(archiveRoot(root, 'electerm.exe'), root)
  fs.cpSync(root, path.join(dir, 'another'), { recursive: true })
  assert.throws(() => archiveRoot(dir, 'electerm.exe'))
})

test('Windows helpers avoid PowerShell 3 containment operators and raw reads', () => {
  for (const name of ['install.ps1', 'launch.ps1']) {
    const script = fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')
    assert.doesNotMatch(script, /-(?:notin|in|raw)\b/i)
  }
})

test('Windows helper survives the calling process and opens the installed executable', { skip: process.platform !== 'win32' }, async t => {
  const root = temporary(t)
  const job = fs.mkdtempSync(path.join(root, 'electerm-update-'))
  const target = path.join(root, 'installed app', 'electerm.exe')
  const script = 'install.ps1'
  fs.mkdirSync(path.dirname(target))
  fs.copyFileSync(require.resolve('@electerm/updater/install.ps1'), path.join(job, script))
  // Imitate NSIS's final /D argument, which includes the full directory even
  // when the ordinary Windows argument parser would split it on spaces.
  const fixture = `using System.IO;
    class Fixture {
      static void Main() {
        string cmd = System.Environment.CommandLine;
        int start = cmd.IndexOf(" /S /D=");
        if (start >= 0) {
          File.Copy(typeof(Fixture).Assembly.Location, Path.Combine(cmd.Substring(start + 7), "electerm.exe"));
        } else {
          File.WriteAllText("reopened", System.Diagnostics.Process.GetCurrentProcess().SessionId.ToString());
        }
      }
    }`
  const payload = path.join(job, 'release installer.exe')
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Add-Type -TypeDefinition '" + fixture + "' -OutputAssembly 'release installer.exe' -OutputType WindowsApplication"
  ], { cwd: job })
  const plan = { dir: job, kind: 'exe', script, payload, target, language: 'zh_cn' }
  const caller = "require('./src').launch(JSON.parse(process.env.TEST_PLAN), process.pid).catch(e => { console.error(e); process.exitCode = 1 })"
  execFileSync(process.env.UPDATER_TEST_ELECTRON || process.execPath, ['-e', caller], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TEST_PLAN: JSON.stringify(plan) },
    timeout: 25000
  })
  const marker = path.join(path.dirname(target), 'reopened')
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(fs.existsSync(marker), fs.readFileSync(path.join(job, 'install.log'), 'utf8') || 'Installer exited without reopening Electerm')
  const session = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process -Id $PID).SessionId'], { encoding: 'utf8' }).trim()
  assert.equal(fs.readFileSync(marker, 'utf8'), session)
})

test('archive install replaces application resources and preserves adjacent user data', { skip: process.platform === 'darwin' }, async t => {
  const dir = temporary(t)
  const job = fs.mkdtempSync(path.join(dir, 'electerm-update-'))
  const target = path.join(dir, 'installed app')
  const payload = path.join(job, 'new app')
  for (const root of [target, payload]) fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  const windows = process.platform === 'win32'
  const profile = path.join(target, windows ? 'electerm' : 'user-data')
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'settings'), 'keep')
  fs.writeFileSync(path.join(target, 'resources/obsolete'), 'old')
  fs.writeFileSync(path.join(payload, 'resources/app.asar'), 'new')
  const script = windows ? 'install.ps1' : 'install.sh'
  const copy = path.join(job, script)
  fs.copyFileSync(require.resolve('@electerm/updater/' + script), copy)
  if (windows) {
    // A GUI-subsystem fixture exits immediately without opening a window.
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Add-Type -TypeDefinition 'public class Fixture { public static void Main() { System.IO.File.WriteAllText(\"reopened\", \"new\"); } }' -OutputAssembly electerm.exe -OutputType WindowsApplication"
    ], { cwd: payload })
    const plan = { dir: job, kind: 'tar.gz', script, payload, target }
    execFileSync(process.env.UPDATER_TEST_ELECTRON || process.execPath, ['-e',
      "require('./src').launch(JSON.parse(process.env.TEST_PLAN), process.pid).catch(e => { console.error(e); process.exitCode = 1 })"
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TEST_PLAN: JSON.stringify(plan) }, timeout: 25000 })
    const marker = path.join(target, 'reopened')
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(fs.existsSync(marker), fs.readFileSync(path.join(job, 'install.log'), 'utf8'))
  } else {
    fs.writeFileSync(path.join(payload, 'electerm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    execFileSync('/bin/sh', [copy, 'tar.gz', payload, target, '0'])
  }
  assert.equal(fs.readFileSync(path.join(profile, 'settings'), 'utf8'), 'keep')
  assert.equal(fs.readFileSync(path.join(target, 'resources/app.asar'), 'utf8'), 'new')
  assert.equal(fs.existsSync(path.join(target, 'resources/obsolete')), false)
})
