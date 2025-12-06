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
	@echo "  $(PURPLE)publish$(RESET)        Publish to npm (auto-checks, builds, publishes)"
	@echo "  $(PURPLE)test-local$(RESET)     Test server locally"
	@echo "  $(PURPLE)pm2-start$(RESET)      Start server with PM2"
	@echo "  $(PURPLE)pm2-stop$(RESET)       Stop PM2 instance"
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
# 📦 Build & Publish
# ==========================================
.PHONY: pre-publish publish publish-dry
pre-publish: check-git check-npm check-version check-files ## Run all pre-publish checks
	@echo "$(GREEN)✅ All pre-publish checks passed!$(RESET)"

publish-dry: pre-publish ## Dry-run publish (test without actually publishing)
	@echo "$(CYAN)🧪 Running dry-run publish...$(RESET)"
	@npm publish --dry-run
	@echo "$(GREEN)✅ Dry-run successful!$(RESET)"
	@echo "$(YELLOW)To actually publish, run: make publish$(RESET)"

publish: check-git check-npm check-files ## 🚀 Publish to npm (auto-bumps version)
	@echo ""
	@echo "$(PURPLE)$(BOLD)╔═══════════════════════════════════════════════════╗$(RESET)"
	@echo "$(PURPLE)$(BOLD)║  📦 Publishing $(PACKAGE_NAME)  ║$(RESET)"
	@echo "$(PURPLE)$(BOLD)╚═══════════════════════════════════════════════════╝$(RESET)"
	@echo ""
	@echo "$(CYAN)Current version: v$(VERSION)$(RESET)"
	@echo ""
	@echo "$(CYAN)📈 Bumping patch version...$(RESET)"
	@NEW_VER=$$(node -e "const p=require('./package.json'); const v=p.version.split('.'); v[2]=parseInt(v[2])+1; console.log(v.join('.'))"); \
	git tag -d "v$$NEW_VER" 2>/dev/null || true; \
	git push origin --delete "v$$NEW_VER" 2>/dev/null || true
	@npm version patch -m "chore: bump version to %s"
	@NEW_VERSION=$$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/'); \
	echo "$(GREEN)✅ Version bumped to $$NEW_VERSION$(RESET)"; \
	echo ""; \
	echo "$(CYAN)📤 Pushing to GitHub...$(RESET)"; \
	git push && git push --tags; \
	echo "$(GREEN)✅ Pushed to GitHub!$(RESET)"; \
	echo ""; \
	echo "$(CYAN)Package: $(PACKAGE_NAME)@$$NEW_VERSION$(RESET)"; \
	echo ""; \
	read -p "$(YELLOW)Confirm publish? [y/N] $(RESET)" -n 1 -r; \
	echo; \
	if [[ ! $$REPLY =~ ^[Yy]$$ ]]; then \
		echo "$(YELLOW)⚠️  Publish cancelled$(RESET)"; \
		exit 1; \
	fi; \
	echo ""; \
	echo "$(CYAN)📦 Publishing to npm...$(RESET)"; \
	npm publish --access public || { echo "$(RED)❌ npm publish failed! Run manually: npm publish --access public$(RESET)"; exit 1; }; \
	echo "$(GREEN)✅ Published to npm!$(RESET)"; \
	echo ""; \
	if command -v gh >/dev/null 2>&1; then \
		echo "$(CYAN)🎉 Creating GitHub release...$(RESET)"; \
		gh release create "v$$NEW_VERSION" \
			--title "v$$NEW_VERSION" \
			--notes "Multi-instance PostgreSQL embedded server - See README.md for details" \
			|| echo "$(YELLOW)⚠️  GitHub release creation failed (may already exist)$(RESET)"; \
		echo ""; \
	fi; \
	echo "$(GREEN)$(BOLD)╔═══════════════════════════════════════════════════╗$(RESET)"; \
	echo "$(GREEN)$(BOLD)║  🍾 SUCCESS! Package published!                  ║$(RESET)"; \
	echo "$(GREEN)$(BOLD)╚═══════════════════════════════════════════════════╝$(RESET)"; \
	echo ""; \
	echo "$(CYAN)📦 Install with:$(RESET)"; \
	echo "   npm install -g $(PACKAGE_NAME)"; \
	echo ""; \
	echo "$(CYAN)🔗 View on npm:$(RESET)"; \
	echo "   https://www.npmjs.com/package/$(PACKAGE_NAME)"; \
	echo ""

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
