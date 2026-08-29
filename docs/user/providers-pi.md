# Pi

Pi support connects T3 Code to the Pi coding agent through the Agent Client Protocol (ACP). It is
available on web, desktop, and mobile because the Pi process runs on the T3 Code server host.

## Install and configure

Install both Pi and its ACP adapter on the machine running T3 Code:

```sh
npm install --global @earendil-works/pi-coding-agent pi-acp
```

Run `pi` in a terminal first and configure at least one model provider. Pi manages its own model
provider credentials; T3 Code does not replace that setup.

In T3 Code, open **Settings → Providers**, select **Pi**, and enable it. If `pi-acp` is not on the
server's `PATH`, set the Pi binary path to its absolute location. The provider status changes to
ready after T3 Code starts ACP and discovers Pi's available models.

## Models and reasoning

T3 Code reads the model list from Pi for each provider refresh. The model picker also shows the
reasoning levels advertised by Pi for the active configuration. Changing either value updates the
Pi ACP session before the next turn.

You can create multiple Pi provider instances when you need separate Pi homes or credentials. Set
`PI_CODING_AGENT_DIR` as an instance environment variable to isolate each Pi configuration.

## Current limitation

Pi loads MCP servers from its own configuration. Pi's ACP adapter cannot currently attach the HTTP
MCP server supplied by T3 Code, so T3 Code's injected agent-browser tools are not available in Pi
sessions. MCP servers configured directly in Pi continue to work.
