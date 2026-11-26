const messages = require('./messages.json')

function locale (language = Intl.DateTimeFormat().resolvedOptions().locale) {
  const id = String(language).toLowerCase().replace(/-/g, '_')
  const base = id.split('_')[0]
  const fallback = /^zh_(tw|hk|mo|hant)/.test(id) ? 'zh_tw' : Object.keys(messages).find(key => key.startsWith(base + '_'))
  const key = Object.hasOwn(messages, id) ? id : fallback || 'en_us'
  return { language: key, ...messages[key] }
}

module.exports = { locale }
