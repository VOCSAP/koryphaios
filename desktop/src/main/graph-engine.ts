// Graph chat context compilation + inference orchestration
// (EXPLORATION-graph-chat C25).
//
// The three system prompts below are CODE CONSTANTS (C8 rule): never
// operator- or repo-configurable. Compilation renders the inference node's
// ancestry as a transcript — linear when the node has 0-1 parents, or a
// three-way-style "trunk + labeled divergent branches" document when it has
// several (decision D3: two divergent branches are NEVER flattened into a
// fake linear conversation; they often contradict each other by design).
//
// Node builtins only; pure builders unit-testable under bun, runInference
// takes an injectable runner for tests (like runHelp's fake-binary pattern).

import { join } from 'node:path'
import {
  ancestorsOf,
  graphId,
  linearize,
  mergePartition,
  type GraphDoc,
  type GraphNode,
  type ModelTarget
} from '../shared/graph'
import {
  buildAdapterCommand,
  GRAPH_INFER_TIMEOUT_MS,
  runHttpInference,
  writeContextFile,
  type HttpInferenceInput
} from './model-adapters'
import { runHelp } from './help-assistant'
import type { LocalProviderConfig } from '../shared/models'

// ---------------------------------------------------------------------------
// Prompts (CODE CONSTANTS — C8)

export const GRAPH_CHAT_SYSTEM_PROMPT = [
  'You are answering inside the GRAPH CHAT of Koryphaios, a canvas where every exchange is a node and the operator can branch "what if" explorations at any point.',
  'The conversation history below was recompiled from the graph: it is the exact ancestry of the node you are answering. Treat it as the conversation so far.',
  'Answer the operator\'s message directly and concisely, in the language of the question. Do not mention the graph mechanics unless asked.'
].join('\n\n')

export const GRAPH_MERGE_SYSTEM_PROMPT = [
  'You are answering inside the GRAPH CHAT of Koryphaios, a canvas where every exchange is a node and conversations can BRANCH and be CROSSED.',
  'The operator crossed SEVERAL divergent branches into this node. Below you get: the COMMON TRUNK (shared history, rendered once), then each BRANCH as a labeled section. The branches diverged from the trunk independently: they do NOT know each other, and they may explore contradictory directions — that is intentional, do not treat contradictions as errors.',
  'Ground your answer in ALL the provided branches (compare, reconcile, synthesize as the operator asks). Answer in the language of the question.'
].join('\n\n')

export const GRAPH_JUDGE_SYSTEM_PROMPT = [
  'You are the BATTLE JUDGE of the Koryphaios graph chat. Several models answered the SAME prompt with the SAME context, independently.',
  'Below you get the shared context, the prompt, and the candidate answers labeled A, B, C... The model names are hidden on purpose: judge the content only.',
  'Your job: (1) compare the answers — agreements, contradictions, unique insights, factual or logical weaknesses; (2) state which answer is strongest and why, briefly; (3) produce the best merged answer to the original prompt, taking the strongest elements of each candidate. The merged answer is the main deliverable — make it standalone. Answer in the language of the prompt.'
].join('\n\n')

/** Question side of the judge invocation (the system file carries the data). */
export const GRAPH_JUDGE_PROMPT =
  'Judge the candidate answers provided in your instructions: compare them, pick the strongest, and produce the merged answer.'

// ---------------------------------------------------------------------------
// Transcript rendering + budget (decision D8)

export const GRAPH_MAX_CONTEXT_CHARS = 60_000
/** Verbatim tail kept per section when the budget forces elision. */
const KEEP_LAST = 6

function nodeHeader(n: GraphNode): string {
  if (n.type === 'user') return '[user]'
  if (n.type === 'judge') return `[judge ${n.cli ?? '?'}${n.model ? `/${n.model}` : ''}]`
  return `[assistant ${n.cli ?? '?'}${n.model ? `/${n.model}` : ''}]`
}

function renderNodes(nodes: GraphNode[]): string {
  return nodes.map((n) => `${nodeHeader(n)}\n${n.text}`).join('\n\n')
}

/** Render a section under budget: oldest exchanges elided with a marker. */
function renderSection(nodes: GraphNode[], budget: number): string {
  const full = renderNodes(nodes)
  if (full.length <= budget) return full
  const tail = nodes.slice(-KEEP_LAST)
  const elided = nodes.length - tail.length
  let text = renderNodes(tail)
  if (text.length > budget) text = `[… section truncated …]\n${text.slice(text.length - budget)}`
  return elided > 0 ? `[… ${elided} earlier exchanges elided …]\n\n${text}` : text
}

export interface CompiledContext {
  /** System side: constant prompt + rendered context (goes into a file, D5). */
  system: string
  /** Prompt side: the inference node's own text. */
  prompt: string
  /** True when the merge (multi-parent) rendering was used. */
  merge: boolean
}

/**
 * Compile the context of a (user) node: linear transcript for 0-1 parents,
 * trunk + labeled branch sections for 2+ parents (D3). Deterministic — the
 * context inspector shows exactly this.
 */
export function compileContext(doc: GraphDoc, nodeId: string): CompiledContext {
  const node = doc.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error(`unknown node ${nodeId}`)
  const heads = node.parents

  if (heads.length <= 1) {
    const ids = new Set<string>()
    for (const h of heads) for (const id of ancestorsOf(doc.nodes, h)) ids.add(id)
    const history = linearize(doc.nodes, ids)
    const section =
      history.length > 0
        ? `## Conversation so far\n\n${renderSection(history, GRAPH_MAX_CONTEXT_CHARS)}`
        : '## Conversation so far\n\n(none — this is the first exchange)'
    return { system: `${GRAPH_CHAT_SYSTEM_PROMPT}\n\n${section}`, prompt: node.text, merge: false }
  }

  const part = mergePartition(doc.nodes, heads)
  // Split the budget: trunk first (shared, usually short), branches evenly.
  const trunkText = renderSection(part.trunk, Math.floor(GRAPH_MAX_CONTEXT_CHARS / 2))
  const perBranch = Math.floor(
    Math.max(GRAPH_MAX_CONTEXT_CHARS - trunkText.length, 8000) / part.branches.length
  )
  const sections = [
    `## Common trunk (shared history)\n\n${part.trunk.length > 0 ? trunkText : '(empty — the branches share no history)'}`
  ]
  part.branches.forEach((b, i) => {
    sections.push(
      `## Branch ${String.fromCharCode(65 + i)} (diverged exploration, head: ${b.head.id})\n\n${
        b.nodes.length > 0 ? renderSection(b.nodes, perBranch) : '(empty)'
      }`
    )
  })
  return {
    system: `${GRAPH_MERGE_SYSTEM_PROMPT}\n\n${sections.join('\n\n')}`,
    prompt: node.text,
    merge: true
  }
}

/** Full composed prompt for CLIs without a system flag (codex/gemini, D5). */
export function composeSinglePrompt(compiled: CompiledContext): string {
  return `${compiled.system}\n\n## Operator's message (answer this)\n\n${compiled.prompt}`
}

/** Judge-side system file: shared context + prompt + anonymized answers. */
export function buildJudgeSystem(
  compiled: CompiledContext,
  answers: { label: string; text: string }[]
): string {
  const parts = [
    GRAPH_JUDGE_SYSTEM_PROMPT,
    `## Shared context given to every candidate\n\n${compiled.system}`,
    `## The prompt every candidate answered\n\n${compiled.prompt}`
  ]
  for (const a of answers) parts.push(`## Answer ${a.label}\n\n${a.text}`)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Inference orchestration

export const DEFAULT_JUDGE: ModelTarget = { cli: 'claude', model: 'sonnet' }

export interface InferDeps {
  /** App-state dir (context files land under <stateDir>/graphs). */
  stateDir: string
  shell: string
  cwd: string
  /** Injectable for tests; defaults to runHelp with the graph timeout. */
  run?: (command: string) => Promise<string>
  /** Configured local endpoints (C29) for cli 'local' targets. */
  localProviders?: LocalProviderConfig[]
  /** Injectable for tests; defaults to runHttpInference. */
  http?: (input: HttpInferenceInput) => Promise<string>
}

export interface InferRequest {
  nodeId: string
  targets: ModelTarget[]
  battle: boolean
  judge?: ModelTarget
}

/** Fan-out horizontal spread between sibling answer nodes (canvas px). */
const FAN_X = 340
const FAN_Y = 170

/**
 * Run one inference request against `doc` IN PLACE semantics: returns a new
 * doc with the answer nodes appended (one per target; a failed target yields
 * a status:'error' node and never blocks its siblings), plus the judge node
 * when battle mode has >= 2 successful answers to arbitrate.
 */
export async function runInference(
  deps: InferDeps,
  doc: GraphDoc,
  req: InferRequest
): Promise<GraphDoc> {
  const node = doc.nodes.find((n) => n.id === req.nodeId)
  if (!node) throw new Error(`unknown node ${req.nodeId}`)
  if (node.type !== 'user') throw new Error('inference target must be a user node')
  const targets = req.targets.slice(0, 4)
  if (targets.length === 0) throw new Error('no inference target')

  const run =
    deps.run ??
    ((command: string) =>
      runHelp({ command, shell: deps.shell, cwd: deps.cwd, timeoutMs: GRAPH_INFER_TIMEOUT_MS }))
  const http = deps.http ?? runHttpInference
  const filesDir = join(deps.stateDir, 'graphs')
  const compiled = compileContext(doc, req.nodeId)

  /** One target inference: shell command for the CLIs, HTTP for 'local'. */
  const runTarget = (target: ModelTarget): Promise<string> => {
    if (target.cli === 'local') {
      const provider = (deps.localProviders ?? []).find((p) => p.id === target.providerId)
      if (!provider) {
        return Promise.reject(new Error(`unknown local provider ${target.providerId ?? '?'}`))
      }
      return http({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: target.model,
        system: compiled.system,
        prompt: compiled.prompt
      })
    }
    const content = target.cli === 'claude' ? compiled.system : composeSinglePrompt(compiled)
    const contextFile = writeContextFile(filesDir, { nodeId: node.id, cli: target.cli }, content)
    return run(buildAdapterCommand({ promptText: compiled.prompt, contextFile, target }))
  }

  const settled = await Promise.allSettled(
    targets.map((target) => {
      const started = Date.now()
      return runTarget(target).then((text) => ({ text, durationMs: Date.now() - started }))
    })
  )

  const out: GraphDoc = { ...doc, nodes: [...doc.nodes] }
  const answers: GraphNode[] = targets.map((target, i) => {
    const res = settled[i]!
    const base: GraphNode = {
      id: graphId(),
      type: 'assistant',
      parents: [node.id],
      text: '',
      x: node.x + (i - (targets.length - 1) / 2) * FAN_X,
      y: node.y + FAN_Y,
      createdAt: Date.now(),
      cli: target.cli,
      model: target.model,
      ...(target.cli === 'local' && target.providerId ? { providerId: target.providerId } : {})
    }
    if (res.status === 'fulfilled') {
      base.text = res.value.text
      base.status = 'ok'
      base.durationMs = res.value.durationMs
    } else {
      base.status = 'error'
      base.error = String(res.reason instanceof Error ? res.reason.message : res.reason).slice(
        0,
        2000
      )
      base.text = ''
    }
    return base
  })
  out.nodes.push(...answers)

  const ok = answers.filter((a) => a.status === 'ok')
  if (req.battle && ok.length >= 2) {
    const judgeTarget = req.judge ?? DEFAULT_JUDGE
    const labeled = ok.map((a, i) => ({
      label: String.fromCharCode(65 + i),
      text: a.text,
      node: a
    }))
    const judgeSystem = buildJudgeSystem(compiled, labeled)
    const content =
      judgeTarget.cli === 'claude'
        ? judgeSystem
        : `${judgeSystem}\n\n## Operator's message (answer this)\n\n${GRAPH_JUDGE_PROMPT}`
    const contextFile = writeContextFile(
      filesDir,
      { nodeId: `${node.id}-judge`, cli: judgeTarget.cli },
      content
    )
    const command = buildAdapterCommand({
      promptText: GRAPH_JUDGE_PROMPT,
      contextFile,
      target: judgeTarget
    })
    const started = Date.now()
    const judge: GraphNode = {
      id: graphId(),
      type: 'judge',
      parents: ok.map((a) => a.id),
      text: '',
      x: node.x,
      y: node.y + 2 * FAN_Y,
      createdAt: Date.now(),
      cli: judgeTarget.cli,
      model: judgeTarget.model
    }
    try {
      const text = await run(command)
      // The candidates were judged anonymized (bias); reveal the mapping in
      // the node so the operator knows which model was which.
      const legend = labeled
        .map((l) => `${l.label} = ${l.node.cli}${l.node.model ? `/${l.node.model}` : ''}`)
        .join(', ')
      judge.text = `${text}\n\n---\n${legend}`
      judge.status = 'ok'
      judge.durationMs = Date.now() - started
    } catch (err) {
      judge.status = 'error'
      judge.error = String(err instanceof Error ? err.message : err).slice(0, 2000)
    }
    out.nodes.push(judge)
  }

  out.updatedAt = Date.now()
  return out
}
