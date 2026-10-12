// Uploads the solution renderer and its fonts to the Anthropic Files API, so every request can
// mount them into Claude's code execution sandbox. Prints the file ids to store as a secret:
//   deno run -A scripts/upload-sandbox-assets.ts
//   supabase secrets set SANDBOX_FILE_IDS=<printed ids>
// Re-run (and update the secret) whenever sandbox/ changes.
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

const ids: string[] = [];
for (const path of files) {
  const bytes = await Deno.readFile(new URL(path, root));
  const name = path.split("/").pop()!;
  const type = name.endsWith(".py") ? "text/x-python" : "font/otf";
  const uploaded = await client.files.upload({ file: await toFile(bytes, name, { type }) });
  console.error(`${name} -> ${uploaded.id}`);
  ids.push(uploaded.id);
}
console.log(ids.join(","));
