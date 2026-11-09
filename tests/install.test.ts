import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = process.cwd()

function tempDir(prefix = 'ask-install-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeFixture(): string {
  const dir = tempDir('ask-fixture-')
  copyFileSync(join(REPO, 'install.sh'), join(dir, 'install.sh'))
  chmodSync(join(dir, 'install.sh'), 0o755)
  writeFileSync(join(dir, 'package.json'), '{"name":"ask-fixture"}\n')
  writeFileSync(join(dir, 'package-lock.json'), '{}\n')
  return dir
}

function makeFakeNpm(dir: string, options: { failFirst?: boolean } = {}): string {
  const npmPath = join(dir, 'npm')
  const marker = join(dir, 'npm-failed-once')
  const log = join(dir, 'npm-calls.log')
  const failFirst = options.failFirst ? '1' : '0'

  writeFileSync(
    npmPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = "ci" ] || [ "$1" = "install" ]; then
  if [ "${failFirst}" = "1" ] && [ ! -f "${marker}" ]; then
    : > "${marker}"
    exit 1
  fi
  exit 0
fi
if [ "$1" = "run" ]; then
  mkdir -p dist
  printf '#!/usr/bin/env node\\nconsole.log("0.1.0")\\n' > dist/cli.js
  chmod +x dist/cli.js
  exit 0
fi
exit 0
`,
    'utf8',
  )
  chmodSync(npmPath, 0o755)
  return npmPath
}

function readNpmCalls(npmPath: string): string[] {
  const log = join(dirname(npmPath), 'npm-calls.log')
  if (!existsSync(log)) {
    return []
  }
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
}

interface InstallResult {
  status: number | null
  stdout: string
  stderr: string
}

function runInstall(
  fixture: string,
  args: string[],
  env: Record<string, string>,
): InstallResult {
  const result = spawnSync('/bin/bash', [join(fixture, 'install.sh'), ...args], {
    env,
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function baseEnv(npmDir: string, home: string, binDir: string): Record<string, string> {
  // 排除本机已安装的 ~/.local/bin/ask，否则会触发名称冲突检查
  const homeBin = join(homedir(), '.local', 'bin')
  const cleanPath = (process.env.PATH ?? '')
    .split(':')
    .filter((entry) => entry !== homeBin)
    .join(':')

  return {
    ...process.env,
    PATH: `${npmDir}:${cleanPath}`,
    ASK_HOME: home,
    BIN_DIR: binDir,
  } as Record<string, string>
}

describe('install.sh', () => {
  it('aborts when another ask exists on PATH', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const collisionDir = tempDir('ask-collision-')
    const otherAsk = join(collisionDir, 'ask')
    writeFileSync(otherAsk, '#!/bin/sh\nexit 0\n')
    chmodSync(otherAsk, 0o755)

    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')
    const result = runInstall(fixture, [], {
      ...baseEnv(npmDir, home, binDir),
      PATH: `${collisionDir}:${npmDir}:${process.env.PATH ?? ''}`,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Another ask already exists')
  })

  it('retries dependency installation once after a failure', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    const npmPath = makeFakeNpm(npmDir, { failFirst: true })
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')

    const result = runInstall(fixture, [], baseEnv(npmDir, home, binDir))

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('retrying once')
    expect(readNpmCalls(npmPath).filter((call) => call === 'ci')).toHaveLength(2)
  })

  it('installs the launcher, seeds config, hints about PATH, and self-checks', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')

    const result = runInstall(fixture, [], baseEnv(npmDir, home, binDir))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Installed successfully')
    expect(result.stderr).toContain('not in PATH')

    const launcher = join(binDir, 'ask')
    expect(existsSync(launcher)).toBe(true)
    expect(resolveVersion(launcher)).toBe('0.1.0')
    expect(existsSync(join(home, 'config.json'))).toBe(true)

    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    expect(config.context_window_tokens).toBe(128000)
    expect(config.language).toBe('zh')
  })

  it('writes the language selected through ASK_LANG', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')

    const result = runInstall(fixture, [], {
      ...baseEnv(npmDir, home, binDir),
      ASK_LANG: 'ja',
    })

    expect(result.status).toBe(0)
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    expect(config.language).toBe('ja')
  })

  it('updates only language on reinstall when ASK_LANG is set', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')

    writeFileSync(
      join(home, 'config.json'),
      '{"model":"custom","language":"zh"}\n',
    )

    const result = runInstall(fixture, [], {
      ...baseEnv(npmDir, home, binDir),
      ASK_LANG: 'fr',
    })

    expect(result.status).toBe(0)
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    expect(config.language).toBe('fr')
    expect(config.model).toBe('custom')
  })

  it('writes model configuration from environment variables', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')

    const result = runInstall(fixture, [], {
      ...baseEnv(npmDir, home, binDir),
      ASK_BASE_URL: 'https://api.deepseek.com',
      ASK_MODEL: 'deepseek-chat',
      ASK_API_KEY: 'secret-key',
    })

    expect(result.status).toBe(0)
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    expect(config.base_url).toBe('https://api.deepseek.com')
    expect(config.model).toBe('deepseek-chat')
    expect(config.api_key).toBe('secret-key')
  })

  it('preserves untouched model fields when only one env value is set', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')

    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        base_url: 'https://old.example.com',
        model: 'old-model',
        api_key: 'old-key',
      }),
    )

    const result = runInstall(fixture, [], {
      ...baseEnv(npmDir, home, binDir),
      ASK_MODEL: 'new-model',
    })

    expect(result.status).toBe(0)
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    expect(config.model).toBe('new-model')
    expect(config.base_url).toBe('https://old.example.com')
    expect(config.api_key).toBe('old-key')
  })

  it('is idempotent and preserves existing config; uninstall and purge behave as specified', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')
    const env = baseEnv(npmDir, home, binDir)

    expect(runInstall(fixture, [], env).status).toBe(0)

    writeFileSync(join(home, 'config.json'), '{"model":"custom"}\n')
    writeFileSync(join(home, 'history'), '{"q":"kept","ts":"t"}\n')

    expect(runInstall(fixture, [], env).status).toBe(0)
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(
      '{"model":"custom"}\n',
    )
    expect(readFileSync(join(home, 'history'), 'utf8')).toContain('kept')

    expect(runInstall(fixture, ['--uninstall'], env).status).toBe(0)
    expect(existsSync(join(binDir, 'ask'))).toBe(false)
    expect(existsSync(join(home, 'config.json'))).toBe(true)

    expect(runInstall(fixture, [], env).status).toBe(0)
    expect(runInstall(fixture, ['--purge'], env).status).toBe(0)
    expect(existsSync(join(binDir, 'ask'))).toBe(false)
    expect(existsSync(home)).toBe(false)
  })

  it('honors --bin-dir', () => {
    const fixture = makeFixture()
    const npmDir = tempDir('ask-npm-')
    makeFakeNpm(npmDir)
    const home = tempDir('ask-home-')
    const custom = join(tempDir('ask-custom-'), 'bin')

    const result = runInstall(
      fixture,
      ['--bin-dir', custom],
      baseEnv(npmDir, home, join(tempDir('ask-unused-'), 'bin')),
    )

    expect(result.status).toBe(0)
    expect(existsSync(join(custom, 'ask'))).toBe(true)
    expect(resolveVersion(join(custom, 'ask'))).toBe('0.1.0')
  })
})

describe('install.sh Node bootstrap', () => {
  function serveRuntime(goodHash: boolean): { baseUrl: string; version: string } {
    const version = '22.11.0'
    const os = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const tarballName = `node-v${version}-${os}-${arch}.tar.gz`

    const staging = tempDir('ask-node-stage-')
    const packageRoot = join(staging, `node-v${version}-${os}-${arch}`)
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    const fakeNpm = makeFakeNpm(tempDir('ask-npm-'))

    writeFileSync(
      join(packageRoot, 'bin', 'node'),
      `#!/bin/sh
if [ "$1" = "-v" ]; then echo v${version}; exit 0; fi
exec "${process.execPath}" "$@"
`,
    )
    writeFileSync(
      join(packageRoot, 'bin', 'npm'),
      `#!/bin/sh\nexec "${fakeNpm}" "$@"\n`,
    )
    chmodSync(join(packageRoot, 'bin', 'node'), 0o755)
    chmodSync(join(packageRoot, 'bin', 'npm'), 0o755)

    const tarball = join(staging, tarballName)
    const tar = spawnSync('tar', [
      '-czf',
      tarball,
      '-C',
      staging,
      `node-v${version}-${os}-${arch}`,
    ])
    expect(tar.status).toBe(0)

    const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    const sums = goodHash
      ? `${hash}  ${tarballName}\n`
      : `${'0'.repeat(64)}  ${tarballName}\n`

    const servedRoot = tempDir('ask-node-served-')
    const versionDir = join(servedRoot, `v${version}`)
    mkdirSync(versionDir, { recursive: true })
    copyFileSync(tarball, join(versionDir, tarballName))
    writeFileSync(join(versionDir, 'SHASUMS256.txt'), sums)

    return { baseUrl: `file://${servedRoot}`, version }
  }

  it('downloads, verifies and uses a private Node runtime', () => {
    const { baseUrl, version } = serveRuntime(true)

    const fixture = makeFixture()
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')
    const restricted = makeRestrictedPath()

    const result = runInstall(fixture, ['--bin-dir', binDir], {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      PATH: restricted,
      ASK_HOME: home,
      NODE_VERSION: version,
      ASK_NODE_BASE_URL: baseUrl,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Node.js installed at')
    expect(existsSync(join(home, 'node', version, 'bin', 'node'))).toBe(true)

    const launcher = readFileSync(join(binDir, 'ask'), 'utf8')
    expect(launcher).toContain(join(home, 'node', version, 'bin', 'node'))
    expect(resolveVersion(join(binDir, 'ask'), restricted)).toBe('0.1.0')
  })

  it('aborts when the checksum does not match', () => {
    const { baseUrl, version } = serveRuntime(false)

    const fixture = makeFixture()
    const home = tempDir('ask-home-')
    const binDir = join(tempDir('ask-bin-'), 'bin')
    const restricted = makeRestrictedPath()

    const result = runInstall(fixture, ['--bin-dir', binDir], {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      PATH: restricted,
      ASK_HOME: home,
      NODE_VERSION: version,
      ASK_NODE_BASE_URL: baseUrl,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('sha256 verification failed')
    expect(existsSync(join(binDir, 'ask'))).toBe(false)
  })
})

function resolveVersion(launcher: string, path?: string): string {
  const result = spawnSync(launcher, ['--version'], {
    encoding: 'utf8',
    env: path ? { ...process.env, PATH: path } : process.env,
  })
  return (result.stdout ?? '').trim()
}

function makeRestrictedPath(): string {
  const dir = tempDir('ask-restricted-')
  const tools = [
    'bash',
    'env',
    'uname',
    'sed',
    'mkdir',
    'chmod',
    'cp',
    'rm',
    'cat',
    'tar',
    'curl',
    'shasum',
    'mktemp',
    'dirname',
    'gzip',
  ]

  for (const tool of tools) {
    const found = spawnSync('which', [tool], { encoding: 'utf8' })
    const path = (found.stdout ?? '').trim()
    if (path !== '') {
      const link = join(dir, tool)
      try {
        symlinkSync(path, link)
      } catch {
        try {
          cpSync(path, link)
          chmodSync(link, 0o755)
        } catch {
          // 某些工具是脚本，忽略复制失败
        }
      }
    }
  }

  return dir
}
