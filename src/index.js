#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { once } = require('events')
const { locale } = require('./locale')
const { format, download } = require('./release')

function archiveRoot (dir, exe) {
  const isApp = root => fs.statSync(path.join(root, exe), { throwIfNoEntry: false })?.isFile() &&
    ['app.asar', 'app/package.json'].some(file => fs.existsSync(path.join(root, 'resources', file)))
  if (isApp(dir)) return dir
  const roots = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => path.join(dir, d.name)).filter(isApp)
  if (roots.length !== 1) throw new Error('Archive does not contain one Electerm application')
  return roots[0]
}

async function prepare (options, dir, progress, preparing = () => {}) {
  const kind = format(options.src, process.platform)
  const exe = fs.realpathSync(options.exe)
  const windows = process.platform === 'win32'
  let target = exe
  if (kind === 'tar.gz') {
    const binary = windows ? 'electerm.exe' : 'electerm'
    if (path.basename(exe).toLowerCase() !== binary || archiveRoot(path.dirname(exe), path.basename(exe)) !== path.dirname(exe)) {
      throw new Error('Select the installed Electerm executable')
    }
    target = path.dirname(exe)
  } else if (kind === 'AppImage') {
    target = fs.realpathSync(options.appImage || exe)
    const fd = fs.openSync(target, 'r')
    try {
      const magic = Buffer.alloc(3)
      fs.readSync(fd, magic, 0, magic.length, 8)
      if (!magic.equals(Buffer.from([0x41, 0x49, 2]))) throw new Error('Cannot locate the installed Electerm AppImage')
    } finally {
      fs.closeSync(fd)
    }
  } else if (kind === 'dmg') {
    target = path.resolve(exe, '../../..')
    if (!target.endsWith('.app') || target.includes('/AppTranslocation/')) {
      throw new Error('Move Electerm to Applications before updating')
    }
    try {
      fs.accessSync(path.dirname(target), fs.constants.W_OK)
    } catch (err) {
      if (err.code === 'EROFS') throw new Error('Move Electerm off the read-only disk image before updating')
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err
    }
  }
  let payload = await download(options, dir, progress)
  preparing()
  if (kind === 'tar.gz') {
    const unpack = path.join(dir, 'unpacked')
    fs.mkdirSync(unpack)
    // Load modules from the running app.asar before disabling Electron's
    // virtual filesystem. The incoming app.asar must be written as a file.
    const tar = require('tar')
    const noAsar = process.noAsar
    try {
      if (process.versions.electron) process.noAsar = true
      await tar.x({ file: payload, cwd: unpack, strict: true })
    } finally {
      if (process.versions.electron) process.noAsar = noAsar
    }
    payload = archiveRoot(unpack, path.basename(exe))
    if (windows && fs.readdirSync(payload).some(name => name.toLowerCase() === 'electerm')) {
      throw new Error('Archive conflicts with the portable profile')
    }
  } else if (kind === 'dmg') {
    const mount = path.join(dir, 'volume')
    fs.mkdirSync(mount)
    execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, payload])
    try {
      const apps = fs.readdirSync(mount).filter(n => n.endsWith('.app'))
      if (apps.length !== 1) throw new Error('Unexpected application layout in disk image')
      payload = path.join(dir, apps[0])
      execFileSync('/usr/bin/ditto', [path.join(mount, apps[0]), payload])
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', mount])
    }
  }
  const script = windows ? 'install.ps1' : 'install.sh'
  fs.copyFileSync(path.join(__dirname, script), path.join(dir, script))
  return { kind, target, payload, script, dir, language: locale(options.language).language }
}

async function launch (plan, pid) {
  if (!Number.isSafeInteger(pid) || pid < 0) throw new Error('Invalid Electerm process ID')
  const { script, kind, target } = plan
  const windows = process.platform === 'win32'
  // PowerShell expands 8.3 temp paths when resolving the script filename.
  // Give the script its payload in that same canonical form.
  const dir = windows ? fs.realpathSync.native(plan.dir) : plan.dir
  const payload = windows ? fs.realpathSync.native(plan.payload) : plan.payload
  const flags = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
  let args = [path.join(dir, script), kind, payload, target, String(pid)]
  const helperLog = path.join(dir, windows ? 'bootstrap.log' : 'install.log')
  const log = fs.openSync(helperLog, 'a', 0o600)
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const messages = locale(plan.language)
    fs.writeFileSync(path.join(dir, 'failure.txt'), messages.failed)
    fs.writeFileSync(path.join(dir, 'title.txt'), messages.title)
    const powershell = windows && path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    // Detached Windows PowerShell can exit without executing its script.
    // A short bootstrap starts the installer outside the app's process job.
    if (windows) {
      const wrapper = path.join(dir, 'launch.ps1')
      fs.copyFileSync(path.join(__dirname, 'launch.ps1'), wrapper)
      env.ELECTERM_INSTALL_COMMAND = [powershell, ...flags, ...args].map(arg => '"' + arg + '"').join(' ')
      args = [...flags, wrapper, dir]
    }
    const child = spawn(windows ? powershell : '/bin/sh', args, {
      cwd: dir, detached: !windows, windowsHide: true, stdio: ['ignore', log, log], env
    })
    await once(child, 'spawn')
    child.unref()
    if (pid > 0) {
      const deadline = Date.now() + 15000
      while (!fs.existsSync(path.join(dir, 'ready'))) {
        if (child.exitCode !== null || Date.now() > deadline) {
          const detail = [helperLog, path.join(dir, 'install.log')]
            .filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8').trim()).filter(Boolean).join('\n')
          throw new Error(detail ? messages.failed + ' — ' + detail : messages.failed)
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    return child
  } finally {
    fs.closeSync(log)
  }
}

if (require.main === module) {
  const [tag, src, exe, pid = '0', language] = process.argv.slice(2)
  const messages = locale(language)
  async function main () {
    if (!exe) throw new Error('Usage: electerm-updater <vX.Y.Z> <installSrc> <installed executable> [PID to wait for]')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-update-'))
    let installer
    try {
      const progress = percent => {
        if (process.stderr.isTTY) process.stderr.write('\r' + messages.download + ' ' + percent + '%')
      }
      const plan = await prepare({ tag, src, exe, language }, dir, progress)
      if (process.stderr.isTTY) process.stderr.write('\n')
      installer = await launch(plan, Number(pid))
      console.log(messages.started + ' — ' + path.join(dir, 'install.log'))
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw err
    }
    installer.ref()
    const code = installer.exitCode ?? (await once(installer, 'exit'))[0]
    if (code !== 0) throw new Error(messages.failed + ' — ' + path.join(dir, 'install.log'))
  }
  main().catch(err => {
    console.error(messages.failed + ' — ' + err.message)
    process.exitCode = 1
  })
}

module.exports = { archiveRoot, prepare, launch, locale }
