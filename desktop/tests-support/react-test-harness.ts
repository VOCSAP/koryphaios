// Imported by relative path, not a bare specifier, so root-level tests and
// desktop/src/renderer components resolve the same physical React copy despite
// desktop/ and the repo root being separate npm trees with separate
// node_modules.
// Do not remove react/react-dom/zustand from the root package.json: CI runs
// root-level tests before desktop/node_modules exists, so root's copies are the
// fallback that resolution walks up to.
// IS_REACT_ACT_ENVIRONMENT is set explicitly because react-dom checks this
// global before flushing effects synchronously inside act().
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export { act } from 'react'
export * as React from 'react'
export { createRoot, type Root } from 'react-dom/client'
export { create } from 'zustand'
