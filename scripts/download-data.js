#!/usr/bin/env node
/**
 * Download MCP data from terraform-provider-f5xc GitHub releases
 *
 * Downloads documentation, OpenAPI specs, and metadata from the provider
 * release artifacts for bundling into the npm package.
 *
 * Usage:
 *   node scripts/download-data.js
 *   node scripts/download-data.js --version 3.24.0
 *   PROVIDER_VERSION=3.24.0 node scripts/download-data.js
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Configuration
 */
const CONFIG = {
  /** GitHub repository for the Terraform provider */
  GITHUB_REPO: "f5xc-salesdemos/terraform-provider-f5xc",

  /** GitHub API base for releases */
  GITHUB_API_BASE: "https://api.github.com/repos/f5xc-salesdemos/terraform-provider-f5xc/releases",

  /** Project root (parent of scripts/) */
  PROJECT_ROOT: join(__dirname, ".."),

  /** Destination directory for extracted data */
  DIST_DIR: join(__dirname, "..", "dist"),

  /** Temporary download file */
  TEMP_TARBALL: join(__dirname, "..", ".tmp-mcp-data.tar.gz"),

  /** Expected directories after extraction */
  EXPECTED_DIRS: ["docs", "metadata"],

  /** Request timeout in milliseconds */
  TIMEOUT: 120_000,

  /** User agent for GitHub API */
  USER_AGENT: "f5xc-terraform-mcp/download-data",
};

/**
 * Logger with prefixed output
 */
const log = {
  info: (message) => console.log(`[INFO] ${message}`),
  warn: (message) => console.warn(`[WARN] ${message}`),
  error: (message) => console.error(`[ERROR] ${message}`),
  success: (message) => console.log(`[OK] ${message}`),
};

/**
 * Parse command-line arguments for --version flag
 *
 * @returns {string|null} The version string if provided, null otherwise
 */
function parseCliVersion() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  if (versionIndex !== -1 && versionIndex + 1 < args.length) {
    return args[versionIndex + 1];
  }
  return null;
}

/**
 * Read version from package.json
 *
 * @returns {string} The version from package.json
 */
function readPackageVersion() {
  const packagePath = join(CONFIG.PROJECT_ROOT, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error(`package.json not found at ${packagePath}`);
  }
  const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
  if (!pkg.version) {
    throw new Error("No version field in package.json");
  }
  return pkg.version;
}

/**
 * Resolve the provider version using priority: CLI > env > package.json
 *
 * @returns {string} The resolved version
 */
function resolveVersion() {
  const cliVersion = parseCliVersion();
  if (cliVersion) {
    log.info(`Using CLI version: ${cliVersion}`);
    return cliVersion;
  }

  const envVersion = process.env.PROVIDER_VERSION;
  if (envVersion) {
    log.info(`Using PROVIDER_VERSION env: ${envVersion}`);
    return envVersion;
  }

  const pkgVersion = readPackageVersion();
  log.info(`Using package.json version: ${pkgVersion}`);
  return pkgVersion;
}

/**
 * Build request headers for GitHub API calls
 *
 * @param {string} accept - The Accept header value
 * @returns {Record<string, string>} Headers object
 */
function buildHeaders(accept) {
  const headers = {
    "User-Agent": CONFIG.USER_AGENT,
    Accept: accept,
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  return headers;
}

/**
 * Make an HTTPS request and return the response body as a string
 *
 * Follows 301/302 redirects automatically.
 *
 * @param {string} url - The URL to fetch
 * @param {Record<string, string>} headers - Request headers
 * @returns {Promise<string>} The response body
 */
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers,
      timeout: CONFIG.TIMEOUT,
    };

    const request = https.request(options, (response) => {
      // Follow redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          httpsGet(redirectUrl, headers).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        // Consume body so the socket can be freed
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage} (${url})`));
        return;
      }

      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => resolve(data));
    });

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Request timed out: ${url}`));
    });

    request.end();
  });
}

/**
 * Download a file from URL to a local path, following redirects
 *
 * @param {string} url - The URL to download
 * @param {string} destPath - Local file path for the download
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const headers = buildHeaders("application/octet-stream");
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers,
      timeout: CONFIG.TIMEOUT,
    };

    const file = createWriteStream(destPath);

    const request = https.request(options, (response) => {
      // Follow redirects (GitHub uses 302 for asset downloads)
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          log.info("Following redirect...");
          file.close();
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        file.close();
        rmSync(destPath, { force: true });
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }

      const contentLength = response.headers["content-length"];
      if (contentLength) {
        log.info(`Download size: ${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(2)} MB`);
      }

      response.pipe(file);

      file.on("finish", () => {
        file.close();
        resolve();
      });

      file.on("error", (err) => {
        file.close();
        rmSync(destPath, { force: true });
        reject(err);
      });
    });

    request.on("error", (err) => {
      file.close();
      rmSync(destPath, { force: true });
      reject(err);
    });

    request.on("timeout", () => {
      request.destroy();
      file.close();
      rmSync(destPath, { force: true });
      reject(new Error("Download timed out"));
    });

    request.end();
  });
}

/**
 * Fetch release information from GitHub API
 *
 * Tries the tagged release first, then falls back to latest.
 *
 * @param {string} version - The version tag to look for (without 'v' prefix)
 * @returns {Promise<object>} The GitHub release JSON
 */
async function fetchRelease(version) {
  const taggedUrl = `${CONFIG.GITHUB_API_BASE}/tags/v${version}`;
  const latestUrl = `${CONFIG.GITHUB_API_BASE}/latest`;
  const headers = buildHeaders("application/vnd.github.v3+json");

  // Try tagged release first
  log.info(`Fetching release for tag v${version}...`);
  try {
    const body = await httpsGet(taggedUrl, headers);
    const release = JSON.parse(body);
    log.success(`Found tagged release: ${release.tag_name} (${release.name || ""})`);
    return release;
  } catch (err) {
    log.warn(`Tagged release v${version} not found: ${err.message}`);
  }

  // Fall back to latest
  log.info("Falling back to latest release...");
  try {
    const body = await httpsGet(latestUrl, headers);
    const release = JSON.parse(body);
    log.success(`Found latest release: ${release.tag_name} (${release.name || ""})`);
    return release;
  } catch (err) {
    throw new Error(`Failed to fetch any release: ${err.message}`);
  }
}

/**
 * Find the mcp-data tarball asset in a release
 *
 * @param {object} release - The GitHub release object
 * @returns {object} The matching asset object
 */
function findDataAsset(release) {
  if (!release.assets || !Array.isArray(release.assets)) {
    throw new Error("Release has no assets");
  }

  // Look for mcp-data-{version}.tar.gz pattern
  const asset = release.assets.find((a) => a.name.startsWith("mcp-data-") && a.name.endsWith(".tar.gz"));

  if (!asset) {
    const available = release.assets.map((a) => a.name).join(", ");
    throw new Error(
      `No mcp-data-*.tar.gz asset found in release ${release.tag_name}. ` +
        `Available assets: ${available || "none"}`
    );
  }

  return asset;
}

/**
 * Extract a tarball to the destination directory, stripping the mcp-data/ prefix
 *
 * @param {string} tarballPath - Path to the .tar.gz file
 * @param {string} destDir - Directory to extract into
 */
function extractTarball(tarballPath, destDir) {
  log.info(`Extracting to ${destDir}...`);

  // Ensure destination exists
  mkdirSync(destDir, { recursive: true });

  // Extract with --strip-components=1 to remove the mcp-data/ prefix
  try {
    execSync(`tar -xzf "${tarballPath}" --strip-components=1 -C "${destDir}"`, {
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    throw new Error(`tar extraction failed: ${stderr || err.message}`);
  }
}

/**
 * Count files in a directory recursively
 *
 * @param {string} dir - Directory to count files in
 * @returns {number} Total file count
 */
function countFiles(dir) {
  if (!existsSync(dir)) {
    return 0;
  }

  let count = 0;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      count += countFiles(fullPath);
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Verify the extracted content has the expected structure
 *
 * @param {string} destDir - The directory to verify
 */
function verifyExtraction(destDir) {
  log.info("Verifying extracted content...");

  const missing = [];
  for (const expected of CONFIG.EXPECTED_DIRS) {
    const dirPath = join(destDir, expected);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      missing.push(expected);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Extraction verification failed: missing expected directories: ${missing.join(", ")}. ` +
        `Contents of ${destDir}: ${existsSync(destDir) ? readdirSync(destDir).join(", ") : "(not found)"}`
    );
  }

  // Log what was extracted
  for (const expected of CONFIG.EXPECTED_DIRS) {
    const dirPath = join(destDir, expected);
    const fileCount = countFiles(dirPath);
    log.success(`  ${expected}/: ${fileCount} files`);
  }
}

/**
 * Remove temporary files
 */
function cleanup() {
  if (existsSync(CONFIG.TEMP_TARBALL)) {
    rmSync(CONFIG.TEMP_TARBALL, { force: true });
    log.info("Cleaned up temporary files");
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log("=".repeat(60));
  console.log("Download MCP Data from terraform-provider-f5xc");
  console.log(`Source: github.com/${CONFIG.GITHUB_REPO}`);
  console.log("=".repeat(60));

  try {
    // 1. Resolve version
    const version = resolveVersion();

    // 2. Fetch release info from GitHub
    const release = await fetchRelease(version);

    // 3. Find the mcp-data tarball asset
    const asset = findDataAsset(release);
    log.info(`Asset: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(2)} MB)`);

    // 4. Download the tarball
    log.info(`Downloading ${asset.name}...`);
    await downloadFile(asset.browser_download_url, CONFIG.TEMP_TARBALL);
    log.success("Download completed");

    // 5. Clean existing dist/ content that will be replaced
    if (existsSync(CONFIG.DIST_DIR)) {
      for (const expected of CONFIG.EXPECTED_DIRS) {
        const dirPath = join(CONFIG.DIST_DIR, expected);
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true });
        }
      }
    }

    // 6. Extract tarball to dist/
    extractTarball(CONFIG.TEMP_TARBALL, CONFIG.DIST_DIR);

    // 7. Verify extraction
    verifyExtraction(CONFIG.DIST_DIR);

    // 8. Clean up temp files
    cleanup();

    // Summary
    const totalFiles = CONFIG.EXPECTED_DIRS.reduce((sum, dir) => {
      return sum + countFiles(join(CONFIG.DIST_DIR, dir));
    }, 0);

    console.log("");
    console.log("=".repeat(60));
    console.log("Download Summary:");
    console.log(`  Source:    github.com/${CONFIG.GITHUB_REPO}`);
    console.log(`  Release:   ${release.tag_name}`);
    console.log(`  Asset:     ${asset.name}`);
    console.log(`  Extracted: ${totalFiles} files to dist/`);
    console.log("=".repeat(60));
  } catch (err) {
    cleanup();
    log.error(err.message);
    process.exit(1);
  }
}

main();
