import { createHash } from 'node:crypto'
import { homedir, hostname, userInfo } from 'node:os'

export function machineId(): string {
  const raw = `${hostname()} ${userInfo().username} ${homedir()}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}
