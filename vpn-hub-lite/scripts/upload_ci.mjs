/** Заливает файлы в репозиторий через GitHub API (в обход локального git). */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repo = "kot53094-creator/vless-sub";
const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const root = path.resolve("..");

const files = [
  [".github/workflows/verify.yml", path.join(root, ".github/workflows/verify.yml")],
  ["vpn-hub-lite/tools/agent/verify.mjs", path.join(root, "vpn-hub-lite/tools/agent/verify.mjs")],
];

for (const [repoPath, localPath] of files) {
  const content = readFileSync(localPath).toString("base64");
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${repoPath}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: `ci: add ${repoPath}`, content }),
  });
  const body = await response.json();
  console.log(repoPath, response.status, body.commit?.sha?.slice(0, 7) ?? body.message);
}
