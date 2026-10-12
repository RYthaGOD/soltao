import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

// Only public, finalized RPC results belong here. Never persist a provider URL or credentials.
export async function createUsageCache(directory, genesisHash, onProgress = () => {}) {
  if (typeof genesisHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{20,88}$/.test(genesisHash)) {
    throw new Error("Invalid cluster genesis hash; no count was produced");
  }
  const root = join(directory, digest(genesisHash));
  await mkdir(root, { recursive: true });
  const pathFor = (signature) => join(root, `${digest(signature)}.json`);
  return {
    async get(signature) {
      let saved;
      try { saved = JSON.parse(await readFile(pathFor(signature), "utf8")); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (saved?.version === 1 && saved.genesisHash === genesisHash
          && saved.commitment === "finalized" && saved.signature === signature && saved.tx) return saved.tx;
      onProgress(`Ignoring invalid cached transaction ${signature}; fetching again`);
      return null;
    },
    async put(signature, tx) {
      const target = pathFor(signature), temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, genesisHash,
          commitment: "finalized", signature, tx }), { flag: "wx" });
        // An interrupted write cannot replace an existing, complete transaction file.
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
