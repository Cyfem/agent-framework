# Fixed Node 22 acceptance toolchain

`node22.lock.json` pins Node.js `22.23.2`, pnpm `11.1.3`, the official Windows
archive SHA-256, and the Linux multi-platform image digest.

On Windows, bootstrap and invoke the pinned toolchain without changing the host installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tooling/node/bootstrap-node22.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tooling/node/invoke-node22.ps1 pnpm --version
```

The bootstrap downloads into the ignored `.tools` directory, verifies both the pinned digest and
the matching entry in Node's official `SHASUMS256.txt`, and refuses install roots outside `.tools`.

For Linux acceptance, build `Dockerfile.node22`; its base image is pinned by digest and it activates
the same pnpm version through Corepack.
