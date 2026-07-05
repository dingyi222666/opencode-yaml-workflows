import type { Part, SessionMessagesResponse, SessionPromptResponse } from "@opencode-ai/sdk/v2/client"

type Envelope<T> = T | { data?: T }

export function responseData<T>(input: Envelope<T> | undefined): T | undefined {
  if (!input) return undefined
  return isEnvelope(input) ? input.data : input
}

function isEnvelope<T>(input: Envelope<T>): input is { data?: T } {
  return typeof input === "object" && input !== null && "data" in input
}

export function responseSessionID(input: Envelope<{ id: string }> | undefined) {
  return responseData(input)?.id
}

export function responseSessionDirectory(input: Envelope<{ directory?: string }> | undefined) {
  return responseData(input)?.directory
}

export function responseSessionModel(input: Envelope<{ model?: { providerID?: string; id?: string; modelID?: string } }> | undefined) {
  const model = responseData(input)?.model
  const providerID = model?.providerID
  const modelID = model?.modelID ?? model?.id
  return providerID && modelID ? { providerID, modelID } : undefined
}

export function responsePromptText(input: Envelope<SessionPromptResponse> | undefined) {
  return lastTextPart(responseData(input)?.parts)
}

export function responseLastAssistantText(input: Envelope<SessionMessagesResponse> | undefined) {
  const messages = responseData(input) ?? []
  const lastAssistant = messages.filter((message) => message.info.role === "assistant").at(-1)
  return lastTextPart(lastAssistant?.parts)
}

function lastTextPart(parts: Part[] | undefined) {
  return parts?.filter((part) => part.type === "text").at(-1)?.text
}
