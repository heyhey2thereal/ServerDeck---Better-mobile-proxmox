(() => {
  const $ = (id) => document.getElementById(id)
  const SD = () => window.SD
  const T = (key, vars) => (window.t ? window.t(key, vars) : key)
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const state = { files: [], total: 0, max: 0, free: null, loading: false, loaded: false }

  const fmtBytes = (value) => (SD()?.fmtBytes ? SD().fmtBytes(value) : String(value))

  function fmtDate(ms) {
    const locale = (window.getLang && window.getLang()) === 'en' ? 'en-GB' : 'fr-FR'
    return new Date(ms).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  }

  function extOf(name) {
    const match = /\.([a-z0-9]{1,5})$/i.exec(name)
    return match ? match[1].toUpperCase() : 'FILE'
  }

  // Guillemet simple pour le shell : une apostrophe dans un nom ne casse pas
  // la commande copiée dans le terminal du conteneur.
  const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

  function render() {
    const list = $('filesList')
    if (!list) return
    const usage = $('filesUsage')
    if (usage) usage.textContent = T('files.usage', { u: fmtBytes(state.total), f: fmtBytes(state.free) })

    const rows = state.files.map((file) => `
      <div class="file-row" data-file="${esc(file.name)}" role="button" tabindex="0">
        <span class="file-ext">${esc(extOf(file.name))}</span>
        <span class="file-meta">
          <span class="file-name">${esc(file.name)}</span>
          <span class="file-sub">${fmtBytes(file.size)} · ${fmtDate(file.mtime)}</span>
        </span>
        <span class="file-more" aria-hidden="true">⋯</span>
      </div>`).join('')

    list.innerHTML = rows || `<p class="empty">${state.loaded ? T('files.empty') : T('files.loading')}</p>`
    for (const row of list.querySelectorAll('[data-file]')) {
      row.onclick = (event) => {
        event.stopPropagation()
        openFile(row.dataset.file)
      }
    }
  }

  async function load() {
    if (state.loading) return
    state.loading = true
    try {
      const res = await SD().api('/api/files')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || T('files.error'))
      state.files = data.files || []
      state.total = data.total || 0
      state.max = data.max || 0
      state.free = data.free ?? null
      state.loaded = true
      render()
    } catch (err) {
      const list = $('filesList')
      if (list) list.innerHTML = `<p class="empty">${esc(err.message)}</p>`
    } finally {
      state.loading = false
    }
  }

  function show() {
    render()
    load()
  }

  function addProgress(name) {
    const box = $('filesProgress')
    if (!box) return { set() {}, done() {}, fail() {} }
    box.classList.remove('hidden')
    const row = document.createElement('div')
    row.className = 'file-up'
    row.innerHTML = `<span class="file-up-name">${esc(name)}</span>
      <span class="file-up-pct">0 %</span>
      <span class="file-up-bar"><span></span></span>`
    box.append(row)
    const bar = row.querySelector('.file-up-bar > span')
    const pct = row.querySelector('.file-up-pct')
    const cleanup = () => setTimeout(() => {
      row.remove()
      if (!box.children.length) box.classList.add('hidden')
    }, 1200)
    return {
      set: (ratio) => {
        const value = Math.max(0, Math.min(1, ratio))
        bar.style.width = `${(value * 100).toFixed(0)}%`
        pct.textContent = `${(value * 100).toFixed(0)} %`
      },
      done: () => {
        row.classList.add('ok')
        bar.style.width = '100%'
        pct.textContent = '✓'
        cleanup()
      },
      fail: (message) => {
        row.classList.add('bad')
        pct.textContent = message.slice(0, 48)
        cleanup()
      },
    }
  }

  function uploadOne(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `/api/files/${encodeURIComponent(file.name)}`)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total)
      }
      xhr.onload = () => {
        let body = {}
        try { body = JSON.parse(xhr.responseText) } catch {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body)
        if (xhr.status === 401) { location.href = '/login'; return reject(new Error('non authentifié')) }
        const err = new Error(body.error || `HTTP ${xhr.status}`)
        err.status = xhr.status
        reject(err)
      }
      xhr.onerror = () => reject(new Error(T('files.network')))
      xhr.onabort = () => reject(new Error(T('files.aborted')))
      xhr.send(file)
    })
  }

  async function uploadFiles(fileList) {
    const files = [...(fileList || [])]
    if (!files.length) return
    let sent = 0
    for (const file of files) {
      const row = addProgress(file.name)
      try {
        await uploadOne(file, (ratio) => row.set(ratio))
        row.done()
        sent += 1
      } catch (err) {
        row.fail(err.message)
        SD().toast(T('files.uploadFailed', { n: file.name, e: err.message }), 4200)
      }
    }
    await load()
    if (sent) SD().toast(sent === 1 ? T('files.uploadedOne') : T('files.uploaded', { n: sent }))
  }

  function closeSheet(id) {
    $(id)?.classList.add('hidden')
  }

  function openFile(name) {
    const file = state.files.find((entry) => entry.name === name)
    if (!file) return
    const body = $('fileBody')
    body.innerHTML = `
      <h3>${esc(file.name)}</h3>
      <div class="kv"><span>${T('files.size')}</span><b>${fmtBytes(file.size)}</b></div>
      <div class="kv"><span>${T('files.modified')}</span><b>${fmtDate(file.mtime)}</b></div>
      <div class="row" style="margin-top:12px">
        <a class="file-btn primary" href="/api/files/${encodeURIComponent(file.name)}" download="${esc(file.name)}">${T('files.download')}</a>
        <button id="fileUse" class="file-btn" type="button">${T('files.use')}</button>
      </div>
      <div class="row">
        <button id="fileRename" class="file-btn" type="button">${T('files.rename')}</button>
        <button id="fileDelete" type="button" class="file-btn danger-btn">${T('files.delete')}</button>
      </div>
      <div class="row hidden" id="fileRenameBox" style="margin-top:10px">
        <input id="fileNewName" value="${esc(file.name)}" autocapitalize="none" spellcheck="false" autocomplete="off">
        <button id="fileRenameOk" type="button" class="file-btn">${T('files.save')}</button>
      </div>`
    $('fileSheet').classList.remove('hidden')

    $('fileUse').onclick = (event) => {
      event.stopPropagation()
      closeSheet('fileSheet')
      openUse(file.name)
    }

    $('fileRename').onclick = (event) => {
      event.stopPropagation()
      const box = $('fileRenameBox')
      box.classList.toggle('hidden')
      if (!box.classList.contains('hidden')) {
        const input = $('fileNewName')
        input.focus()
        input.select?.()
      }
    }

    $('fileRenameOk').onclick = async (event) => {
      event.stopPropagation()
      const next = $('fileNewName').value.trim()
      if (!next || next === file.name) return
      try {
        const res = await SD().api(`/api/files/${encodeURIComponent(file.name)}/rename`, {
          method: 'POST',
          body: JSON.stringify({ name: next }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'refusé')
        closeSheet('fileSheet')
        SD().toast(T('files.renamed', { n: data.file?.name || next }))
        await load()
      } catch (err) {
        SD().toast(err.message, 3600)
      }
    }

    // Deux appuis plutôt qu'un confirm() : les boîtes natives sont peu fiables
    // en PWA autonome sur iOS.
    const del = $('fileDelete')
    del.onclick = async (event) => {
      event.stopPropagation()
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1'
        del.classList.add('confirm')
        del.textContent = T('files.confirmDelete')
        setTimeout(() => {
          if (!del.isConnected) return
          del.dataset.confirm = ''
          del.classList.remove('confirm')
          del.textContent = T('files.delete')
        }, 3200)
        return
      }
      del.disabled = true
      try {
        const res = await SD().api(`/api/files/${encodeURIComponent(file.name)}`, { method: 'DELETE' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'refusé')
        closeSheet('fileSheet')
        SD().toast(T('files.deleted', { n: file.name }))
        await load()
      } catch (err) {
        del.disabled = false
        SD().toast(err.message, 3600)
      }
    }
  }

  async function openUse(name) {
    const body = $('useBody')
    $('useSheet').classList.remove('hidden')
    body.innerHTML = `<h3>${esc(name)}</h3><p class="empty">${T('files.loading')}</p>`

    let link
    try {
      const res = await SD().api(`/api/files/${encodeURIComponent(name)}/link`)
      link = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(link.error || 'refusé')
    } catch (err) {
      body.innerHTML = `<h3>${esc(name)}</h3><p class="empty">${esc(err.message)}</p>`
      return
    }

    let guests = []
    try {
      const res = await SD().api('/api/pve/overview')
      if (res.ok) {
        const data = await res.json()
        guests = (data.guests || []).filter((guest) => guest.type === 'lxc')
      }
    } catch {}

    const dest = '/root'
    body.innerHTML = `
      <h3>${T('files.use')}</h3>
      <label class="use-field">${T('files.linkTitle')}
        <input id="useUrl" readonly value="${esc(link.url)}" spellcheck="false">
      </label>
      <div class="row">
        <button id="useCopyUrl" type="button">${T('files.copyLink')}</button>
      </div>
      <label class="use-field">${T('files.dest')}
        <input id="useDest" value="${dest}" autocapitalize="none" spellcheck="false" autocomplete="off">
      </label>
      <div class="use-cmd">
        <span class="use-cmd-label">${T('files.wget')}</span>
        <code id="useWget"></code>
        <button data-copy="wget" type="button">${T('files.copy')}</button>
      </div>
      <div class="use-cmd">
        <span class="use-cmd-label">${T('files.curl')}</span>
        <code id="useCurl"></code>
        <button data-copy="curl" type="button">${T('files.copy')}</button>
      </div>
      ${guests.length ? `
        <div class="use-grid">
          <label class="use-field">${T('files.guest')}
            <select id="useGuest">${guests.map((guest) => `<option value="${esc(guest.vmid)}">${esc(guest.vmid)} · ${esc(guest.name)}${guest.status === 'running' ? '' : ` (${T('files.stopped')})`}</option>`).join('')}</select>
          </label>
          <label class="use-field">${T('files.tool')}
            <select id="useTool"><option value="wget">wget</option><option value="curl">curl</option></select>
          </label>
        </div>
        <div class="row">
          <button id="usePaste" type="button">${T('files.pasteOnly')}</button>
          <button id="useExec" type="button" class="primary">${T('files.exec')}</button>
        </div>`
      : `<p class="hint">${T('files.noGuest')}</p>`}
      <p class="hint">${T('files.linkHint', { h: 24 })}</p>`

    const destValue = () => {
      const raw = ($('useDest').value || '/root').trim().replace(/\/+$/, '')
      return raw.startsWith('/') ? raw : `/${raw}`
    }
    const commandFor = (tool) => {
      const target = `${destValue()}/${name}`
      return tool === 'wget'
        ? `wget -qO ${shq(target)} ${shq(link.url)}`
        : `curl -fsSL ${shq(link.url)} -o ${shq(target)}`
    }
    const refreshCommands = () => {
      $('useWget').textContent = commandFor('wget')
      $('useCurl').textContent = commandFor('curl')
    }
    refreshCommands()
    $('useDest').oninput = refreshCommands

    $('useCopyUrl').onclick = (event) => {
      event.stopPropagation()
      SD().copyText(link.url)
    }
    for (const button of body.querySelectorAll('[data-copy]')) {
      button.onclick = (event) => {
        event.stopPropagation()
        SD().copyText(commandFor(button.dataset.copy))
      }
    }

    const runInTerminal = (execute) => {
      const vmid = $('useGuest')?.value
      if (!vmid) return
      const command = commandFor($('useTool')?.value || 'wget')
      SD().closeSheets()
      SD().openConsole({ kind: 'ct', vmid: String(vmid) })
      SD().typeText(execute ? `${command}\n` : command)
      SD().toast(execute ? T('files.execToast') : T('files.pasteToast'), 3600)
    }
    if ($('usePaste')) $('usePaste').onclick = (event) => { event.stopPropagation(); runInTerminal(false) }
    if ($('useExec')) $('useExec').onclick = (event) => { event.stopPropagation(); runInTerminal(true) }
  }

  function init() {
    const pick = $('filePick')
    const input = $('fileInput')
    if (pick && input) {
      pick.onclick = (event) => {
        event.stopPropagation()
        input.click()
      }
      input.onchange = () => {
        uploadFiles(input.files)
        input.value = ''
      }
    }

    const list = $('filesList')
    if (list) {
      let dragging = 0
      list.addEventListener('dragenter', (event) => {
        event.preventDefault()
        dragging += 1
        list.classList.add('drop')
      })
      list.addEventListener('dragover', (event) => event.preventDefault())
      list.addEventListener('dragleave', () => {
        dragging = Math.max(0, dragging - 1)
        if (!dragging) list.classList.remove('drop')
      })
      list.addEventListener('drop', (event) => {
        event.preventDefault()
        dragging = 0
        list.classList.remove('drop')
        uploadFiles(event.dataTransfer?.files)
      })
    }
  }

  init()
  window.SDFiles = { show, load, render }

  // Lien profond /?view=files : app.js a déjà basculé la vue avant que ce
  // fichier ne soit chargé, il faut donc amorcer la liste nous-mêmes.
  if ($('view-files')?.classList.contains('active')) show()
})()
