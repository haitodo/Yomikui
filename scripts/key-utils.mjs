import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Chromium (Edge / Chrome) の公開鍵 (SPKI DER) から 32 桁の拡張機能 ID を算出する
 *
 * Chromium の仕様:
 * 1. 公開鍵の SPKI DER バイナリの SHA-256 ハッシュを計算
 * 2. 先頭 16 バイト (128 ビット) を取り出す
 * 3. 各バイトを 4 ビットずつ (上位・下位ニブル) に分解し、0-15 を 'a'-'p' にマッピングする (計 32 文字)
 *
 * @param {Buffer | string} publicKeyDer - SPKI DER 形式の Buffer、またはその Base64 文字列
 * @returns {string} 32 文字の英小文字 (a-p)
 */
export function deriveExtensionId(publicKeyDer) {
  const buffer = Buffer.isBuffer(publicKeyDer)
    ? publicKeyDer
    : Buffer.from(publicKeyDer, "base64");

  const hash = crypto.createHash("sha256").update(buffer).digest();
  const idBytes = hash.subarray(0, 16);

  let id = "";
  for (const byte of idBytes) {
    const high = (byte >> 4) & 0x0f;
    const low = byte & 0x0f;
    id += String.fromCharCode(high + 97); // 0〜15 を 'a'〜'p' にマッピング
    id += String.fromCharCode(low + 97);
  }
  return id;
}

/**
 * システム上の Microsoft Edge または Google Chrome の実行可能ファイルを探す
 *
 * @returns {string | null}
 */
export function findChromiumBinary() {
  const candidates = [];

  if (process.platform === "win32") {
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const localAppData = process.env.LOCALAPPDATA || "";

    candidates.push(
      path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      localAppData ? path.join(localAppData, "Microsoft\\Edge\\Application\\msedge.exe") : "",
      localAppData ? path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe") : "",
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * 拡張機能の秘密鍵 (key.pem) を取得、無ければ新規生成し、
 * 公開鍵 (Base64) と 32 桁の固定拡張機能 ID を返す。
 *
 * また、ルートの manifest.json に "key" フィールドを自動的に反映する。
 *
 * @param {string} rootDir - プロジェクトルート
 * @returns {Promise<{
 *   keyPath: string;
 *   privateKeyPem: string;
 *   publicKeyBase64: string;
 *   extensionId: string;
 *   isNewKey: boolean;
 * }>}
 */
export async function ensureExtensionKey(rootDir) {
  const keyPath = path.join(rootDir, "key.pem");
  let privateKeyPem = "";
  let isNewKey = false;

  if (existsSync(keyPath)) {
    privateKeyPem = await readFile(keyPath, "utf8");
  } else {
    // RSA 2048bit の鍵ペアを生成 (PKCS#8 PEM)
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKeyPem = privateKey;
    await writeFile(keyPath, privateKeyPem, "utf8");
    isNewKey = true;
  }

  // 秘密鍵から公開鍵 (SPKI DER) を抽出
  const privateKeyObj = crypto.createPrivateKey(privateKeyPem);
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  const publicKeyDer = publicKeyObj.export({ type: "spki", format: "der" });
  const publicKeyBase64 = publicKeyDer.toString("base64");

  const extensionId = deriveExtensionId(publicKeyDer);

  // ルートの manifest.json を読み込み、"key" が設定されていない・異なる場合は更新
  const manifestPath = path.join(rootDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    if (manifest.key !== publicKeyBase64) {
      manifest.key = publicKeyBase64;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    }
  }

  return {
    keyPath,
    privateKeyPem,
    publicKeyBase64,
    extensionId,
    isNewKey,
  };
}
