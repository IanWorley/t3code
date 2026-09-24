# VibeProxy

T3 Code can route a Codex or Claude provider instance through VibeProxy (or its underlying
CLIProxyAPI service). Routed instances can use models that VibeProxy makes available from your
connected accounts.

You can connect to an existing proxy or let T3 Code manage an installed CLIProxyAPI executable.
Proxy connections and process controls run on the machine hosting the T3 Code server, including
when you connect from a remote browser or phone.

## Let T3 Code manage the proxy

Install CLIProxyAPI and configure its accounts before enabling management in T3 Code.

1. Open **Settings → Providers** and find the **VibeProxy** section.
2. Enable **Let T3 manage the CLI proxy**.
3. Enter the executable path and the absolute configuration file path on the server machine.
4. Set **Proxy URL** to the address and port in that configuration file.
5. Select **Save proxy management**, then **Start**.

You can stop or restart the managed proxy from the same settings. Enable **Start with this T3 server**
to start it when the T3 server starts. Stopping it leaves it stopped until you start it again
or restart T3 with automatic startup enabled.

T3 stops its managed proxy when the server shuts down. Switching to external management stops
the process T3 started. T3 does not take control of an already running VibeProxy process, install
CLIProxyAPI, or change its configuration files. Stop an existing proxy before using the same port.

The process status reports whether the executable is running. Provider availability still depends
on the proxy URL, client API key, and configured accounts.

On mobile, open **Settings → Environments** and expand the connected environment to control a
configured proxy. Use web or desktop Providers settings for initial setup.

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
