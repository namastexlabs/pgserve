# Platform Packages

This directory contains platform-specific packages for pgserve.

Each package contains a prebuilt binary for its respective platform:

- `@pgserve/linux-x64` - Linux x64
- `@pgserve/linux-arm64` - Linux ARM64
- `@pgserve/darwin-x64` - macOS Intel
- `@pgserve/darwin-arm64` - macOS Apple Silicon
- `@pgserve/windows-x64` - Windows x64

These packages are automatically published by the CI/CD pipeline when a release is created.

The main `pgserve` package depends on these via `optionalDependencies`, so npm will install the correct binary for your platform automatically.

## Manual Installation

If automatic installation fails, you can install the correct package manually:

```bash
# Linux x64
npm install @pgserve/linux-x64

# macOS Apple Silicon
npm install @pgserve/darwin-arm64

# Windows
npm install @pgserve/windows-x64
```
