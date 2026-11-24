import satisfies from "semver/functions/satisfies.js";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSubagents } from "./src/controller/index.ts";

export default function piSubagents(pi: ExtensionAPI) {
  if (!satisfies(VERSION, ">=1.6.0 <2.0.0"))
    throw new Error(`@korioinc/pi-subagents requires Pi >=1.6.0 <2.0.0; found ${VERSION}.`);
  registerSubagents(pi);
}
