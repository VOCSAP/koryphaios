import { reportError } from './log'
import type { SecretCipher } from './scope-secrets'

/** The part of Electron's `safeStorage` the codec calls; the real object satisfies it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

async function traced<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    reportError('secrets', `safeStorage ${operation} failed`, error instanceof Error ? error.name : typeof error)
    throw error
  }
}

export function createSafeStorageCipher(storage: SafeStorageLike): SecretCipher {
  return {
    isAvailable: () => storage.isEncryptionAvailable(),
    encrypt: (plain) => storage.encryptString(plain),
    decrypt: (buf) => storage.decryptString(buf),
    isAvailableAsync: () => traced('isAsyncEncryptionAvailable', () => storage.isAsyncEncryptionAvailable()),
    encryptAsync: (plain) => traced('encryptStringAsync', () => storage.encryptStringAsync(plain)),
    decryptAsync: (buf) => traced('decryptStringAsync', async () => (await storage.decryptStringAsync(buf)).result)
  }
}
