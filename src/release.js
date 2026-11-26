const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { pipeline } = require('stream/promises')

function format (src, platform) {
  const patterns = {
    win32: /^(?:win-(?:x64|arm64)(?:-(?:portable|loose))?\.tar\.gz|win7\.tar\.gz|win-(?:x64|arm64)-installer\.exe)$/,
    darwin: /^mac(?:10)?-(?:arm64|x64)\.dmg$/,
    linux: /^linux-[a-z0-9_]+(?:-legacy)?\.(?:tar\.gz|AppImage|rpm|deb)$/
  }
  if (!patterns[platform]?.test(src)) throw new Error('Unsupported Electerm installation source: ' + src)
  return src.slice(src.indexOf('.') + 1)
}

function assetFor (release, tag, src) {
  const name = 'electerm-' + tag.slice(1) + '-' + src
  const asset = release.assets.find(a => a.name === name)
  if (release.tag_name !== tag || !asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !(asset.size > 0)) {
    throw new Error('Missing release asset or SHA-256 digest for ' + name)
  }
  return asset
}

function downloadUrl (tag, name, mirror) {
  const tail = tag + '/' + name
  const github = 'https://github.com/electerm/electerm/releases/download/' + tail
  switch (mirror) {
    case 'atomgit': return 'https://atomgit.com/electerm/electerm/releases/download/' + tail
    case 'r2': return 'https://electerm-store.html5beta.com/r/' + name
    case 'gh-proxy': return 'https://mirror.electerm.org/' + github
    case 'sourceforge': return 'https://master.dl.sourceforge.net/project/electerm.mirror/' + tail + '?viasf=1'
    default: return github
  }
}

async function download (options, dir, progress) {
  const { tag, src, mirror, proxy, signal } = options
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid release tag')
  let agent
  if (proxy) {
    const Agent = /^socks/.test(proxy) ? require('socks-proxy-agent').SocksProxyAgent : require('https-proxy-agent').HttpsProxyAgent
    agent = new Agent(proxy)
  }
  const http = require('axios').create({ proxy: false, httpsAgent: agent, timeout: 60000, signal })
  const platform = src?.startsWith('win') ? 'win32' : src?.startsWith('mac') ? 'darwin' : 'linux'
  format(src, platform)
  const name = 'electerm-' + tag.slice(1) + '-' + src
  const atomgit = mirror === 'atomgit'
  const checksumUrl = atomgit ? downloadUrl(tag, 'checksum.json', mirror) : 'https://electerm.org/sha256/' + name + '.checksum'
  const { data: record } = await http.get(checksumUrl, { responseType: atomgit ? 'json' : 'text', maxContentLength: 1024 * 1024 })
  const fields = typeof record === 'string' && record.trim().split(/\s+/)
  const digest = atomgit ? record?.[name] : fields?.length === 2 && fields[1] === name && fields[0]
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) throw new Error('Missing SHA-256 checksum for ' + name)
  const file = path.join(dir, name)
  const { data, headers } = await http.get(downloadUrl(tag, name, mirror), { responseType: 'stream' })
  const size = Number(headers?.['content-length'])
  const hash = createHash('sha256')
  let bytes = 0
  let last = -1
  data.on('data', chunk => {
    hash.update(chunk)
    bytes += chunk.length
    if (!(size > 0)) return
    const percent = Math.min(99, Math.floor(100 * bytes / size))
    if (percent !== last) progress(percent)
    last = percent
  })
  await pipeline(data, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal })
  if (!bytes || hash.digest('hex') !== digest.toLowerCase()) {
    throw new Error('The downloaded file failed release verification')
  }
  return file
}

module.exports = { format, assetFor, download }
