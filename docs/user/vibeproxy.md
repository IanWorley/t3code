# VibeProxy

T3 Code can route a Codex or Claude provider instance through VibeProxy (or its underlying
CLIProxyAPI service). Routed instances can use models that VibeProxy makes available from your
connected accounts.

VibeProxy must be installed and configured on the machine running the T3 Code server. This also
applies when you use T3 Code remotely: the server machine's VibeProxy is used, not the proxy on your
phone or browser machine.

## Enable routing

1. Open **Settings → Providers**.
2. Select a Codex or Claude instance.
3. Turn on **Route through VibeProxy**.
4. If VibeProxy requires a client API key, enter it in **VibeProxy client API key**.

The key is stored separately from settings and is hidden after saving. It is the client key defined
by VibeProxy, not a credential for OpenAI or Anthropic.

New provider sessions use VibeProxy after the setting is enabled. Existing sessions may need a new
thread before the routing change takes effect.

## Choose a model

Routed instances show a **VP** marker in the model picker. Models currently reported by VibeProxy
are added to that instance's model list. A dimmed model is not currently present in VibeProxy's live
model list, but it remains selectable because account quota and model availability can change.

If the proxy is stopped or unreachable, T3 Code shows a warning and requests fail. T3 Code does not
silently send those requests directly to OpenAI or Anthropic.

## Disable routing

Turn off **Route through VibeProxy** for the provider instance. New sessions return to that
instance's original configuration. T3 Code does not modify your Codex, Claude, or VibeProxy config
files.
