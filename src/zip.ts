import { deflateRawSync } from 'node:zlib'

interface ZipEntry {
  path: string
  data: Buffer
}

export function createZip(entries: ZipEntry[]): Buffer {
  const centralDir: Buffer[] = []
  const fileEntries: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data)
    const pathBuf = Buffer.from(entry.path, 'utf8')
    const crc = crc32(entry.data)

    // Local file header (30 bytes + path + compressed data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)  // signature
    local.writeUInt16LE(20, 4)           // version needed
    local.writeUInt16LE(0, 6)            // flags
    local.writeUInt16LE(8, 8)            // compression: deflate
    local.writeUInt16LE(0, 10)           // mod time
    local.writeUInt16LE(0, 12)           // mod date
    local.writeUInt32LE(crc, 14)         // crc-32
    local.writeUInt32LE(compressed.length, 18)  // compressed size
    local.writeUInt32LE(entry.data.length, 22)  // uncompressed size
    local.writeUInt16LE(pathBuf.length, 26)     // filename length
    local.writeUInt16LE(0, 28)           // extra field length

    fileEntries.push(local, pathBuf, compressed)

    // Central directory entry (46 bytes + path)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)  // signature
    central.writeUInt16LE(20, 4)           // version made by
    central.writeUInt16LE(20, 6)           // version needed
    central.writeUInt16LE(0, 8)            // flags
    central.writeUInt16LE(8, 10)           // compression: deflate
    central.writeUInt16LE(0, 12)           // mod time
    central.writeUInt16LE(0, 14)           // mod date
    central.writeUInt32LE(crc, 16)         // crc-32
    central.writeUInt32LE(compressed.length, 20)  // compressed size
    central.writeUInt32LE(entry.data.length, 24)  // uncompressed size
    central.writeUInt16LE(pathBuf.length, 28)     // filename length
    central.writeUInt16LE(0, 30)           // extra field length
    central.writeUInt16LE(0, 32)           // file comment length
    central.writeUInt16LE(0, 34)           // disk number start
    central.writeUInt16LE(0, 36)           // internal attributes
    central.writeUInt32LE(0, 38)           // external attributes
    central.writeUInt32LE(offset, 42)      // relative offset of local header

    centralDir.push(central, pathBuf)

    offset += 30 + pathBuf.length + compressed.length
  }

  const centralDirBuf = Buffer.concat(centralDir)

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)           // signature
  eocd.writeUInt16LE(0, 4)                     // disk number
  eocd.writeUInt16LE(0, 6)                     // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)        // entries on this disk
  eocd.writeUInt16LE(entries.length, 10)       // total entries
  eocd.writeUInt32LE(centralDirBuf.length, 12) // central dir size
  eocd.writeUInt32LE(offset, 16)               // central dir offset
  eocd.writeUInt16LE(0, 20)                    // comment length

  return Buffer.concat([...fileEntries, centralDirBuf, eocd])
}

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[n] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]!) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
