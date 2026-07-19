/**
 * The complete human-to-human vocabulary Flock carries.
 *
 * These are protocol actions, not caller-provided messages. Labels are rendered
 * locally and retained on the wire only as a compatibility field for older
 * clients. Exact reverse mapping lets current clients migrate old fixed-label
 * payloads without accepting arbitrary text.
 */
export const COORDINATION_LABELS = {
  check_in: 'Check in',
  on_my_way: 'On my way',
  where_are_you: 'Where are you?',
  call_me: 'Call me',
  come_to_me: 'Come to me',
} as const

export type CoordinationAction = keyof typeof COORDINATION_LABELS
export type CoordinationLabel = (typeof COORDINATION_LABELS)[CoordinationAction]

export const GROUP_COORDINATION_ACTIONS = ['check_in', 'on_my_way'] as const
export type GroupCoordinationAction = (typeof GROUP_COORDINATION_ACTIONS)[number]

export const DIRECT_COORDINATION_ACTIONS = ['come_to_me', 'where_are_you', 'call_me', 'on_my_way'] as const
export type DirectCoordinationAction = (typeof DIRECT_COORDINATION_ACTIONS)[number]

const GROUP_ACTION_SET: ReadonlySet<string> = new Set(GROUP_COORDINATION_ACTIONS)
const DIRECT_ACTION_SET: ReadonlySet<string> = new Set(DIRECT_COORDINATION_ACTIONS)

export function coordinationLabel(action: CoordinationAction): CoordinationLabel {
  return COORDINATION_LABELS[action]
}

/** Exact by design: whitespace, URLs, and caller-defined prose are not actions. */
export function coordinationActionFromLabel(label: unknown): CoordinationAction | null {
  if (typeof label !== 'string') return null
  for (const action of Object.keys(COORDINATION_LABELS) as CoordinationAction[]) {
    if (COORDINATION_LABELS[action] === label) return action
  }
  return null
}

export function isGroupCoordinationAction(value: unknown): value is GroupCoordinationAction {
  return typeof value === 'string' && GROUP_ACTION_SET.has(value)
}

export function isDirectCoordinationAction(value: unknown): value is DirectCoordinationAction {
  return typeof value === 'string' && DIRECT_ACTION_SET.has(value)
}
