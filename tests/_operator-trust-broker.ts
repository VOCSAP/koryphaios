import { deriveOperatorId } from "../shared/approval.ts";

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * Wraps a fake broker with the two routes the Deck calls before minting a
 * token: GET /health advertising a ready operator trust handshake, and the
 * signed POST /operator/check answering with the operator id derived from the
 * key that signed. Every other request reaches `inner` untouched, so a test's
 * own request log never sees the diagnostic step.
 */
export function withOperatorTrustBroker(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
    if (url.endsWith("/operator/check")) {
      const body = JSON.parse(String(init?.body)) as { public_key?: unknown };
      if (typeof body.public_key !== "string") {
        return new Response(JSON.stringify({ error: "public_key required" }), { status: 400, headers: JSON_HEADERS });
      }
      return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
}
