import { sanitizeFlagValue } from './flag-value'

export interface TemplateLaunchOptions {
  args?: string
  agent?: string
  model?: string
}

export interface LiftedLaunchOptions {
  args: string
  agent?: string
  model?: string
  /** `args` still names an agent flag that the structured field does not represent. */
  unresolvedAgent: boolean
  unresolvedModel: boolean
}

// The exact prefix SessionService.create() writes: `--agent "<v>" --model "<v>" <args>`.
const AGENT_PREFIX = /^--agent "([^"\s]+)"(?=\s|$)/
const MODEL_PREFIX = /^--model "([^"\s]+)"(?=\s|$)/
// Any spelling of the flag, quoted or `=` form included; `--agents` redefines profiles.
const AGENT_FAMILY = /(?:^|[\s"'=])--agents?(?=$|[\s="'])/g
const MODEL_FAMILY = /(?:^|[\s"'=])(?:--model|-m)(?=$|[\s="'])/g

function occurrences(source: string, family: RegExp): number {
  return source.match(family)?.length ?? 0
}

function liftPrefix(source: string, prefix: RegExp): { value: string; rest: string } | null {
  const match = prefix.exec(source)
  if (!match) return null
  const value = match[1]!
  if (sanitizeFlagValue(value) !== value) return null
  return { value, rest: source.slice(match[0].length).trimStart() }
}

/** Unsupported or duplicate flags stay in args: interpreting arbitrary shell fragments could change their meaning. */
export function liftTemplateLaunchOptions(input: TemplateLaunchOptions): LiftedLaunchOptions {
  const original = input.args ?? ''
  const source = original.trim()
  let rest = source
  let agent = input.agent
  let model = input.model
  const agentCount = occurrences(source, AGENT_FAMILY)
  const modelCount = occurrences(source, MODEL_FAMILY)
  let liftedAgent = false
  let liftedModel = false

  if (agent === undefined && agentCount === 1) {
    const lifted = liftPrefix(rest, AGENT_PREFIX)
    if (lifted) {
      agent = lifted.value
      rest = lifted.rest
      liftedAgent = true
    }
  }
  if (model === undefined && modelCount === 1) {
    const lifted = liftPrefix(rest, MODEL_PREFIX)
    if (lifted) {
      model = lifted.value
      rest = lifted.rest
      liftedModel = true
    }
  }

  return {
    args: liftedAgent || liftedModel ? rest : original,
    agent,
    model,
    unresolvedAgent: agentCount > 0 && !liftedAgent,
    unresolvedModel: modelCount > 0 && !liftedModel
  }
}
