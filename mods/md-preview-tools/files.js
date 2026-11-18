import { appHome, exec, readTextFile } from "herdr";

const TEXT_LIMIT = 256 * 1024;
export const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path ?? "");

export async function readPreviewFile(file, on) {
  const helper = `${appHome()}/mods/md-preview-tools/file_preview.py`;
  try {
    const script = on ? await readTextFile(helper) : null;
    if (on && !script) throw new Error("File preview helper is missing.");
    const args = on ? ["-c", script, file] : [helper, file];
    const result = await exec("python3", args, { on, timeout: 5000 });
    if (result.code !== 0) throw new Error("The file preview helper failed.");
    return JSON.parse(result.stdout);
  } catch (error) {
    if (!on) throw error;
    // A connected machine may not have Python. Keep the native UTF-8 route available.
    try {
      const text = await readTextFile(file, { on });
      if (text === null) return { kind: "error", message: "This file is no longer available." };
      if (!text.includes("\0")) {
        return { kind: "text", text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT };
      }
    } catch { /* The host text reader cannot read an arbitrary binary or large file. */ }
    return { kind: "error", message: "This remote file needs Python 3 on its machine for a bounded preview." };
  }
}

const LANG = {
  bash: "sh", c: "c", cpp: "cpp", css: "css", go: "go", h: "c", hpp: "cpp", html: "html",
  ini: "ini", js: "js", json: "json", jsonc: "json", jsx: "js", lua: "lua",
  mjs: "js", py: "python", rb: "ruby", rs: "rust", sh: "sh", sql: "sql", swift: "swift",
  toml: "toml", ts: "js", tsx: "js", xml: "xml", yaml: "yaml", yml: "yaml", zsh: "sh",
};

export function sourceLanguage(path) {
  if (isMarkdown(path)) return "markdown";
  if (/\.svg$/i.test(path)) return "xml";
  const extension = path?.split(".").pop()?.toLowerCase();
  return Object.hasOwn(LANG, extension) ? LANG[extension] : "txt";
}
