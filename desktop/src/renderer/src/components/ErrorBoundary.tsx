import React from 'react'

// React error boundary (PLAN O4). Mounted at the root AND around each top-level
// view: the views are siblings of one tree, so without a per-view boundary a
// render throw in, say, GraphView unmounted the whole window -- terminals
// included. Deliberately NOT translated through the i18n pipeline: the boundary
// must render even when init()/i18n itself is what broke.

const isFr = (): boolean =>
  typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('fr')

interface Props {
  /** Short identifier shown in the fallback and sent to main.log ("graph", "root"…). */
  scope: string
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      window.api.reportError(
        this.props.scope,
        `render crash: ${error.message}\n${error.stack ?? ''}${info.componentStack ?? ''}`
      )
    } catch {
      // Reporting must never re-throw inside the boundary.
    }
  }

  private retry = (): void => this.setState({ error: null })

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    const fr = isFr()
    return (
      <div className="error-boundary" role="alert">
        <h2>
          {fr
            ? `Cette vue a planté (${this.props.scope})`
            : `This view crashed (${this.props.scope})`}
        </h2>
        <p className="error-boundary-detail">{this.state.error.message}</p>
        <p>
          {fr
            ? "L'erreur a été enregistrée dans le journal et le fichier de log. Le reste de la fenêtre continue de fonctionner."
            : 'The error was recorded in the journal and the log file. The rest of the window keeps running.'}
        </p>
        <button className="primary" onClick={this.retry}>
          {fr ? 'Réessayer' : 'Retry'}
        </button>
      </div>
    )
  }
}
