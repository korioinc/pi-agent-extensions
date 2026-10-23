import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSubagents } from "./src/controller/index.ts";

export default function piSubagents(pi: ExtensionAPI) {
  registerSubagents(pi);
}
