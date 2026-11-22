import http from 'node:http'

// Faux nœud Proxmox : reproduit les formes de réponse de /api2/json utilisées
// par src/proxmox.js. Aucun accès réseau externe.
export function startFakePve({ tokenId = 'test@pve!api', tokenSecret = 'secret', port = 0 } = {}) {
  const actions = []
  const authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`

  const nodes = [
    {
      node: 'pve1', status: 'online', cpu: 0.12, maxcpu: 8,
      mem: 4_000_000_000, maxmem: 16_000_000_000,
      disk: 20_000_000_000, maxdisk: 100_000_000_000, uptime: 90_000,
    },
  ]

  const guests = [
    {
      vmid: 101, name: 'web', node: 'pve1', type: 'lxc', status: 'running',
      cpu: 0.05, maxcpu: 2, mem: 500_000_000, maxmem: 2_000_000_000,
      disk: 3_000_000_000, maxdisk: 8_000_000_000, uptime: 3600, template: 0,
    },
    {
      vmid: 102, name: 'db', node: 'pve1', type: 'lxc', status: 'stopped',
      cpu: 0, maxcpu: 2, mem: 0, maxmem: 2_000_000_000,
      disk: 0, maxdisk: 8_000_000_000, uptime: 0, template: 0,
    },
    {
      vmid: 200, name: 'win11', node: 'pve1', type: 'qemu', status: 'running',
      cpu: 0.3, maxcpu: 4, mem: 6_000_000_000, maxmem: 8_000_000_000,
      disk: 10_000_000_000, maxdisk: 64_000_000_000, uptime: 7200, template: 0,
    },
  ]

  const backups = [
    {
      volid: 'local:backup/vzdump-lxc-101-2026_11_20-03_00_01.tar.zst', size: 512_000_000,
      ctime: 1_760_000_000, format: 'tzst', vmid: 101, content: 'backup',
    },
    {
      volid: 'local:backup/vzdump-lxc-102-2026_11_19-03_00_01.tar.zst', size: 480_000_000,
      ctime: 1_759_900_000, format: 'tzst', vmid: 102, content: 'backup',
    },
  ]

  const snapshots = {
    101: [{ name: 'before-upgrade', description: 'avant apt upgrade', snaptime: 1_760_000_000 }],
  }

  const tasks = [
    { upid: 'UPID:pve1:0001:task', type: 'vzdump', status: 'OK', starttime: 1_700_000_000, node: 'pve1', id: '101' },
    { upid: 'UPID:pve1:0005:running', type: 'vzsnapshot', status: 'running', starttime: 1_700_001_000, node: 'pve1', id: '101' },
  ]

  const appliances = [
    { template: 'debian-12-standard_12.12-1_amd64.tar.zst', package: 'debian-12-standard', version: '12.12-1', os: 'Debian 12', section: 'system', infopage: 'https://pve.proxmox.com' },
    { template: 'alpine-3.19-default_20240207_amd64.tar.xz', package: 'alpine-3.19-default', version: '20240207', os: 'Alpine 3.19', section: 'system', infopage: '' },
  ]

  const rrd = Array.from({ length: 12 }, (_, i) => ({
    time: 1_700_000_000 + i * 300,
    cpu: 0.1 + Math.sin(i) * 0.05,
    memused: 4e9 + i * 1e7,
    memtotal: 16e9,
    netin: 1e6 * i,
    netout: 5e5 * i,
  }))

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => route(req, res, body))
  })

  function route(req, res, body) {
    const url = new URL(req.url, 'http://localhost')
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    const path = url.pathname.replace(/^\/api2\/json/, '')

    // Authentification par identifiants (pas de jeton requis).
    if (path === '/access/ticket') {
      const params = new URLSearchParams(body)
      const user = params.get('username')
      const pass = params.get('password')
      const challenge = params.get('tfa-challenge')
      if (user === 'root@pam' && pass === 'secret') {
        return send(200, { data: { ticket: 'PVE:root@pam:ticket', CSRFPreventionToken: 'csrf', username: 'root@pam' } })
      }
      if (user === 'admin@pve' && !challenge && pass === 'secret') {
        return send(200, { data: { ticket: 'PVE:partial:challenge', NeedTFA: 1 } })
      }
      if (user === 'admin@pve' && challenge === 'PVE:partial:challenge' && pass === '123456') {
        return send(200, { data: { ticket: 'PVE:admin@pve:ticket', CSRFPreventionToken: 'csrf', username: 'admin@pve' } })
      }
      return send(401, { data: null, errors: { auth: 'authentication failure' } })
    }

    const cookie = req.headers.cookie || ''
    const ticketOk = /PVEAuthCookie=PVE:(root@pam|admin@pve):ticket/.test(cookie)
    if (req.headers.authorization !== authHeader && !ticketOk) {
      return send(401, { data: null, errors: { auth: 'authentication failure' } })
    }

    const parts = path.split('/').filter(Boolean)

    if (path === '/version') return send(200, { data: { version: '8.2.4', release: '8.2', repoid: 'deadbeef' } })
    if (path === '/nodes') return send(200, { data: nodes })
    if (path === '/cluster/resources') return send(200, { data: [...nodes.map((n) => ({ ...n, type: 'node' })), ...guests] })

    if (parts[0] === 'nodes' && parts[2] === 'status' && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(body))
      actions.push({ node: parts[1], action: 'node-power', command: params.command })
      return send(200, { data: 'UPID:pve1:0006:nodepower' })
    }
    if (parts[0] === 'nodes' && parts[2] === 'syslog') {
      return send(200, {
        data: [
          { n: 1, t: 'Nov 20 03:00:01 pve1 pvedaemon[1234]: <root@pam> starting task' },
          { n: 2, t: 'Nov 20 03:00:02 pve1 pvedaemon[1234]: <root@pam> end task' },
        ],
      })
    }
    if (parts[0] === 'nodes' && parts[2] === 'aplinfo') {
      if (req.method === 'POST') {
        const params = Object.fromEntries(new URLSearchParams(body))
        actions.push({ node: parts[1], action: 'template-download', storage: params.storage, template: params.template })
        return send(200, { data: 'UPID:pve1:0007:aplinfo' })
      }
      return send(200, { data: appliances })
    }
    if (parts[0] === 'nodes' && parts[2] === 'vzdump' && req.method === 'POST') {
      actions.push({ node: parts[1], action: 'vzdump', body: Object.fromEntries(new URLSearchParams(body)) })
      return send(200, { data: 'UPID:pve1:0008:vzdump' })
    }
    if (parts[0] === 'nodes' && parts[2] === 'tasks' && parts[3]) {
      const upid = decodeURIComponent(parts[3])
      const task = tasks.find((t) => t.upid === upid)
      if (!task) return send(500, { data: null, errors: { upid: 'no such task' } })
      if (parts[4] === 'status') {
        return send(200, { data: { status: task.status === 'running' ? 'running' : 'stopped', exitstatus: 'OK' } })
      }
      if (parts[4] === 'log') {
        return send(200, {
          data: [
            { n: 1, t: `starting ${task.type}` },
            { n: 2, t: 'INFO: 100% complete' },
            { n: 3, t: 'TASK OK' },
          ],
        })
      }
      if (req.method === 'DELETE') {
        actions.push({ node: parts[1], action: 'task-stop', upid })
        return send(200, { data: null })
      }
    }
    if (parts[0] === 'nodes' && parts[2] === 'status' && parts.length === 3) {
      return send(200, {
        data: {
          pveversion: 'pve-manager/8.2.4/abcd1234',
          kversion: 'Linux 6.8.4-2-pve',
          loadavg: ['0.42', '0.51', '0.60'],
          cpuinfo: { cpus: 8, model: 'Intel(R) Xeon(R)' },
          memory: { total: 16e9, used: 4e9, free: 12e9 },
          rootfs: { total: 100e9, used: 20e9, free: 80e9 },
          uptime: 90_000,
        },
      })
    }
    if (parts[0] === 'nodes' && parts[2] === 'rrddata') return send(200, { data: rrd })
    if (parts[0] === 'nodes' && parts[2] === 'storage' && parts.length === 3) {
      return send(200, {
        data: [
          { storage: 'local', type: 'dir', content: 'vztmpl,iso,backup', total: 100e9, used: 20e9, avail: 80e9, active: 1 },
          { storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir', total: 500e9, used: 120e9, avail: 380e9, active: 1 },
        ],
      })
    }
    if (parts[0] === 'nodes' && parts[2] === 'storage' && parts[4] === 'content' && parts[5] && req.method === 'DELETE') {
      actions.push({ node: parts[1], action: 'delete-volume', storage: parts[3], volid: decodeURIComponent(parts[5]) })
      return send(200, { data: null })
    }
    if (parts[0] === 'nodes' && parts[2] === 'storage' && parts[4] === 'content'
      && url.searchParams.get('content') === 'backup') {
      return send(200, { data: backups })
    }
    if (parts[0] === 'nodes' && parts[2] === 'storage' && parts[4] === 'content') {
      return send(200, {
        data: [
          { volid: 'local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst', size: 120e6, format: 'tzst' },
          { volid: 'local:vztmpl/alpine-3.19-default_20240207_amd64.tar.xz', size: 3e6, format: 'txz' },
        ],
      })
    }
    if (parts[0] === 'nodes' && parts[2] === 'lxc' && req.method === 'POST' && parts.length === 3) {
      actions.push({ node: parts[1], type: 'lxc', action: 'create', body: Object.fromEntries(new URLSearchParams(body)) })
      return send(200, { data: 'UPID:pve1:0004:create' })
    }
    if (parts[0] === 'nodes' && parts[2] === 'tasks') {
      return send(200, { data: tasks })
    }

    if (parts[0] === 'nodes' && (parts[2] === 'lxc' || parts[2] === 'qemu')) {
      const guest = guests.find((g) => String(g.vmid) === parts[3] && g.type === parts[2])
      if (!guest) return send(500, { data: null, errors: { vmid: 'no such guest' } })

      if (parts[4] === 'status' && parts[5] === 'current') {
        return send(200, {
          data: {
            name: guest.name,
            status: guest.status,
            cpu: guest.cpu,
            cpus: guest.maxcpu,
            mem: guest.mem,
            maxmem: guest.maxmem,
            disk: guest.disk,
            maxdisk: guest.maxdisk,
            uptime: guest.uptime,
            pids: guest.type === 'lxc' ? 42 : undefined,
            swap: 0,
          },
        })
      }
      if (parts[4] === 'config' && req.method === 'PUT') {
        actions.push({
          node: parts[1], type: parts[2], vmid: Number(parts[3]), action: 'config',
          body: Object.fromEntries(new URLSearchParams(body)),
        })
        return send(200, { data: 'UPID:pve1:0003:config' })
      }
      if (parts[4] === 'config') {
        return send(200, {
          data: guest.type === 'lxc'
            ? {
                hostname: guest.name, memory: 2048, cores: 2, ostype: 'debian',
                net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
                rootfs: 'local-lvm:vm-101-disk-0,size=8G',
                onboot: '1',
              }
            : {
                name: guest.name, memory: 8192, cores: 4, ostype: 'win11',
                net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0',
                scsi0: 'local-lvm:vm-200-disk-0,size=64G',
              },
        })
      }
      if (parts[4] === 'snapshot') {
        const vmid = String(parts[3])
        if (req.method === 'POST' && parts.length === 5) {
          const params = Object.fromEntries(new URLSearchParams(body))
          actions.push({ node: parts[1], type: parts[2], vmid: Number(vmid), action: 'snapshot', snapname: params.snapname })
          snapshots[vmid] = [...(snapshots[vmid] || []), { name: params.snapname, description: params.description, snaptime: 1_760_100_000 }]
          return send(200, { data: 'UPID:pve1:0009:snapshot' })
        }
        if (req.method === 'DELETE' && parts[5]) {
          actions.push({ node: parts[1], type: parts[2], vmid: Number(vmid), action: 'snapshot-delete', snapname: decodeURIComponent(parts[5]) })
          snapshots[vmid] = (snapshots[vmid] || []).filter((snap) => snap.name !== decodeURIComponent(parts[5]))
          return send(200, { data: 'UPID:pve1:0010:snapshot' })
        }
        if (req.method === 'POST' && parts[6] === 'rollback') {
          actions.push({ node: parts[1], type: parts[2], vmid: Number(vmid), action: 'snapshot-rollback', snapname: decodeURIComponent(parts[5]) })
          return send(200, { data: 'UPID:pve1:0011:snapshot' })
        }
        return send(200, { data: snapshots[vmid] || [] })
      }
      if (parts[4] === 'clone' && req.method === 'POST') {
        actions.push({ node: parts[1], type: parts[2], vmid: Number(parts[3]), action: 'clone', body: Object.fromEntries(new URLSearchParams(body)) })
        return send(200, { data: 'UPID:pve1:0012:clone' })
      }
      if (parts[4] === 'resize' && req.method === 'PUT') {
        actions.push({ node: parts[1], type: parts[2], vmid: Number(parts[3]), action: 'resize', body: Object.fromEntries(new URLSearchParams(body)) })
        return send(200, { data: 'UPID:pve1:0013:resize' })
      }
      if (parts[4] === 'rrddata') return send(200, { data: rrd })
      if (parts[4] === 'status' && req.method === 'POST') {
        actions.push({ node: parts[1], type: parts[2], vmid: Number(parts[3]), action: parts[5] })
        return send(200, { data: `UPID:pve1:0002:${parts[5]}` })
      }
    }

    send(404, { data: null, errors: { path: `no route ${path}` } })
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        actions,
        tokenId,
        tokenSecret,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}
