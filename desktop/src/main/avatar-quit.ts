export interface AvatarClosable {
  close(): Promise<void>
}

export interface AvatarReleasable {
  release(): void
}

export async function releaseAvatarResources(
  server: AvatarClosable | null,
  owner: AvatarReleasable | null,
  lifetime: AvatarReleasable | null
): Promise<void> {
  try {
    await server?.close()
  } finally {
    try {
      owner?.release()
    } finally {
      lifetime?.release()
    }
  }
}
