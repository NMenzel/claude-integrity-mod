// Session state the Integrity pane draws from. The canonical task, evidence and
// finding data lives in the engine and `$.store`; `rev` is bumped on every
// change so drawings subscribed to it redraw, and `ui` is the pane's own focus,
// kept apart from evidence so a redraw never loses the person's place.

export type IntegrityTab = 'overview' | 'requirements' | 'evidence' | 'findings' | 'claims' | 'activity' | 'report'

export type IntegrityUi = {
  tab: IntegrityTab
  /** The id of the requirement, evidence, finding or claim opened for detail. */
  selected?: string
  /** The finding whose waiver reason is being typed. */
  waiving?: string
  page: number
  /** The last message of a pane action (exported to ..., waived ...). */
  flash?: string
}

declare module 'claude-code' {
  interface PluginState {
    'integrity': { rev: number; ui: IntegrityUi }
  }
}
