import type { ScopedMemory } from './vault.ts'

/**
 * The system prompt the vault sends (encrypted) to the model: the app's own instructions, then the
 * memories from the scopes the user granted. The app never receives this text — only the reply.
 */
export function buildSystemPrompt(opts: { appName: string; appSystem?: string; memories: ScopedMemory[] }): string {
  const lines = [
    opts.appSystem?.trim() || `You are a helpful assistant inside ${opts.appName}.`,
    '',
    `The user keeps a private, encrypted memory and has shared some of it with ${opts.appName}.`,
    'Use these memories when they are relevant. Do not list them back unless the user asks.',
  ]
  if (opts.memories.length) {
    lines.push('', 'Shared memories:')
    for (const m of opts.memories) lines.push(`- [${m.scope}] ${m.text.replace(/\s+/g, ' ')}`)
  } else {
    lines.push('', 'No memories are shared for this request.')
  }
  return lines.join('\n')
}
