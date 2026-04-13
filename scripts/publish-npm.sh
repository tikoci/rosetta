#!/bin/bash
# publish-npm.sh — Publish rosetta to npm registry
# 
# This script publishes the current version to npm registry.
# It requires npm credentials to be configured (via npm login or NPM_TOKEN env var).
#
# Usage:
#   ./scripts/publish-npm.sh [--dry-run] [--registry <url>]
#
# Environment:
#   NPM_TOKEN     — npm authentication token (optional, uses ~/.npmrc by default)
#   NODE_AUTH_TOKEN — alias for NPM_TOKEN (used by some CI systems)

set -e

DRY_RUN=false
REGISTRY="https://registry.npmjs.org/"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --registry)
      REGISTRY="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--dry-run] [--registry <url>]"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== npm Publish Script for Rosetta ==="
echo

# Verify we're in the right directory
if [ ! -f "$PROJECT_ROOT/package.json" ]; then
  echo "❌ Error: package.json not found in $PROJECT_ROOT"
  exit 1
fi

VERSION=$(grep '"version"' "$PROJECT_ROOT/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
PACKAGE_NAME=$(grep '"name"' "$PROJECT_ROOT/package.json" | head -1 | sed 's/.*"name": "\([^"]*\)".*/\1/')

echo "Package: $PACKAGE_NAME"
echo "Version: $VERSION"
echo "Registry: $REGISTRY"
echo "Dry run: $DRY_RUN"
echo

# Check if already published
echo "Checking if version $VERSION already exists..."
PUBLISHED=$(npm view "$PACKAGE_NAME@$VERSION" version 2>/dev/null || echo "")

if [ "$PUBLISHED" = "$VERSION" ]; then
  echo "⚠️  Version $VERSION is already published to npm."
  echo "To republish, increment the version in package.json and try again."
  exit 1
fi

echo "✓ Version $VERSION is not yet published (ready to publish)"
echo

# Verify authentication
echo "Verifying npm authentication..."
if ! npm whoami >/dev/null 2>&1; then
  echo "❌ Error: Not authenticated to npm registry"
  echo "Please run: npm login"
  exit 1
fi

WHOAMI=$(npm whoami)
echo "✓ Authenticated as: $WHOAMI"
echo

# Double-check working tree is clean
if [ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]; then
  echo "⚠️  Warning: Working tree has uncommitted changes"
  git -C "$PROJECT_ROOT" status --short
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# Run the publish command
echo "Publishing to npm..."
cd "$PROJECT_ROOT"

if [ "$DRY_RUN" = true ]; then
  echo "(DRY RUN MODE)"
  npm publish --dry-run --access public
  echo
  echo "✓ Dry run successful. No actual publish occurred."
else
  npm publish --access public
  echo
  echo "✓ Published successfully!"
  echo
  echo "Verifying publication..."
  sleep 2
  VERIFY=$(npm view "$PACKAGE_NAME@$VERSION" version)
  if [ "$VERIFY" = "$VERSION" ]; then
    echo "✓ Verified: $PACKAGE_NAME@$VERSION is live on npm"
    echo
    echo "Users can now install with:"
    echo "  npm install -g @tikoci/rosetta"
    echo "  bunx @tikoci/rosetta"
  else
    echo "⚠️  Warning: Could not verify publication (npm registry may be syncing)"
  fi
fi

echo
echo "Done!"
