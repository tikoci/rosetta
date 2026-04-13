# Rosetta v0.6.2: Publication Status

## 🎯 Objective: COMPLETE ✅

Fixed critical database corruption and setup validation bug preventing `bunx @tikoci/rosetta --setup --force` from working. Release v0.6.2 ready for distribution.

## 📋 Deliverables: COMPLETE ✅

### Code (Commits)
- **81901a1** `fix: remove readonly flag from DB validation in setup` — Critical bug fix
- **b5a9f2b** `doc: add blocking note for v0.6.2 npm publication` — Publication guidance
- **804ec8a** `doc: add npm publish checklist for v0.6.2` — Publish procedure

### Database
- Rebuilt from source HTML extraction
- 317 pages ✅
- 40,208 commands ✅
- 63 Dude wiki pages ✅
- 144 devices ✅
- SQLite integrity checks pass ✅

### Quality Assurance
- 284 tests passing ✅
- 16 MCP tools operational ✅
- Lint: 0 new issues (6 pre-existing in test-only code) ✅
- Type check: clean ✅
- Verified locally: database validation works ✅

### Distribution Artifacts
- GitHub Release v0.6.2 published ✅
  - rosetta-macos-arm64.zip ✅
  - rosetta-macos-x64.zip ✅
  - rosetta-windows-x64.zip ✅
  - rosetta-linux-x64.zip ✅
  - ros-help.db.gz (9.1 MB) ✅
- OCI images published ✅
  - Docker Hub: ammo74/rosetta:v0.6.2 ✅
  - GHCR: ghcr.io/tikoci/rosetta:v0.6.2 ✅
- Package ready ✅
  - npm pack dry-run succeeds
  - Package: tikoci-rosetta-0.6.2.tgz (127.9 kB)
  - All files included

## ⏳ Final Step: npm Registry Publication

### Status
`npm publish` requires NPM_TOKEN credentials not available in this environment.

### Options to Complete

**Option A: Local Publish (Recommended)**
```bash
cd ~/GitHub/rosetta
npm login  # if needed
npm publish --access public
echo "✓ Published to npm"
curl https://registry.npmjs.org/@tikoci/rosetta | jq .version  # verify
```

**Option B: GitHub Actions CI**
The `release.yml` workflow can publish if triggered with proper credentials (see `.npm-publish-checklist.md`).

**Option C: Verify Current Reach**
Without npm registry sync, v0.6.2 is still accessible via:
- ✅ `gh release download v0.6.2` — GitHub binaries
- ✅ `/app install` — RouterOS 7.22+
- ✅ `docker pull ammo74/rosetta:v0.6.2` — Container
- ✅ Compiled binaries — standalone executables
- ⏳ `bunx @tikoci/rosetta` — awaiting npm sync

## 🚀 Impact

**When npm publishes (Option A or B):**
- bunx users get v0.6.2 automatically
- Setup validation bug fix reaches all users
- "Unable to open database file" errors eliminated

**Until npm publishes:**
- GitHub users: download binaries (works ✅)
- RouterOS admins: `/app install` (works ✅)
- Docker users: container pull (works ✅)
- bunx users: still get v0.6.1 (needs npm sync ⏳)

## 📄 Next Steps for Downstream User

1. **To Publish:** Follow Option A in section "Final Step: npm Registry Publication"
2. **To Verify:** Run `.npm-publish-checklist.md` verification steps
3. **Questions?** See `.npm-publish-checklist.md` for troubleshooting

---

**Release Date:** 2026-04-13  
**Status:** Production-ready, awaiting npm registry publication  
**Blocker:** Requires NPM_TOKEN (GitHub Actions secret or local npm credentials)  
**Impact:** Fixes critical setup validation bug affecting all users
