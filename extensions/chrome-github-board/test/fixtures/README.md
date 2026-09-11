# Recorded GitHub board fixture

`project-board.html` records GitHub's undocumented project-board markup. See [mechanics M27](../../../../docs/mechanics.md#github-board-dom-and-extension-lifecycle) for observed selectors and dates.

From the repository root:

```bash
npm run record --workspace @ground-control/chrome-github-board
```

The recorder uses GitHub's public roadmap at `https://github.com/orgs/github/projects/4247/views/21`; no authentication is required. `anonymise.cjs` scrubs the markup before saving it.

The filter input and the signed-in login are synthesized, not recorded: both would name a real person or a real board's filter. The fixture is a board filtered to its own viewer (`assignee:example-dev`), the state the overlay is built for.

The roadmap has no assignees, so `record.cjs` captures a real stack from the first public board in `ASSIGNEE_SOURCES` with one. It scrubs the person and inserts the stack into two cards, leaving the third unassigned. Recording fails if no stack is available.

| Preserved | Replaced |
|---|---|
| Board region, two columns, three cards, and observed attributes | Issue numbers 4501–4503 and repository `example-org/example-repo` |
| Real assignee markup on two cards | Assignee `example-dev`, inert data-URI avatar, and distinct per-card tooltip IDs derived from the captured ID |
| Wrappers and hashed class names | Titles from `tools/fixture-words.js` |
| One empty column | Column names, cursor IDs, and project-item IDs |
| Filter toolbar structure | Filter text `assignee:example-dev` and `meta[name="user-login"]`, both synthesized |

Trim by removing whole nodes: extra columns/cards, unread label lists, and unused icons. Preserve structural markup needed by the tests.

Validation checks that replaced values are gone and that no unexpected repository, issue number, or project-item ID remains. Validate URL-bearing attributes (`src`, `srcset`, `href`, `poster`, `data-src`) to prevent external requests or navigation. Check parsed attribute values: decoded `&` differs from serialized `&amp;`, so text replacement alone can miss an avatar URL.

Use the isolation and scrubbing rules in [testing.md](../../../../docs/testing.md#recording-and-scrubbing).

## Loopback certificate

`github.com.key.pem` and `github.com.crt.pem` are a self-signed pair for `github.com`, valid for a century, made with `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=github.com -addext subjectAltName=DNS:github.com`. The extension suite serves a pull request page over TLS on a loopback listener and points the test browser's `github.com` at it with `--host-resolver-rules`, so the header rule in `rules.json` is exercised on a real response: Chrome applies `declarativeNetRequest` to responses from the network, not to ones Playwright's `route.fulfill` synthesizes. The pair secures nothing and is not a secret.
