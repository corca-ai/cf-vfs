/**
 * One replacement inside a document's text, in UTF-16 code units.
 *
 * Offsets are against the text as it was when the edit list was produced, and
 * edits are sorted by original offset and do not overlap. Apply from last to
 * first when mutating text directly, or use applyTextEdits on the original text.
 */
export interface TextEdit {
  readonly offset: number;
  readonly remove: number;
  readonly insert: string;
}

/**
 * A document whose text several writers are changing at once.
 *
 * This is the seam where a CRDT or OT implementation plugs in. Nothing here
 * ships one: the choice has real consequences for a Worker — Yjs is JavaScript
 * while Loro and Automerge are Wasm — and it belongs to the application rather
 * than to a filesystem.
 */
export interface CollaborativeDocument {
  /** The text as it stands now, including changes not yet published. */
  text(): string;
  /**
   * Applies a change that came from outside the editing session — a shell
   * command, another caller, a restored backup.
   *
   * The point of receiving edits rather than a whole replacement is that a
   * document merges them: a `sed -i` that arrives while someone is typing
   * lands as their neighbour's edit would, instead of discarding it.
   */
  applyExternal(edits: readonly TextEdit[]): void;
}

/** What the registry knows about one open document. */
export interface OpenDocument {
  readonly path: string;
  readonly document: CollaborativeDocument;
  /**
   * The mutation token this document was last published at, and therefore the
   * guard its next publication uses.
   *
   * It is also how a notification is recognized as this registry's own work:
   * a `vfs.mutation` carrying this token is the publication that produced it.
   */
  readonly token: string;
  /** Whether the document holds text that has not been published. */
  readonly dirty: boolean;
  readonly version: number;
  readonly publishedText: string;
  readonly needsRefresh: boolean;
}
