import { execFileSync, execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureExtensionKey, findChromiumBinary } from "./key-utils.mjs";
import { buildExtension } from "./build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const releaseDir = path.join(rootDir, "release");

/**
 * バイト数を読みやすい単位にフォーマットする
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * ディレクトリ内容を ZIP アーカイブに圧縮する (tar または Compress-Archive)
 */
function createZip(sourceDir, targetZipPath) {
  if (existsSync(targetZipPath)) {
    try {
      execSync(`del /f /q "${targetZipPath}"`, { stdio: "ignore", shell: "cmd.exe" });
    } catch {}
  }

  try {
    // Windows 10/11 搭載の tar.exe (高速)
    execSync(`tar -a -c -f "${targetZipPath}" -C "${sourceDir}" .`, { stdio: "pipe" });
  } catch {
    // PowerShell Compress-Archive (フォールバック)
    const psCmd = `Compress-Archive -Path "${path.join(sourceDir, "*")}" -DestinationPath "${targetZipPath}" -Force`;
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: "inherit" });
  }
}

async function main() {
  console.log("======================================================================");
  console.log("   Yomikui - 拡張機能パッケージ化 (CRX / ZIP 生成)");
  console.log("======================================================================\n");

  // 1. 署名鍵の確認・取得
  const keyInfo = await ensureExtensionKey(rootDir);
  console.log(`[1/4] 拡張機能 ID (固定 32 桁):`);
  console.log(`      ${keyInfo.extensionId}`);
  if (keyInfo.isNewKey) {
    console.log(`      ※ 新しい署名鍵 (key.pem) をプロジェクトルートに生成しました。`);
    console.log(`      ※ この秘密鍵を保持することで、拡張機能 ID が永続的に固定されます。`);
  } else {
    console.log(`      ※ 既存の秘密鍵 (key.pem) を使用して同一 ID を維持します。`);
  }

  // 2. 最新コードを展開フォルダー (dist) にビルド
  console.log(`\n[2/4] 最新コードを展開フォルダー (dist) に配置しています...`);
  await buildExtension();

  const manifestRaw = await readFile(path.join(rootDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  const version = manifest.version || "1.0.0";

  await mkdir(releaseDir, { recursive: true });

  // 3. 署名済み CRX パッケージの作成
  console.log(`\n[3/4] 署名済み CRX パッケージ (.crx) を生成中...`);
  const chromiumBin = findChromiumBinary();
  const crxName = `yomikui-v${version}.crx`;
  const finalCrxPath = path.join(releaseDir, crxName);
  let crxCreated = false;

  if (chromiumBin) {
    try {
      console.log(`      ブラウザ実行ファイルを検出: ${path.basename(chromiumBin)}`);
      // Chromium の --pack-extension は親ディレクトリに <フォルダー名>.crx (dist.crx) を出力する
      const tempCrxOutput = path.join(rootDir, "dist.crx");
      if (existsSync(tempCrxOutput)) {
        await rm(tempCrxOutput, { force: true });
      }

      try {
        execFileSync(chromiumBin, [
          `--pack-extension=${distDir}`,
          `--pack-extension-key=${keyInfo.keyPath}`,
          "--no-message-box",
        ]);
      } catch {
        // Chromium CLI が非同期で別プロセスに委譲することがあるためエラーを無視して待機確認
      }

      let waitCount = 0;
      while (!existsSync(tempCrxOutput) && waitCount < 15) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        waitCount++;
      }

      if (existsSync(tempCrxOutput)) {
        if (existsSync(finalCrxPath)) {
          await rm(finalCrxPath, { force: true });
        }
        await cp(tempCrxOutput, finalCrxPath);
        await rm(tempCrxOutput, { force: true });
        crxCreated = true;
        const crxSize = statSync(finalCrxPath).size;
        console.log(`      -> 署名済み CRX 作成完了: release/${crxName} (${formatBytes(crxSize)})`);
      } else {
        console.warn(`      [注意] CRX の出力ファイルが検出されませんでした (ブラウザ側での生成をスキップ)`);
      }
    } catch (crxErr) {
      console.warn(`      [注意] ブラウザによる CRX 自動生成をスキップしました: ${crxErr.message}`);
    }
  } else {
    console.log(`      [情報] Edge / Chrome の実行バイナリが見つかりませんでした (CRX 自動生成をスキップ)`);
  }

  // 4. 配布用 ZIP アーカイブ作成
  console.log(`\n[4/4] 配布用 ZIP パッケージを生成中...`);

  // 4-A. 展開読み込み用 ZIP (key 埋め込み済み。解凍して「展開して読み込み」すれば同一 ID で動作)
  const zipName = `yomikui-v${version}.zip`;
  const unpackedZipName = `yomikui-v${version}-unpacked.zip`;
  const targetZipPath = path.join(releaseDir, zipName);
  const targetUnpackedZipPath = path.join(releaseDir, unpackedZipName);

  createZip(distDir, targetZipPath);
  await cp(targetZipPath, targetUnpackedZipPath);
  const zipSize = statSync(targetZipPath).size;
  console.log(`      -> 展開読み込み用 ZIP 作成完了: release/${zipName} (${formatBytes(zipSize)})`);

  // 4-B. Chrome Web Store / Edge Add-ons 提出用 ZIP ("key" プロパティを除外した標準パッケージ)
  const storeZipName = `yomikui-v${version}-store.zip`;
  const storeZipPath = path.join(releaseDir, storeZipName);
  const tempStoreDir = path.join(releaseDir, ".tmp-store-pkg");

  try {
    if (existsSync(tempStoreDir)) {
      await rm(tempStoreDir, { recursive: true, force: true });
    }
    await cp(distDir, tempStoreDir, { recursive: true });

    // store 用 manifest から "key" を削除 (ストア審査ポリシーで禁止されているため)
    const storeManifestPath = path.join(tempStoreDir, "manifest.json");
    if (existsSync(storeManifestPath)) {
      const storeManifestObj = JSON.parse(await readFile(storeManifestPath, "utf8"));
      delete storeManifestObj.key;
      await writeFile(storeManifestPath, JSON.stringify(storeManifestObj, null, 2) + "\n", "utf8");
    }

    createZip(tempStoreDir, storeZipPath);
    const storeZipSize = statSync(storeZipPath).size;
    console.log(`      -> ストア提出用 ZIP 作成完了: release/${storeZipName} (${formatBytes(storeZipSize)})`);
  } finally {
    if (existsSync(tempStoreDir)) {
      await rm(tempStoreDir, { recursive: true, force: true });
    }
  }

  console.log("\n======================================================================");
  console.log("   ★ パッケージ化が正常に完了しました！");
  console.log("======================================================================");
  console.log(`  【拡張機能 ID】  : ${keyInfo.extensionId}`);
  console.log(`  【バージョン】    : v${version}`);
  console.log(`  【出力フォルダー】: ${releaseDir}`);
  console.log("");
  console.log("  生成物一覧:");
  if (crxCreated) {
    console.log(`    1. release/${crxName}`);
    console.log("       -> Edge / Chrome にドラッグ＆ドロップして即座にインストール可能");
  }
  console.log(`    2. release/${zipName} (または ${unpackedZipName})`);
  console.log("       -> 展開して読み込み用 (誰がどこで解凍しても同一の 32 桁 ID を維持)");
  console.log(`    3. release/${storeZipName}`);
  console.log("       -> Chrome Web Store / Edge アドオン ダッシュボード提出用 (key 除外)");
  console.log(`    4. key.pem (${keyInfo.isNewKey ? "新規作成" : "保持中"})`);
  console.log("       -> 署名用の秘密鍵です (Git非公開)。この鍵を保持することで、");
  console.log("          次回以降のパッケージ化時も拡張機能 ID が永久に変わりません！");
  console.log("======================================================================\n");
}

main().catch((err) => {
  console.error("\n[エラー] パッケージ化中にエラーが発生しました:", err);
  process.exit(1);
});
