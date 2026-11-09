import { createLinkIndex } from "./mcp-daemon-links.ts";
import type { FamilyFactory } from "./mcp-daemon-server.ts";
import { createPeersFamily, type PeersFamilyDeps } from "./peers-family.ts";
import { createRoadmapFamily } from "./roadmap-server.ts";

export interface DaemonFamiliesOptions {
  peers?: Omit<PeersFamilyDeps, "links">;
  roadmapHome?: string;
}

/** Both families of the daemon, over the one link index that lets the roadmap read the identity of the peers session. */
export function daemonFamilies({ peers, roadmapHome }: DaemonFamiliesOptions = {}): { roadmap: FamilyFactory; peers: FamilyFactory } {
  const links = createLinkIndex();
  return { roadmap: createRoadmapFamily(links, roadmapHome), peers: createPeersFamily({ ...peers, links }) };
}
