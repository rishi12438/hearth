// Every test run gets its own throwaway master key, so tests never create or read ~/.hearth/master.key.
import { randomBytes } from "node:crypto";
process.env.HEARTH_MASTER_KEY ??= randomBytes(32).toString("base64");
