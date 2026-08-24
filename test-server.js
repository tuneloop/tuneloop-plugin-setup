import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/ingest/transcript') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)

    const boundary = req.headers['content-type']?.match(/boundary=(.+)/)?.[1]
    if (!boundary) {
      console.log('ERROR: no multipart boundary')
      res.writeHead(400)
      res.end()
      return
    }

    // Parse multipart parts
    const raw = body.toString('latin1')
    const parts = raw.split('--' + boundary).slice(1, -1)

    let meta = null
    let transcriptGzSize = 0
    let transcriptSize = 0
    let bundlePreview = null

    for (const part of parts) {
      const [headerBlock, ...rest] = part.split('\r\n\r\n')
      const content = rest.join('\r\n\r\n').replace(/\r\n$/, '')

      if (headerBlock.includes('name="meta"')) {
        meta = JSON.parse(content)
      } else if (headerBlock.includes('name="transcript"')) {
        const gzBuf = Buffer.from(content, 'latin1')
        transcriptGzSize = gzBuf.length
        try {
          const decompressed = gunzipSync(gzBuf)
          transcriptSize = decompressed.length
          const bundle = JSON.parse(decompressed.toString('utf8'))
          bundlePreview = {
            bundleVersion: bundle.bundleVersion,
            sessionKey: bundle.sessionKey,
            primary: bundle.primary,
            fileCount: bundle.files?.length,
            files: bundle.files?.map(f => ({
              name: f.name,
              contentLength: f.content?.length,
            })),
          }
        } catch (e) {
          bundlePreview = { error: e.message }
        }
      }
    }

    // E2E support: persist the decompressed bundle + meta so a downstream
    // parser test can consume exactly what a real server would have received.
    if (process.env.SAVE_UPLOADS_TO && transcriptSize > 0) {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const dir = process.env.SAVE_UPLOADS_TO
      mkdirSync(dir, { recursive: true })
      const stamp = Date.now()
      for (const part of parts) {
        const [headerBlock, ...rest] = part.split('\r\n\r\n')
        const content = rest.join('\r\n\r\n').replace(/\r\n$/, '')
        if (headerBlock.includes('name="transcript"')) {
          writeFileSync(`${dir}/bundle-${stamp}.json`, gunzipSync(Buffer.from(content, 'latin1')))
        }
      }
      writeFileSync(`${dir}/meta-${stamp}.json`, JSON.stringify(meta, null, 2))
    }

    const timestamp = new Date().toISOString()
    console.log('\n' + '='.repeat(70))
    console.log(`UPLOAD RECEIVED at ${timestamp}`)
    console.log('='.repeat(70))
    console.log('\nAuth:', req.headers.authorization)
    console.log('\nMeta:')
    console.log(JSON.stringify(meta, null, 2))
    console.log(`\nTranscript: ${(transcriptGzSize / 1024).toFixed(1)}KB gzipped → ${(transcriptSize / 1024).toFixed(1)}KB`)
    console.log('\nBundle:')
    console.log(JSON.stringify(bundlePreview, null, 2))
    console.log('='.repeat(70))

    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, transcriptId: `test-${Date.now()}`, deduped: false }))
  } else {
    console.log(`${req.method} ${req.url} (ignored)`)
    res.writeHead(404)
    res.end()
  }
})

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 9919
server.listen(PORT, () => {
  console.log(`Tuneloop mock server listening on http://localhost:${PORT}`)
  console.log('Waiting for uploads...\n')
})
