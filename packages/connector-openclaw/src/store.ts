/**
 * Correlates a MakerChecker `checkId` (minted by the pre-execution CHECK policy)
 * with the OpenClaw `toolCallId`, so the separate `after_tool_call` hook can pop
 * it and record the tool's outcome. A taken checkId is removed, so a replayed
 * completion for the same tool call cannot double-write an outcome.
 */
export class CheckIdStore {
  private readonly byToolCall = new Map<string, string>();

  /** Remember the checkId for a tool call. A missing toolCallId is a no-op. */
  stash(toolCallId: string | undefined, checkId: string): void {
    if (toolCallId !== undefined) {
      this.byToolCall.set(toolCallId, checkId);
    }
  }

  /** Pop the checkId for a tool call, or undefined if there is none (or already taken). */
  take(toolCallId: string | undefined): string | undefined {
    if (toolCallId === undefined) {
      return undefined;
    }
    const checkId = this.byToolCall.get(toolCallId);
    if (checkId !== undefined) {
      this.byToolCall.delete(toolCallId);
    }
    return checkId;
  }

  /** Number of outstanding checks awaiting a recorded outcome. */
  get pending(): number {
    return this.byToolCall.size;
  }
}
