import { describe, expect, it } from 'vitest'
import {
  COORDINATION_LABELS,
  DIRECT_COORDINATION_ACTIONS,
  GROUP_COORDINATION_ACTIONS,
  coordinationActionFromLabel,
  coordinationLabel,
  isDirectCoordinationAction,
  isGroupCoordinationAction,
} from './coordination.js'

describe('structured coordination actions', () => {
  it('keeps the group vocabulary deliberately small', () => {
    expect(GROUP_COORDINATION_ACTIONS).toEqual(['check_in', 'on_my_way'])
    expect(GROUP_COORDINATION_ACTIONS.map(coordinationLabel)).toEqual(['Check in', 'On my way'])
  })

  it('keeps private actions fixed, including consented Come to me', () => {
    expect(DIRECT_COORDINATION_ACTIONS).toEqual(['come_to_me', 'where_are_you', 'call_me', 'on_my_way'])
    expect(DIRECT_COORDINATION_ACTIONS.map(coordinationLabel)).toEqual([
      'Come to me',
      'Where are you?',
      'Call me',
      'On my way',
    ])
  })

  it('maps only exact provider-defined labels back to actions', () => {
    for (const [action, label] of Object.entries(COORDINATION_LABELS)) {
      expect(coordinationActionFromLabel(label)).toBe(action)
    }
    expect(coordinationActionFromLabel('meet at the corner')).toBeNull()
    expect(coordinationActionFromLabel('https://example.com')).toBeNull()
    expect(coordinationActionFromLabel('  On my way  ')).toBeNull()
  })

  it('separates group and private action sets', () => {
    expect(isGroupCoordinationAction('check_in')).toBe(true)
    expect(isGroupCoordinationAction('where_are_you')).toBe(false)
    expect(isDirectCoordinationAction('where_are_you')).toBe(true)
    expect(isDirectCoordinationAction('check_in')).toBe(false)
    expect(isDirectCoordinationAction('anything_else')).toBe(false)
  })
})
