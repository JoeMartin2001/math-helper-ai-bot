// Uploads the solution renderer and its fonts to the Anthropic Files API. The bot mounts the
// newest upload of each file (found by name) into Claude's code execution sandbox, so no config
// change is needed. Re-run whenever sandbox/ changes:
//   deno run -A scripts/upload-sandbox-assets.ts
// Older copies are deleted only after every new file is uploaded. A bot worker that still holds an
// old id looks the files up again when the API reports one missing.
import Anthropic, { toFile } from "npm:@anthropic-ai/sdk@0.133.0";

const client = new Anthropic();
const root = new URL("../sandbox/", import.meta.url);
const files = [
  "render_solution.py",
  "fonts/cmunrm.otf",
  "fonts/cmunbx.otf",
  "fonts/cmunti.otf",
  "fonts/cmunbi.otf",
];

const uploaded = new Set<string>();
for (const path of files) {
  const bytes = await Deno.readFile(new URL(path, root));
  const name = path.split("/").pop()!;
  const type = name.endsWith(".py") ? "text/x-python" : "font/otf";
  const file = await client.files.upload({ file: await toFile(bytes, name, { type }) });
  console.log(`uploaded ${name} -> ${file.id}`);
  uploaded.add(file.id);
}

const names = new Set(files.map((p) => p.split("/").pop()!));
for await (const f of client.files.list({ limit: 100 })) {
  if (names.has(f.filename) && !uploaded.has(f.id)) {
    await client.files.delete(f.id);
    console.log(`deleted old ${f.filename} (${f.id})`);
  }
}
