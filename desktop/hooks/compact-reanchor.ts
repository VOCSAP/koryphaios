export interface CompactTileIdentity {
  peerId: string;
  groupId: string;
  role: string;
}

export interface CompactPeer {
  peer_id: string;
  group_id: string;
  role: string | null;
}

const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

const PREFIX = "Une compaction du contexte vient d'avoir lieu.";
const RESUME_TASK = "Si le résumé indique une tâche en cours, reprends-la et rends compte par `send_message` à qui te l'a confiée.";
const NO_LEAD = `${RESUME_TASK} Sinon, aucun team-lead joignable ; appelle \`list_peers\` puis attends un brief.`;

export function buildCompactReanchorContext(tile: CompactTileIdentity, peers: readonly CompactPeer[] | null): string {
  if (tile.role === "team-lead") {
    return `${PREFIX} Tu es le team-lead : appelle \`check_messages\`, puis \`list_peers\`, puis reprends ta file.`;
  }

  const leads = (peers ?? []).filter(
    (peer) => peer.group_id === tile.groupId && peer.role === "team-lead" && PEER_ID_REGEX.test(peer.peer_id),
  );
  if (leads.length !== 1) {
    return leads.length === 0
      ? NO_LEAD
      : `${RESUME_TASK} Sinon, ne choisis pas de team-lead ; appelle \`list_peers\` et demande lequel coordonne.`;
  }

  return `${RESUME_TASK} Sinon, avant toute autre action, appelle \`send_message\` avec \`to_peer_id\` égal à \`${leads[0]!.peer_id}\` et demande un brief de reprise.`;
}

export async function reanchorAfterCompaction(
  tile: CompactTileIdentity,
  listPeers: () => Promise<readonly CompactPeer[]>,
  trace: (message: string) => void,
): Promise<string> {
  try {
    return buildCompactReanchorContext(tile, await listPeers());
  } catch (error) {
    trace(`Kory compact reanchor: broker lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return buildCompactReanchorContext(tile, null);
  }
}

export async function fetchCompactGroupPeers(
  endpoint: { url: string; token: string | null },
  instanceToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CompactPeer[]> {
  const response = await fetchImpl(`${endpoint.url}/list-peers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    },
    body: JSON.stringify({ scope: "machine", instance_token: instanceToken }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Broker error (/list-peers): ${response.status} ${await response.text()}`);

  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("Broker error (/list-peers): malformed response");
  return body.filter(
    (peer): peer is CompactPeer =>
      typeof peer === "object" &&
      peer !== null &&
      typeof (peer as CompactPeer).peer_id === "string" &&
      typeof (peer as CompactPeer).group_id === "string" &&
      ((peer as CompactPeer).role === null || typeof (peer as CompactPeer).role === "string"),
  );
}
