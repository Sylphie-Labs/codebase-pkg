# Vendored grammars

`tree-sitter-rust.wasm` is vendored from the npm package `tree-sitter-rust@0.24.0` (`package/tree-sitter-rust.wasm`).

- sha256: `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57`
- Loaded by `web-tree-sitter` 0.25.10 (exact pin).
- Vendored rather than depending on `tree-sitter-rust`, because that package runs a native node-gyp install step.

To upgrade: `npm pack tree-sitter-rust@<new>`, copy the new wasm out of the tarball, update the hash above, and re-run the tests (grammar upgrades can change node shapes).
