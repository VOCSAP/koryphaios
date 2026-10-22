import type { Register } from 'claude-code'

import { resolveHrefs } from './guard'
import { allowedExtensions, applyLinks, findCandidates, MAX_PATHS, mustStayStock } from './linkify'
import { isSupported } from './versions'

export const register: Register = (on, options) => {
  const { allowed, refused } = allowedExtensions(options.allowed_extensions)
  let refusalLogged = false

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { text } = e.props
    if (e.surface !== 'terminal' || typeof text !== 'string') return next(e)

    let rewritten: string | undefined
    try {
      if (refused.length > 0 && !refusalLogged) {
        refusalLogged = true
        $.ui.log(`mitos: allowed_extensions entries ignored: ${refused.join(', ')}`, { to: 'debug' })
      }
      const version = await $.session.version()
      if (isSupported(version.base, 'links') && !mustStayStock(text)) {
        const candidates = findCandidates(text)
        if (candidates.length > 0) {
          const cwd = await $.session.cwd()
          const stat = (path: string) => $.fs.stat(path, { resolve: false })
          const hrefs = await resolveHrefs(candidates.map(candidate => candidate.path), { cwd, allowed, stat }, MAX_PATHS)
          if (hrefs.size > 0) rewritten = applyLinks(text, candidates, hrefs)
        }
      }
    } catch (error) {
      $.ui.log(`mitos: text left unchanged after ${String(error)}`, { to: 'debug' })
    }
    return rewritten === undefined ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
  })
}
