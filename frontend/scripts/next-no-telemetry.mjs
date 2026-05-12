import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const nextCli = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url))

const child = spawn(process.execPath, [nextCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
  },
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
