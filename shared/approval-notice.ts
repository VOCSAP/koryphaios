// Wire format of the operator-sentinel notice that tells a question's asker how
// its ticket ended. The broker writes it and inbound-framing.ts recognises it,
// so both ends import this one dependency-free module.

/** The answer text is the operator's own; the id is broker-minted, so `]` follows it directly. */
export function buildAnswerNotice(id: string, title: string, answer: string): string {
  return [`[approval ${id}] ${title}`, "", answer].join("\n");
}

export interface ClosedNoticeInput {
  id: string;
  title: string;
  /** Null when the closer has no public peer_id: the authority is named instead. */
  closerPeerId: string | null;
  authority: string;
  /** Another agent's text: JSON-quoted so it can never read as a line of the notice. */
  reason: string;
}

export function buildClosedNotice(input: ClosedNoticeInput): string {
  const closer = input.closerPeerId ?? `the ${input.authority}`;
  return [
    `[approval ${input.id} closed] ${input.title}`,
    "",
    `Closed by ${closer} (${input.authority}) without an answer. Reason given: ${JSON.stringify(input.reason)}`,
  ].join("\n");
}

const CLOSED_TAG = /^\[approval [^\s\]]+ closed\] /;

/** Anchored at the start of the text: an answer notice starts `[approval <id>]`, so no title or answer can forge the tag. */
export function isClosedNotice(text: string): boolean {
  return CLOSED_TAG.test(text);
}
