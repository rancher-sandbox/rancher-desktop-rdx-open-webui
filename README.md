# AI Workbench docker extension

docker extension that installs and configures [Ollama](https://ollama.com/), [llama.cpp](https://github.com/ggml-org/llama.cpp), [LlamaEdge](https://llamaedge.com/), [Open WebUI](https://docs.openwebui.com/), a tiny open source LLM (tinyllama) on top of Rancher Desktop for local GenAI exploration & development.

## How to install

- Install and run Rancher Desktop.
- Run the command

  ```
  rdctl extension install <extension-container-image>
  ```

## How to uninstall

- Run the command

```
rdctl extension uninstall <extension-container-image>
```

## How to build the extension container image

- Run the command

```
docker build -t <extension-container-image> .
```

## Documentation

To learn more about the extension and how to use it, refer to the [documentation](https://docs.rancherdesktop.io/tutorials/working-with-llms).
