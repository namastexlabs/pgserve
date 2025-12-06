# ==========================================
# 📦 pgserve - Embedded PostgreSQL Server
# ==========================================

.DEFAULT_GOAL := help
SHELL := /bin/bash

# Colors
GREEN := $(shell tput setaf 2)
YELLOW := $(shell tput setaf 3)
RED := $(shell tput setaf 1)
CYAN := $(shell tput setaf 6)
PURPLE := $(shell tput setaf 5)
BOLD := $(shell tput bold)
RESET := $(shell tput sgr0)

# Package info
PACKAGE_NAME := pgserve
VERSION := $(shell grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')

# ==========================================
# 📋 Help
# ==========================================
.PHONY: help
help: ## Show this help
	@echo ""
	@echo "$(PURPLE)$(BOLD)📦 pgserve$(RESET) - v$(VERSION)"
	@echo "$(CYAN)Embedded PostgreSQL server with multi-tenant support$(RESET)"
	@echo ""
	@echo "$(BOLD)Quick Commands:$(RESET)"
	@echo "  $(PURPLE)release-rc$(RESET)     Create RC release locally"
	@echo "  $(PURPLE)release-stable$(RESET) Promote RC to stable"
	@echo "  $(PURPLE)test-local$(RESET)     Test server locally"
	@echo "  $(PURPLE)pm2-start$(RESET)      Start server with PM2"
	@echo ""
	@echo "$(BOLD)CI/CD Workflow:$(RESET)"
	@echo "  1. Create PR with changes"
	@echo "  2. Add 'rc' label → auto-publishes to npm @next"
	@echo "  3. Add 'stable' label → promotes to npm @latest"
	@echo ""
	@echo "$(BOLD)Build Executables:$(RESET)"
	@echo "  $(PURPLE)build$(RESET)          Build for current platform"
	@echo "  $(PURPLE)build-all$(RESET)      Build for all platforms (Linux, macOS, Windows)"
	@echo "  $(PURPLE)build-linux$(RESET)    Build for Linux (x64 + arm64)"
	@echo "  $(PURPLE)build-macos$(RESET)    Build for macOS (x64 + arm64)"
	@echo "  $(PURPLE)build-windows$(RESET)  Build for Windows (x64)"
	@echo ""
	@echo "$(BOLD)Development:$(RESET)"
	@echo "  $(PURPLE)install$(RESET)        Install dependencies"
	@echo "  $(PURPLE)clean$(RESET)          Clean generated files"
	@echo ""
	@echo "$(BOLD)Status:$(RESET)"
	@echo "  Version: $(VERSION)"
	@echo "  Package: $(PACKAGE_NAME)"
	@echo ""

# ==========================================
# 🚀 Installation
# ==========================================
.PHONY: install
install: ## Install dependencies
	@echo "$(CYAN)📦 Installing dependencies...$(RESET)"
	@bun install
	@echo "$(GREEN)✅ Dependencies installed!$(RESET)"

.PHONY: test
test: ## Run tests
	@echo "$(CYAN)🧪 Running tests...$(RESET)"
	@bun test
	@echo "$(GREEN)✅ Tests passed!$(RESET)"

.PHONY: bench
bench: ## Run benchmarks
	@echo "$(CYAN)📊 Running benchmarks...$(RESET)"
	@bun tests/benchmarks/runner.js
	@echo "$(GREEN)✅ Benchmarks complete!$(RESET)"

# ==========================================
# 🧪 Testing
# ==========================================
.PHONY: test-local
test-local: ## Test server locally
	@echo "$(CYAN)🧪 Testing server...$(RESET)"
	@./bin/pglite-server.js start ./data/test-local --port 12050 --log info &
	@TESTPID=$$!; \
	sleep 3; \
	./bin/pglite-server.js list; \
	./bin/pglite-server.js health --port 12050; \
	kill $$TESTPID 2>/dev/null || true; \
	./bin/pglite-server.js cleanup
	@echo "$(GREEN)✅ Server test passed!$(RESET)"

# ==========================================
# 📦 PM2 Management
# ==========================================
.PHONY: pm2-start pm2-stop pm2-restart pm2-logs pm2-status
pm2-start: ## Start server with PM2
	@echo "$(CYAN)🚀 Starting PM2 instance...$(RESET)"
	@pm2 start ecosystem.config.cjs
	@pm2 save
	@echo "$(GREEN)✅ PM2 instance started and saved!$(RESET)"

pm2-stop: ## Stop PM2 instance
	@echo "$(CYAN)🛑 Stopping PM2 instance...$(RESET)"
	@pm2 stop "pgserve" 2>/dev/null || true
	@pm2 delete "pgserve" 2>/dev/null || true
	@pm2 save
	@echo "$(GREEN)✅ PM2 instance stopped!$(RESET)"

pm2-restart: ## Restart PM2 instance
	@echo "$(CYAN)🔄 Restarting PM2 instance...$(RESET)"
	@pm2 restart "pgserve" 2>/dev/null || $(MAKE) pm2-start
	@echo "$(GREEN)✅ PM2 instance restarted!$(RESET)"

pm2-logs: ## Show PM2 logs
	@pm2 logs "pgserve" --lines 50

pm2-status: ## Show PM2 status
	@pm2 status "pgserve"

# ==========================================
# 🔍 Pre-publish Checks
# ==========================================
.PHONY: check-git check-npm check-version check-files
check-git: ## Check git status
	@echo "$(CYAN)🔍 Checking git status...$(RESET)"
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "$(RED)❌ Uncommitted changes detected!$(RESET)"; \
		git status --short; \
		exit 1; \
	fi
	@echo "$(GREEN)✅ Git working directory clean$(RESET)"

check-npm: ## Check npm authentication
	@echo "$(CYAN)🔍 Checking npm authentication...$(RESET)"
	@if ! npm whoami >/dev/null 2>&1; then \
		echo "$(RED)❌ Not logged in to npm!$(RESET)"; \
		echo "$(YELLOW)Run: npm login --auth-type=legacy$(RESET)"; \
		exit 1; \
	fi
	@echo "$(GREEN)✅ Logged in as: $$(npm whoami)$(RESET)"
	@if [ -z "$$NPM_TOKEN" ] && ! grep -q "_authToken" ~/.npmrc 2>/dev/null; then \
		echo "$(YELLOW)⚠️  Consider using NPM_TOKEN or ~/.npmrc for non-interactive publish$(RESET)"; \
	fi

check-version: ## Check if version tag exists
	@echo "$(CYAN)🔍 Checking version $(VERSION)...$(RESET)"
	@if git tag | grep -q "^v$(VERSION)$$"; then \
		echo "$(RED)❌ Version v$(VERSION) already tagged!$(RESET)"; \
		echo "$(YELLOW)Bump version first: npm version patch|minor|major$(RESET)"; \
		exit 1; \
	fi
	@echo "$(GREEN)✅ Version $(VERSION) is new$(RESET)"

check-files: ## Check required files exist
	@echo "$(CYAN)🔍 Checking required files...$(RESET)"
	@for file in package.json README.md LICENSE src/index.js bin/pglite-server.js; do \
		if [ ! -f "$$file" ]; then \
			echo "$(RED)❌ Missing required file: $$file$(RESET)"; \
			exit 1; \
		fi; \
	done
	@echo "$(GREEN)✅ All required files present$(RESET)"

# ==========================================
# 🔨 Build Standalone Executables
# ==========================================
DIST_DIR := dist

.PHONY: build build-linux build-macos build-windows build-all clean-dist

build: ## Build standalone executable for current platform
	@echo "$(CYAN)🔨 Building standalone executable...$(RESET)"
	@mkdir -p $(DIST_DIR)
	@bun build --compile bin/pglite-server.js --outfile $(DIST_DIR)/pgserve
	@echo "$(GREEN)✅ Built: $(DIST_DIR)/pgserve$(RESET)"

build-linux: ## Build for Linux (x64 + arm64)
	@echo "$(CYAN)🐧 Building for Linux...$(RESET)"
	@mkdir -p $(DIST_DIR)
	@bun build --compile --target=bun-linux-x64 bin/pglite-server.js --outfile $(DIST_DIR)/pgserve-linux-x64
	@bun build --compile --target=bun-linux-arm64 bin/pglite-server.js --outfile $(DIST_DIR)/pgserve-linux-arm64
	@echo "$(GREEN)✅ Built: $(DIST_DIR)/pgserve-linux-x64$(RESET)"
	@echo "$(GREEN)✅ Built: $(DIST_DIR)/pgserve-linux-arm64$(RESET)"

build-macos: ## Build for macOS (x64 + arm64)
	@echo "$(CYAN)🍎 Building for macOS...$(RESET)"
	@mkdir -p $(DIST_DIR)
	@bun build --compile --target=bun-darwin-x64 bin/pglite-server.js --outfile $(DIST_DIR)/pgserve-darwin-x64
	@bun build --compile --target=bun-darwin-arm64 bin/pglite-server.js --outfile $(DIST_DIR)/pgserve-darwin-arm64
	@echo "$(GREEN)✅ Built: $(DIST_DIR)/pgserve-darwin-x64$(RESET)"
	@echo "$(GREEN)✅ Built: $(DIST_DIR)/pgserve-darwin-arm64$(RESET)"

build-windows: ## Build for Windows (x64)
	@echo "$(CYAN)🪟 Building for Windows...$(RESET)"
	@mkdir -p $(DIST_DIR)
	@bun build --compile --target=bun-windows-x64 bin/pglite-server.js --outfile $(DIST_DIR)/pgserve-windows-x64.exe
	@echo "$(GREEN)✅ Built: $(DIST_DIR)/pgserve-windows-x64.exe$(RESET)"

build-all: build-linux build-macos build-windows ## Build for all platforms
	@echo ""
	@echo "$(GREEN)$(BOLD)╔═══════════════════════════════════════════════════╗$(RESET)"
	@echo "$(GREEN)$(BOLD)║  🎉 All platform builds complete!                ║$(RESET)"
	@echo "$(GREEN)$(BOLD)╚═══════════════════════════════════════════════════╝$(RESET)"
	@echo ""
	@ls -lh $(DIST_DIR)/
	@echo ""

clean-dist: ## Clean build artifacts
	@echo "$(CYAN)🧹 Cleaning dist...$(RESET)"
	@rm -rf $(DIST_DIR)
	@echo "$(GREEN)✅ Dist cleaned!$(RESET)"

# ==========================================
# 🚀 CI/CD Release (Automated)
# ==========================================
# Releases are triggered by GitHub Actions when PRs are merged with labels:
#   - 'rc' label → Creates RC release (1.0.8 → 1.0.9-rc.1)
#   - 'stable' label → Promotes RC to stable (1.0.9-rc.1 → 1.0.9)
#
# See .github/workflows/release.yml for full automation.
# ==========================================
.PHONY: release-rc release-stable release-dry

release-rc: ## Create RC release locally (for testing)
	@echo "$(CYAN)🔢 Creating RC release...$(RESET)"
	@node scripts/release.cjs --action bump-rc
	@echo ""
	@echo "$(GREEN)✅ RC release created!$(RESET)"
	@echo "$(YELLOW)Push with: git push && git push --tags$(RESET)"

release-stable: ## Promote RC to stable locally (for testing)
	@echo "$(CYAN)🎉 Promoting to stable...$(RESET)"
	@node scripts/release.cjs --action promote
	@echo ""
	@echo "$(GREEN)✅ Stable release created!$(RESET)"
	@echo "$(YELLOW)Push with: git push && git push --tags$(RESET)"

release-dry: ## Dry-run release (no changes)
	@echo "$(CYAN)🔍 Dry-run release...$(RESET)"
	@node scripts/release.cjs --action bump-rc --dry-run
	@echo ""
	@echo "$(GREEN)✅ Dry-run complete (no changes made)$(RESET)"

# ==========================================
# 📦 Manual Publish (Deprecated)
# ==========================================
.PHONY: pre-publish publish publish-dry
pre-publish: check-git check-npm check-version check-files ## Run all pre-publish checks
	@echo "$(GREEN)✅ All pre-publish checks passed!$(RESET)"

publish-dry: pre-publish ## Dry-run publish (test without actually publishing)
	@echo "$(CYAN)🧪 Running dry-run publish...$(RESET)"
	@npm publish --dry-run
	@echo "$(GREEN)✅ Dry-run successful!$(RESET)"
	@echo "$(YELLOW)To actually publish, run: make publish$(RESET)"

publish: ## ⚠️ [DEPRECATED] Use PR labels instead
	@echo ""
	@echo "$(YELLOW)$(BOLD)╔═══════════════════════════════════════════════════════════════╗$(RESET)"
	@echo "$(YELLOW)$(BOLD)║  ⚠️  Manual publish is DEPRECATED                            ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║                                                               ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║  Use PR labels for automated releases:                       ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║    • Add 'rc' label → RC release (npm @next)                 ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║    • Add 'stable' label → Promote to stable (npm @latest)   ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║                                                               ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║  Local testing:                                              ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║    make release-rc      Create RC locally                    ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║    make release-stable  Promote locally                      ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)║    make release-dry     Dry-run (no changes)                 ║$(RESET)"
	@echo "$(YELLOW)$(BOLD)╚═══════════════════════════════════════════════════════════════╝$(RESET)"
	@echo ""

# ==========================================
# 🧹 Maintenance
# ==========================================
.PHONY: clean clean-all
clean: ## Clean generated files
	@echo "$(CYAN)🧹 Cleaning...$(RESET)"
	@rm -rf data/test-* data/genieos-local
	@./bin/pglite-server.js cleanup
	@echo "$(GREEN)✅ Cleaned!$(RESET)"

clean-all: clean ## Deep clean (including node_modules)
	@echo "$(CYAN)🧹 Deep cleaning...$(RESET)"
	@rm -rf node_modules package-lock.json pnpm-lock.yaml bun.lock
	@echo "$(GREEN)✅ Deep clean complete!$(RESET)"

# ==========================================
# 🔧 Utility
# ==========================================
.PHONY: version bump-patch bump-minor bump-major
version: ## Show current version
	@echo "$(CYAN)Current version: $(BOLD)$(VERSION)$(RESET)"

bump-patch: ## Bump patch version (0.1.0 → 0.1.1)
	@echo "$(CYAN)📈 Bumping patch version...$(RESET)"
	@npm version patch -m "chore: bump version to %s"
	@echo "$(GREEN)✅ Version bumped to $$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')$(RESET)"

bump-minor: ## Bump minor version (0.1.0 → 0.2.0)
	@echo "$(CYAN)📈 Bumping minor version...$(RESET)"
	@npm version minor -m "chore: bump version to %s"
	@echo "$(GREEN)✅ Version bumped to $$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')$(RESET)"

bump-major: ## Bump major version (0.1.0 → 1.0.0)
	@echo "$(CYAN)📈 Bumping major version...$(RESET)"
	@npm version major -m "chore: bump version to %s"
	@echo "$(GREEN)✅ Version bumped to $$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')$(RESET)"
