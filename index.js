#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { once } = require('events')
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
  return { kind, target, payload, script, dir }
}

async function launch (plan, pid) {
  if (!Number.isSafeInteger(pid) || pid < 0) throw new Error('Invalid Electerm process ID')
  const { dir, script, kind, target, payload } = plan
  const windows = process.platform === 'win32'
  const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : []
  args.push(path.join(dir, script), kind, payload, target, String(pid))
  const log = fs.openSync(path.join(dir, 'install.log'), 'a', 0o600)
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', args, {
      cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', log, log], env
    })
    await once(child, 'spawn')
    child.unref()
    return child
  } finally {
    fs.closeSync(log)
  }
}

if (require.main === module) {
  const [tag, src, exe, pid = '0'] = process.argv.slice(2)
  async function main () {
    if (!exe) throw new Error('Usage: electerm-updater <vX.Y.Z> <installSrc> <installed executable> [PID to wait for]')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-update-'))
    let installer
    try {
      const progress = percent => {
        if (process.stderr.isTTY) process.stderr.write('\rDownloading ' + percent + '%')
      }
      const plan = await prepare({ tag, src, exe }, dir, progress)
      if (process.stderr.isTTY) process.stderr.write('\n')
      installer = await launch(plan, Number(pid))
      console.log('Installer started. Installation log: ' + path.join(dir, 'install.log'))
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw err
    }
    installer.ref()
    const [code] = await once(installer, 'exit')
    if (code !== 0) throw new Error('Installation failed. See ' + path.join(dir, 'install.log'))
  }
  main().catch(err => {
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { archiveRoot, prepare, launch }
