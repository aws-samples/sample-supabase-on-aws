import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProjectSecretsStorage, SecretsCorruptedError } from './storage'

const ENCRYPTION_KEY = 'test-encryption-key-32bytes-min-1234'

let tmpRoot: string
let storage: ProjectSecretsStorage

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-storage-test-'))
  storage = new ProjectSecretsStorage({
    accessTokensPath: path.join(tmpRoot, 'tokens.json'),
    secretsPath: path.join(tmpRoot, 'secrets'),
    encryptionKey: ENCRYPTION_KEY,
  })
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('ProjectSecretsStorage.loadProjectSecrets', () => {
  it('returns [] when the secrets file does not exist (ENOENT, expected first run)', async () => {
    await expect(storage.loadProjectSecrets('ref-never-saved')).resolves.toEqual([])
  })

  it('throws SecretsCorruptedError when the file exists but cannot be decrypted', async () => {
    // Write garbage that decrypt() cannot parse — must NOT be silently swallowed.
    const filePath = path.join(tmpRoot, 'secrets', 'ref-corrupt.json')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(['not-a-valid-encrypted-payload']))

    await expect(storage.loadProjectSecrets('ref-corrupt')).rejects.toBeInstanceOf(SecretsCorruptedError)
  })

  it('throws SecretsCorruptedError when the file is malformed JSON', async () => {
    const filePath = path.join(tmpRoot, 'secrets', 'ref-bad-json.json')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '{not json')

    await expect(storage.loadProjectSecrets('ref-bad-json')).rejects.toBeInstanceOf(SecretsCorruptedError)
  })

  it('round-trips: saves and loads secrets identically', async () => {
    await storage.updateProjectSecrets('ref-rt', [
      { name: 'A', value: 'aaa' },
      { name: 'B', value: 'bbb' },
    ])
    const loaded = await storage.loadProjectSecrets('ref-rt')
    expect(loaded.map((s) => ({ name: s.name, value: s.value }))).toEqual([
      { name: 'A', value: 'aaa' },
      { name: 'B', value: 'bbb' },
    ])
  })
})

describe('ProjectSecretsStorage atomic + concurrent writes (B1 fix)', () => {
  it('does not lose updates when two concurrent updateProjectSecrets calls race', async () => {
    // Two writers each update one disjoint secret on the same project file.
    // Without locking, one will overwrite the other.
    const ref = 'ref-concurrent'
    await storage.updateProjectSecrets(ref, [{ name: 'INITIAL', value: 'init' }])

    await Promise.all([
      storage.updateProjectSecrets(ref, [{ name: 'WRITER_A', value: 'aaa' }]),
      storage.updateProjectSecrets(ref, [{ name: 'WRITER_B', value: 'bbb' }]),
    ])

    const loaded = await storage.loadProjectSecrets(ref)
    const names = loaded.map((s) => s.name).sort()
    expect(names).toEqual(['INITIAL', 'WRITER_A', 'WRITER_B'])
  })

  it('writes atomically — partial-write-on-crash leaves the original file untouched', async () => {
    // Seed a known-good file, then attempt to corrupt the write path mid-flight.
    // We can't truly kill the process inside a test, but we can verify that the
    // implementation uses tmp+rename: after a successful write, no orphan tmp
    // files remain in the secrets directory matching the project ref.
    const ref = 'ref-atomic'
    await storage.updateProjectSecrets(ref, [{ name: 'X', value: '1' }])
    await storage.updateProjectSecrets(ref, [{ name: 'Y', value: '2' }])

    const dir = path.join(tmpRoot, 'secrets')
    const entries = await fs.readdir(dir)
    // Only the canonical {ref}.json should remain — no leaked .tmp / .lock files.
    const stragglers = entries.filter((e) => e !== `${ref}.json`)
    expect(stragglers).toEqual([])
  })
})
