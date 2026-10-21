export const EXPECTED_FIXTURE_VERDICTS: Record<string, { checkpoints: readonly ('clear' | 'modal')[]; final: 'clear' | 'modal' }> = {
  'ask-user-question-2.1.301.json': { checkpoints: ['modal', 'clear', 'modal', 'modal'], final: 'modal' },
  'channels-warning-conpty-win.json': { checkpoints: [], final: 'modal' },
  'composer-2.1.283-reduced.json': { checkpoints: [], final: 'clear' },
  'dialog-open-no-esc.json': { checkpoints: ['modal', 'modal'], final: 'modal' },
  'dialog-open-with-esc.json': { checkpoints: ['modal', 'modal'], final: 'modal' },
  'draft-numbered-2.1.301.json': { checkpoints: ['modal', 'clear', 'modal', 'modal', 'clear'], final: 'clear' },
  'draft-typed-with-esc.json': { checkpoints: ['clear', 'clear', 'clear', 'clear', 'clear'], final: 'clear' },
  'permission-bash-2.1.291.json': { checkpoints: ['modal'], final: 'modal' },
  'permission-bash-ba116-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-ba81-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-bashindent-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-bemoji-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-gitnl-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-heredoc-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-touchnl-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-touchsp-2.1.291.json': { checkpoints: [], final: 'modal' },
  'permission-bash-wrapped-2.1.291.json': { checkpoints: ['modal'], final: 'modal' },
  'permission-write-2.1.291.json': { checkpoints: ['modal'], final: 'modal' },
  'plan-approval-2.1.301.json': { checkpoints: ['modal', 'clear', 'modal'], final: 'modal' },
  'prompt-idle-with-esc.json': { checkpoints: ['clear', 'clear', 'clear', 'clear'], final: 'clear' },
  'resize-numbered-draft-2.1.301.json': { checkpoints: ['modal', 'clear', 'modal', 'modal', 'modal'], final: 'modal' },
  'resize-storm-write-perm-2.1.303.json': {
    checkpoints: ['clear', 'clear', 'clear', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'modal', 'clear'],
    final: 'clear'
  },
  'scroll-context-2.1.284-reduced.json': { checkpoints: [], final: 'modal' },
  'slash-menu-with-esc.json': { checkpoints: ['clear', 'clear', 'clear', 'clear', 'clear'], final: 'clear' },
  'trust-dialog-glued-folder-2.1.303.json': { checkpoints: ['modal', 'modal', 'modal', 'modal', 'modal', 'modal'], final: 'modal' },
  'trust-dialog-quick-safety-check.json': { checkpoints: [], final: 'modal' },
  'turn-chunks-inherited-env.json': { checkpoints: [], final: 'modal' },
  'turn-chunks-scrubbed-env.json': { checkpoints: [], final: 'modal' },
  'turn-no-statusline-count.json': { checkpoints: [], final: 'clear' },
  'turn-no-statusline-hi.json': { checkpoints: [], final: 'clear' },
  'turn-with-statusline-count.json': { checkpoints: [], final: 'clear' },
  'turn-with-statusline-hi.json': { checkpoints: [], final: 'clear' },
  'typing-numbered-2.1.301.json': { checkpoints: ['modal', 'clear', 'modal', 'modal'], final: 'modal' },
  'prosopon-432ab5e-flow-40c-2.1.306.json': { checkpoints: ['clear', 'clear', 'clear', 'clear', 'modal', 'clear', 'modal', 'clear', 'clear', 'modal', 'clear', 'clear'], final: 'clear' },
  'prosopon-432ab5e-permission-40c-2.1.306.json': { checkpoints: ['clear', 'clear', 'modal'], final: 'modal' },
  'prosopon-432ab5e-resume-40c-2.1.306.json': { checkpoints: ['clear', 'clear'], final: 'clear' },
  'prosopon-432ab5e-flow-80c-2.1.306.json': { checkpoints: ['clear', 'clear', 'clear', 'clear', 'modal', 'clear', 'modal', 'clear', 'clear', 'modal', 'clear', 'clear'], final: 'clear' },
  'prosopon-432ab5e-permission-80c-2.1.306.json': { checkpoints: ['clear', 'clear', 'modal'], final: 'modal' },
  'prosopon-432ab5e-resume-80c-2.1.306.json': { checkpoints: ['clear', 'clear'], final: 'clear' },
  'prosopon-432ab5e-flow-120c-2.1.306.json': { checkpoints: ['clear', 'clear', 'clear', 'clear', 'modal', 'clear', 'modal', 'clear', 'clear', 'modal', 'clear', 'clear'], final: 'clear' },
  'prosopon-432ab5e-permission-120c-2.1.306.json': { checkpoints: ['clear', 'clear', 'modal'], final: 'modal' },
  'prosopon-432ab5e-resume-120c-2.1.306.json': { checkpoints: ['clear', 'clear'], final: 'clear' },
  'prosopon-432ab5e-quota-80c-2.1.306.json': { checkpoints: ['clear'], final: 'clear' },
  'stock-quota-80c-2.1.306.json': { checkpoints: ['clear'], final: 'clear' }
}

export const RESIZE_MARKER = /^\n########## RESIZE \[(\d+),(\d+)\] ##########/

export const GEOMETRY_MARKER = /^\n########## GEOMETRY \[(\d+),(\d+)\] ##########/

export const LEGACY_START_SIZE = { cols: 120, rows: 40 } as const

export function fixtureStartSize(chunks: ReadonlyArray<{ data: string }>): { cols: number; rows: number } {
  const declared = chunks[0] === undefined ? null : GEOMETRY_MARKER.exec(chunks[0].data)
  return declared ? { cols: Number(declared[1]), rows: Number(declared[2]) } : LEGACY_START_SIZE
}
