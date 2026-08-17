import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

// vitest-pool-workers 0.21+ dropped automatic per-test storage isolation
// (`isolatedStorage`) in favor of an explicit reset — see the vitest-4
// migration notes. Without this, DO rows created by one `it()` leak into the
// next `it()` sharing the same stub name (several suites deliberately reuse
// `stub("singleton")` across tests), producing off-by-one row counts.
afterEach(async () => {
  await reset();
});
