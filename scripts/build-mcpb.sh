#!/bin/bash
# Copyright (c) 2026 Robin Mordasiewicz. MIT License.

# Build MCPB bundle for F5XC Terraform MCP Server
#
# This script creates a self-contained .mcpb bundle that can be installed
# without requiring Node.js on the target machine. The bundle includes:
# - Compiled TypeScript (dist/)
# - Production dependencies (node_modules/)
# - Documentation files (docs/)
# - manifest.json
#
# Usage: ./scripts/build-mcpb.sh [--version X.Y.Z]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse arguments
VERSION=""
while [[ $# -gt 0 ]]; do
  case $1 in
  --version)
    VERSION="$2"
    shift 2
    ;;
  *)
    echo -e "${RED}Unknown option: $1${NC}"
    exit 1
    ;;
  esac
done

# Get version from package.json if not specified
if [[ -z "$VERSION" ]]; then
  VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")
fi

echo -e "${GREEN}Building MCPB bundle v${VERSION}${NC}"
echo "========================================"

# Create build directory
BUILD_DIR="$PROJECT_ROOT/build"
BUNDLE_DIR="$BUILD_DIR/f5xc-terraform-mcp"
OUTPUT_FILE="$BUILD_DIR/f5xc-terraform-mcp-${VERSION}.mcpb"

# Clean previous build
echo -e "${YELLOW}Cleaning previous build...${NC}"
rm -rf "$BUILD_DIR"
mkdir -p "$BUNDLE_DIR"

# Build TypeScript
echo -e "${YELLOW}Building TypeScript...${NC}"
cd "$PROJECT_ROOT"
npm run build

# Copy compiled code
echo -e "${YELLOW}Copying compiled code...${NC}"
cp -r "$PROJECT_ROOT/dist" "$BUNDLE_DIR/"

# Install production dependencies
echo -e "${YELLOW}Installing production dependencies...${NC}"
cp "$PROJECT_ROOT/package.json" "$BUNDLE_DIR/"
cp "$PROJECT_ROOT/package-lock.json" "$BUNDLE_DIR/"
cd "$BUNDLE_DIR"
npm ci --production --ignore-scripts

# Copy manifest
echo -e "${YELLOW}Copying manifest...${NC}"
cp "$PROJECT_ROOT/manifest.json" "$BUNDLE_DIR/"

# Copy documentation files from dist/ (populated by download-data.js)
echo -e "${YELLOW}Copying documentation files...${NC}"
if [[ -d "$PROJECT_ROOT/dist/docs" ]]; then
  cp -r "$PROJECT_ROOT/dist/docs" "$BUNDLE_DIR/docs"
  echo -e "${GREEN}Copied docs from dist/docs${NC}"
else
  echo -e "${YELLOW}Warning: dist/docs not found - run 'npm run build:docs' first${NC}"
  mkdir -p "$BUNDLE_DIR/docs"
fi

# Copy metadata files from dist/ (populated by download-data.js)
if [[ -d "$PROJECT_ROOT/dist/metadata" ]]; then
  cp -r "$PROJECT_ROOT/dist/metadata" "$BUNDLE_DIR/metadata"
  echo -e "${GREEN}Copied metadata from dist/metadata${NC}"
fi

# Copy subscription tiers from dist/
if [[ -f "$PROJECT_ROOT/dist/subscription-tiers.json" ]]; then
  cp "$PROJECT_ROOT/dist/subscription-tiers.json" "$BUNDLE_DIR/"
  echo -e "${GREEN}Copied subscription-tiers.json${NC}"
fi

# Update version in manifest
echo -e "${YELLOW}Updating version in manifest...${NC}"
cd "$BUNDLE_DIR"
node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.version = '$VERSION';
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
"

# Create the .mcpb bundle (ZIP file)
# IMPORTANT: manifest.json must be at the root of the archive for Claude Desktop drag-and-drop
echo -e "${YELLOW}Creating MCPB bundle...${NC}"
cd "$BUNDLE_DIR"
zip -r "$OUTPUT_FILE" . -x "*.DS_Store" -x "*__MACOSX*"

# Calculate SHA-256 hash
echo -e "${YELLOW}Calculating SHA-256 hash...${NC}"
HASH=$(shasum -a 256 "$OUTPUT_FILE" | cut -d' ' -f1)
echo "$HASH" >"$OUTPUT_FILE.sha256"

# Calculate bundle size
SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)

# Clean up intermediate directory
rm -rf "$BUNDLE_DIR"

# Summary
echo ""
echo -e "${GREEN}========================================"
echo "MCPB Bundle Created Successfully!"
echo "========================================"
echo ""
echo "Output: $OUTPUT_FILE"
echo "Size:   $SIZE"
echo "SHA256: $HASH"
echo ""
echo "Installation:"
echo "  1. Download the .mcpb file"
echo "  2. Double-click to install in Claude Desktop"
echo "  3. Or drag into VSCode MCP Extensions"
echo ""
echo -e "Registry SHA256 (for server.json):${NC}"
echo "  $HASH"
