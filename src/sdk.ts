export function createSessionInput(parentID: string, title: string, directory?: string) {
  return withDirectory({ body: { parentID, title } }, directory)
}

export function promptSessionInput(sessionID: string, body: Record<string, unknown>, directory?: string) {
  return withDirectory({ path: { id: sessionID }, body }, directory)
}

export function sessionPathInput(sessionID: string, directory?: string) {
  return withDirectory({ path: { id: sessionID } }, directory)
}

function withDirectory(input: Record<string, unknown>, directory?: string) {
  if (directory) input.query = { directory }
  return input
}
