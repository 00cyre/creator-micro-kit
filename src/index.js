export { CreatorMicro } from "./device.js";
export * from "./protocol.js";

import { CreatorMicro } from "./device.js";

/** Opens the first connected Creator Micro. */
export function open(options) {
  return CreatorMicro.open(options);
}
