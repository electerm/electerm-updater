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
  const release = await http.get('https://api.github.com/repos/electerm/electerm/releases/tags/' + tag)
  const asset = assetFor(release.data, tag, src)
  const file = path.join(dir, asset.name)
  const { data } = await http.get(downloadUrl(tag, asset.name, mirror), { responseType: 'stream' })
  const hash = createHash('sha256')
  let bytes = 0
  let last = -1
  data.on('data', chunk => {
    hash.update(chunk)
    bytes += chunk.length
    const percent = Math.min(99, Math.floor(100 * bytes / asset.size))
    if (percent !== last) progress(percent)
    last = percent
  })
  await pipeline(data, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal })
  if (bytes !== asset.size || 'sha256:' + hash.digest('hex') !== asset.digest) {
    throw new Error('The downloaded file failed release verification')
  }
  return file
}

module.exports = { format, assetFor, download }
