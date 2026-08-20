import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { syncCurrentHerdrIdentityAsync } from "./herdr.ts";
import { registerTalkTools } from "./service.ts";

/**
 * Standalone pi-peer extension entrypoint.
 *
 * Registers exactly three tools: `talk_sessions`, `talk_latest`, `talk_to`.
 * The runtime is Herdr-only and self-tracks busy through agent_start/agent_settled.
 * Setting `PI_PEER_DISABLED=1` disables registration entirely.
 *
 * This entrypoint is source-independent: no dependency on any host agent extension.
 */
export default function piPeerExtension(pi: ExtensionAPI): void {
  if (process.env.PI_PEER_DISABLED === "1") return;
  registerTalkTools(pi, { syncVisibleIdentity: syncCurrentHerdrIdentityAsync });
}
