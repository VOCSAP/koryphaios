---
paths:
  - "**/SKILL.md"
---

# Writing a skill description and body

- A request the skill must REDIRECT goes into the triggers ("and when asked to X, which does not exist yet"); a "NOT for X" clause is only for requests that must not invoke the skill at all.
  Why: "NOT for creating a named lot" left the skill uninvoked on exactly that request; rewording it as a trigger made the same prompt invoke it.
- The description says when to call the skill ("Use before calling roadmap_add to file ONE new card") and the operator's trigger phrases, not what it delegates to.
  Why: a description selling delegation gave a capable lead no reason to call it.
- Take examples from an area unrelated to the inputs the skill will see, and never reuse an id or title from a test fixture.
  Why: an example on the fixture's topic was copied into the output, and a matching id leaks the answer.
- Name the forbidden workaround and the sanctioned alternative together, and state that a refusal is never routed around.
  Why: an encoding workaround and a CLI fallback both stopped only once the skill named them.
- Describe content the agent must write in another language; do not quote an English line for it to paste.
  Why: quoted English ended up verbatim in French cards.
- Test a `desktop/deck-plugin` skill in a new `claude -p` session started with `--plugin-dir desktop/deck-plugin` and `--output-format stream-json --verbose`.
  Why: skills are discovered at session start, plugin skills only with that flag, and only stream-json shows whether the Skill tool was called.
