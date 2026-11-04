// 最小 ZIP 写入器：不依赖任何外部工具，纯 Node。
// 用于「迁移导出」——把整个 memory 目录打成一个包带走。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

const DOS_TIME = 0
const DOS_DATE = 33 // 1980-01-01

/** 把目录下所有文件打成 zip（deflate），返回 {file, bytes, entries} */
export function zipDirectory(dir, outFile, { skip = ['.lock', '.tmp'] } = {}) {
  const entries = []
  const visited = new Set() // 跟随联接时防环
  const walk = (d, prefix) => {
    let real
    try {
      real = fs.realpathSync(d)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.some((s) => e.name.endsWith(s))) continue
      // 不要把自己上一次导出的包再打进去（会滚雪球）
      if (/^memory-export-.*\.zip$/i.test(e.name)) continue
      const full = path.join(d, e.name)
      const name = prefix ? `${prefix}/${e.name}` : e.name
      // 用 statSync 判断类型：联接/符号链接在 Dirent 里不是目录，
      // 直接当文件读会 EISDIR。
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, name)
      else entries.push({ full, name })
    }
  }
  walk(dir, '')

  const chunks = []
  const central = []
  let offset = 0

  for (const ent of entries) {
    const data = fs.readFileSync(ent.full)
    const deflated = zlib.deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const nameBuf = Buffer.from(ent.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(DOS_TIME, 12)
    cen.writeUInt16LE(DOS_DATE, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  const out = Buffer.concat([...chunks, centralBuf, end])
  fs.writeFileSync(outFile, out)
  return { file: outFile, bytes: out.length, entries: entries.length }
}
