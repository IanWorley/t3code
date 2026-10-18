# Model proxy

T3 Code can send a Codex or Claude provider's requests through an OpenAI- and Anthropic-compatible
proxy, such as CLIProxyAPI or a tool built on it. Routed providers can also use models the proxy
offers from your connected accounts.

The proxy must be reachable from the machine running the T3 Code server. When you use T3 Code
remotely, the server machine connects to the proxy, not your phone or browser.

## Set it up

1. Open **Settings → Providers → Model proxy**.
2. Keep **Proxy URL** at `http://localhost:8317` for a standard local install, or enter the proxy's
   address.
3. If the proxy requires a client key, enter it in **API key**. This is the proxy's own key, not an
   OpenAI or Anthropic key. It is stored in the server's secret store and hidden after saving.
4. Select a Codex or Claude provider and turn on **Model proxy** under its **Environment** section.

New sessions use the proxy once it is on. Start a new thread if an existing one should switch.

Codex instances that use **Managed** setup can't use the proxy. Switch the instance to an existing
Codex installation first.

## Models

Models the proxy offers beyond the provider's own list appear in the model picker labelled
**Proxy**. Hide any you don't want from the provider's **Models** section. Routed providers show a
route icon in the model picker.

If the proxy is stopped or rejects T3 Code, the provider shows a warning and its requests fail. T3
Code never falls back to sending them directly to OpenAI or Anthropic.

## Turn it off

Turn off **Model proxy** for the provider. New sessions return to the provider's normal
configuration. T3 Code does not change your Codex, Claude, or proxy config files.
