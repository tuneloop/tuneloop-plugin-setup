import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

export async function walkFiles(root: string, ext: string): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const rec = async (dir: string): Promise<void> => {
    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await rec(full)
      } else if (e.isFile()) {
        if (e.name.endsWith(ext)) out.push(full)
      } else if (e.isSymbolicLink()) {
        try {
          const st = await stat(full)
          if (st.isDirectory()) await rec(full)
          else if (st.isFile() && e.name.endsWith(ext)) out.push(full)
        } catch {
          /* dangling symlink */
        }
      }
    }
  }
  await rec(root)
  return out
}
