# eerraa fork notes

This repository is a fork of [`totec448-spec/chat-on-steroids`](https://github.com/totec448-spec/chat-on-steroids).
It keeps upstream history intact and carries focused compatibility fixes that are useful before
they are available upstream.

## Current fixes over upstream v2.0.2

Base: upstream tag `v2.0.2`, commit `e254b954eb6570c52f2e7cc059700deff1214a9b`.

### ChatGPT Project conversation attribution

Upstream recognizes normal ChatGPT conversation routes:

```text
/c/<conversation-id>
```

ChatGPT Project conversations use a different route family:

```text
/g/<project>/c/<conversation-id>
```

The companion in this fork recognizes both exact route families. This restores the normal
request-id -> conversation-id correlation chain in Project chats instead of leaving the page
apparently connected while MCP calls fall into `Unattributed activity` after the attribution
grace period.

The parser deliberately does not search arbitrary paths for a `c/<uuid>` fragment. Conversation
identity feeds security-sensitive attribution and remains fail-closed on unknown route shapes.

### Multi-agent Project affinity

When a Project conversation is the prime agent, newly spawned workers now open on that same
ChatGPT Project's New Chat surface instead of the global New Chat page. A later revival of that
worker also uses its recorded Project route. This allows ChatGPT to apply the Project's own
instructions and Project-scoped memory to worker chats rather than relying only on the explicit
CoS `context` and worker task.

The fresh Project composer is addressed through `/g/<project>/project`. Opening the bare
`/g/<project>` namespace is not equivalent in current ChatGPT: it can redirect to global New Chat,
where a browser-restored draft can make a Project worker fail before its conversation exists.

Project affinity is not inferred from titles, DOM text, the active tab, or timing. The extension
derives `/g/<project>` from Chrome's `MessageSender.url` on the same acknowledged request
correlation handshake that proves conversation ownership. The app validates and durably stores
that prime mapping before acknowledging it, so a spawn retried after an app restart does not
silently fall back to global New Chat. When a Project-scoped worker bootstrap is acknowledged, the
same route is also durably attached to the concrete worker conversation before the bootstrap
command is retired; a worker can therefore finish immediately and still be reopened inside the
same Project later, even if no subsequent worker tool call ever observes the settled SPA route.

Worker identity is unchanged: Project affinity chooses where a ChatGPT conversation is created;
the existing command lease, acknowledgement, and conversation binding remain the authority for
which worker owns it.

### Worker browser affinity on Windows

Upstream's browser launcher prefers a discovered Google Chrome executable for every worker/resume
URL. That can move a worker out of an Edge-hosted prime into a separate Chrome profile even while
the Project route itself is correct. Browser-local ChatGPT state and custom MCP availability can
then differ from the prime; in the live reproduction the worker opened in Chrome and could not see
the `agents` tool that was available to the Edge prime.

This fork records whether the request-correlation handshake came from Microsoft Edge or Google
Chrome using the loopback request's browser User-Agent. New workers inherit that browser family
from the prime, and the worker's successful bootstrap ACK durably attaches the same family to its
conversation for later revivals. On Windows the launcher then targets the matching executable
family instead of silently crossing from Edge to Chrome. The launcher still passes only the URL;
whether an already-running browser presents it as a tab or has to create a new window remains the
browser's own process/window behavior rather than an agent UI action.

### Current ChatGPT composer compatibility

Current ChatGPT builds expose the submit control as `#composer-submit-button`; its accessible label
is localized (for example, `프롬프트 보내기`). The companion recognizes that stable control id in
addition to the older `data-testid="send-button"` / English-label shapes, so a successfully inserted
worker bootstrap is submitted by ChatGPT's real button rather than falling through to a synthetic
Enter key that React may ignore.

## Validation

The fork is validated with the repository's own gates:

```sh
npm ci
npm run verify
npm run build
```

Regression coverage includes normal/Project conversation parsing, Project request correlation,
fresh worker Project affinity, the current Project New Chat and submit-button shapes, same-browser
worker spawn/revival, and Project/browser-affinity restoration across a bridge restart.

## Remotes for contributors

A local checkout should normally keep the fork as `origin` and the original project as
`upstream`:

```text
origin   https://github.com/eerraa/chat-on-steroids.git
upstream https://github.com/totec448-spec/chat-on-steroids.git
```

No fork-specific installer release is implied merely by the source branch. A release will say
explicitly when it contains packaged binaries.
