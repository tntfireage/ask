import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Command } from 'commander'
import {
  ConfigError,
  collectConfigWarnings,
  loadConfig,
} from './config/config.js'
import { runModelCommand } from './config/model.js'
import { detectLanguage, messages } from './i18n.js'
import { runMcpCommand } from './mcp/commands.js'
import { Repl } from './repl/repl.js'
import { VERSION } from './version.js'

async function startSession(initialQuery?: string): Promise<number> {
  try {
    const config = loadConfig()
    for (const warning of collectConfigWarnings(config)) {
      process.stderr.write(`提示: ${warning}\n`)
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  const repl = new Repl({
    initialQuery,
    history: undefined,
  })
  return repl.start()
}

export function createProgram(
  language: string = detectLanguage(),
): Command {
  const text = messages(language).help
  const program = new Command()

  program
    .name('ask')
    .description(text.description)
    .version(VERSION, '-v, --version')

  program
    .command('model')
    .description(text.model)
    .action(() => {
      process.exitCode = runModelCommand({ language })
    })

  program
    .command('mcp')
    .description(text.mcp)
    .action(() => {
      process.exitCode = runMcpCommand({ language })
    })

  program
    .argument('[query...]', text.query)
    .action(async (parts: string[]) => {
      const query = parts.join(' ').trim()
      process.exitCode = await startSession(query === '' ? undefined : query)
    })

  return program
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createProgram()
  await program.parseAsync(argv)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

const entry = process.argv[1]
let isEntryPoint = false
if (entry) {
  try {
    isEntryPoint =
      realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    isEntryPoint =
      import.meta.url === pathToFileURL(entry).href
  }
}

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      process.exitCode = 1
    })
}
