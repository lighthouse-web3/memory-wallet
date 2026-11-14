const input = document.getElementById('url')
chrome.storage.sync.get({ vaultUrl: 'http://localhost:5173' }, (v) => (input.value = v.vaultUrl))
document.getElementById('save').addEventListener('click', () => {
  let url
  try {
    url = new URL(input.value.trim())
    if (!/^https?:$/.test(url.protocol)) throw new Error()
  } catch {
    document.getElementById('saved').textContent = 'Enter an http(s) URL.'
    return
  }
  chrome.storage.sync.set({ vaultUrl: url.origin + url.pathname.replace(/\/+$/, '') }, () => (document.getElementById('saved').textContent = 'Saved.'))
})
