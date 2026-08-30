# VibeProxy

T3 Code can route a Codex or Claude provider instance through VibeProxy (or its underlying
CLIProxyAPI service). Routed instances can use models that VibeProxy makes available from your
connected accounts.

VibeProxy must be installed and configured on the machine running the T3 Code server. This also
applies when you use T3 Code remotely: the server machine's VibeProxy is used, not the proxy on your
phone or browser machine.

## Enable routing

1. Open **Settings → Providers** and find the **VibeProxy** section.
2. Leave **Proxy URL** at `http://localhost:8317` for the standard local installation, or enter the
   URL of the VibeProxy server reachable from the T3 Code server machine.
3. If VibeProxy requires a client API key, enter it in **Client API key**.
4. Under **Use VibeProxy with**, turn on routing for each Codex or Claude instance that should use
   the proxy.

The key is stored separately from settings and is hidden after saving. It is the client key defined
by VibeProxy, not a credential for OpenAI or Anthropic.

New provider sessions use VibeProxy after the setting is enabled. Existing sessions may need a new
thread before the routing change takes effect.

## Choose a model

Routed instances show a **VP** marker in the model picker. Models added beyond the harness's native
catalog show a **VibeProxy** source badge; native models keep their normal harness identity even
though their requests are routed through VibeProxy. Models currently reported by VibeProxy are
added to the routed instance's model list. A dimmed model is not currently present in VibeProxy's
live model list, but it remains selectable because account quota and model availability can change.

You can hide individual models from the provider's **Models** tab.

If the proxy is stopped or unreachable, T3 Code shows a warning and requests fail. T3 Code does not
silently send those requests directly to OpenAI or Anthropic.

## Disable routing

Turn off the provider instance under **Use VibeProxy with**. New sessions return to that instance's
original configuration. T3 Code does not modify your Codex, Claude, or VibeProxy config files.
