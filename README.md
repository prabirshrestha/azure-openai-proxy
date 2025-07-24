# azure-openai-proxy

CLI tool to create open ai compatible endpoints for azure open ai by using azure cli as the authentication mechanism to get access token automatically which can be useful when api key is disabled or not available.

## Installation

1. Make sure azure cli is installed and configured. https://learn.microsoft.com/en-us/cli/azure/

2. Add `~/.azure-openai-proxy.json` with the following content replacing the resource name and deployment names correctly.

The configuration supports the following options for model definitions:
- Simple string format: Maps model name to Azure deployment name
- Object format with the following properties:
  - `deployment`: (Required) The Azure deployment name
  - `endpoint`: (Optional) Override the default endpoint for this model
  - `apiVersion`: (Optional) Override the default API version for this model
  - `modelName`: (Optional) Override the model parameter sent to Azure API

```json
{
  "defaultEndpoint": "https://resourcename.openai.azure.com",
  "defaultApiVersion": "2024-08-01-preview",
  "models": {
    "gpt-4o": {
      "deployment": "gpt-4o",
      "endpoint": "https://resourcename2.openai.azure.com"
    },
    "gpt-4o-mini": "gpt-4o-mini",
    "DeepSeek-R1-abyc": {
      "deployment": "deepseek-r1-deployment",
      "modelName": "DeepSeek-R1"
    },
    "text-embedding-3-large": "text-embedding-3-large"
  }
}
```

3. Run the following command to start the proxy server:

```bash
npx azure-openai-proxy@latest
```

## Example Requests

### List Models API

```bash
curl http://localhost:3000/v1/models | jq
```

### Chat Completions API

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "Tell me a brief joke about programming."
      }
    ],
    "temperature": 0.7,
    "stream": false
  }' | jq '.choices[0].message.content'
```

### Embeddings API

```bash
curl http://localhost:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-large",
    "input": ["Your text here", "Another text to embed"]
  }'
```
