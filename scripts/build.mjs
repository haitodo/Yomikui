import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureExtensionKey } from "./key-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

/**
 * Yomikui 拡張機能を構成する静的ファイルおよびフォルダーを dist/ にコピーする
 */
const EXTENSION_FILES = new Set([
  "background.js",
  "contentDeck.js",
  "contentIframe.js",
  "mediaInterceptor.js",
]);

const EXTENSION_DIRS = ["icons", "_locales"];

export async function buildExtension() {
  const keyInfo = await ensureExtensionKey(rootDir);
  console.log(`[Yomikui] 拡張機能 ID (固定 32 桁): ${keyInfo.extensionId}`);

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  for (const fileName of EXTENSION_FILES) {
    const srcPath = path.join(rootDir, fileName);
    const destPath = path.join(distDir, fileName);
    if (existsSync(srcPath)) {
      await cp(srcPath, destPath);
    }
  }

  for (const dirName of EXTENSION_DIRS) {
    const srcDir = path.join(rootDir, dirName);
    const destDir = path.join(distDir, dirName);
    if (existsSync(srcDir)) {
      await cp(srcDir, destDir, { recursive: true });
    }
  }

  // ルート直下に追加された .js / .css / .html ファイルを自動検出してコピー
  const rootFiles = await readdir(rootDir);
  for (const file of rootFiles) {
    if (
      (file.endsWith(".js") || file.endsWith(".css") || file.endsWith(".html")) &&
      !EXTENSION_FILES.has(file)
    ) {
      const srcPath = path.join(rootDir, file);
      const fileStat = await stat(srcPath);
      if (fileStat.isFile()) {
        await cp(srcPath, path.join(distDir, file));
      }
    }
  }

  // manifest.json に公開鍵 (key) を埋め込んで dist 向けに出力
  const manifestRaw = await readFile(path.join(rootDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  if (keyInfo.publicKeyBase64) {
    manifest.key = keyInfo.publicKeyBase64;
  }
  await writeFile(
    path.join(distDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  console.log(`[Yomikui] 展開用フォルダーを生成しました -> ${distDir}`);
  return keyInfo;
}

// CLI から直接実行された場合のみビルドを実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildExtension().catch((err) => {
    console.error("[Yomikui] ビルド中にエラーが発生しました:", err);
    process.exit(1);
  });
}
