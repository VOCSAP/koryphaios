'use strict'

// Pure formatter, no I/O: kept out of launch.js so it can be unit-tested
// without triggering that file's top-level Electron spawn.

function formatVersionLine(version, build) {
  const hasCommit = !!build && typeof build.commit === 'string' && build.commit.length > 0
  const hasBuiltAt = !!build && typeof build.builtAt === 'string' && build.builtAt.length > 0
  if (!hasCommit || !hasBuiltAt) {
    return `koryphaios ${version} (build inconnu)`
  }
  const hash = build.dirty === true ? `${build.commit}-dirty` : build.commit
  return `koryphaios ${version} (${hash}, ${build.builtAt})`
}

module.exports = { formatVersionLine }
