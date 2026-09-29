export function uniqueAvatarDeckLabels(names: readonly string[]): string[] {
  const labels = new Set<string>()

  return names.map((name) => {
    if (!labels.has(name)) {
      labels.add(name)
      return name
    }

    let suffix = 2
    let label = `${name} (${suffix})`
    while (labels.has(label)) {
      suffix += 1
      label = `${name} (${suffix})`
    }
    labels.add(label)
    return label
  })
}
